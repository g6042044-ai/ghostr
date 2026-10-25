// src/services/encryptedBlobService.ts
// v28.0: Encrypted Blob Storage — OHTTP-only + iOS performance fix
//
// ARCHITECTURE (v27.0 — CHANGED from v26.0):
//   Upload: data → nacl.secretbox(random key) → pad to tier → base64 → OHTTP relay → gateway → Supabase Storage
//   Download: OHTTP relay → gateway → Supabase Storage → base64 → unpad → nacl.secretbox.open → data
//
// v27.0 VULNERABILITY FIXED:
//   Previously, uploads/downloads went through CF Relay's /storage/* proxy.
//   The CF Relay saw the client's IP AND the blob path (UUID) in the URL.
//   Supabase saw the blob UUID AND the timestamp/size.
//   An adversary with access to both logs could correlate IP ↔ blob via timestamp+size.
//
// v27.0 FIX:
//   ALL blob operations now go through the OHTTP tunnel (/relay endpoint).
//   The CF Relay sees ONLY an opaque encrypted blob — no UUID, no path, no size.
//   The gateway sees the UUID and forwards to Supabase, but never sees the IP.
//   → No single entity can correlate IP ↔ blob ↔ conversation.
//
// TRADE-OFF:
//   Base64 encoding adds ~33% overhead on the OHTTP payload.
//   A 16MB blob becomes ~21.3MB in transit through the tunnel.
//   This is acceptable for the anonymity guarantee.
//
// ============================================================================
// v28.0 — iOS PERFORMANCE FIX:
//
// PROBLÈMES CORRIGÉS (latence iOS sur l'envoi d'images):
//
//   1. PADDING RANDOM EXPLOSIF:
//      L'ancienne implémentation de padToTier appelait getRandomBytes() en
//      boucle avec des chunks de 64KB, mais en interne chaque chunk était
//      lui-même découpé en 64 appels de 1024 bytes vers Crypto.getRandomBytes
//      (limite expo-crypto). Pour le tier 16MB: 256 × 64 = 16 384 appels JSI.
//      → CORRIGÉ via fillRandomBytes (naclSetup.ts) qui utilise crypto.getRandomValues
//        (limite 64KB) directement en place. 16 384 → 256 appels.
//
//   2. DOUBLE ALLOCATION CIPHERTEXT + PADDED:
//      L'ancien code allouait `ciphertext` (taille X+16), puis `padded`
//      (taille tier), puis copiait ciphertext dans padded. Pour 16MB: deux
//      allocations distinctes + memcpy.
//      → CORRIGÉ: padToTier alloue UNE fois la taille tier puis copie
//        ciphertext + fillRandomBytes en place. Pas de copie supplémentaire.
//
//   3. THREAD JS BLOQUÉ:
//      nacl.secretbox sur 4-10MB d'image bloque le thread JS plusieurs
//      secondes (tweetnacl est pur JS). Pendant ce temps, l'UI freeze.
//      → CORRIGÉ: on yield au thread JS avant chaque opération lourde
//        (encryptBlob, padToTier, encodeBase64) via yieldToUI() pour que
//        React puisse rafraîchir l'overlay de progression et les indicateurs.
//
//   4. encryptBlob N'EST PLUS SYNCHRONE:
//      Avant: function encryptBlob(data) → EncryptedBlobResult
//      Après: async function encryptBlob(data) → Promise<EncryptedBlobResult>
//      Seul caller interne (encryptAndUploadBlob) est mis à jour.
// ============================================================================

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { getRandomBytes } from './crypto';
import { fillRandomBytes } from './naclSetup';
import { secureRpc } from './relayTransport';

// ============================================
// CONSTANTS
// ============================================

/**
 * Tiers de padding pour les blobs chiffrés.
 * Le blob est paddé au tier immédiatement supérieur → un observateur
 * ne peut pas deviner le type de contenu (image vs voix vs fichier).
 *
 * Distribution typique:
 *   Voix courte (20KB)   → 256KB
 *   Image compressée      → 256KB ou 1MB
 *   Voix longue (300KB)   → 1MB
 *   Image haute qualité   → 1MB ou 4MB
 *   Fichier moyen         → 4MB
 *   Gros fichier          → 16MB
 */
const BLOB_TIERS = [
  256 * 1024,       //  256 KB
  1 * 1024 * 1024,  //   1 MB
  4 * 1024 * 1024,  //   4 MB
  16 * 1024 * 1024, //  16 MB
];

/** Taille max acceptée (doit correspondre à la config Supabase bucket) */
const MAX_BLOB_SIZE = 20 * 1024 * 1024; // 20 MB

// ============================================
// UTILITAIRES
// ============================================

/**
 * Yield au thread JS pour laisser l'UI se rafraîchir entre deux étapes lourdes.
 * Sur iOS, ceci permet à React de redessiner l'overlay de progression et
 * aux gestes tactiles de rester réactifs pendant l'envoi d'un média.
 *
 * setTimeout(0) traverse la file de macrotasks, ce qui force un tick complet
 * de l'event loop (rendering, animations, gestes). Promise.resolve() ne
 * suffirait pas — elle reste dans la file microtask.
 */
function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ============================================
// ENCRYPTION
// ============================================

export interface EncryptedBlobResult {
  /** Blob chiffré paddé, prêt à uploader */
  paddedBlob: Uint8Array;
  /** Clé de chiffrement (32 bytes) — à transmettre dans le message E2E */
  key: Uint8Array;
  /** Nonce (24 bytes) — à transmettre dans le message E2E */
  nonce: Uint8Array;
  /** Taille du ciphertext AVANT padding — nécessaire pour unpad après download */
  ciphertextSize: number;
  /** Tier de padding utilisé */
  tier: number;
}

/**
 * Chiffre et padde des données pour upload anonyme.
 *
 * Pipeline: data → nacl.secretbox(key, nonce) → ciphertext → pad(tier) → blob
 *
 * Le padding utilise des bytes aléatoires (pas des zéros) pour que toute
 * compression au niveau transport ne puisse pas révéler la taille originale.
 *
 * v28.0: Async — yield au thread JS entre encryption et padding pour
 *        garder l'UI réactive pendant les transferts >1MB.
 */
export async function encryptBlob(data: Uint8Array): Promise<EncryptedBlobResult> {
  // Clé et nonce aléatoires (CSPRNG)
  const key = getRandomBytes(nacl.secretbox.keyLength); // 32 bytes
  const nonce = getRandomBytes(nacl.secretbox.nonceLength); // 24 bytes

  // Yield avant l'opération lourde (nacl.secretbox est pur JS)
  await yieldToUI();

  // Chiffrement XSalsa20-Poly1305 — bloquant ~100-500ms pour 1-10MB sur iOS
  const ciphertext = nacl.secretbox(data, nonce, key);
  if (!ciphertext) {
    throw new Error('[BlobService] Encryption failed');
  }

  // Yield avant le padding (lui aussi peut être lourd pour les gros tiers)
  await yieldToUI();

  // Padding au tier supérieur
  const tier = selectTier(ciphertext.length);
  const paddedBlob = padToTier(ciphertext, tier);

  return {
    paddedBlob,
    key,
    nonce,
    ciphertextSize: ciphertext.length,
    tier,
  };
}

/**
 * Déchiffre un blob téléchargé.
 *
 * Pipeline: paddedBlob → unpad(ciphertextSize) → nacl.secretbox.open → data
 *
 * Reste synchrone — la réception passe déjà par un setState async et le
 * volume traité ici est borné par l'image décodée que l'utilisateur regarde.
 */
export function decryptBlob(
  paddedBlob: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextSize: number
): Uint8Array {
  // Retirer le padding (subarray = zéro-copy)
  const ciphertext = paddedBlob.subarray(0, ciphertextSize);

  // Déchiffrement
  const data = nacl.secretbox.open(ciphertext, nonce, key);
  if (!data) {
    throw new Error('[BlobService] Decryption failed — invalid key, nonce, or corrupted data');
  }

  return data;
}

// ============================================
// PADDING
// ============================================

/**
 * Sélectionne le tier de padding ≥ taille du ciphertext.
 * Si aucun tier ne convient, arrondit au prochain multiple de 4MB.
 */
function selectTier(size: number): number {
  for (const tier of BLOB_TIERS) {
    if (size <= tier) return tier;
  }
  // Au-delà du plus grand tier: arrondir au prochain multiple de 4MB
  const BLOCK = 4 * 1024 * 1024;
  return Math.ceil(size / BLOCK) * BLOCK;
}

/**
 * Padde le ciphertext à exactement `tierSize` bytes avec des bytes aléatoires.
 * Les bytes aléatoires empêchent la compression HTTP / au stockage de
 * révéler la taille originale.
 *
 * v28.0: Une seule allocation (le buffer paddé final), pas de copie
 * intermédiaire. Le random est écrit DIRECTEMENT dans la queue du buffer
 * via fillRandomBytes(subarray) → un seul appel JSI par 64KB de padding.
 */
function padToTier(ciphertext: Uint8Array, tierSize: number): Uint8Array {
  if (ciphertext.length >= tierSize) {
    return ciphertext; // Déjà ≥ tier (ne devrait pas arriver)
  }

  // Une seule allocation: le buffer de la taille tier finale.
  const padded = new Uint8Array(tierSize);
  // Préfixe = ciphertext (memcpy natif via Uint8Array.set)
  padded.set(ciphertext, 0);

  // Queue = bytes aléatoires écrits EN PLACE.
  // fillRandomBytes utilise crypto.getRandomValues (1 appel natif / 64KB)
  // au lieu de la chaîne Crypto.getRandomBytes (1 appel natif / 1024B).
  // Gain pour le tier 16MB: ~64× moins d'appels au pont natif iOS.
  fillRandomBytes(padded.subarray(ciphertext.length));

  return padded;
}

// ============================================
// UPLOAD (via OHTTP relay → gateway → Supabase Storage)
// ============================================

/**
 * Génère un ID de blob anonyme (UUID v4-like, URL-safe).
 */
function generateBlobId(): string {
  const bytes = getRandomBytes(24);
  return encodeBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export interface UploadBlobResult {
  /** UUID du blob sur le storage */
  blobId: string;
  /** Clé de chiffrement (base64) — pour le message E2E */
  blobKey: string;
  /** Nonce (base64) — pour le message E2E */
  blobNonce: string;
  /** Taille du ciphertext avant padding — pour le message E2E */
  blobSize: number;
}

/**
 * Chiffre, padde, et uploade un blob anonyme via OHTTP relay.
 *
 * v27.0 (ACTION-03): Upload goes through OHTTP tunnel, not /storage/* proxy.
 * The CF Relay sees only an opaque encrypted OHTTP blob.
 * The gateway decrypts, extracts the blob data, and uploads to Supabase Storage.
 * → No single entity sees both IP and blob UUID.
 *
 * v28.0: Async encryptBlob + yield avant l'encodage base64 pour ne pas
 * bloquer le thread JS pendant l'envoi.
 *
 * @param data - Données brutes à chiffrer (Uint8Array)
 * @returns Métadonnées du blob pour inclusion dans le message E2E
 */
export async function encryptAndUploadBlob(data: Uint8Array): Promise<UploadBlobResult> {
  if (data.length > MAX_BLOB_SIZE) {
    throw new Error(`[BlobService] Data too large: ${Math.round(data.length / 1024 / 1024)}MB > ${MAX_BLOB_SIZE / 1024 / 1024}MB`);
  }

  // 1. Chiffrer + padder (async — yield JS thread entre étapes)
  const encrypted = await encryptBlob(data);

  __DEV__ && console.log(
    `[BlobService] 🔐 Encrypted: ${Math.round(data.length / 1024)}KB → ${Math.round(encrypted.ciphertextSize / 1024)}KB → padded to ${Math.round(encrypted.tier / 1024)}KB`
  );

  // 2. Yield avant l'encodage base64 (qui sur 16MB = ~21MB string en JS)
  await yieldToUI();

  // 3. Upload via OHTTP relay (v27.0: no more /storage/* proxy)
  const blobId = generateBlobId();
  const blobPath = `${blobId}.bin`;

  // Base64 encode the padded blob for JSON transport through OHTTP.
  // encodeBase64 sur 16MB ≈ 21.3MB string — opération lourde mais
  // inévitable car le tunnel OHTTP est JSON-based.
  const blobB64 = encodeBase64(encrypted.paddedBlob);

  // Yield juste avant le RPC réseau pour que les indicateurs UI se mettent
  // à jour avant que le thread JS ne soit absorbé par le NaCl box du RPC.
  await yieldToUI();

  const { error } = await secureRpc('upload_blob', {
    blob_data: blobB64,
    blob_path: blobPath,
    content_type: 'application/octet-stream',
  });

  if (error) {
    throw new Error(`[BlobService] Upload failed: ${error.message}`);
  }

  __DEV__ && console.log(`[BlobService] ✅ Uploaded blob ${blobId.slice(0, 12)}... via OHTTP (${Math.round(encrypted.tier / 1024)}KB)`);

  return {
    blobId,
    blobKey: encodeBase64(encrypted.key),
    blobNonce: encodeBase64(encrypted.nonce),
    blobSize: encrypted.ciphertextSize,
  };
}

// ============================================
// DOWNLOAD (via OHTTP relay → gateway → Supabase Storage)
// ============================================

/**
 * Télécharge et déchiffre un blob via OHTTP relay.
 *
 * v27.0 (ACTION-03): Download goes through OHTTP tunnel, not /storage/* proxy.
 * The gateway fetches the blob from Supabase Storage, base64-encodes it,
 * and sends it back through the encrypted OHTTP response.
 *
 * @param blobId - UUID du blob
 * @param blobKey - Clé de chiffrement (base64, du message E2E)
 * @param blobNonce - Nonce (base64, du message E2E)
 * @param blobSize - Taille du ciphertext avant padding
 * @returns Données déchiffrées (Uint8Array)
 */
export async function downloadAndDecryptBlob(
  blobId: string,
  blobKey: string,
  blobNonce: string,
  blobSize: number
): Promise<Uint8Array> {
  __DEV__ && console.log(`[BlobService] ⬇️ Downloading blob ${blobId.slice(0, 12)}... via OHTTP`);

  const blobPath = `${blobId}.bin`;

  // 1. Download via OHTTP relay (v27.0: no more /storage/* proxy)
  const { data: result, error } = await secureRpc('download_blob', {
    blob_path: blobPath,
  });

  if (error) {
    throw new Error(`[BlobService] Download failed: ${error.message}`);
  }

  if (!result || !(result as any).blob_data) {
    throw new Error('[BlobService] Download returned empty data');
  }

  // 2. Decode base64 blob from OHTTP response
  const paddedBlob = decodeBase64((result as any).blob_data);

  __DEV__ && console.log(
    `[BlobService] ⬇️ Downloaded ${Math.round(paddedBlob.length / 1024)}KB via OHTTP, ciphertext ${Math.round(blobSize / 1024)}KB`
  );

  // 3. Déchiffrer
  const key = decodeBase64(blobKey);
  const nonce = decodeBase64(blobNonce);

  const decrypted = decryptBlob(paddedBlob, key, nonce, blobSize);

  __DEV__ && console.log(`[BlobService] ✅ Decrypted: ${Math.round(decrypted.length / 1024)}KB`);

  // 4. Zéroiser la clé ET le nonce en mémoire (forward secrecy)
  key.fill(0);
  nonce.fill(0);

  return decrypted;
}

// ============================================
// CLEANUP (via OHTTP relay, best-effort)
// ============================================

/**
 * Supprime un blob du storage via OHTTP relay (best-effort).
 * En pratique, le gateway balaie le bucket toutes les 6 h et supprime les
 * blobs > 48 h via l'API Storage (ohttp-gateway/blobSweep.js).
 */
export async function deleteBlob(blobId: string): Promise<void> {
  try {
    const blobPath = `${blobId}.bin`;
    await secureRpc('delete_blob', { blob_path: blobPath });
    __DEV__ && console.log(`[BlobService] 🗑️ Deleted blob ${blobId.slice(0, 12)}... via OHTTP`);
  } catch {
    // Best-effort — le cron nettoiera
  }
}

// ============================================
// HELPERS EXPORT
// ============================================

/** Convertit base64 → Uint8Array (pour transformer les données base64 des médias) */
export function base64ToUint8Array(base64: string): Uint8Array {
  return decodeBase64(base64);
}

/** Convertit Uint8Array → base64 */
export function uint8ArrayToBase64(data: Uint8Array): string {
  return encodeBase64(data);
}

// ============================================
// P0-A2: REMPLACEMENT DE fetchMediaSecurely (legacyMediaProxy supprimé)
// ============================================

/**
 * Télécharge un média chiffré via le relay OHTTP.
 *
 * Remplace fetchMediaSecurely (legacyMediaProxy.ts, supprimé en P0-A2).
 * Toutes les URLs de médias pointent vers le bucket ghostr-blobs.
 * Le téléchargement passe par le tunnel OHTTP pour protéger l'IP.
 *
 * Fonctionnement:
 *   1. Parse l'URL pour extraire le chemin du blob dans le bucket
 *   2. Télécharge via secureRpc('download_blob') à travers le relay OHTTP
 *   3. Retourne les données brutes chiffrées (Uint8Array)
 *
 * @param url - URL du média (format Supabase: .../ghostr-blobs/<path>)
 * @returns Données chiffrées brutes (encore chiffrées avec la clé du fichier)
 */
export async function fetchMediaViaRelay(url: string): Promise<Uint8Array> {
  // Extraire le chemin du blob depuis l'URL Supabase Storage
  // Format: .../storage/v1/object/public/ghostr-blobs/<blobPath>
  // ou:     .../storage/v1/object/ghostr-blobs/<blobPath>
  const blobPath = extractBlobPathFromUrl(url);

  if (!blobPath) {
    // Fallback: URL non-Supabase ou format inconnu — ne devrait pas arriver
    // dans le flux normal, mais on log et on retente via fetch direct
    __DEV__ && console.warn(
      '[BlobService] ⚠️ Unrecognized URL, cannot route via OHTTP:',
      url.slice(0, 80)
    );
    throw new Error(
      `[BlobService] Unrecognized media URL. The /storage/* proxy has been removed. ` +
      `All URLs must point to ghostr-blobs. URL: ${url.slice(0, 80)}...`
    );
  }

  __DEV__ && console.log(
    `[BlobService] ⬇️ fetchMediaViaRelay: ${blobPath.slice(0, 30)}... via OHTTP`
  );

  const { data, error } = await secureRpc('download_blob', {
    blob_path: blobPath,
  });

  if (error) {
    throw new Error(`[BlobService] Download via OHTTP failed: ${error.message}`);
  }

  if (!data || !(data as any).blob_data) {
    throw new Error('[BlobService] Download returned empty data');
  }

  const mediaBytes = decodeBase64((data as any).blob_data);

  __DEV__ && console.log(
    `[BlobService] ✅ Downloaded ${Math.round(mediaBytes.length / 1024)}KB via OHTTP`
  );

  return mediaBytes;
}

/**
 * Extrait le chemin du blob depuis une URL Supabase Storage.
 *
 * @param url - URL complète (ex: https://relay.example.com/storage/v1/object/public/ghostr-blobs/abc/def.enc)
 * @returns Chemin du blob (ex: "abc/def.enc") ou null si non reconnu
 */
function extractBlobPathFromUrl(url: string): string | null {
  try {
    // Pattern 1: /ghostr-blobs/<path> (URL publique ou avec /public/)
    const match = url.match(/\/ghostr-blobs\/(.+)$/);
    if (match) {
      return decodeURIComponent(match[1]);
    }

    // Pattern 2: URL encodée (%2F au lieu de /)
    const matchEncoded = url.match(/\/ghostr-blobs%2F(.+)$/i);
    if (matchEncoded) {
      return decodeURIComponent(matchEncoded[1]);
    }

    return null;
  } catch {
    return null;
  }
}
