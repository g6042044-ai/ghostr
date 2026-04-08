// src/services/encryptedBlobService.ts
// v27.0: Encrypted Blob Storage — OHTTP-only (ACTION-03 Phase 1 Security)
//
// ARCHITECTURE (v27.0 — CHANGED from v26.0):
//   Upload: data → nacl.secretbox(random key) → pad to tier → base64 → OHTTP relay → gateway → Supabase Storage
//   Download: OHTTP relay → gateway → Supabase Storage → base64 → unpad → nacl.secretbox.open → data
//
// v26.0 VULNERABILITY FIXED:
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

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { getRandomBytes } from './crypto';
import { secureRpc } from './relayTransport';

// ============================================
// CONSTANTS
// ============================================

/** Bucket Supabase pour les blobs anonymes chiffrés */
const BLOB_BUCKET = 'ghostr-blobs';

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
  256 * 1024,     //  256 KB
  1 * 1024 * 1024,  //   1 MB
  4 * 1024 * 1024,  //   4 MB
  16 * 1024 * 1024, //  16 MB
];

/** Taille max acceptée (doit correspondre à la config Supabase bucket) */
const MAX_BLOB_SIZE = 20 * 1024 * 1024; // 20 MB

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
 * Le padding utilise des bytes aléatoires (pas des zéros) pour que
 * la compression HTTP ne puisse pas révéler la taille originale.
 */
export function encryptBlob(data: Uint8Array): EncryptedBlobResult {
  // Clé et nonce aléatoires (CSPRNG)
  const key = getRandomBytes(nacl.secretbox.keyLength); // 32 bytes
  const nonce = getRandomBytes(nacl.secretbox.nonceLength); // 24 bytes

  // Chiffrement XSalsa20-Poly1305
  const ciphertext = nacl.secretbox(data, nonce, key);
  if (!ciphertext) {
    throw new Error('[BlobService] Encryption failed');
  }

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
 */
export function decryptBlob(
  paddedBlob: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextSize: number
): Uint8Array {
  // Retirer le padding
  const ciphertext = paddedBlob.slice(0, ciphertextSize);

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
 * Les bytes aléatoires empêchent la compression HTTP de révéler la taille originale.
 */
function padToTier(ciphertext: Uint8Array, tierSize: number): Uint8Array {
  if (ciphertext.length >= tierSize) {
    return ciphertext; // Déjà ≥ tier (ne devrait pas arriver)
  }

  const padded = new Uint8Array(tierSize);
  padded.set(ciphertext, 0);

  // Remplir le reste avec des bytes aléatoires
  const paddingSize = tierSize - ciphertext.length;
  // Générer le padding en blocs de 64KB (plus efficace)
  const CHUNK = 65536;
  for (let offset = ciphertext.length; offset < tierSize; offset += CHUNK) {
    const remaining = Math.min(CHUNK, tierSize - offset);
    const randomPad = getRandomBytes(remaining);
    padded.set(randomPad, offset);
  }

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
 * @param data - Données brutes à chiffrer (Uint8Array)
 * @returns Métadonnées du blob pour inclusion dans le message E2E
 */
export async function encryptAndUploadBlob(data: Uint8Array): Promise<UploadBlobResult> {
  if (data.length > MAX_BLOB_SIZE) {
    throw new Error(`[BlobService] Data too large: ${Math.round(data.length / 1024 / 1024)}MB > ${MAX_BLOB_SIZE / 1024 / 1024}MB`);
  }

  // 1. Chiffrer + padder
  const encrypted = encryptBlob(data);

  __DEV__ && console.log(
    `[BlobService] 🔐 Encrypted: ${Math.round(data.length / 1024)}KB → ${Math.round(encrypted.ciphertextSize / 1024)}KB → padded to ${Math.round(encrypted.tier / 1024)}KB`
  );

  // 2. Upload via OHTTP relay (v27.0: no more /storage/* proxy)
  const blobId = generateBlobId();
  const blobPath = `${blobId}.bin`;

  // Base64 encode the padded blob for JSON transport through OHTTP
  const blobB64 = encodeBase64(encrypted.paddedBlob);

  const { data: result, error } = await secureRpc('upload_blob', {
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
 * En pratique, le cron job côté serveur nettoie les blobs > 48h.
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
      '[BlobService] ⚠️ URL non reconnue, impossible de router via OHTTP:',
      url.slice(0, 80)
    );
    throw new Error(
      `[BlobService] URL de média non reconnue. Le proxy /storage/* a été supprimé. ` +
      `Toutes les URLs doivent pointer vers ghostr-blobs. URL: ${url.slice(0, 80)}...`
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