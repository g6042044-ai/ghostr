// src/services/mediaChunking.ts
// PHASE 1: Media Chunking Service — Indistinguishable Media Transfer
//
// PROBLÈME RÉSOLU:
//   Les médias (images, vocaux, fichiers) produisent des payloads de 64KB-1MB+
//   alors que les decoys font ~6KB. Un observateur passif peut:
//   1. Filtrer tous les messages >8KB → forcément vrais (jamais des decoys)
//   2. Déduire le TYPE de contenu par la taille
//   3. Compter les médias échangés par conversation
//
// SOLUTION (inspirée de Signal SPQR, Loopix, Wright et al. Traffic Morphing):
//   Fragmenter les médias en chunks de taille uniforme (~6KB), identiques
//   aux messages texte et aux decoys. Chaque chunk passe par le pipeline
//   complet (padding → Triple Ratchet → Sealed Sender → constant-rate slot).
//
// ARCHITECTURE:
//   Envoi:
//     1. Sérialiser l'InnerPayload média en JSON
//     2. Si taille > CHUNK_THRESHOLD → fragmenter en chunks de CHUNK_DATA_SIZE
//     3. Chaque chunk = InnerPayload de type 'media_chunk' avec métadonnées
//     4. Chunks enqueués un par un dans le constant-rate traffic
//
//   Réception:
//     1. Recevoir les chunks individuellement (type 'media_chunk')
//     2. Buffer d'assemblage par mediaId
//     3. Quand tous les chunks arrivent → reconstituer l'InnerPayload original
//     4. Traiter comme un message média normal
//
// PROPRIÉTÉS DE SÉCURITÉ:
//   - Chaque chunk fait ~6KB après padding → indistinguable d'un texte/decoy
//   - Pas de corrélation de taille entre chunks (padding uniforme)
//   - Chunks envoyés via constant-rate slots (timing indistinguable)
//   - Métadonnées média (fileName, mimeType, etc.) chiffrées E2E dans les chunks

import * as Crypto from 'expo-crypto';

// ============================================
// CONFIGURATION
// ============================================

/**
 * Seuil au-delà duquel un payload est fragmenté en chunks.
 * Correspond au palier de padding de 8KB (UNIFORM_PADDING_TIERS[1]).
 * Les payloads <= 8KB passent dans un seul message paddé à 8KB.
 * Les payloads > 8KB seraient paddés à 64KB+ → distinguables des decoys.
 *
 * En chunkant à partir de 8KB, on garantit que chaque chunk individuel
 * sera paddé au palier 2KB ou 8KB → indistinguable des textes et decoys.
 */
export const CHUNK_THRESHOLD_BYTES = 7 * 1024; // 7KB (avec marge pour overhead JSON)

/**
 * Taille des données par chunk.
 * Calculé pour que le chunk complet (header + data + padding) tienne dans
 * le palier 8KB après addUniformPadding().
 *
 * v25.1: Avatar supprimé des chunk wrappers → overhead réduit de ~550B à ~400B:
 *   ~190 bytes de structure JSON (clés, guillemets, accolades)
 *   + ~150 bytes de valeurs (fingerprint, displayName, mediaId, hash, etc.)
 *   + ~30 bytes de _senderHint
 *   + ~30 bytes de marge
 *   → ~400 bytes d'overhead
 *
 * Pour rester dans le palier 8KB de addUniformPadding (8192 - 20 wrapper = 8172):
 *   Max chunkData = 8172 - 400 = 7772 bytes
 *   On utilise 6400 pour garder une marge confortable.
 *
 * Impact: 211 chunks (ancien 4KB) → 135 chunks (6.4KB) = -36% de chunks.
 */
export const CHUNK_DATA_SIZE = 6400; // 6.4KB de données base64 par chunk

/**
 * Timeout d'assemblage (ms). Si tous les chunks ne sont pas arrivés
 * dans ce délai, le buffer est nettoyé et le message est marqué incomplet.
 */
export const ASSEMBLY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Nombre max de buffers d'assemblage simultanés (protection mémoire).
 */
const MAX_ASSEMBLY_BUFFERS = 20;

// ============================================
// TYPES
// ============================================

/**
 * En-tête d'un chunk média. Contenu dans l'InnerPayload.
 */
export interface MediaChunkHeader {
  /** UUID unique du média (partagé entre tous les chunks) */
  mediaId: string;
  /** Index du chunk (0-based) */
  chunkIndex: number;
  /** Nombre total de chunks */
  totalChunks: number;
  /** Données du chunk (base64 slice du payload original) */
  chunkData: string;
  /** Hash SHA-256 du payload complet (pour vérification d'intégrité) */
  payloadHash: string;
  /** Taille totale du payload original (bytes) pour vérification */
  totalPayloadSize: number;
}

/**
 * Buffer d'assemblage pour un média en cours de réception.
 */
interface AssemblyBuffer {
  /** UUID du média */
  mediaId: string;
  /** SessionId source */
  sessionId: string;
  /** Chunks reçus (indexés par chunkIndex) */
  chunks: Map<number, string>;
  /** Nombre total de chunks attendus */
  totalChunks: number;
  /** Hash SHA-256 attendu du payload complet */
  expectedHash: string;
  /** Taille totale attendue */
  expectedSize: number;
  /** Timestamp de création du buffer */
  createdAt: number;
  /** Timestamp du dernier chunk reçu */
  lastChunkAt: number;
}

/**
 * Résultat de l'assemblage d'un média.
 */
export interface AssemblyResult {
  /** true si le média est complet et vérifié */
  complete: boolean;
  /** Payload original reconstitué (si complet) */
  originalPayload?: string;
  /** Progression (0.0 - 1.0) */
  progress: number;
  /** Nombre de chunks reçus */
  receivedChunks: number;
  /** Nombre total de chunks attendus */
  totalChunks: number;
  /** Erreur éventuelle */
  error?: string;
}

// ============================================
// ÉTAT
// ============================================

/** Buffers d'assemblage actifs (mediaId → buffer) */
const assemblyBuffers = new Map<string, AssemblyBuffer>();

/** Timer de nettoyage périodique */
let cleanupTimerId: ReturnType<typeof setInterval> | null = null;

// ============================================
// CHUNKING (ENVOI)
// ============================================

/**
 * Génère un mediaId unique (UUID v4-like) avec CSPRNG.
 */
function generateMediaId(): string {
  const bytes = Crypto.getRandomBytes(16);
  // Format UUID v4
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Calcule le SHA-256 d'une string (pour vérification d'intégrité).
 */
async function hashPayload(data: string): Promise<string> {
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    new TextEncoder().encode(data)
  );
  // Crypto.digest retourne un ArrayBuffer sur expo-crypto
  // Convertir en hex string
  if (typeof digest === 'string') {
    return digest;
  }
  const bytes = new Uint8Array(digest as ArrayBuffer);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Détermine si un payload doit être chunké.
 *
 * @param payloadJson - Le JSON stringified de l'InnerPayload
 * @returns true si le payload dépasse le seuil de chunking
 */
export function shouldChunkPayload(payloadJson: string): boolean {
  return new TextEncoder().encode(payloadJson).length > CHUNK_THRESHOLD_BYTES;
}

/**
 * Fragmente un payload média en chunks de taille uniforme.
 *
 * Chaque chunk contient:
 * - Les métadonnées de routage (mediaId, index, total, hash)
 * - Un slice des données du payload original
 *
 * L'appelant doit ensuite wrapper chaque chunk dans un InnerPayload
 * de type 'media_chunk' et l'envoyer via sendInnerPayload().
 *
 * @param payloadJson - Le JSON stringified de l'InnerPayload original complet
 * @returns Un tableau de MediaChunkHeader, un par chunk
 */
export async function chunkPayload(payloadJson: string): Promise<MediaChunkHeader[]> {
  const mediaId = generateMediaId();
  const payloadHash = await hashPayload(payloadJson);
  const totalPayloadSize = payloadJson.length;

  // Découper le payload en slices de CHUNK_DATA_SIZE caractères
  const chunks: MediaChunkHeader[] = [];
  const totalChunks = Math.ceil(payloadJson.length / CHUNK_DATA_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_DATA_SIZE;
    const end = Math.min(start + CHUNK_DATA_SIZE, payloadJson.length);
    const chunkData = payloadJson.slice(start, end);

    chunks.push({
      mediaId,
      chunkIndex: i,
      totalChunks,
      chunkData,
      payloadHash,
      totalPayloadSize,
    });
  }

  __DEV__ && console.log(
    `[MediaChunking] 📦 Chunked payload: ${Math.round(totalPayloadSize / 1024)}KB → ${totalChunks} chunks of ~${CHUNK_DATA_SIZE}B (mediaId: ${mediaId.slice(0, 8)}...)`
  );

  return chunks;
}

// ============================================
// ASSEMBLAGE (RÉCEPTION)
// ============================================

/**
 * Démarre le nettoyage périodique des buffers expirés.
 * Appelé une fois au démarrage de l'app.
 */
export function startAssemblyCleanup(): void {
  if (cleanupTimerId) return;
  cleanupTimerId = setInterval(cleanupExpiredBuffers, 60_000); // Toutes les minutes
}

/**
 * Arrête le nettoyage périodique.
 */
export function stopAssemblyCleanup(): void {
  if (cleanupTimerId) {
    clearInterval(cleanupTimerId);
    cleanupTimerId = null;
  }
}

/**
 * Nettoie les buffers d'assemblage expirés.
 */
function cleanupExpiredBuffers(): void {
  const now = Date.now();
  const expiredIds: string[] = [];

  for (const [mediaId, buffer] of assemblyBuffers) {
    if (now - buffer.createdAt > ASSEMBLY_TIMEOUT_MS) {
      expiredIds.push(mediaId);
    }
  }

  for (const mediaId of expiredIds) {
    assemblyBuffers.delete(mediaId);
    __DEV__ && console.log(`[MediaChunking] 🗑️ Cleaned up expired buffer: ${mediaId.slice(0, 8)}...`);
  }

  // Protection mémoire: si trop de buffers, supprimer les plus anciens
  if (assemblyBuffers.size > MAX_ASSEMBLY_BUFFERS) {
    const sorted = [...assemblyBuffers.entries()]
      .sort((a, b) => a[1].lastChunkAt - b[1].lastChunkAt);
    const toRemove = sorted.slice(0, assemblyBuffers.size - MAX_ASSEMBLY_BUFFERS);
    for (const [mediaId] of toRemove) {
      assemblyBuffers.delete(mediaId);
      __DEV__ && console.log(`[MediaChunking] 🗑️ Evicted oldest buffer: ${mediaId.slice(0, 8)}...`);
    }
  }
}

/**
 * Traite un chunk reçu et tente l'assemblage.
 *
 * @param sessionId - Session d'origine
 * @param chunk - Le chunk reçu (MediaChunkHeader)
 * @returns AssemblyResult avec l'état de progression
 */
export async function processReceivedChunk(
  sessionId: string,
  chunk: MediaChunkHeader
): Promise<AssemblyResult> {
  const { mediaId, chunkIndex, totalChunks, chunkData, payloadHash, totalPayloadSize } = chunk;

  // Validation basique
  if (chunkIndex < 0 || chunkIndex >= totalChunks || totalChunks <= 0) {
    return {
      complete: false,
      progress: 0,
      receivedChunks: 0,
      totalChunks: 0,
      error: `Invalid chunk metadata: index=${chunkIndex}, total=${totalChunks}`,
    };
  }

  if (totalChunks > 1000) {
    return {
      complete: false,
      progress: 0,
      receivedChunks: 0,
      totalChunks,
      error: `Too many chunks: ${totalChunks} (max 1000)`,
    };
  }

  // Obtenir ou créer le buffer d'assemblage
  let buffer = assemblyBuffers.get(mediaId);
  if (!buffer) {
    buffer = {
      mediaId,
      sessionId,
      chunks: new Map(),
      totalChunks,
      expectedHash: payloadHash,
      expectedSize: totalPayloadSize,
      createdAt: Date.now(),
      lastChunkAt: Date.now(),
    };
    assemblyBuffers.set(mediaId, buffer);
    __DEV__ && console.log(
      `[MediaChunking] 📥 New assembly buffer: ${mediaId.slice(0, 8)}... (${totalChunks} chunks expected)`
    );
  }

  // Vérifier la cohérence
  if (buffer.totalChunks !== totalChunks || buffer.expectedHash !== payloadHash) {
    return {
      complete: false,
      progress: buffer.chunks.size / buffer.totalChunks,
      receivedChunks: buffer.chunks.size,
      totalChunks: buffer.totalChunks,
      error: 'Chunk metadata mismatch',
    };
  }

  // Vérifier que la session correspond
  if (buffer.sessionId !== sessionId) {
    return {
      complete: false,
      progress: 0,
      receivedChunks: 0,
      totalChunks,
      error: 'Session mismatch for media chunks',
    };
  }

  // Stocker le chunk (idempotent: remplace si déjà reçu)
  buffer.chunks.set(chunkIndex, chunkData);
  buffer.lastChunkAt = Date.now();

  const receivedChunks = buffer.chunks.size;
  const progress = receivedChunks / totalChunks;

  __DEV__ && console.log(
    `[MediaChunking] 📥 Chunk ${chunkIndex + 1}/${totalChunks} for ${mediaId.slice(0, 8)}... (${Math.round(progress * 100)}%)`
  );

  // Vérifier si l'assemblage est complet
  if (receivedChunks < totalChunks) {
    return {
      complete: false,
      progress,
      receivedChunks,
      totalChunks,
    };
  }

  // Assemblage !
  __DEV__ && console.log(`[MediaChunking] ✅ All ${totalChunks} chunks received for ${mediaId.slice(0, 8)}..., assembling...`);

  // Reconstituer le payload dans l'ordre
  const parts: string[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const part = buffer.chunks.get(i);
    if (!part) {
      return {
        complete: false,
        progress,
        receivedChunks,
        totalChunks,
        error: `Missing chunk ${i} despite count matching`,
      };
    }
    parts.push(part);
  }

  const originalPayload = parts.join('');

  // Vérifier la taille
  if (originalPayload.length !== totalPayloadSize) {
    __DEV__ && console.warn(
      `[MediaChunking] ⚠️ Size mismatch: expected ${totalPayloadSize}, got ${originalPayload.length}`
    );
    // Ne pas bloquer — tailles peuvent varier légèrement selon l'encodage
  }

  // Vérifier le hash d'intégrité
  const actualHash = await hashPayload(originalPayload);
  if (actualHash !== payloadHash) {
    assemblyBuffers.delete(mediaId);
    return {
      complete: false,
      progress: 1,
      receivedChunks,
      totalChunks,
      error: 'Integrity check failed: hash mismatch',
    };
  }

  // Succès — nettoyer le buffer
  assemblyBuffers.delete(mediaId);

  __DEV__ && console.log(
    `[MediaChunking] ✅ Assembly complete for ${mediaId.slice(0, 8)}...: ${Math.round(originalPayload.length / 1024)}KB reconstituted from ${totalChunks} chunks`
  );

  return {
    complete: true,
    originalPayload,
    progress: 1,
    receivedChunks,
    totalChunks,
  };
}

// ============================================
// PROGRESSION
// ============================================

/**
 * Retourne la progression d'un assemblage en cours.
 */
export function getAssemblyProgress(mediaId: string): { progress: number; received: number; total: number } | null {
  const buffer = assemblyBuffers.get(mediaId);
  if (!buffer) return null;
  return {
    progress: buffer.chunks.size / buffer.totalChunks,
    received: buffer.chunks.size,
    total: buffer.totalChunks,
  };
}

/**
 * Retourne les statistiques de tous les assemblages en cours.
 */
export function getAssemblyStats(): {
  activeBuffers: number;
  totalChunksBuffered: number;
  oldestBufferAge: number;
} {
  let totalChunks = 0;
  let oldestAge = 0;
  const now = Date.now();

  for (const buffer of assemblyBuffers.values()) {
    totalChunks += buffer.chunks.size;
    const age = now - buffer.createdAt;
    if (age > oldestAge) oldestAge = age;
  }

  return {
    activeBuffers: assemblyBuffers.size,
    totalChunksBuffered: totalChunks,
    oldestBufferAge: oldestAge,
  };
}

/**
 * Nettoie tous les buffers (pour reset/logout).
 */
export function clearAllAssemblyBuffers(): void {
  assemblyBuffers.clear();
  __DEV__ && console.log('[MediaChunking] 🗑️ All assembly buffers cleared');
}
