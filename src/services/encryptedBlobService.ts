// src/services/encryptedBlobService.ts
// v26.0: Encrypted Blob Storage — Replace chunking with direct blob upload
//
// ARCHITECTURE:
//   Upload: data → nacl.secretbox(random key) → pad to tier → upload via relay
//   Download: fetch via relay → unpad → nacl.secretbox.open(key) → data
//
// SÉCURITÉ:
//   • Chiffrement XSalsa20-Poly1305 côté client (clé aléatoire par blob)
//   • Padding à tiers fixes → masque le type de contenu
//   • Upload/download via CF Relay → IP cachée de Supabase
//   • Path = UUID aléatoire → aucun lien avec la session/conversation
//   • Clé de déchiffrement dans le message E2E → seul le destinataire peut lire
//   • TTL 48h → les blobs expirent automatiquement
//
// SPLIT-TRUST:
//   CF Relay:  voit l'IP du client, voit la TAILLE du blob, pas le contenu (TLS)
//   Supabase:  voit le blob chiffré, ne voit PAS l'IP du client
//   → Aucun tiers ne voit IP + contenu simultanément

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { getRandomBytes } from './crypto';
import { supabaseStorage, API_URL, SUPABASE_ANON_KEY } from './api';

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
// UPLOAD (via relay → Supabase Storage)
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
 * Chiffre, padde, et uploade un blob anonyme sur Supabase Storage via le relay.
 *
 * Le relay CF masque l'IP du client. Supabase ne voit qu'un blob opaque
 * avec un UUID aléatoire — aucun lien avec l'utilisateur ou la conversation.
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

  // 2. Upload via relay (supabaseStorage utilise API_URL = RELAY_URL)
  const blobId = generateBlobId();
  const blobPath = `${blobId}.bin`;

  const { error } = await supabaseStorage.storage
    .from(BLOB_BUCKET)
    .upload(blobPath, encrypted.paddedBlob, {
      contentType: 'application/octet-stream',
      cacheControl: '0', // Pas de cache — le blob expire
      upsert: false,
    });

  if (error) {
    throw new Error(`[BlobService] Upload failed: ${error.message}`);
  }

  __DEV__ && console.log(`[BlobService] ✅ Uploaded blob ${blobId.slice(0, 12)}... (${Math.round(encrypted.tier / 1024)}KB)`);

  return {
    blobId,
    blobKey: encodeBase64(encrypted.key),
    blobNonce: encodeBase64(encrypted.nonce),
    blobSize: encrypted.ciphertextSize,
  };
}

// ============================================
// DOWNLOAD (via relay → Supabase Storage)
// ============================================

/**
 * Télécharge et déchiffre un blob depuis Supabase Storage via le relay.
 *
 * Le download passe par le relay CF via fetch direct (API_URL + /storage/v1/object/).
 * ATTENTION: NE PAS utiliser supabaseStorage.storage.download() ni createSignedUrl() — 
 * .download() retourne un Blob sans .arrayBuffer() en React Native,
 * et createSignedUrl() génère une URL directe vers Supabase qui CONTOURNE le relay.
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
  __DEV__ && console.log(`[BlobService] ⬇️ Downloading blob ${blobId.slice(0, 12)}...`);

  // 1. Download via relay proxy (CF Worker /storage/* route)
  // CRITIQUE: NE PAS utiliser createSignedUrl() — la signed URL pointe
  // directement vers Supabase, CONTOURNANT le relay → fuite IP.
  // On fetch via API_URL (= relay) qui proxy vers Supabase.
  const blobPath = `${blobId}.bin`;
  const downloadUrl = `${API_URL}/storage/v1/object/${BLOB_BUCKET}/${blobPath}`;
  
  const response = await fetch(downloadUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`[BlobService] Download HTTP ${response.status}: ${response.statusText}`);
  }

  // 2. Convertir Response → Uint8Array (fetch Response a .arrayBuffer() en RN)
  const arrayBuffer = await response.arrayBuffer();
  const paddedBlob = new Uint8Array(arrayBuffer);

  __DEV__ && console.log(
    `[BlobService] ⬇️ Downloaded ${Math.round(paddedBlob.length / 1024)}KB, ciphertext ${Math.round(blobSize / 1024)}KB`
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
// CLEANUP (appelé depuis le client, optionnel)
// ============================================

/**
 * Supprime un blob du storage (après téléchargement par le destinataire).
 * En pratique, le cron job côté serveur nettoie les blobs > 48h.
 * Cette fonction est optionnelle (best-effort cleanup).
 */
export async function deleteBlob(blobId: string): Promise<void> {
  try {
    const blobPath = `${blobId}.bin`;
    await supabaseStorage.storage.from(BLOB_BUCKET).remove([blobPath]);
    __DEV__ && console.log(`[BlobService] 🗑️ Deleted blob ${blobId.slice(0, 12)}...`);
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
