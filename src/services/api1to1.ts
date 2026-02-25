// src/services/api1to1.ts
// Service de transport complet pour conversations 1-à-1 avec Triple Ratchet
// Version 4.0 - Support complet: texte, images, fichiers, vocaux, réactions, accusés
//
// FONCTIONNALITÉS:
// ✅ Messages texte avec padding
// ✅ Images (thumbnail + données chiffrées)
// ✅ Fichiers (métadonnées + données chiffrées)
// ✅ Messages vocaux (audio + durée)
// ✅ Réactions emoji
// ✅ Accusés de lecture (delivered/read)
// ✅ Réponses à des messages
// ✅ K-anonymity avec decoys
// ✅ Polling optimisé

// Audit Fix M-02: L'import direct de supabase a été supprimé.
// Toutes les opérations passent par secureRpc() via le relay OHTTP.
import {
  // V2: Triple Ratchet avec protection post-quantique
  sessionService,
  StoredSession,
  encodeBase64,
  decodeBase64,
} from './tripleRatchet';
import { LocalMessage } from './storage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from './crypto';
import { encryptIfEnabled, decryptIfNeeded, isEncryptionEnabled } from './localCrypto';
import { sendSingleDecoy, sendSingleDecoyMediumTier, generateSizedPayload } from './decoyService';
import { shouldChunkPayload, chunkPayload, processReceivedChunk, startAssemblyCleanup, stopAssemblyCleanup, clearAllAssemblyBuffers, MediaChunkHeader } from './mediaChunking';
import {
  reportChunkingSendStart,
  reportChunkingSendProgress,
  reportChunkingSendComplete,
  reportChunkingSendError,
  reportChunkingReceiveProgress,
  reportChunkingReceiveComplete,
  startProgressCleanup,
  stopProgressCleanup,
} from './chunkingProgress';
import { requirePinningOrThrow } from './networkSecurity';
import { startConstantTraffic, stopConstantTraffic, enqueueMessage, getPollGeneration } from './constantTraffic';
// Audit Fix C-01: Sealed Sender
import { isSealedSenderReady, createSealedSenderEnvelope, bootstrapSealedSender, invalidateSenderCertificate, SenderCertificate } from './sealedSender';
import { secureRpc } from './relayTransport';
// v20.0: SHA-256 pour le tag de session (remplace XOR faible)
import { sha256 } from '@noble/hashes/sha256';
import * as Crypto from 'expo-crypto';
import { externalizeMedia, migrateMessagesToFileStore, clearAllMediaFiles } from './mediaFileStore';
// PHASE 1: Epoch tags (rotation 5min) — legacy
// ACTION 3: Tags directionnels asymétriques avec rotation 24h
import {
  deriveTagSeed,
  getDirectionalSendTag,
  getDirectionalReceiveTags,
  generateDecoyTagsForEpoch,
  getEpochNumber,
  csprngShuffle as csprngShuffleArray,
} from './epochTags';
// v26.0: Service de relai pour polling des pending session tags

// ============================================
// CONSTANTES
// ============================================

const MESSAGES_1TO1_PREFIX = 'ghostr_1to1_messages_';
const LAST_POLL_PREFIX = 'ghostr_1to1_lastpoll_';
const PROCESSED_IDS_PREFIX = 'ghostr_1to1_processed_';
const STATUS_PREFIX = 'ghostr_1to1_status_';
const UNREAD_COUNT_PREFIX = 'ghostr_1to1_unread_'; // v6.1: Compteur messages non lus

// Padding pour messages normaux (texte, réactions, accusés)
// ACTION 18: PADDED_MESSAGE_SIZE supprimé — remplacé par UNIFORM_PADDING_TIERS (voir addUniformPadding)
// Padding pour médias (images, fichiers, vocaux) - plus grand
const PADDED_MEDIA_SIZE = 1024 * 1024; // 1MB max inline

// ============================================
// STOCKAGE LOCAL CHIFFRÉ
// ============================================

/**
 * Lecture AsyncStorage avec déchiffrement transparent.
 * Rétrocompatible: données en clair (sans préfixe enc1:) retournées telles quelles.
 * FAIL-SAFE: si le déchiffrement échoue pour quelque raison que ce soit,
 * retourne null au lieu de throw (le caller gère null comme "pas de données").
 */
async function secureGet(key: string): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    try {
      if (raw.startsWith('enc1:') && !isEncryptionEnabled()) {
        return null; // Clé pas encore disponible (startup avant unlock)
      }
      return decryptIfNeeded(raw);
    } catch {
      // Déchiffrement échoué: donnée corrompue ou clé invalide
      // Retourner null pour que le caller utilise ses valeurs par défaut
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Écriture AsyncStorage avec chiffrement transparent.
 * FIX 0.4: Si le chiffrement échoue, on lève une erreur au lieu de stocker en clair.
 * Mieux vaut perdre une donnée que la stocker en clair sur un device potentiellement saisi.
 */
async function secureSet(key: string, value: string): Promise<void> {
  const encrypted = encryptIfEnabled(value);
  await AsyncStorage.setItem(key, encrypted);
}

// ============================================
// TYPES DE MESSAGES
// ============================================

export type MessageType = 
  | 'text' 
  | 'image' 
  | 'file' 
  | 'voice' 
  | 'media_ref'      // v26.0: Référence vers un blob chiffré sur le storage
  | 'reaction' 
  | 'read_receipt' 
  | 'delivered_receipt'
  | 'typing'
  | 'call_signal'  // v5.0: Signaux d'appel vocal
  | 'call'         // v7.0: Message "Appel terminé"
  | 'handshake_ack'    // Accusé de réception du handshake
  | 'media_chunk';     // v25.0: Legacy — réception uniquement (backward compat)

// v20.0: Types de messages de protocole à ne jamais afficher dans l'UI
const PROTOCOL_MESSAGE_TYPES: MessageType[] = [
  'handshake_ack',
  'media_chunk', // v25.0: Chunks intermédiaires masqués — seul le média assemblé est affiché
];

export interface Message1to1 {
  id: string;
  sessionId: string;
  content: string;
  timestamp: number;
  isMine: boolean;
  displayName: string;
  senderAvatarBase64?: string; // v6.0: Avatar de l'expéditeur
  senderFingerprint?: string;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'; // v23.0: Added 'sending' and 'failed'
  
  // Type de message
  messageType?: MessageType;
  
  // Pour images
  imageData?: string; // Base64
  thumbnailData?: string; // Base64 thumbnail
  imageWidth?: number;
  imageHeight?: number;
  
  // Pour fichiers
  fileData?: string; // Base64
  fileName?: string;
  fileSize?: number;
  fileMimeType?: string;
  
  // Pour vocaux
  voiceData?: string; // Base64
  voiceDuration?: number; // en secondes
  
  // Pour réactions
  targetMessageId?: string;
  emoji?: string;
  
  // Pour réponses
  replyToId?: string;
  replyToContent?: string;
  replyToSender?: string;
  
  // IDs des messages lus (pour read_receipt)
  readMessageIds?: string[];
  
  // v5.0: Pour signaux d'appel (via SFU double-hop)
  callSignalType?: 'offer' | 'answer' | 'senderkey' | 'hangup' | 'decline' | 'busy' | 'crypto';
  callId?: string;
  roomTag?: string; // Tag de la room SFU
  authToken?: string; // Token d'auth pour la room SFU
  senderKeyDistribution?: string; // JSON stringified SenderKeyDistribution
  cryptoSignal?: string; // v8.0: Signal crypto Audio Triple Ratchet (JSON stringified)
  callStartedAt?: number; // Timestamp de début pour synchroniser les chronos
  
  // v26.0: Blob Storage — Référence vers un média chiffré sur le storage
  // Présent quand le média n'a pas encore été téléchargé.
  // Après téléchargement, imageData/fileData/voiceData sont remplis et blobId supprimé.
  blobId?: string;       // UUID du blob sur Supabase Storage
  blobKey?: string;      // Clé de déchiffrement (base64 XSalsa20-Poly1305)
  blobNonce?: string;    // Nonce (base64)
  blobSize?: number;     // Taille du ciphertext avant padding
  blobMediaType?: 'image' | 'file' | 'voice'; // Type de média original
  
}

// Structure du payload INTERNE (chiffré)
interface InnerPayload {
  // Commun
  type: MessageType;
  content: string;
  senderFingerprint: string;
  displayName: string;
  senderAvatarBase64?: string; // v6.0: Avatar de l'expéditeur
  timestamp: number;
  messageId: string;
  
  // Images
  imageData?: string;
  thumbnailData?: string;
  imageWidth?: number;
  imageHeight?: number;
  
  // Fichiers
  fileData?: string;
  fileName?: string;
  fileSize?: number;
  fileMimeType?: string;
  
  // Vocaux
  voiceData?: string;
  voiceDuration?: number;
  
  // Réactions
  targetMessageId?: string;
  emoji?: string;
  
  // Réponses
  replyToId?: string;
  replyToContent?: string;
  replyToSender?: string;
  
  // Accusés
  readMessageIds?: string[];
  
  // v5.0: Signaux d'appel (via SFU double-hop)
  callSignalType?: 'offer' | 'answer' | 'senderkey' | 'hangup' | 'decline' | 'busy' | 'crypto';
  callId?: string;
  roomTag?: string;
  authToken?: string;
  senderKeyDistribution?: string;
  cryptoSignal?: string; // v8.0: Signal crypto pour Audio Triple Ratchet (JSON stringified)
  
  // v7.0: Message "Appel terminé"
  callStatus?: 'ended' | 'missed' | 'declined' | 'cancelled';
  callDuration?: number; // En secondes
  callStartedAt?: number;
  callEndedAt?: number;
  
  // v25.0: Legacy Media Chunking — réception uniquement (backward compat v25.x)
  mediaId?: string;
  chunkIndex?: number;
  totalChunks?: number;
  chunkData?: string;
  payloadHash?: string;
  totalPayloadSize?: number;
  
  // v26.0: Encrypted Blob Storage — référence vers un média chiffré hors-bande
  // Remplace le chunking pour l'envoi. Le message ne contient que la référence
  // (~200B) au lieu du média inline (200KB-10MB). Le blob est sur Supabase Storage.
  blobId?: string;        // UUID du blob
  blobKey?: string;       // Clé de déchiffrement (base64)
  blobNonce?: string;     // Nonce (base64)
  blobSize?: number;      // Taille ciphertext avant padding
  blobMediaType?: 'image' | 'file' | 'voice'; // Type de média
  
}


interface ServerMessage {
  id: string;
  tag: string;
  sealed_payload: string;
  created_at: string;
}

interface SealedPayload {
  type: string;
  version?: number;
  data: string;
  // v20.0: senderHint remplace senderFingerprint pour l'anonymat
  // C'est un hash opaque qui permet de filtrer nos propres messages
  // sans révéler notre identité au serveur
  senderHint?: string;
  senderFingerprint?: string; // Deprecated, gardé pour compatibilité
}

// ============================================
// PADDING FUNCTIONS
// ============================================

/**
 * ACTION 18 (Audit Fix): Padding UNIFORME par paliers pour TOUS les messages.
 *
 * PROBLÈME CORRIGÉ:
 *   L'ancien code utilisait addPadding() (cible fixe 2048) pour le texte et
 *   addMediaPadding() (paliers 64KB/256KB/1MB) pour les médias.
 *   → Le serveur voyait ~4KB pour un texte vs ≥64KB pour un média
 *   → Fuite du TYPE de message par analyse de taille.
 *
 * SOLUTION:
 *   Un SEUL jeu de paliers pour texte ET média. Un message texte court (200B)
 *   et une petite image (1.5KB) produisent le même payload de 4KB.
 *   Seuls les très gros médias (>64KB) sont distinguables, ce qui est
 *   inévitable sans overhead réseau inacceptable.
 *
 * Paliers unifiés:
 *   0 - 2 KB      → 2 KB     (texte court, ACK, signaux)
 *   2 - 8 KB      → 8 KB     (texte long, petits médias)
 *   8 - 64 KB     → 64 KB    (images compressées, vocaux courts)
 *   64 - 256 KB   → 256 KB   (images HD, vocaux longs)
 *   256 KB - 1 MB  → 1 MB    (vidéos courtes)
 *   > 1 MB         → prochain multiple de 1 MB
 */
const UNIFORM_PADDING_TIERS = [
  2 * 1024,      // 2 KB
  8 * 1024,      // 8 KB
  64 * 1024,     // 64 KB
  256 * 1024,    // 256 KB
  1024 * 1024,   // 1 MB
];

function addUniformPadding(data: string): string {
  const dataBytes = new TextEncoder().encode(data);
  const currentSize = dataBytes.length;

  // Trouver le palier cible (même logique pour texte ET média)
  let targetSize: number;
  const matchedTier = UNIFORM_PADDING_TIERS.find(tier => currentSize <= tier);
  if (matchedTier) {
    targetSize = matchedTier;
  } else {
    // > 1MB: prochain multiple de 1MB
    const MB = 1024 * 1024;
    targetSize = Math.ceil(currentSize / MB) * MB;
  }

  const wrapperOverhead = 20; // {"d":"...","p":"..."}
  const targetDataSize = targetSize - wrapperOverhead;

  if (currentSize >= targetDataSize) {
    return JSON.stringify({ d: data, p: '' });
  }

  const paddingSize = targetDataSize - currentSize;
  // Générer du padding aléatoire en chunks (getRandomBytes limité à 1024 sur expo-crypto)
  const paddingBytes = getRandomBytes(Math.min(Math.ceil(paddingSize / 2), 65536));
  // Répéter le base64 si nécessaire pour atteindre la taille voulue
  let padding = encodeBase64(paddingBytes);
  while (padding.length < paddingSize) {
    padding += encodeBase64(getRandomBytes(Math.min(1024, Math.ceil((paddingSize - padding.length) / 2))));
  }
  padding = padding.slice(0, paddingSize);

  return JSON.stringify({ d: data, p: padding });
}

function removePadding(paddedData: string): string {
  try {
    const parsed = JSON.parse(paddedData);
    return parsed.d || paddedData;
  } catch {
    return paddedData;
  }
}

// ============================================
// v25.1: AVATAR-ON-CHANGE — Ne transmet l'avatar que si modifié
// ============================================
//
// PROBLÈME RÉSOLU:
//   Avant: chaque InnerPayload contenait senderAvatarBase64 (~18KB).
//   → Un texte "hello" (500B) + avatar (18KB) = 18.5KB → tier 64KB → sealed ~88KB
//   → Les decoys font ~16KB → 100% distinguable
//   → Les chunks portaient aussi l'avatar → 256KB chacun au lieu de 48KB
//
// SOLUTION:
//   L'avatar n'est inclus que si son hash a changé depuis le dernier envoi
//   à ce contact. Côté réception, updateContactProfile() met en cache l'avatar.
//   → 99% des messages font <2KB → tier 2KB → sealed ~16KB → match decoy small ✅
//   → Les chunks font ~4.6KB → tier 8KB → sealed ~48KB → match decoy medium ✅

/** Cache du dernier hash d'avatar envoyé par session */
const avatarHashCache = new Map<string, string>();

/** Calcule un hash court de l'avatar pour comparaison rapide */
function computeAvatarHash(avatarBase64: string): string {
  // Utilise les 32 premiers + 32 derniers chars + longueur comme fingerprint rapide
  // Pas besoin de SHA-256 complet: c'est juste pour détecter les changements
  const len = avatarBase64.length;
  if (len < 64) return avatarBase64;
  return `${len}:${avatarBase64.slice(0, 32)}:${avatarBase64.slice(-32)}`;
}

/**
 * Détermine si l'avatar doit être inclus dans le payload pour cette session.
 * Retourne l'avatar si changé, undefined sinon.
 * 
 * Cas spéciaux:
 *   - Pas d'avatar → toujours undefined
 *   - Première fois pour cette session → inclure (le contact n'a pas encore l'avatar)
 *   - Avatar changé → inclure
 *   - Avatar identique → ne pas inclure (le contact l'a déjà)
 */
function getAvatarIfChanged(sessionId: string, avatarBase64?: string): string | undefined {
  if (!avatarBase64) return undefined;
  
  const currentHash = computeAvatarHash(avatarBase64);
  const lastHash = avatarHashCache.get(sessionId);
  
  if (lastHash === currentHash) {
    // Avatar inchangé → ne pas envoyer
    return undefined;
  }
  
  // Avatar changé (ou premier envoi) → inclure et mettre à jour le cache
  avatarHashCache.set(sessionId, currentHash);
  return avatarBase64;
}

/**
 * v25.1: Nettoie le payload avant sérialisation.
 * 
 * 1. Chunks: JAMAIS d'avatar (il est dans le payload original chunké)
 * 2. media_ref: JAMAIS d'avatar (thumbnail déjà inclus, budget serré)
 * 3. Messages normaux: avatar seulement si changé
 * 4. Messages locaux (display): ne passe PAS par ici
 */
function stripAvatarForWire(sessionId: string, payload: InnerPayload): InnerPayload {
  // Les chunks ne portent JAMAIS l'avatar
  // L'avatar est dans le payload ORIGINAL qui est slicé en chunkData
  if (payload.type === 'media_chunk') {
    const { senderAvatarBase64, ...rest } = payload;
    return rest as InnerPayload;
  }
  
  // media_ref ne porte JAMAIS l'avatar: le thumbnail + blob refs occupent
  // déjà ~5-30KB du budget. L'avatar (~14KB) pousserait au-delà du guard 64KB.
  // L'avatar sera transmis avec le prochain message léger (texte, réaction, receipt).
  if (payload.type === 'media_ref') {
    const { senderAvatarBase64, ...rest } = payload;
    return rest as InnerPayload;
  }
  
  // Messages normaux: avatar-on-change
  const avatarToSend = getAvatarIfChanged(sessionId, payload.senderAvatarBase64);
  if (avatarToSend === payload.senderAvatarBase64) {
    return payload; // Inchangé (avatar inclus car premier envoi ou changé)
  }
  
  // Remplacer par undefined (strip)
  return { ...payload, senderAvatarBase64: avatarToSend };
}

/** Reset le cache avatar (logout/reset) */
function clearAvatarHashCache(): void {
  avatarHashCache.clear();
}

// ============================================
// UTILITAIRES
// ============================================

function generateAnonymousDeviceId(): string {
  return encodeBase64(getRandomBytes(16));
}

/**
 * Ajoute un jitter de ±30% à un intervalle pour éviter le fingerprinting temporel.
 * Utilise CSPRNG pour que le jitter soit imprévisible.
 */
function jitteredInterval(baseMs: number): number {
  const byte = getRandomBytes(1)[0]; // 0-255
  // Convertir en facteur entre 0.70 et 1.30
  const factor = 0.70 + (byte / 255) * 0.60;
  return Math.round(baseMs * factor);
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Array.from(Crypto.getRandomBytes(6)).map(b => b.toString(36)).join('').substring(0, 8)}`;
}

/**
 * v20.0: Génère un tag de session avec SHA-256 (remplace XOR faible)
 * Le tag est dérivé des deux fingerprints triés, rendant impossible
 * la reconstruction sans connaître les deux fingerprints
 */
export function generateSessionTag(session: StoredSession): string {
  const parts = [
    session.myIdentityKeyFingerprint,
    session.theirIdentityKeyFingerprint,
  ].sort();
  
  const combined = parts.join(':');
  const bytes = new TextEncoder().encode(combined);
  
  // v20.0: Utiliser SHA-256 au lieu de XOR simple
  const hash = sha256(bytes);
  
  // Prendre les 16 premiers bytes (32 caractères hex)
  return Array.from(hash.slice(0, 16))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function getSessionTag(session: StoredSession): string {
  return session.tag || generateSessionTag(session);
}

// ============================================
// GESTION DES IDs TRAITÉS
// ============================================

// Cache mémoire synchrone des IDs envoyés — consulté AVANT AsyncStorage
// Résout la race condition: poll récupère notre propre message avant que
// markIdAsProcessed ait fini d'écrire dans AsyncStorage
const recentlySentIds = new Set<string>();

// Cache mémoire de TOUS les IDs traités (envoyés + reçus) — empêche le
// batch poll et le session poll de traiter le même message en parallèle.
// Peuplé immédiatement AVANT le déchiffrement, vérifié par les deux polls.
const inFlightOrProcessedIds = new Set<string>();

async function getProcessedIds(sessionId: string): Promise<Set<string>> {
  try {
    const key = PROCESSED_IDS_PREFIX + sessionId;
    const stored = await secureGet(key);
    const ids = stored ? new Set(JSON.parse(stored) as string[]) : new Set<string>();
    // Fusionner le cache mémoire synchrone
    for (const id of recentlySentIds) ids.add(id);
    return ids;
  } catch {
    return new Set(recentlySentIds);
  }
}

async function markIdAsProcessed(sessionId: string, messageId: string): Promise<void> {
  // Synchrone — visible immédiatement par les polls concurrents
  recentlySentIds.add(messageId);
  inFlightOrProcessedIds.add(messageId);
  
  // Limiter la taille des caches mémoire
  if (recentlySentIds.size > 200) {
    const first = recentlySentIds.values().next().value;
    if (first) recentlySentIds.delete(first);
  }
  if (inFlightOrProcessedIds.size > 500) {
    const first = inFlightOrProcessedIds.values().next().value;
    if (first) inFlightOrProcessedIds.delete(first);
  }
  
  try {
    const key = PROCESSED_IDS_PREFIX + sessionId;
    const ids = await getProcessedIds(sessionId);
    ids.add(messageId);
    
    const idsArray = Array.from(ids);
    if (idsArray.length > 1000) {
      idsArray.splice(0, idsArray.length - 1000);
    }
    
    await secureSet(key, JSON.stringify(idsArray));
  } catch (error) {
    console.error('[api1to1] Error marking ID as processed:', error);
  }
}

// ============================================
// GESTION DES STATUTS DE MESSAGES
// ============================================

async function getMessageStatuses(sessionId: string): Promise<Map<string, string>> {
  try {
    const key = STATUS_PREFIX + sessionId;
    const stored = await secureGet(key);
    if (!stored) return new Map();
    return new Map(JSON.parse(stored));
  } catch {
    return new Map();
  }
}

async function setMessageStatus(
  sessionId: string, 
  messageId: string, 
  status: 'sent' | 'delivered' | 'read'
): Promise<void> {
  try {
    const key = STATUS_PREFIX + sessionId;
    const statuses = await getMessageStatuses(sessionId);
    statuses.set(messageId, status);
    
    // Garder seulement les 500 derniers
    const entries = Array.from(statuses.entries());
    if (entries.length > 500) {
      entries.splice(0, entries.length - 500);
    }
    
    await secureSet(key, JSON.stringify(entries));
  } catch (error) {
    console.error('[api1to1] Error setting message status:', error);
  }
}

// ============================================
// ENVOI DE MESSAGES - FONCTION GÉNÉRIQUE
// ============================================

async function sendInnerPayload(
  sessionId: string,
  innerPayload: InnerPayload,
  priority: 'normal' | 'urgent' | 'deferred' = 'normal'
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    __DEV__ && console.log('[api1to1] 📤 sendInnerPayload START');
    __DEV__ && console.log('[api1to1] Type:', innerPayload.type);
    
    // FIX 0.5: Vérifier le cert pinning avant tout envoi réseau
    try { requirePinningOrThrow(); } catch (e: any) {
      console.error('[api1to1] 🚨 SECURITY:', e.message);
      return { success: false, error: e.message };
    }
    
    const session = sessionService.getSession(sessionId);
    if (!session) {
      console.error('[api1to1] ❌ Session not found:', sessionId.slice(0, 12) + '...');
      return { success: false, error: 'Session not found' };
    }
    __DEV__ && console.log('[api1to1] ✅ Session found');
    
    // v25.1: Strip avatar sauf si changé (économise ~18KB par message)
    const wirePayload = stripAvatarForWire(sessionId, innerPayload);
    const payloadJson = JSON.stringify(wirePayload);
    __DEV__ && console.log('[api1to1] Payload JSON size:', payloadJson.length, 'bytes');
    
    // =========================================================
    // v26.0: PLUS DE CHUNKING
    //
    // Les médias (images, fichiers, vocaux) sont désormais uploadés
    // comme des blobs chiffrés sur Supabase Storage AVANT d'arriver ici.
    // Le message ne contient qu'une référence (~200-5000B selon thumbnail).
    //
    // Tous les payloads transitant ici sont petits:
    //   - Texte: ~200B
    //   - media_ref sans thumbnail: ~300B
    //   - media_ref avec thumbnail: ~5KB
    //   - Réactions, receipts: ~100B
    //
    // Guard de sécurité: rejeter les payloads > 32KB (ne devrait pas arriver)
    // =========================================================
    if (payloadJson.length > 32768) {
      console.error(`[api1to1] ❌ Payload too large for message channel: ${Math.round(payloadJson.length / 1024)}KB. Use blob storage for media.`);
      return { success: false, messageId: innerPayload.messageId, error: 'Payload too large — media should use blob storage' };
    }
    
    // =========================================================
    // Pipeline: padding → encrypt → seal → enqueue
    // v25.1: wirePayload a déjà l'avatar strippé si inchangé
    // =========================================================
    return await sendSingleChunk(sessionId, wirePayload, session, priority);
    
  } catch (error) {
    console.error('[api1to1] ❌ sendInnerPayload EXCEPTION:', error);
    // v25.1: Invalider le cache avatar pour cette session
    // Si c'était le premier envoi (avatar inclus), le destinataire ne l'a pas reçu.
    // Le retry doit re-inclure l'avatar.
    avatarHashCache.delete(sessionId);
    return { success: false, error: String(error) };
  }
}

/**
 * v25.0: Prépare un chunk pour envoi SANS l'enqueuer.
 *
 * Effectue le pipeline complet (hint → padding → encrypt → seal) et retourne
 * la fonction RPC prête à être enqueued dans le constantTraffic.
 *
 * IMPORTANT: Le chiffrement Triple Ratchet AVANCE le ratchet state.
 * Cette fonction DOIT être appelée séquentiellement pour chaque chunk
 * (l'ordre des chunks détermine l'ordre du ratchet).
 *
 * @returns La fonction RPC, ou null en cas d'erreur
 */
async function prepareChunkRpcFunction(
  sessionId: string,
  innerPayload: InnerPayload,
  session: StoredSession
): Promise<(() => Promise<any>) | null> {
  try {
    // senderHint
    const seed = deriveTagSeed(
      session.myIdentityKeyFingerprint,
      session.theirIdentityKeyFingerprint
    );
    const tag = getDirectionalSendTag(seed, session.myIdentityKeyFingerprint, session.theirIdentityKeyFingerprint);
    
    const _hintInput = new TextEncoder().encode(session.myIdentityKeyFingerprint + ':' + tag);
    const _hintHash = sha256(_hintInput);
    const _senderHint = Array.from(_hintHash.slice(0, 8))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    const payloadWithHint = { ...innerPayload, _senderHint };
    const payloadJsonWithHint = JSON.stringify(payloadWithHint);
    
    // Padding uniforme
    const paddedPayload = addUniformPadding(payloadJsonWithHint);
    
    // Chiffrement Triple Ratchet (fait avancer le ratchet — DOIT être séquentiel)
    const encryptedJson = await sessionService.encryptMessageForSession(sessionId, paddedPayload);
    
    // Enveloppe v3
    const sealedPayload: SealedPayload = {
      type: 'triple_ratchet_v3',
      version: 3,
      data: encryptedJson,
    };
    const sealedPayloadStr = JSON.stringify(sealedPayload);
    
    // Sealed Sender — attendre le bootstrap (PoW + certificat)
    if (!isSealedSenderReady()) {
      const ready = await Promise.race([
        ensureSealedSenderBootstrap(),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 45000)),
      ]);
      if (!ready) return null;
    }
    
    const envelope = createSealedSenderEnvelope(tag, sealedPayloadStr);
    
    // Retourner la fonction RPC SANS l'exécuter
    return async () => {
      const result = await secureRpc('send_sealed_message', {
        p_tag: envelope.tag,
        p_sealed_content: envelope.sealedContent,
        p_version: envelope.version,
      });
      if (result.data?.[0]?.id) {
        recentlySentIds.add(result.data[0].id);
        await markIdAsProcessed(sessionId, result.data[0].id);
      }
      return result;
    };
    
  } catch (error) {
    console.error('[api1to1] ❌ prepareChunkRpcFunction error:', error);
    return null;
  }
}

/**
 * Envoie un seul payload (chunk ou message complet) via le pipeline complet.
 * Fonction interne extraite de l'ancien sendInnerPayload monolithique.
 *
 * Pipeline: senderHint → padding uniforme → Triple Ratchet → Sealed Sender → constant-rate slot
 */
async function sendSingleChunk(
  sessionId: string,
  innerPayload: InnerPayload,
  session: StoredSession,
  priority: 'normal' | 'urgent' | 'deferred' = 'normal'
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const payloadJson = JSON.stringify(innerPayload);
    
    // FIX 0.2: Injecter le _senderHint DANS le payload avant chiffrement
    const seed = deriveTagSeed(
      session.myIdentityKeyFingerprint,
      session.theirIdentityKeyFingerprint
    );
    const tag = getDirectionalSendTag(seed, session.myIdentityKeyFingerprint, session.theirIdentityKeyFingerprint);
    
    const _hintInput = new TextEncoder().encode(session.myIdentityKeyFingerprint + ':' + tag);
    const _hintHash = sha256(_hintInput);
    const _senderHint = Array.from(_hintHash.slice(0, 8))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    const payloadWithHint = { ...innerPayload, _senderHint };
    const payloadJsonWithHint = JSON.stringify(payloadWithHint);
    
    // ACTION 18: Padding UNIFORME
    const paddedPayload = addUniformPadding(payloadJsonWithHint);
    __DEV__ && console.log('[api1to1] After padding:', paddedPayload.length, 'bytes');
    
    // Chiffrement Triple Ratchet + SPQR
    const encryptedJson = await sessionService.encryptMessageForSession(sessionId, paddedPayload);
    
    // Enveloppe v3 (pas de senderHint visible)
    const sealedPayload: SealedPayload = {
      type: 'triple_ratchet_v3',
      version: 3,
      data: encryptedJson,
    };
    
    const sealedPayloadStr = JSON.stringify(sealedPayload);
    __DEV__ && console.log('[api1to1] Sealed payload:', Math.round(sealedPayloadStr.length / 1024), 'KB');
    
    // Sealed Sender OBLIGATOIRE — attendre le bootstrap
    if (!isSealedSenderReady()) {
      __DEV__ && console.warn('[api1to1] ⚠️ Sealed sender not ready, awaiting bootstrap...');
      const ready = await Promise.race([
        ensureSealedSenderBootstrap(),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 45000)),
      ]);
      if (!ready) {
        return {
          success: false,
          error: 'SEALED_SENDER_REQUIRED: Envoi anonyme impossible.',
        };
      }
    }
    
    const envelope = createSealedSenderEnvelope(tag, sealedPayloadStr);
    
    const wrappedSendRpcFn = async () => {
      const result = await secureRpc('send_sealed_message', {
        p_tag: envelope.tag,
        p_sealed_content: envelope.sealedContent,
        p_version: envelope.version,
      });
      if (result.data?.[0]?.id) {
        recentlySentIds.add(result.data[0].id);
      }
      return result;
    };
    
    const { data, error } = await enqueueMessage(sessionId, wrappedSendRpcFn, priority);
    
    if (error) {
      if (error.message && error.message.includes('quota exceeded')) {
        invalidateSenderCertificate();
      }
      return { success: false, error: error.message };
    }
    
    const serverMessageId = data?.[0]?.id;
    if (serverMessageId) {
      await markIdAsProcessed(sessionId, serverMessageId);
    }
    
    return { success: true, messageId: innerPayload.messageId };
    
  } catch (error) {
    console.error('[api1to1] ❌ sendSingleChunk EXCEPTION:', error);
    return { success: false, error: String(error) };
  }
}

// ============================================
// ENVOI - MESSAGE TEXTE
// ============================================

export async function sendMessage1to1(
  sessionId: string,
  content: string,
  replyTo?: { id: string; content: string; sender: string }
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const session = sessionService.getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found' };
  }
  
  const messageId = generateMessageId();
  const myFingerprint = session.myIdentityKeyFingerprint;
  const myProfile = sessionService.getMyProfile();
  const timestamp = Date.now();
  
  // v23.0: Créer et sauvegarder le message avec status 'sending' AVANT l'envoi
  const localMessage: Message1to1 = {
    id: messageId,
    sessionId,
    content,
    timestamp,
    isMine: true,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    senderFingerprint: myFingerprint,
    status: 'sending', // v23.0: Status initial
    messageType: 'text',
    ...(replyTo && {
      replyToId: replyTo.id,
      replyToContent: replyTo.content,
      replyToSender: replyTo.sender,
    }),
  };
  
  // Sauvegarder immédiatement avec status 'sending'
  await saveLocalMessage1to1(sessionId, localMessage);
  __DEV__ && console.log(`[api1to1] 📤 Message ${messageId.slice(0, 8)}... created with status: sending`);
  
  const innerPayload: InnerPayload = {
    type: 'text',
    content,
    senderFingerprint: myFingerprint,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    timestamp,
    messageId,
    ...(replyTo && {
      replyToId: replyTo.id,
      replyToContent: replyTo.content,
      replyToSender: replyTo.sender,
    }),
  };
  
  const result = await sendInnerPayload(sessionId, innerPayload);
  
  // v23.0: Mettre à jour le statut après l'envoi
  if (result.success) {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'sent');
    __DEV__ && console.log(`[api1to1] ✅ Text message sent: ${messageId.slice(0, 8)}...`);
  } else {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
    console.error(`[api1to1] ❌ Text message failed: ${messageId.slice(0, 8)}...`, result.error);
  }
  
  return { ...result, messageId };
}

// ============================================
// ENVOI - IMAGE
// ============================================

/** @deprecated v26.0: Utiliser sendImageMessage1to1() de media1to1.ts (blob storage) */
export async function sendImage1to1(
  sessionId: string,
  imageData: string, // Base64
  thumbnailData: string, // Base64 thumbnail
  width: number,
  height: number,
  caption?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  __DEV__ && console.log('[api1to1] 📸 sendImage1to1 START');
  __DEV__ && console.log('[api1to1] Session:', sessionId.slice(0, 12) + '...');
  __DEV__ && console.log('[api1to1] Image base64 length:', imageData.length, '(~', Math.round(imageData.length * 0.75 / 1024), 'KB)');
  __DEV__ && console.log('[api1to1] Thumbnail base64 length:', thumbnailData.length);
  __DEV__ && console.log('[api1to1] Dimensions:', width, 'x', height);
  
  const session = sessionService.getSession(sessionId);
  if (!session) {
    console.error('[api1to1] ❌ Session not found');
    return { success: false, error: 'Session not found' };
  }
  
  const messageId = generateMessageId();
  const myFingerprint = session.myIdentityKeyFingerprint;
  const myProfile = sessionService.getMyProfile();
  const timestamp = Date.now();
  
  // v23.0: Créer et sauvegarder le message avec status 'sending' AVANT l'envoi
  const localMessage: Message1to1 = {
    id: messageId,
    sessionId,
    content: caption || '[Image]',
    timestamp,
    isMine: true,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    senderFingerprint: myFingerprint,
    status: 'sending', // v23.0: Status initial
    messageType: 'image',
    imageData,
    thumbnailData,
    imageWidth: width,
    imageHeight: height,
  };
  
  // Sauvegarder immédiatement avec status 'sending'
  await saveLocalMessage1to1(sessionId, localMessage);
  __DEV__ && console.log(`[api1to1] 📤 Image ${messageId.slice(0, 8)}... created with status: sending`);
  
  const innerPayload: InnerPayload = {
    type: 'image',
    content: caption || '',
    senderFingerprint: myFingerprint,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    timestamp,
    messageId,
    imageData,
    thumbnailData,
    imageWidth: width,
    imageHeight: height,
  };
  
  __DEV__ && console.log('[api1to1] Calling sendInnerPayload...');
  const result = await sendInnerPayload(sessionId, innerPayload);
  
  // v23.0: Mettre à jour le statut après l'envoi
  if (result.success) {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'sent');
    __DEV__ && console.log(`[api1to1] ✅ Image sent: ${messageId.slice(0, 8)}...`);
  } else {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
    console.error('[api1to1] ❌ Image send failed:', result.error);
  }
  
  return { ...result, messageId };
}

// ============================================
// ENVOI - FICHIER
// ============================================

/** @deprecated v26.0: Utiliser sendFileMessage1to1() de media1to1.ts (blob storage) */
export async function sendFile1to1(
  sessionId: string,
  fileData: string, // Base64
  fileName: string,
  fileSize: number,
  mimeType: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  __DEV__ && console.log('[api1to1] 📎 sendFile1to1 START');
  __DEV__ && console.log('[api1to1] File:', fileName, 'Size:', fileSize, 'bytes', 'Type:', mimeType);
  __DEV__ && console.log('[api1to1] Base64 length:', fileData.length);
  
  const session = sessionService.getSession(sessionId);
  if (!session) {
    console.error('[api1to1] ❌ Session not found');
    return { success: false, error: 'Session not found' };
  }
  
  const messageId = generateMessageId();
  const myFingerprint = session.myIdentityKeyFingerprint;
  const myProfile = sessionService.getMyProfile();
  const timestamp = Date.now();
  
  // v23.0: Créer et sauvegarder le message avec status 'sending' AVANT l'envoi
  const localMessage: Message1to1 = {
    id: messageId,
    sessionId,
    content: `[Fichier: ${fileName}]`,
    timestamp,
    isMine: true,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    senderFingerprint: myFingerprint,
    status: 'sending', // v23.0: Status initial
    messageType: 'file',
    fileData,
    fileName,
    fileSize,
    fileMimeType: mimeType,
  };
  
  // Sauvegarder immédiatement avec status 'sending'
  await saveLocalMessage1to1(sessionId, localMessage);
  __DEV__ && console.log(`[api1to1] 📤 File ${messageId.slice(0, 8)}... created with status: sending`);
  
  const innerPayload: InnerPayload = {
    type: 'file',
    content: fileName,
    senderFingerprint: myFingerprint,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    timestamp,
    messageId,
    fileData,
    fileName,
    fileSize,
    fileMimeType: mimeType,
  };
  
  __DEV__ && console.log('[api1to1] Calling sendInnerPayload...');
  const result = await sendInnerPayload(sessionId, innerPayload);
  
  // v23.0: Mettre à jour le statut après l'envoi
  if (result.success) {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'sent');
    __DEV__ && console.log(`[api1to1] ✅ File sent: ${messageId.slice(0, 8)}... (${fileName})`);
  } else {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
    console.error('[api1to1] ❌ File send failed:', result.error);
  }
  
  return { ...result, messageId };
}

// ============================================
// ENVOI - MESSAGE VOCAL
// ============================================

/** @deprecated v26.0: Utiliser sendVoiceMessage1to1() de media1to1.ts (blob storage) */
export async function sendVoice1to1(
  sessionId: string,
  voiceData: string, // Base64
  duration: number // en secondes
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  __DEV__ && console.log('[api1to1] 🎤 sendVoice1to1 START');
  __DEV__ && console.log('[api1to1] Duration:', duration, 'seconds');
  __DEV__ && console.log('[api1to1] Base64 length:', voiceData.length, '(~', Math.round(voiceData.length * 0.75 / 1024), 'KB)');
  
  const session = sessionService.getSession(sessionId);
  if (!session) {
    console.error('[api1to1] ❌ Session not found');
    return { success: false, error: 'Session not found' };
  }
  
  const messageId = generateMessageId();
  const myFingerprint = session.myIdentityKeyFingerprint;
  const myProfile = sessionService.getMyProfile();
  const timestamp = Date.now();
  
  // v23.0: Créer et sauvegarder le message avec status 'sending' AVANT l'envoi
  const localMessage: Message1to1 = {
    id: messageId,
    sessionId,
    content: `[Message vocal ${Math.round(duration)}s]`,
    timestamp,
    isMine: true,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    senderFingerprint: myFingerprint,
    status: 'sending', // v23.0: Status initial
    messageType: 'voice',
    voiceData,
    voiceDuration: duration,
  };
  
  // Sauvegarder immédiatement avec status 'sending'
  await saveLocalMessage1to1(sessionId, localMessage);
  __DEV__ && console.log(`[api1to1] 📤 Voice ${messageId.slice(0, 8)}... created with status: sending`);
  
  const innerPayload: InnerPayload = {
    type: 'voice',
    content: `[Message vocal ${Math.round(duration)}s]`,
    senderFingerprint: myFingerprint,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    timestamp,
    messageId,
    voiceData,
    voiceDuration: duration,
  };
  
  __DEV__ && console.log('[api1to1] Calling sendInnerPayload...');
  const result = await sendInnerPayload(sessionId, innerPayload);
  
  // v23.0: Mettre à jour le statut après l'envoi
  if (result.success) {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'sent');
    __DEV__ && console.log(`[api1to1] ✅ Voice sent: ${messageId.slice(0, 8)}... (${duration}s)`);
  } else {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
    console.error('[api1to1] ❌ Voice send failed:', result.error);
  }
  
  return { ...result, messageId };
}

// ============================================
// v26.0: ENVOI - MEDIA REF (blob chiffré sur storage)
// ============================================

/**
 * Métadonnées du blob uploadé, reçues de encryptedBlobService.
 */
export interface BlobUploadResult {
  blobId: string;
  blobKey: string;   // base64
  blobNonce: string;  // base64
  blobSize: number;   // ciphertext size before padding
}

/**
 * Envoie une référence vers un média chiffré uploadé sur Supabase Storage.
 *
 * Le message ne contient que la référence (~200-5000B selon thumbnail)
 * au lieu du média complet (200KB-10MB). Le destinataire téléchargera
 * le blob à la demande via le relay.
 *
 * Le message local (sender) conserve les données complètes pour affichage immédiat.
 *
 * @param sessionId - ID de session
 * @param blobResult - Résultat de l'upload (blobId, blobKey, blobNonce, blobSize)
 * @param mediaType - Type de média ('image', 'file', 'voice')
 * @param metadata - Métadonnées spécifiques au type de média
 */
export async function sendMediaRef1to1(
  sessionId: string,
  blobResult: BlobUploadResult,
  mediaType: 'image' | 'file' | 'voice',
  metadata: {
    content?: string;
    thumbnailData?: string; // base64, ~5KB (images only)
    imageWidth?: number;
    imageHeight?: number;
    fileName?: string;
    fileSize?: number;
    fileMimeType?: string;
    voiceDuration?: number;
    // Données locales complètes (pour le message local du sender)
    localImageData?: string;
    localFileData?: string;
    localVoiceData?: string;
  }
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  __DEV__ && console.log(`[api1to1] 📦 sendMediaRef1to1 START (${mediaType})`);
  
  const session = sessionService.getSession(sessionId);
  if (!session) {
    console.error('[api1to1] ❌ Session not found');
    return { success: false, error: 'Session not found' };
  }
  
  const messageId = generateMessageId();
  const myFingerprint = session.myIdentityKeyFingerprint;
  const myProfile = sessionService.getMyProfile();
  const timestamp = Date.now();
  
  // Contenu textuel selon le type
  const contentText = metadata.content 
    || (mediaType === 'image' ? '[Image]' 
    : mediaType === 'voice' ? `[Message vocal ${Math.round(metadata.voiceDuration || 0)}s]`
    : `[Fichier: ${metadata.fileName || 'fichier'}]`);
  
  // ── Message local (sender) — conserve les données complètes ──
  const localMessage: Message1to1 = {
    id: messageId,
    sessionId,
    content: contentText,
    timestamp,
    isMine: true,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    senderFingerprint: myFingerprint,
    status: 'sending',
    messageType: mediaType,
    // Données complètes pour affichage immédiat du sender
    imageData: metadata.localImageData,
    thumbnailData: metadata.thumbnailData,
    imageWidth: metadata.imageWidth,
    imageHeight: metadata.imageHeight,
    fileData: metadata.localFileData,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    fileMimeType: metadata.fileMimeType,
    voiceData: metadata.localVoiceData,
    voiceDuration: metadata.voiceDuration,
    // Blob refs (pour info — le sender n'en a pas besoin mais c'est utile pour debug)
    blobId: blobResult.blobId,
    blobMediaType: mediaType,
  };
  
  // Sauvegarder immédiatement (externalizeMedia enverra les données au filesystem)
  await saveLocalMessage1to1(sessionId, localMessage);
  
  // ── InnerPayload E2E — NE CONTIENT PAS les données média ──
  // Seule la référence blob + thumbnail transitent sur le réseau.
  // C'est ~200-5000B au lieu de 200KB-10MB → 1 seul message texte.
  const innerPayload: InnerPayload = {
    type: 'media_ref',
    content: contentText,
    senderFingerprint: myFingerprint,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    timestamp,
    messageId,
    // Référence blob
    blobId: blobResult.blobId,
    blobKey: blobResult.blobKey,
    blobNonce: blobResult.blobNonce,
    blobSize: blobResult.blobSize,
    blobMediaType: mediaType,
    // Metadata pour affichage AVANT download
    // v27.0: thumbnailData SUPPRIMÉ du wire payload.
    // SÉCURITÉ: Sans thumbnail, media_ref = ~350B → tier 2KB → sealed 5.8KB
    //   = strictement identique à un message texte et aux decoys (70% small).
    //   Le serveur ne peut PAS distinguer un envoi d'image d'un texte.
    //   Avec thumbnail (~1.5-25KB), le payload montait au tier 8KB+ → corrélable
    //   avec le blob upload sur le relay juste après.
    // UX: Le destinataire voit un placeholder → tap → download blob → image complète.
    imageWidth: metadata.imageWidth,
    imageHeight: metadata.imageHeight,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    fileMimeType: metadata.fileMimeType,
    voiceDuration: metadata.voiceDuration,
  };
  
  __DEV__ && console.log(`[api1to1] 📦 MediaRef payload: ${JSON.stringify(innerPayload).length}B (vs ${
    mediaType === 'image' ? (metadata.localImageData?.length || 0) + 'B inline' : 'inline'
  })`);
  
  const result = await sendInnerPayload(sessionId, innerPayload);
  
  if (result.success) {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'sent');
    __DEV__ && console.log(`[api1to1] ✅ MediaRef sent: ${messageId.slice(0, 8)}... (blob: ${blobResult.blobId.slice(0, 12)}...)`);
  } else {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
    console.error('[api1to1] ❌ MediaRef send failed:', result.error);
  }
  
  return { ...result, messageId };
}

// ============================================
// ENVOI - SIGNAL D'APPEL (v5.0)
// ============================================

export type CallSignalType = 'offer' | 'answer' | 'senderkey' | 'hangup' | 'decline' | 'busy' | 'crypto';

export async function sendCallSignal1to1(
  sessionId: string,
  callSignalType: CallSignalType,
  callId: string,
  roomTag?: string,
  authToken?: string,
  senderKeyDistribution?: string, // JSON stringified
  cryptoSignal?: string, // JSON stringified - pour les signaux crypto (clés audio)
  callStartedAt?: number // Timestamp de début pour synchroniser les chronos
): Promise<{ success: boolean; error?: string }> {
  __DEV__ && console.log('[api1to1] 📞 sendCallSignal1to1:', callSignalType, 'for call:', callId.slice(0, 20) + '...');
  
  const session = sessionService.getSession(sessionId);
  if (!session) {
    console.error('[api1to1] ❌ Session not found');
    return { success: false, error: 'Session not found' };
  }
  
  const messageId = generateMessageId();
  const myFingerprint = session.myIdentityKeyFingerprint;
  const myProfile = sessionService.getMyProfile();  // v7.0: Récupérer le profil complet
  
  const innerPayload: InnerPayload = {
    type: 'call_signal',
    content: `[Call Signal: ${callSignalType}]`,
    senderFingerprint: myFingerprint,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,  // v7.0: Inclure l'avatar dans les signaux d'appel
    timestamp: Date.now(),
    messageId,
    callSignalType,
    callId,
    roomTag,
    authToken,
    senderKeyDistribution,
    cryptoSignal,
    callStartedAt, // Timestamp de début pour synchroniser les chronos
  };
  
  // Les signaux d'appel sont URGENTS — envoi immédiat avec decoys masquants
  const result = await sendInnerPayload(sessionId, innerPayload, 'urgent');
  
  if (result.success) {
    __DEV__ && console.log(`[api1to1] ✅ Call signal sent: ${callSignalType}`);
  } else {
    console.error('[api1to1] ❌ Call signal send failed:', result.error);
  }
  
  // Ne pas sauvegarder les signaux d'appel comme messages locaux
  return result;
}

// ============================================
// ENVOI - MESSAGE "APPEL TERMINÉ"
// ============================================

/**
 * Envoie un message "Appel terminé" avec la durée
 * Ce message apparaît dans la conversation comme sur WhatsApp/Telegram
 */
export async function sendCallEndedMessage1to1(
  sessionId: string,
  callId: string,
  status: 'ended' | 'missed' | 'declined' | 'cancelled',
  duration: number, // En secondes
  startedAt: number,
  endedAt: number
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  __DEV__ && console.log(`[api1to1] 📞 sendCallEndedMessage1to1: ${status}, duration=${duration}s`);
  
  const session = sessionService.getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found' };
  }
  
  const messageId = generateMessageId();
  const myFingerprint = session.myIdentityKeyFingerprint;
  const myProfile = sessionService.getMyProfile();
  
  // Créer le contenu JSON du message (même format que callMessages.ts)
  const callPayload = {
    type: 'call',
    callType: 'voice',
    status,
    duration,
    callId,
    participantCount: 2, // Toujours 2 pour les appels 1-à-1
    startedAt,
    endedAt,
  };
  
  const content = JSON.stringify(callPayload);
  
  const innerPayload: InnerPayload = {
    type: 'call',
    content,
    senderFingerprint: myFingerprint,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64,
    timestamp: Date.now(),
    messageId,
    callId,
    callStatus: status,
    callDuration: duration,
    callStartedAt: startedAt,
    callEndedAt: endedAt,
  };
  
  const result = await sendInnerPayload(sessionId, innerPayload);
  
  if (result.success) {
    // Sauvegarder localement
    const localMessage: Message1to1 = {
      id: messageId,
      sessionId,
      content,
      timestamp: innerPayload.timestamp,
      isMine: true,
      displayName: innerPayload.displayName,
      senderAvatarBase64: myProfile.avatarBase64, // v6.1: BUGFIX - Inclure l'avatar dans le message local
      senderFingerprint: myFingerprint,
      status: 'sent',
      messageType: 'call',
    };
    
    await saveLocalMessage1to1(sessionId, localMessage);
    
    // IMPORTANT: Notifier les callbacks pour que l'UI se mette à jour immédiatement
    const callback = pollState.callbacks.get(sessionId);
    if (callback) {
      callback(localMessage);
    }
    // Aussi notifier via messageCallbacks
    const msgCallbacks = messageCallbacks.get(sessionId) || [];
    for (const cb of msgCallbacks) {
      try {
        cb(localMessage);
      } catch (e) {
        console.error('[api1to1] Callback error:', e);
      }
    }
    
    __DEV__ && console.log(`[api1to1] ✅ Call ended message sent: ${messageId.slice(0, 12)}...`);
  } else {
    console.error('[api1to1] ❌ Call ended message send failed:', result.error);
  }
  
  return { ...result, messageId };
}

// ============================================
// ENVOI - RÉACTION
// ============================================

export async function sendReaction1to1(
  sessionId: string,
  targetMessageId: string,
  emoji: string
): Promise<{ success: boolean; error?: string }> {
  const session = sessionService.getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found' };
  }
  
  const messageId = generateMessageId();
  const myFingerprint = session.myIdentityKeyFingerprint;
  const myProfile = sessionService.getMyProfile();
  
  const innerPayload: InnerPayload = {
    type: 'reaction',
    content: emoji,
    senderFingerprint: myFingerprint,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64, // v27.1: avatar-on-change via stripAvatarForWire
    timestamp: Date.now(),
    messageId,
    targetMessageId,
    emoji,
  };
  
  const result = await sendInnerPayload(sessionId, innerPayload);
  
  if (result.success) {
    __DEV__ && console.log(`[api1to1] Reaction sent: ${emoji} on ${targetMessageId.slice(0, 12)}...`);
  }
  
  return result;
}

// ============================================
// ENVOI - ACCUSÉ DE LECTURE
// ============================================

export async function sendReadReceipt1to1(
  sessionId: string,
  messageIds: string[]
): Promise<{ success: boolean; error?: string }> {
  if (messageIds.length === 0) return { success: true };
  
  const session = sessionService.getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found' };
  }
  
  const myFingerprint = session.myIdentityKeyFingerprint;
  const myProfile = sessionService.getMyProfile();
  
  const innerPayload: InnerPayload = {
    type: 'read_receipt',
    content: '',
    senderFingerprint: myFingerprint,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64, // v27.1: avatar-on-change via stripAvatarForWire
    timestamp: Date.now(),
    messageId: generateMessageId(),
    readMessageIds: messageIds,
  };
  
  // ANTI-SDA: 'deferred' = le receipt attend le prochain slot naturel (~30s ±30s).
  // Empêche la corrélation temporelle entre réception de message et envoi du receipt.
  const result = await sendInnerPayload(sessionId, innerPayload, 'deferred');
  
  if (result.success) {
    __DEV__ && console.log(`[api1to1] Read receipt queued (deferred) for ${messageIds.length} messages`);
  }
  
  return result;
}

// ============================================
// ENVOI - ACCUSÉ DE LIVRAISON
// ============================================

export async function sendDeliveredReceipt1to1(
  sessionId: string,
  messageIds: string[]
): Promise<{ success: boolean; error?: string }> {
  if (messageIds.length === 0) return { success: true };
  
  const session = sessionService.getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found' };
  }
  
  const myFingerprint = session.myIdentityKeyFingerprint;
  
  const myProfile = sessionService.getMyProfile();
  
  const innerPayload: InnerPayload = {
    type: 'delivered_receipt',
    content: '',
    senderFingerprint: myFingerprint,
    displayName: myProfile.displayName,
    senderAvatarBase64: myProfile.avatarBase64, // v27.1: avatar-on-change via stripAvatarForWire
    timestamp: Date.now(),
    messageId: generateMessageId(),
    readMessageIds: messageIds,
  };
  
  // ANTI-SDA: 'deferred' = le receipt attend le prochain slot naturel (~30s ±30s).
  // Empêche la corrélation temporelle entre réception de message et envoi du receipt.
  const result = await sendInnerPayload(sessionId, innerPayload, 'deferred');
  
  if (result.success) {
    __DEV__ && console.log(`[api1to1] Delivered receipt queued (deferred) for ${messageIds.length} messages`);
  }
  
  return result;
}

// ============================================
// PERSISTANCE DES RÉACTIONS (v21.0)
// ============================================

const REACTIONS_STORAGE_KEY = '@ghostr_reactions_';

export interface StoredReaction {
  emoji: string;
  senderFingerprint: string;
  timestamp: number;
}

/**
 * Sauvegarde les réactions d'une conversation
 */
export async function saveReactions(
  conversationId: string,
  reactions: Map<string, StoredReaction[]>
): Promise<void> {
  try {
    const key = `${REACTIONS_STORAGE_KEY}${conversationId}`;
    const data: Record<string, StoredReaction[]> = {};
    reactions.forEach((value, messageId) => {
      if (value.length > 0) {
        data[messageId] = value;
      }
    });
    await secureSet(key, JSON.stringify(data));
    __DEV__ && console.log(`[api1to1] 💾 Saved ${Object.keys(data).length} messages with reactions`);
  } catch (error) {
    console.error('[api1to1] Error saving reactions:', error);
  }
}

/**
 * Charge les réactions d'une conversation
 */
export async function loadReactions(
  conversationId: string
): Promise<Map<string, StoredReaction[]>> {
  try {
    const key = `${REACTIONS_STORAGE_KEY}${conversationId}`;
    const data = await secureGet(key);
    if (!data) {
      return new Map();
    }
    const parsed: Record<string, StoredReaction[]> = JSON.parse(data);
    const map = new Map<string, StoredReaction[]>();
    Object.entries(parsed).forEach(([messageId, reactions]) => {
      map.set(messageId, reactions);
    });
    __DEV__ && console.log(`[api1to1] 📂 Loaded reactions for ${map.size} messages`);
    return map;
  } catch (error) {
    console.error('[api1to1] Error loading reactions:', error);
    return new Map();
  }
}

/**
 * Toggle une réaction (ajoute si absente, supprime si présente)
 * Utilisé quand l'utilisateur tape sur une réaction
 */
export async function toggleReactionStorage(
  conversationId: string,
  messageId: string,
  emoji: string,
  senderFingerprint: string
): Promise<Map<string, StoredReaction[]>> {
  const reactions = await loadReactions(conversationId);
  const existing = reactions.get(messageId) || [];
  
  // Vérifier si la réaction existe déjà
  const existingIndex = existing.findIndex(
    r => r.emoji === emoji && r.senderFingerprint === senderFingerprint
  );
  
  if (existingIndex > -1) {
    // Toggle off: supprimer la réaction
    existing.splice(existingIndex, 1);
  } else {
    // Toggle on: ajouter la réaction
    existing.push({ emoji, senderFingerprint, timestamp: Date.now() });
  }
  
  reactions.set(messageId, existing);
  await saveReactions(conversationId, reactions);
  return reactions;
}

/**
 * Reçoit une réaction (ajoute uniquement si absente, pas de toggle)
 * Utilisé quand on reçoit une réaction d'un autre utilisateur
 */
export async function receiveReaction(
  conversationId: string,
  messageId: string,
  emoji: string,
  senderFingerprint: string
): Promise<Map<string, StoredReaction[]>> {
  const reactions = await loadReactions(conversationId);
  const existing = reactions.get(messageId) || [];
  
  // Vérifier si la réaction existe déjà
  const alreadyExists = existing.some(
    r => r.emoji === emoji && r.senderFingerprint === senderFingerprint
  );
  
  if (!alreadyExists) {
    // Ajouter uniquement si elle n'existe pas
    existing.push({ emoji, senderFingerprint, timestamp: Date.now() });
    reactions.set(messageId, existing);
    await saveReactions(conversationId, reactions);
  }
  
  return reactions;
}

/**
 * @deprecated Use toggleReactionStorage for user actions and receiveReaction for incoming reactions
 */
export async function addReaction(
  conversationId: string,
  messageId: string,
  emoji: string,
  senderFingerprint: string
): Promise<Map<string, StoredReaction[]>> {
  return toggleReactionStorage(conversationId, messageId, emoji, senderFingerprint);
}

// ============================================
// RÉCEPTION DE MESSAGES
// ============================================

// v6.2: Verrou par session pour éviter les déchiffrements concurrents
const fetchLocks = new Map<string, Promise<Message1to1[]>>();

export async function fetchMessages1to1(
  sessionId: string,
  since?: Date
): Promise<Message1to1[]> {
  // Si un fetch est déjà en cours pour cette session, attendre qu'il finisse
  const existingLock = fetchLocks.get(sessionId);
  if (existingLock) {
    __DEV__ && console.log('[api1to1] ⏳ Waiting for existing fetch to complete:', sessionId.slice(0, 12) + '...');
    return existingLock;
  }
  
  // Créer un nouveau verrou
  const fetchPromise = doFetchMessages1to1(sessionId, since);
  fetchLocks.set(sessionId, fetchPromise);
  
  try {
    const result = await fetchPromise;
    return result;
  } finally {
    // Libérer le verrou
    fetchLocks.delete(sessionId);
  }
}

async function doFetchMessages1to1(
  sessionId: string,
  since?: Date
): Promise<Message1to1[]> {
  try {
    const session = sessionService.getSession(sessionId);
    if (!session) {
      console.warn('[api1to1] Session not found:', sessionId.slice(0, 12) + '...');
      return [];
    }
    
    const realTag = getSessionTag(session);
    const lastPoll = since || (await getLastPollTime(sessionId));
    const processedIds = await getProcessedIds(sessionId);
    const myFingerprint = session.myIdentityKeyFingerprint;
    
    // ACTION 3: Tags directionnels asymétriques pour le polling
    const seed = deriveTagSeed(
      session.myIdentityKeyFingerprint,
      session.theirIdentityKeyFingerprint
    );
    const directionalTags = getDirectionalReceiveTags(seed, session.myIdentityKeyFingerprint, session.theirIdentityKeyFingerprint);
    const legacyTag = realTag; // Tag permanent legacy (migration pre-ACTION 3)
    const allRealTags = [...new Set([...directionalTags, legacyTag])];
    const realTagSet = new Set(allRealTags);
    __DEV__ && console.log(`[api1to1] 🔍 DIAG SESSION POLL directional tags: ${allRealTags.map(t => t.slice(0,16)+'...').join(', ')} | p_since: ${lastPoll?.toISOString() || 'null'}`);
    
    // ACTION 06: K-ANONYMITY RENFORCÉE — TOUJOURS 50 tags exactement
    // Le serveur ne peut plus déduire le nombre de conversations.
    // Decoys purement aléatoires (les HKDF-persistants sont statistiquement identifiables).
    const FIXED_POLLING_TAG_COUNT = 50;
    const decoysNeeded = Math.max(0, FIXED_POLLING_TAG_COUNT - allRealTags.length);
    const randomDecoys: string[] = [];
    for (let i = 0; i < decoysNeeded; i++) {
      // Decoy = random hex 64 chars (même format que les vrais tags)
      const randomBytes = getRandomBytes(32);
      const hexTag = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      randomDecoys.push(hexTag);
    }
    
    // Audit Fix M-03: Mélanger vrais tags + decoys avec CSPRNG shuffle
    const mixedTags = [...allRealTags, ...randomDecoys];
    const shuffledTags = csprngShuffleArray(mixedTags);
    
    const { data, error } = await secureRpc('get_messages_by_tags', {
      p_tags: shuffledTags,
      p_since: lastPoll?.toISOString() || null,
      p_limit: 100,
    });
    
    if (error) {
      console.error('[api1to1] Fetch error:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`[api1to1] 🔍 DIAG session poll: server returned 0 msgs for ${allRealTags.length} real tags`);
      return [];
    }
    
    const realMessages = (data as ServerMessage[]).filter(row => realTagSet.has(row.tag));
    console.log(`[api1to1] 🔍 DIAG session poll: ${(data as any[]).length} total rows, ${realMessages.length} matched real tags`);
    
    if (realMessages.length === 0) {
      return [];
    }
    
    const messages: Message1to1[] = [];
    const deliveredIds: string[] = [];
    
    for (const row of realMessages) {
      if (processedIds.has(row.id) || recentlySentIds.has(row.id) || inFlightOrProcessedIds.has(row.id)) {
        continue;
      }
      
      let sealedPayload: SealedPayload;
      try {
        sealedPayload = JSON.parse(row.sealed_payload);
      } catch {
        continue;
      }
      
      // Ignorer les messages de handshake X3DH/PQXDH
      if (sealedPayload.type === 'ghostr_x3dh_response' || 
          sealedPayload.type === 'ghostr_invite_v1' ||
          sealedPayload.type === 'ghostr_accept_v1' ||
          sealedPayload.type === 'ghostr_invite_pq' ||
          sealedPayload.type === 'ghostr_accept_pq') {
        continue;
      }
      
      // Accepter les messages Triple Ratchet v1, v2 et v3
      if (sealedPayload.type !== 'triple_ratchet_v1' && sealedPayload.type !== 'triple_ratchet_v2' && sealedPayload.type !== 'triple_ratchet_v3') {
        continue;
      }
      
      // v20.0: Filtrer nos propres messages avec le senderHint anonyme
      // FIX 0.2: Pour v3, le hint est DANS le payload chiffré (filtrage post-decrypt)
      // Pour v2/v1, le hint est dans l'enveloppe (filtrage pré-decrypt)
      const messageTag = row.tag;
      const myHintInput = new TextEncoder().encode(myFingerprint + ':' + messageTag);
      const myHintHash = sha256(myHintInput);
      const myHint = Array.from(myHintHash.slice(0, 8))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      
      // Legacy v2: senderHint dans l'enveloppe (filtrage pré-déchiffrement)
      if (sealedPayload.version !== 3) {
        if (sealedPayload.senderHint && sealedPayload.senderHint === myHint) {
          __DEV__ && console.log('[api1to1] ⏭️ Skipping own message (v2 hint match)');
          await markIdAsProcessed(sessionId, row.id);
          continue;
        }
      }
      // Compatibilité avec anciens messages qui ont senderFingerprint
      if (sealedPayload.senderFingerprint && sealedPayload.senderFingerprint === myFingerprint) {
        __DEV__ && console.log('[api1to1] ⏭️ Skipping own message (legacy fingerprint match)');
        await markIdAsProcessed(sessionId, row.id);
        continue;
      }
      
      __DEV__ && console.log('[api1to1] 📩 Received encrypted message:', sealedPayload.type, 'v' + sealedPayload.version);
      
      // Réclamer ce message AVANT le déchiffrement pour empêcher
      // le batch poll de le traiter en parallèle
      inFlightOrProcessedIds.add(row.id);
      
      // Déchiffrer
      const message = await decryptServerMessage(sessionId, row, sealedPayload, myFingerprint);
      
      // FIX 0.2: Pour v3, filtrer nos propres messages APRÈS déchiffrement
      // Le _senderHint est maintenant dans le payload chiffré
      if (message && sealedPayload.version === 3) {
        const decryptedHint = (message as any)._senderHint;
        if (decryptedHint && decryptedHint === myHint) {
          __DEV__ && console.log('[api1to1] ⏭️ Skipping own message (v3 hint inside E2E payload)');
          await markIdAsProcessed(sessionId, row.id);
          continue;
        }
        // Nettoyer le _senderHint du message avant traitement
        if ((message as any)._senderHint) {
          delete (message as any)._senderHint;
        }
      }
      
      // v6.2: Toujours marquer le message comme traité, même si le déchiffrement échoue
      // Cela évite la boucle infinie de re-tentatives
      await markIdAsProcessed(sessionId, row.id);
      
      if (message) {
        // =========================================================
        // v25.0: MEDIA CHUNK ASSEMBLY
        // Si le message est un chunk de média fragmenté, on le passe
        // au buffer d'assemblage. Quand tous les chunks sont reçus,
        // on reconstitue l'InnerPayload original et on le traite
        // comme un message média normal.
        // =========================================================
        if (message.messageType === 'media_chunk') {
          const chunkHeader: MediaChunkHeader = {
            mediaId: (message as any).mediaId || '',
            chunkIndex: (message as any).chunkIndex ?? -1,
            totalChunks: (message as any).totalChunks ?? 0,
            chunkData: (message as any).chunkData || '',
            payloadHash: (message as any).payloadHash || '',
            totalPayloadSize: (message as any).totalPayloadSize ?? 0,
          };
          
          if (!chunkHeader.mediaId || chunkHeader.chunkIndex < 0) {
            __DEV__ && console.warn('[api1to1] ⚠️ Invalid media_chunk, skipping');
            continue;
          }
          
          const assemblyResult = await processReceivedChunk(sessionId, chunkHeader);
          
          // v25.0: Reporter la progression de réception à l'UI
          reportChunkingReceiveProgress(
            chunkHeader.mediaId,
            sessionId,
            assemblyResult.receivedChunks,
            chunkHeader.totalChunks
          );
          
          if (!assemblyResult.complete) {
            __DEV__ && console.log(
              `[api1to1] 📦 Chunk ${chunkHeader.chunkIndex + 1}/${chunkHeader.totalChunks} buffered (${Math.round(assemblyResult.progress * 100)}%)`
            );
            continue; // Attendre les autres chunks
          }
          
          // v25.0: Reporter la complétion de réception
          reportChunkingReceiveComplete(chunkHeader.mediaId);
          
          // Assemblage complet — reconstituer le payload original
          __DEV__ && console.log('[api1to1] ✅ Media fully assembled, processing...');
          
          try {
            const originalInnerPayload: InnerPayload = JSON.parse(assemblyResult.originalPayload!);
            
            // Reconstruire le Message1to1 comme si c'était un message normal
            const assembledMessage: Message1to1 = {
              id: originalInnerPayload.messageId || `assembled-${chunkHeader.mediaId}`,
              sessionId,
              content: originalInnerPayload.content,
              timestamp: originalInnerPayload.timestamp,
              isMine: false,
              displayName: originalInnerPayload.displayName,
              senderAvatarBase64: originalInnerPayload.senderAvatarBase64,
              senderFingerprint: originalInnerPayload.senderFingerprint,
              messageType: originalInnerPayload.type,
              // Images
              imageData: originalInnerPayload.imageData,
              thumbnailData: originalInnerPayload.thumbnailData,
              imageWidth: originalInnerPayload.imageWidth,
              imageHeight: originalInnerPayload.imageHeight,
              // Fichiers
              fileData: originalInnerPayload.fileData,
              fileName: originalInnerPayload.fileName,
              fileSize: originalInnerPayload.fileSize,
              fileMimeType: originalInnerPayload.fileMimeType,
              // Vocaux
              voiceData: originalInnerPayload.voiceData,
              voiceDuration: originalInnerPayload.voiceDuration,
              // Réponses
              replyToId: originalInnerPayload.replyToId,
              replyToContent: originalInnerPayload.replyToContent,
              replyToSender: originalInnerPayload.replyToSender,
            };
            
            // Injecter dans le flux normal comme message visible
            messages.push(assembledMessage);
            await saveLocalMessage1to1(sessionId, assembledMessage);
            
            if (!pollState.callbacks.has(sessionId)) {
              await incrementUnreadCount(sessionId);
            }
            deliveredIds.push(assembledMessage.id);
            
            __DEV__ && console.log(
              `[api1to1] ✅ Assembled ${originalInnerPayload.type} message from ${chunkHeader.totalChunks} chunks: ${assembledMessage.id.slice(0, 8)}...`
            );
          } catch (parseError) {
            console.error('[api1to1] ❌ Failed to parse assembled payload:', parseError);
          }
          
          continue; // Chunk traité (assemblé ou buffered), passer au suivant
        }
        
        // v6.0: Mettre à jour le profil du contact si le displayName ou avatar change
        if (message.displayName && message.displayName !== 'Anonyme') {
          const profileUpdate: { displayName: string; avatarBase64?: string } = { 
            displayName: message.displayName 
          };
          // Inclure l'avatar s'il est présent
          if (message.senderAvatarBase64) {
            profileUpdate.avatarBase64 = message.senderAvatarBase64;
          }
          sessionService.updateContactProfile(sessionId, profileUpdate).catch(err => {
            console.warn('[api1to1] Failed to update contact profile:', err);
          });
        }
        
        // Traiter selon le type
        if (message.messageType === 'read_receipt' && message.readMessageIds) {
          __DEV__ && console.log(`[api1to1] 📬 Received read receipt for ${message.readMessageIds.length} messages`);
          // Mettre à jour les statuts des messages lus
          for (const msgId of message.readMessageIds) {
            await setMessageStatus(sessionId, msgId, 'read');
          }
          notifyStatusChange(sessionId, message.readMessageIds, 'read');
        } else if (message.messageType === 'delivered_receipt' && message.readMessageIds) {
          __DEV__ && console.log(`[api1to1] 📫 Received delivered receipt for ${message.readMessageIds.length} messages`);
          // Mettre à jour les statuts des messages délivrés
          for (const msgId of message.readMessageIds) {
            await setMessageStatus(sessionId, msgId, 'delivered');
          }
          notifyStatusChange(sessionId, message.readMessageIds, 'delivered');
        } else if (message.messageType === 'reaction') {
          __DEV__ && console.log(`[api1to1] 👍 Received reaction: ${message.emoji} on ${message.targetMessageId}`);
          // v21.0: Persister la réaction IMMÉDIATEMENT à la réception (sans toggle)
          await receiveReaction(sessionId, message.targetMessageId!, message.emoji!, message.senderFingerprint!);
          // Notifier l'UI si elle écoute
          notifyReaction(sessionId, message.targetMessageId!, message.emoji!, message.senderFingerprint!);
        } else if (message.messageType === 'call_signal' && message.callSignalType && message.callId) {
          // v5.0: Signal d'appel (via SFU double-hop)
          __DEV__ && console.log(`[api1to1] 📞 Received call signal: ${message.callSignalType}`);
          notifyCallSignal(sessionId, {
            type: message.callSignalType,
            callId: message.callId,
            roomTag: message.roomTag,
            authToken: message.authToken,
            senderKeyDistribution: message.senderKeyDistribution,
            cryptoSignal: message.cryptoSignal,
            callStartedAt: message.callStartedAt, // Timestamp de début pour synchroniser les chronos
            timestamp: message.timestamp,
          }, message.displayName, message.senderAvatarBase64);  // v7.0: Inclure l'avatar
        } else {
          // Message normal
          messages.push(message);
          await saveLocalMessage1to1(sessionId, message);
          
          // v7.2: Si c'est un message "Appel terminé" reçu de l'autre,
          // marquer le callId pour annuler le fallback 8s du callee.
          // Dynamic import pour éviter la dépendance circulaire.
          if (message.messageType === 'call' && message.callId && !message.isMine) {
            import('./call1to1Service').then(({ markCallEndedReceived1to1 }) => {
              markCallEndedReceived1to1(message.callId!);
            }).catch(() => {});
          }
          
          // v6.1: Incrémenter le compteur non-lus SEULEMENT si la conversation n'est pas ouverte
          if (!pollState.callbacks.has(sessionId)) {
            await incrementUnreadCount(sessionId);
          }
          deliveredIds.push(message.id);
        }
      }
    }
    
    // Envoyer les accusés de livraison
    if (deliveredIds.length > 0) {
      sendDeliveredReceipt1to1(sessionId, deliveredIds).catch(() => {});
    }
    
    // Mettre à jour le timestamp de polling
    if (realMessages.length > 0) {
      const latestTime = new Date(realMessages[realMessages.length - 1].created_at);
      await setLastPollTime(sessionId, latestTime);
    }
    
    // v20.0: Filtre de sécurité final - ne jamais retourner les messages de protocole
    const visibleMessages = messages.filter(m => 
      !PROTOCOL_MESSAGE_TYPES.includes(m.messageType as MessageType)
    );
    
    return visibleMessages;
    
  } catch (error) {
    console.error('[api1to1] Fetch exception:', error);
    return [];
  }
}

async function decryptServerMessage(
  sessionId: string,
  serverMessage: ServerMessage,
  sealedPayload: SealedPayload,
  myFingerprint: string
): Promise<Message1to1 | null> {
  try {
    __DEV__ && console.log('[api1to1] 🔓 Decrypting with Triple Ratchet v' + sealedPayload.version);
    
    const plaintext = await sessionService.decryptMessageForSession(
      sessionId,
      sealedPayload.data
    );
    
    if (!plaintext) {
      console.warn('[api1to1] ❌ Decryption failed for message:', serverMessage.id);
      return null;
    }
    
    __DEV__ && console.log('[api1to1] ✅ Decrypted successfully (Post-Quantum protected)');
    
    // Retirer le padding
    const unpaddedData = removePadding(plaintext);
    const innerPayload: InnerPayload = JSON.parse(unpaddedData);
    
    // Vérifier si c'est notre propre message
    if (innerPayload.senderFingerprint === myFingerprint) {
      return null;
    }
    
    // Construire le message
    const message: Message1to1 = {
      id: innerPayload.messageId || serverMessage.id,
      sessionId,
      content: innerPayload.content,
      timestamp: innerPayload.timestamp,
      isMine: false,
      displayName: innerPayload.displayName,
      senderAvatarBase64: innerPayload.senderAvatarBase64, // v6.0: Avatar
      senderFingerprint: innerPayload.senderFingerprint,
      messageType: innerPayload.type,
      
      // Images
      imageData: innerPayload.imageData,
      thumbnailData: innerPayload.thumbnailData,
      imageWidth: innerPayload.imageWidth,
      imageHeight: innerPayload.imageHeight,
      
      // Fichiers
      fileData: innerPayload.fileData,
      fileName: innerPayload.fileName,
      fileSize: innerPayload.fileSize,
      fileMimeType: innerPayload.fileMimeType,
      
      // Vocaux
      voiceData: innerPayload.voiceData,
      voiceDuration: innerPayload.voiceDuration,
      
      // Réactions
      targetMessageId: innerPayload.targetMessageId,
      emoji: innerPayload.emoji,
      
      // Réponses
      replyToId: innerPayload.replyToId,
      replyToContent: innerPayload.replyToContent,
      replyToSender: innerPayload.replyToSender,
      
      // Accusés
      readMessageIds: innerPayload.readMessageIds,
      
      // Signaux d'appel (v5.0)
      callSignalType: innerPayload.callSignalType,
      callId: innerPayload.callId,
      roomTag: innerPayload.roomTag,
      authToken: innerPayload.authToken,
      senderKeyDistribution: innerPayload.senderKeyDistribution,
      
      // v8.0: Signal crypto Audio Triple Ratchet
      cryptoSignal: innerPayload.cryptoSignal,
      
      // Timestamp de début pour synchroniser les chronos
      callStartedAt: innerPayload.callStartedAt,
    };
    
    // v25.0: Legacy — Transmettre les champs de chunking pour l'assemblage (backward compat)
    if (innerPayload.type === 'media_chunk') {
      (message as any).mediaId = innerPayload.mediaId;
      (message as any).chunkIndex = innerPayload.chunkIndex;
      (message as any).totalChunks = innerPayload.totalChunks;
      (message as any).chunkData = innerPayload.chunkData;
      (message as any).payloadHash = innerPayload.payloadHash;
      (message as any).totalPayloadSize = innerPayload.totalPayloadSize;
    }
    
    // v26.0: MEDIA REF — Convertir en message média avec références blob
    // Le messageType est changé de 'media_ref' vers le type réel (image/file/voice)
    // pour que l'UI sache quel composant afficher. Les blob refs permettent
    // le téléchargement à la demande.
    if (innerPayload.type === 'media_ref' && innerPayload.blobMediaType) {
      message.messageType = innerPayload.blobMediaType; // 'image', 'file', 'voice'
      message.blobId = innerPayload.blobId;
      message.blobKey = innerPayload.blobKey;
      message.blobNonce = innerPayload.blobNonce;
      message.blobSize = innerPayload.blobSize;
      message.blobMediaType = innerPayload.blobMediaType;
      // Metadata pour affichage immédiat (AVANT téléchargement du blob)
      message.thumbnailData = innerPayload.thumbnailData;
      message.imageWidth = innerPayload.imageWidth;
      message.imageHeight = innerPayload.imageHeight;
      message.fileName = innerPayload.fileName;
      message.fileSize = innerPayload.fileSize;
      message.fileMimeType = innerPayload.fileMimeType;
      message.voiceDuration = innerPayload.voiceDuration;
      // imageData/fileData/voiceData restent undefined → trigger download on tap
      __DEV__ && console.log(`[api1to1] 📦 Received media_ref: ${innerPayload.blobMediaType} blob=${innerPayload.blobId?.slice(0, 12)}...`);
    }
    
    // FIX 0.2: Transmettre le _senderHint pour le filtrage v3 côté réception
    // Il sera vérifié puis supprimé par le code appelant (doFetchMessages1to1)
    if ((innerPayload as any)._senderHint) {
      (message as any)._senderHint = (innerPayload as any)._senderHint;
    }
    
    return message;
    
  } catch (error) {
    console.error('[api1to1] Decrypt error:', error);
    return null;
  }
}

// ============================================
// CALLBACKS POUR NOTIFICATIONS
// ============================================

type StatusCallback = (messageIds: string[], status: 'delivered' | 'read') => void;
type ReactionCallback = (targetMessageId: string, emoji: string, senderFingerprint: string) => void;
type MessageCallback = (message: Message1to1) => void;
// v7.0: Ajout de senderAvatarBase64 pour afficher l'avatar dans les appels
type CallSignalCallback = (sessionId: string, signal: {
  type: 'offer' | 'answer' | 'senderkey' | 'hangup' | 'decline' | 'busy' | 'crypto';
  callId: string;
  roomTag?: string;
  authToken?: string;
  senderKeyDistribution?: string;
  cryptoSignal?: string;
  callStartedAt?: number; // Timestamp de début pour synchroniser les chronos
  timestamp: number;
}, senderName: string, senderAvatarBase64?: string) => void;

const statusCallbacks = new Map<string, StatusCallback[]>();
const reactionCallbacks = new Map<string, ReactionCallback[]>();
const messageCallbacks = new Map<string, MessageCallback[]>();
let globalCallSignalCallback: CallSignalCallback | null = null;

export function onStatusChange(sessionId: string, callback: StatusCallback): () => void {
  const callbacks = statusCallbacks.get(sessionId) || [];
  callbacks.push(callback);
  statusCallbacks.set(sessionId, callbacks);
  
  return () => {
    const cbs = statusCallbacks.get(sessionId) || [];
    const index = cbs.indexOf(callback);
    if (index > -1) cbs.splice(index, 1);
  };
}

export function onReaction(sessionId: string, callback: ReactionCallback): () => void {
  const callbacks = reactionCallbacks.get(sessionId) || [];
  callbacks.push(callback);
  reactionCallbacks.set(sessionId, callbacks);
  
  return () => {
    const cbs = reactionCallbacks.get(sessionId) || [];
    const index = cbs.indexOf(callback);
    if (index > -1) cbs.splice(index, 1);
  };
}

function notifyStatusChange(sessionId: string, messageIds: string[], status: 'delivered' | 'read') {
  const callbacks = statusCallbacks.get(sessionId) || [];
  __DEV__ && console.log(`[api1to1] notifyStatusChange: ${status} for ${messageIds.length} messages, ${callbacks.length} callbacks registered`);
  
  // v16.0: Mettre à jour le statut dans les messages locaux
  updateLocalMessageStatus(sessionId, messageIds, status).catch(e => {
    console.error('[api1to1] Error updating local message status:', e);
  });
  
  for (const cb of callbacks) {
    try {
      cb(messageIds, status);
    } catch (e) {
      console.error('[api1to1] Status callback error:', e);
    }
  }
}

function notifyReaction(sessionId: string, targetMessageId: string, emoji: string, senderFingerprint: string) {
  const callbacks = reactionCallbacks.get(sessionId) || [];
  for (const cb of callbacks) {
    try {
      cb(targetMessageId, emoji, senderFingerprint);
    } catch (e) {
      console.error('[api1to1] Reaction callback error:', e);
    }
  }
}

function notifyNewMessage(sessionId: string, message: Message1to1) {
  const callbacks = messageCallbacks.get(sessionId) || [];
  for (const cb of callbacks) {
    try {
      cb(message);
    } catch (e) {
      console.error('[api1to1] Message callback error:', e);
    }
  }
}

// v5.0: Callback global pour les signaux d'appel
export function onCallSignal(callback: CallSignalCallback): () => void {
  globalCallSignalCallback = callback;
  return () => {
    globalCallSignalCallback = null;
  };
}

function notifyCallSignal(
  sessionId: string, 
  signal: {
    type: 'offer' | 'answer' | 'senderkey' | 'hangup' | 'decline' | 'busy';
    callId: string;
    roomTag?: string;
    authToken?: string;
    senderKeyDistribution?: string;
    cryptoSignal?: string;
    callStartedAt?: number;
    timestamp: number;
  },
  senderName: string,
  senderAvatarBase64?: string  // v7.0: Avatar de l'appelant
) {
  __DEV__ && console.log(`[api1to1] 📞 notifyCallSignal: ${signal.type} for call ${signal.callId.slice(0, 20)}...`);
  if (globalCallSignalCallback) {
    try {
      globalCallSignalCallback(sessionId, signal, senderName, senderAvatarBase64);
    } catch (e) {
      console.error('[api1to1] Call signal callback error:', e);
    }
  } else {
    console.warn('[api1to1] ⚠️ No call signal callback registered');
  }
}

// ============================================
// POLLING
// ============================================

interface PollState {
  isRunning: boolean;
  intervalId: NodeJS.Timeout | null;
  callbacks: Map<string, MessageCallback>;
}

const pollState: PollState = {
  isRunning: false,
  intervalId: null,
  callbacks: new Map(),
};

export function subscribe1to1(sessionId: string, callback: MessageCallback): () => void {
  __DEV__ && console.log('[api1to1] 📱 subscribe1to1 called for session:', sessionId.slice(0, 12) + '...');
  pollState.callbacks.set(sessionId, callback);
  
  // Aussi ajouter aux messageCallbacks
  const callbacks = messageCallbacks.get(sessionId) || [];
  callbacks.push(callback);
  messageCallbacks.set(sessionId, callbacks);
  
  if (!pollState.isRunning) {
    startPolling();
  } else {
    __DEV__ && console.log('[api1to1] 📱 Polling already running, added callback');
  }
  
  return () => {
    __DEV__ && console.log('[api1to1] 📱 unsubscribe1to1 called for session:', sessionId.slice(0, 12) + '...');
    pollState.callbacks.delete(sessionId);
    const cbs = messageCallbacks.get(sessionId) || [];
    const index = cbs.indexOf(callback);
    if (index > -1) cbs.splice(index, 1);
    
    if (pollState.callbacks.size === 0) {
      stopPolling();
    }
  };
}

function startPolling(): void {
  if (pollState.isRunning) return;
  
  pollState.isRunning = true;
  __DEV__ && console.log('[api1to1] 🔄 Starting session polling');
  
  // v25.0: Démarrer le nettoyage périodique des buffers d'assemblage de chunks
  startAssemblyCleanup();
  startProgressCleanup();
  
  const poll = async () => {
    if (!pollState.isRunning) return;
    
    __DEV__ && console.log('[api1to1] 🔄 Session poll tick, sessions:', pollState.callbacks.size);
    
    for (const [sessionId, callback] of pollState.callbacks) {
      try {
        const messages = await fetchMessages1to1(sessionId);
        if (messages.length > 0) {
          __DEV__ && console.log('[api1to1] 🔄 Got', messages.length, 'new messages for session:', sessionId.slice(0, 12) + '...');
        }
        for (const msg of messages) {
          callback(msg);
        }
      } catch (e) {
        console.error('[api1to1] Poll error for session:', sessionId.slice(0, 12) + '...');
      }
    }
    
    if (pollState.isRunning) {
      pollState.intervalId = setTimeout(poll, jitteredInterval(3000));
    }
  };
  
  poll();
}

export function stopPolling(): void {
  pollState.isRunning = false;
  if (pollState.intervalId) {
    clearTimeout(pollState.intervalId);
    pollState.intervalId = null;
  }
  // v25.0: Arrêter le nettoyage périodique des buffers d'assemblage
  stopAssemblyCleanup();
  stopProgressCleanup();
  __DEV__ && console.log('[api1to1] 🔄 Session polling stopped');
}

/**
 * v8.0: Poll toutes les sessions pour récupérer les messages en attente
 * Utile pour recevoir les messages quand l'app s'ouvre
 */
export async function pollAllSessions(): Promise<void> {
  __DEV__ && console.log('[api1to1] 🔄 Polling all sessions for pending messages...');
  
  // Capturer la génération au début. Si elle change pendant le poll
  // (stopConstantTraffic + startConstantTraffic = remount React),
  // les résultats seront ignorés pour éviter le double-traitement.
  const generation = getPollGeneration();
  
  await sessionService.initialize();
  const sessions = sessionService.getAllSessions();
  
  if (sessions.length === 0) {
    __DEV__ && console.log('[api1to1] 🔄 No sessions to poll');
    return;
  }
  
  __DEV__ && console.log('[api1to1] 🔄 Batch-polling', sessions.length, 'sessions in ONE RPC call');
  
  // BUG FIX: Collecter TOUS les tags de TOUTES les sessions en un seul batch.
  // Avant ce fix, chaque session faisait un appel RPC séparé avec 50 tags,
  // ce qui permettait au serveur de compter le nombre de conversations.
  
  const FIXED_POLLING_TAG_COUNT = 50;
  
  // 1. Construire le mapping tag → sessionId pour dispatcher les résultats
  const tagToSessionId = new Map<string, string>();
  const sessionContexts = new Map<string, {
    realTagSet: Set<string>;
    processedIds: Set<string>;
    myFingerprint: string;
    session: StoredSession;
  }>();
  
  const allRealTagsGlobal: string[] = [];
  
  for (const session of sessions) {
    // Ne pas poller les sessions qui ont un polling actif (conversation ouverte)
    if (pollState.callbacks.has(session.id)) {
      continue;
    }
    
    const realTag = getSessionTag(session);
    const seed = deriveTagSeed(
      session.myIdentityKeyFingerprint,
      session.theirIdentityKeyFingerprint
    );
    // ACTION 3: Tags directionnels pour le batch polling
    const directionalTags = getDirectionalReceiveTags(seed, session.myIdentityKeyFingerprint, session.theirIdentityKeyFingerprint);
    const allRealTags = [...new Set([...directionalTags, realTag])];
    const realTagSet = new Set(allRealTags);
    
    // Enregistrer chaque tag → session
    for (const tag of allRealTags) {
      if (!tagToSessionId.has(tag)) {
        tagToSessionId.set(tag, session.id);
        allRealTagsGlobal.push(tag);
      }
    }
    
    const processedIds = await getProcessedIds(session.id);
    sessionContexts.set(session.id, {
      realTagSet,
      processedIds,
      myFingerprint: session.myIdentityKeyFingerprint,
      session,
    });
  }
  
  if (allRealTagsGlobal.length === 0) {
    __DEV__ && console.log('[api1to1] 🔄 No tags to poll (all sessions have active foreground polling)');
    return;
  }
  
  // 2. Traiter par lots de FIXED_POLLING_TAG_COUNT pour couvrir tous les vrais tags
  // Si < 50 vrais tags → 1 seul appel, paddé à 50
  // Si > 50 vrais tags → plusieurs appels, chacun paddé à exactement 50
  const batches: string[][] = [];
  for (let i = 0; i < allRealTagsGlobal.length; i += FIXED_POLLING_TAG_COUNT) {
    const batchRealTags = allRealTagsGlobal.slice(i, i + FIXED_POLLING_TAG_COUNT);
    
    // Padder à exactement FIXED_POLLING_TAG_COUNT avec des decoys aléatoires
    const decoysNeeded = Math.max(0, FIXED_POLLING_TAG_COUNT - batchRealTags.length);
    const randomDecoys: string[] = [];
    for (let j = 0; j < decoysNeeded; j++) {
      const rb = getRandomBytes(32);
      randomDecoys.push(Array.from(rb).map(b => b.toString(16).padStart(2, '0')).join(''));
    }
    
    batches.push(csprngShuffleArray([...batchRealTags, ...randomDecoys]));
  }
  
  // 3. Exécuter les appels RPC (1 seul dans le cas courant)
  for (const batchTags of batches) {
    try {
      // DIAGNOSTIC: Log les vrais tags pollés (pas les decoys)
      const realTagsInBatch = batchTags.filter(t => allRealTagsGlobal.includes(t));
      console.log(`[api1to1] 🔍 DIAG batch poll: ${realTagsInBatch.length} real tags, ${batchTags.length - realTagsInBatch.length} decoys`);
      for (const rt of realTagsInBatch) {
        const sid = tagToSessionId.get(rt);
        console.log(`[api1to1] 🔍   tag: ${rt.slice(0, 16)}... → session: ${sid?.slice(0, 16)}...`);
      }
      
      const { data, error } = await secureRpc('get_messages_by_tags', {
        p_tags: batchTags,
        p_since: null, // Fetch tout, le filtrage par processedIds se fait côté client
        p_limit: 100,
      });
      
      // DIAGNOSTIC: Log what server returned
      console.log(`[api1to1] 🔍 DIAG server returned: ${data ? (Array.isArray(data) ? data.length + ' rows' : typeof data) : 'null'}, error: ${error ? error.message : 'none'}`);
      
      if (error) {
        console.error('[api1to1] 🔄 Batch fetch error:', error);
        continue;
      }
      
      if (!data || data.length === 0) {
        console.log('[api1to1] 🔍 DIAG batch: server returned 0 messages');
        continue;
      }
      
      // DIAGNOSTIC: Log all returned message tags
      for (const row of (data as ServerMessage[])) {
        const matched = tagToSessionId.has(row.tag);
        console.log(`[api1to1] 🔍 DIAG msg ${row.id.slice(0,8)} tag=${row.tag.slice(0,16)}... matched=${matched}`);
      }
      
      // 4. Dispatcher les résultats par session
      const messagesBySession = new Map<string, ServerMessage[]>();
      
      for (const row of (data as ServerMessage[])) {
        const sessionId = tagToSessionId.get(row.tag);
        if (!sessionId) continue; // Message sur un decoy → ignorer
        
        if (!messagesBySession.has(sessionId)) {
          messagesBySession.set(sessionId, []);
        }
        messagesBySession.get(sessionId)!.push(row);
      }
      
      console.log(`[api1to1] 🔍 DIAG dispatched: ${messagesBySession.size} sessions with messages`);
      
      // 5. Vérifier que la génération n'a pas changé (remount React)
      if (getPollGeneration() !== generation) {
        __DEV__ && console.log('[api1to1] 🔄 Stale generation, discarding batch results');
        return;
      }
      
      // 6. Traiter les messages de chaque session
      for (const [sessionId, rows] of messagesBySession) {
        const ctx = sessionContexts.get(sessionId);
        if (!ctx) continue;
        
        try {
          const messages = await processServerMessages(sessionId, rows, ctx);
          
          if (messages.length > 0) {
            __DEV__ && console.log('[api1to1] 🔄 Got', messages.length, 'messages for session:', sessionId.slice(0, 12) + '...');
            
            const deliveredIds: string[] = [];
            
            for (const message of messages) {
              // Router par type — même logique que fetchMessages1to1
              if (message.messageType === 'read_receipt' && message.readMessageIds) {
                for (const msgId of message.readMessageIds) {
                  await setMessageStatus(sessionId, msgId, 'read');
                }
                notifyStatusChange(sessionId, message.readMessageIds, 'read');
                // Mettre à jour les messages locaux aussi
                await updateLocalMessageStatus(sessionId, message.readMessageIds, 'read');
                
              } else if (message.messageType === 'delivered_receipt' && message.readMessageIds) {
                for (const msgId of message.readMessageIds) {
                  await setMessageStatus(sessionId, msgId, 'delivered');
                }
                notifyStatusChange(sessionId, message.readMessageIds, 'delivered');
                await updateLocalMessageStatus(sessionId, message.readMessageIds, 'delivered');
                
              } else if (message.messageType === 'reaction') {
                await receiveReaction(sessionId, message.targetMessageId!, message.emoji!, message.senderFingerprint!);
                notifyReaction(sessionId, message.targetMessageId!, message.emoji!, message.senderFingerprint!);
                
              } else if (message.messageType === 'call_signal' && message.callSignalType && message.callId) {
                __DEV__ && console.log(`[api1to1] 🔄📞 Received call signal via pollAll: ${message.callSignalType}`);
                notifyCallSignal(sessionId, {
                  type: message.callSignalType,
                  callId: message.callId,
                  roomTag: message.roomTag,
                  authToken: message.authToken,
                  senderKeyDistribution: message.senderKeyDistribution,
                  cryptoSignal: message.cryptoSignal,
                  callStartedAt: message.callStartedAt,
                  timestamp: message.timestamp,
                }, message.displayName, message.senderAvatarBase64);
                
              } else {
                // Message normal (texte, image, fichier, vocal)
                await saveLocalMessage1to1(sessionId, message);
                
                // v7.2: Marquer call-ended reçu (annule fallback callee)
                if (message.messageType === 'call' && message.callId && !message.isMine) {
                  import('./call1to1Service').then(({ markCallEndedReceived1to1 }) => {
                    markCallEndedReceived1to1(message.callId!);
                  }).catch(() => {});
                }
                
                await incrementUnreadCount(sessionId);
                deliveredIds.push(message.id);
              }
              
              // Notifier les callbacks globaux (toast, badge, etc.)
              for (const callback of globalPollState.newMessageCallbacks) {
                try {
                  callback(sessionId, message);
                } catch (e) {
                  console.error('[api1to1] Global callback error in pollAll:', e);
                }
              }
            }
            
            // Envoyer les accusés de livraison en batch (uniquement pour les vrais messages)
            if (deliveredIds.length > 0) {
              sendDeliveredReceipt1to1(sessionId, deliveredIds).catch(() => {});
            }
          }
        } catch (error) {
          console.error('[api1to1] 🔄 Process error for session:', sessionId.slice(0, 12) + '...', error);
        }
      }
    } catch (error) {
      console.error('[api1to1] 🔄 Batch poll RPC error:', error);
    }
  }
  
  __DEV__ && console.log('[api1to1] 🔄 Batch poll complete');
}

/**
 * BUG FIX: Traite des messages serveur pré-récupérés pour une session donnée.
 * Utilisé par pollAllSessions (batch polling) pour éviter les appels RPC par session.
 */
async function processServerMessages(
  sessionId: string,
  rows: ServerMessage[],
  ctx: {
    realTagSet: Set<string>;
    processedIds: Set<string>;
    myFingerprint: string;
    session: StoredSession;
  }
): Promise<Message1to1[]> {
  const messages: Message1to1[] = [];
  
  const realMessages = rows.filter(row => ctx.realTagSet.has(row.tag));
  if (realMessages.length === 0) return messages;
  
  for (const row of realMessages) {
    if (ctx.processedIds.has(row.id) || recentlySentIds.has(row.id) || inFlightOrProcessedIds.has(row.id)) {
      console.log(`[api1to1] 🔍 DIAG skip msg ${row.id.slice(0,8)}: processed=${ctx.processedIds.has(row.id)} sent=${recentlySentIds.has(row.id)} inflight=${inFlightOrProcessedIds.has(row.id)}`);
      continue;
    }
    
    let sealedPayload: SealedPayload;
    try {
      sealedPayload = JSON.parse(row.sealed_payload);
    } catch {
      continue;
    }
    
    // Ignorer les messages de handshake
    if (sealedPayload.type === 'ghostr_x3dh_response' || 
        sealedPayload.type === 'ghostr_invite_v1' ||
        sealedPayload.type === 'ghostr_accept_v1' ||
        sealedPayload.type === 'ghostr_invite_pq' ||
        sealedPayload.type === 'ghostr_accept_pq') {
      continue;
    }
    
    if (sealedPayload.type !== 'triple_ratchet_v1' && 
        sealedPayload.type !== 'triple_ratchet_v2' && 
        sealedPayload.type !== 'triple_ratchet_v3') {
      continue;
    }
    
    // Filtrer nos propres messages
    const messageTag = row.tag;
    const myHintInput = new TextEncoder().encode(ctx.myFingerprint + ':' + messageTag);
    const myHintHash = sha256(myHintInput);
    const myHint = Array.from(myHintHash.slice(0, 8))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    if (sealedPayload.version !== 3) {
      if (sealedPayload.senderHint && sealedPayload.senderHint === myHint) {
        await markIdAsProcessed(sessionId, row.id);
        continue;
      }
    }
    if (sealedPayload.senderFingerprint && sealedPayload.senderFingerprint === ctx.myFingerprint) {
      await markIdAsProcessed(sessionId, row.id);
      continue;
    }
    
    // Réclamer ce message AVANT le déchiffrement pour empêcher
    // le session poll de le traiter en parallèle
    inFlightOrProcessedIds.add(row.id);
    
    // Déchiffrer
    const message = await decryptServerMessage(sessionId, row, sealedPayload, ctx.myFingerprint);
    
    if (message && sealedPayload.version === 3) {
      const decryptedHint = (message as any)._senderHint;
      if (decryptedHint && decryptedHint === myHint) {
        await markIdAsProcessed(sessionId, row.id);
        continue;
      }
      if ((message as any)._senderHint) {
        delete (message as any)._senderHint;
      }
    }
    
    await markIdAsProcessed(sessionId, row.id);
    
    if (message) {
      // Mettre à jour le profil du contact
      if (message.displayName && message.displayName !== 'Anonyme') {
        const profileUpdate: { displayName: string; avatarBase64?: string } = { 
          displayName: message.displayName 
        };
        if (message.senderAvatarBase64) {
          profileUpdate.avatarBase64 = message.senderAvatarBase64;
        }
        sessionService.updateContactProfile(sessionId, profileUpdate).catch(err => {
          console.warn('[api1to1] Failed to update contact profile:', err);
        });
      }
      
      // v25.0: MEDIA CHUNK ASSEMBLY (batch polling path)
      if (message.messageType === 'media_chunk') {
        const chunkHeader: MediaChunkHeader = {
          mediaId: (message as any).mediaId || '',
          chunkIndex: (message as any).chunkIndex ?? -1,
          totalChunks: (message as any).totalChunks ?? 0,
          chunkData: (message as any).chunkData || '',
          payloadHash: (message as any).payloadHash || '',
          totalPayloadSize: (message as any).totalPayloadSize ?? 0,
        };
        
        if (!chunkHeader.mediaId || chunkHeader.chunkIndex < 0) continue;
        
        const assemblyResult = await processReceivedChunk(sessionId, chunkHeader);
        
        // v25.0: Reporter la progression de réception à l'UI
        reportChunkingReceiveProgress(
          chunkHeader.mediaId,
          sessionId,
          assemblyResult.receivedChunks,
          chunkHeader.totalChunks
        );
        
        if (!assemblyResult.complete) continue;
        
        // v25.0: Reporter la complétion de réception
        reportChunkingReceiveComplete(chunkHeader.mediaId);
        
        // Assemblage complet — reconstituer le message
        try {
          const originalInnerPayload: InnerPayload = JSON.parse(assemblyResult.originalPayload!);
          const assembledMessage: Message1to1 = {
            id: originalInnerPayload.messageId || `assembled-${chunkHeader.mediaId}`,
            sessionId,
            content: originalInnerPayload.content,
            timestamp: originalInnerPayload.timestamp,
            isMine: false,
            displayName: originalInnerPayload.displayName,
            senderAvatarBase64: originalInnerPayload.senderAvatarBase64,
            senderFingerprint: originalInnerPayload.senderFingerprint,
            messageType: originalInnerPayload.type,
            imageData: originalInnerPayload.imageData,
            thumbnailData: originalInnerPayload.thumbnailData,
            imageWidth: originalInnerPayload.imageWidth,
            imageHeight: originalInnerPayload.imageHeight,
            fileData: originalInnerPayload.fileData,
            fileName: originalInnerPayload.fileName,
            fileSize: originalInnerPayload.fileSize,
            fileMimeType: originalInnerPayload.fileMimeType,
            voiceData: originalInnerPayload.voiceData,
            voiceDuration: originalInnerPayload.voiceDuration,
            replyToId: originalInnerPayload.replyToId,
            replyToContent: originalInnerPayload.replyToContent,
            replyToSender: originalInnerPayload.replyToSender,
          };
          messages.push(assembledMessage);
        } catch (parseError) {
          console.error('[api1to1] ❌ Failed to parse assembled payload in batch:', parseError);
        }
        continue;
      }
      
      messages.push(message);
    }
  }
  
  return messages;
}


// ============================================
// STOCKAGE LOCAL
// ============================================

/**
 * Récupère TOUS les messages locaux (y compris protocole) - usage interne uniquement
 */
async function getAllLocalMessages1to1Internal(sessionId: string): Promise<Message1to1[]> {
  try {
    const key = MESSAGES_1TO1_PREFIX + sessionId;
    const stored = await secureGet(key);
    
    if (!stored) return [];
    
    const messages: Message1to1[] = JSON.parse(stored);
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  } catch (error) {
    console.error('[api1to1] Error loading local messages:', error);
    return [];
  }
}

/**
 * Récupère les messages locaux VISIBLES pour l'UI (filtre les messages de protocole)
 */
export async function getLocalMessages1to1(sessionId: string): Promise<Message1to1[]> {
  try {
    const messages = await getAllLocalMessages1to1Internal(sessionId);
    
    // v27.1: Migration progressive — strip les avatars inline des anciens messages PROPRES.
    // L'avatar des MES messages est résolu depuis myProfile (pas besoin de le stocker).
    // L'avatar des messages REÇUS est conservé (c'est la source d'avatar du contact).
    // Évite 200 msgs propres × 14KB = 2.8MB de JSON inutile dans AsyncStorage.
    if (!_migratedSessions.has(sessionId)) {
      let needsResave = false;
      for (const msg of messages) {
        if ((msg as any).isMine && (msg as any).senderAvatarBase64) {
          delete (msg as any).senderAvatarBase64;
          needsResave = true;
        }
      }
      if (needsResave) {
        // Re-save en arrière-plan (sans bloquer l'affichage)
        const key = MESSAGES_1TO1_PREFIX + sessionId;
        secureSet(key, JSON.stringify(messages)).catch(e =>
          console.warn('[api1to1] Background avatar migration save failed:', e)
        );
        __DEV__ && console.log(`[api1to1] 🧹 Stripped own avatars from messages for ${sessionId.slice(0, 12)}...`);
      }
      _migratedSessions.add(sessionId);
    }
    
    // v20.0: Filtrer les messages de protocole (ne doivent jamais apparaître dans l'UI)
    const visibleMessages = messages.filter(m => 
      !PROTOCOL_MESSAGE_TYPES.includes(m.messageType as MessageType)
    );
    
    return visibleMessages;
  } catch (error) {
    console.error('[api1to1] Error loading local messages:', error);
    return [];
  }
}

export async function saveLocalMessage1to1(sessionId: string, message: Message1to1): Promise<void> {
  try {
    // v20.0: Ne jamais sauvegarder les messages de protocole
    if (PROTOCOL_MESSAGE_TYPES.includes(message.messageType as MessageType)) {
      __DEV__ && console.log(`[api1to1] Skipping save of protocol message: ${message.messageType}`);
      return;
    }
    
    // v27.1: PERF — Ne pas stocker senderAvatarBase64 dans MES messages.
    // Mon avatar est résolu à l'affichage depuis myProfile.
    // L'avatar des messages REÇUS est conservé (seule source d'avatar du contact dans le message list).
    let strippedMessage: Message1to1;
    if (message.isMine) {
      const { senderAvatarBase64: _stripped, ...messageWithoutAvatar } = message;
      strippedMessage = messageWithoutAvatar as Message1to1;
    } else {
      strippedMessage = message;
    }
    
    const key = MESSAGES_1TO1_PREFIX + sessionId;
    // Utiliser la fonction interne pour récupérer TOUS les messages (y compris protocole)
    let existing = await getAllLocalMessages1to1Internal(sessionId);
    
    // Éviter les doublons — merge intelligent si le message existe déjà
    // v26.0: Nécessaire pour downloadMediaBlob qui met à jour imageData/fileData/voiceData
    // MAIS on ne doit PAS écraser un message qui a des données média (sender local)
    // avec un message du serveur qui n'en a pas (media_ref sans imageData).
    const existingIdx = existing.findIndex(m => m.id === strippedMessage.id);
    if (existingIdx >= 0) {
      const existingMsg = existing[existingIdx] as Record<string, any>;
      const incoming = strippedMessage as Record<string, any>;
      
      // Merge: garder les champs média existants si le nouveau message ne les a pas
      const MEDIA_DATA_FIELDS = ['imageData', 'thumbnailData', 'fileData', 'voiceData'];
      const merged = { ...existingMsg };
      
      // v27.1: Supprimer avatar résiduel uniquement pour MES messages
      if (merged.isMine) {
        delete merged.senderAvatarBase64;
      }
      
      for (const key of Object.keys(incoming)) {
        const val = incoming[key];
        if (val !== undefined && val !== null && val !== '') {
          merged[key] = val;
        }
      }
      
      // Préserver les données média existantes si le nouveau n'en a pas
      for (const field of MEDIA_DATA_FIELDS) {
        if (existingMsg[field] && !incoming[field]) {
          merged[field] = existingMsg[field];
        }
      }
      
      const externalizedUpdate = await externalizeMedia(sessionId, merged) as Message1to1;
      existing[existingIdx] = externalizedUpdate;
      await secureSet(key, JSON.stringify(existing));
      return;
    }
    
    // v25.2: MEDIA FILE STORE — Externaliser les données média vers le filesystem
    // Résout SQLITE_FULL: les base64 volumineux (images 500KB+, voix, fichiers)
    // sont écrits sur le filesystem, seule une ref ~80 bytes reste en SQLite.
    //
    // 1. Migrer les messages existants qui ont encore du base64 inline (one-time)
    if (!_migratedSessions.has(sessionId)) {
      const migration = await migrateMessagesToFileStore(sessionId, existing as Record<string, any>[]);
      if (migration.migrated) {
        existing = migration.messages as Message1to1[];
        __DEV__ && console.log(`[api1to1] 📦 Migrated existing messages to file store for ${sessionId.slice(0, 12)}...`);
      }
      _migratedSessions.add(sessionId);
    }
    
    // 2. Externaliser le nouveau message
    const externalizedMessage = await externalizeMedia(sessionId, strippedMessage as Record<string, any>) as Message1to1;
    existing.push(externalizedMessage);
    
    // Garder les 500 derniers messages
    if (existing.length > 500) {
      existing.splice(0, existing.length - 500);
    }
    
    await secureSet(key, JSON.stringify(existing));
  } catch (error) {
    console.error('[api1to1] Error saving local message:', error);
  }
}

/** Sessions déjà migrées vers le file store (évite re-migration) */
const _migratedSessions = new Set<string>();

// v16.0: Mettre à jour le statut des messages locaux
export async function updateLocalMessageStatus(
  sessionId: string, 
  messageIds: string[], 
  status: 'delivered' | 'read'
): Promise<void> {
  try {
    const key = MESSAGES_1TO1_PREFIX + sessionId;
    const messages = await getLocalMessages1to1(sessionId);
    
    let updated = false;
    for (const msg of messages) {
      if (messageIds.includes(msg.id) && msg.isMine) {
        // Ne mettre à jour que si le nouveau statut est "supérieur"
        if (status === 'read' || (status === 'delivered' && msg.status !== 'read')) {
          msg.status = status;
          updated = true;
        }
      }
    }
    
    if (updated) {
      await secureSet(key, JSON.stringify(messages));
      __DEV__ && console.log(`[api1to1] Updated ${messageIds.length} messages to status: ${status}`);
    }
  } catch (error) {
    console.error('[api1to1] Error updating local message status:', error);
  }
}

/**
 * v23.0: Met à jour le statut d'un seul message (pour le flux sending -> sent/failed)
 */
export async function updateSingleMessageStatus1to1(
  sessionId: string,
  messageId: string,
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
): Promise<void> {
  try {
    const key = MESSAGES_1TO1_PREFIX + sessionId;
    const messages = await getAllLocalMessages1to1Internal(sessionId);
    
    const msg = messages.find(m => m.id === messageId);
    if (msg) {
      msg.status = status;
      await secureSet(key, JSON.stringify(messages));
      __DEV__ && console.log(`[api1to1] Message ${messageId.slice(0, 8)}... status updated to: ${status}`);
      
      // Notifier les listeners du changement de statut
      notifyMessageStatusChange(sessionId, messageId, status);
    }
  } catch (error) {
    console.error('[api1to1] Error updating single message status:', error);
  }
}

// v23.0: Listeners pour les changements de statut de message
type MessageStatusListener = (sessionId: string, messageId: string, status: string) => void;
const messageStatusListeners = new Set<MessageStatusListener>();

export function onMessageStatusChange(listener: MessageStatusListener): () => void {
  messageStatusListeners.add(listener);
  return () => messageStatusListeners.delete(listener);
}

function notifyMessageStatusChange(sessionId: string, messageId: string, status: string): void {
  messageStatusListeners.forEach(listener => {
    try {
      listener(sessionId, messageId, status);
    } catch (e) {
      console.error('[api1to1] Message status listener error:', e);
    }
  });
}

/**
 * v23.0: Réessaie l'envoi d'un message échoué
 * Récupère le message du cache local et tente de le renvoyer
 */
export async function retryFailedMessage1to1(
  sessionId: string,
  messageId: string
): Promise<{ success: boolean; error?: string }> {
  __DEV__ && console.log(`[api1to1] 🔄 Retrying failed message: ${messageId.slice(0, 8)}...`);
  
  try {
    // Récupérer le message du cache
    const messages = await getAllLocalMessages1to1Internal(sessionId);
    const message = messages.find(m => m.id === messageId);
    
    if (!message) {
      return { success: false, error: 'Message not found' };
    }
    
    if (message.status !== 'failed') {
      __DEV__ && console.log(`[api1to1] Message is not failed (status: ${message.status}), skipping retry`);
      return { success: false, error: 'Message is not in failed state' };
    }
    
    // Mettre à jour le statut à 'sending'
    await updateSingleMessageStatus1to1(sessionId, messageId, 'sending');
    
    const session = sessionService.getSession(sessionId);
    if (!session) {
      await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
      return { success: false, error: 'Session not found' };
    }
    
    const myFingerprint = session.myIdentityKeyFingerprint;
    const myProfile = sessionService.getMyProfile();
    
    // Construire le payload selon le type de message
    let innerPayload: InnerPayload;
    
    switch (message.messageType) {
      case 'text':
        innerPayload = {
          type: 'text',
          content: message.content,
          senderFingerprint: myFingerprint,
          displayName: myProfile.displayName,
          senderAvatarBase64: myProfile.avatarBase64,
          timestamp: message.timestamp,
          messageId: message.id,
          ...(message.replyToId && {
            replyToId: message.replyToId,
            replyToContent: message.replyToContent,
            replyToSender: message.replyToSender,
          }),
        };
        break;
        
      case 'image':
        if (!message.imageData || !message.thumbnailData) {
          await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
          return { success: false, error: 'Missing image data' };
        }
        innerPayload = {
          type: 'image',
          content: message.content || '',
          senderFingerprint: myFingerprint,
          displayName: myProfile.displayName,
          senderAvatarBase64: myProfile.avatarBase64,
          timestamp: message.timestamp,
          messageId: message.id,
          imageData: message.imageData,
          thumbnailData: message.thumbnailData,
          imageWidth: message.imageWidth,
          imageHeight: message.imageHeight,
        };
        break;
        
      case 'voice':
        if (!message.voiceData) {
          await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
          return { success: false, error: 'Missing voice data' };
        }
        innerPayload = {
          type: 'voice',
          content: message.content,
          senderFingerprint: myFingerprint,
          displayName: myProfile.displayName,
          senderAvatarBase64: myProfile.avatarBase64,
          timestamp: message.timestamp,
          messageId: message.id,
          voiceData: message.voiceData,
          voiceDuration: message.voiceDuration,
        };
        break;
        
      case 'file':
        if (!message.fileData || !message.fileName) {
          await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
          return { success: false, error: 'Missing file data' };
        }
        innerPayload = {
          type: 'file',
          content: message.fileName,
          senderFingerprint: myFingerprint,
          displayName: myProfile.displayName,
          senderAvatarBase64: myProfile.avatarBase64,
          timestamp: message.timestamp,
          messageId: message.id,
          fileData: message.fileData,
          fileName: message.fileName,
          fileSize: message.fileSize,
          fileMimeType: message.fileMimeType,
        };
        break;
        
      default:
        await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
        return { success: false, error: `Unsupported message type: ${message.messageType}` };
    }
    
    // v25.0: sendInnerPayload gère automatiquement le chunking si nécessaire
    const result = await sendInnerPayload(sessionId, innerPayload);
    
    if (result.success) {
      await updateSingleMessageStatus1to1(sessionId, messageId, 'sent');
      __DEV__ && console.log(`[api1to1] ✅ Retry successful for: ${messageId.slice(0, 8)}...`);
      return { success: true };
    } else {
      await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
      console.error(`[api1to1] ❌ Retry failed for: ${messageId.slice(0, 8)}...`, result.error);
      return { success: false, error: result.error };
    }
  } catch (error) {
    await updateSingleMessageStatus1to1(sessionId, messageId, 'failed');
    console.error('[api1to1] Error retrying message:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * v23.0: Supprime un message échoué du cache local
 */
export async function deleteFailedMessage1to1(
  sessionId: string,
  messageId: string
): Promise<boolean> {
  try {
    const key = MESSAGES_1TO1_PREFIX + sessionId;
    const messages = await getAllLocalMessages1to1Internal(sessionId);
    
    const index = messages.findIndex(m => m.id === messageId && m.status === 'failed');
    if (index === -1) {
      __DEV__ && console.log(`[api1to1] Message ${messageId.slice(0, 8)}... not found or not failed`);
      return false;
    }
    
    messages.splice(index, 1);
    await secureSet(key, JSON.stringify(messages));
    __DEV__ && console.log(`[api1to1] 🗑️ Deleted failed message: ${messageId.slice(0, 8)}...`);
    return true;
  } catch (error) {
    console.error('[api1to1] Error deleting failed message:', error);
    return false;
  }
}

export async function clearLocalMessages1to1(sessionId: string): Promise<void> {
  try {
    const key = MESSAGES_1TO1_PREFIX + sessionId;
    await AsyncStorage.removeItem(key);
    
    const processedKey = PROCESSED_IDS_PREFIX + sessionId;
    await AsyncStorage.removeItem(processedKey);
    
    const pollKey = LAST_POLL_PREFIX + sessionId;
    await AsyncStorage.removeItem(pollKey);
    
    const statusKey = STATUS_PREFIX + sessionId;
    await AsyncStorage.removeItem(statusKey);
  } catch (error) {
    console.error('[api1to1] Error clearing local messages:', error);
  }
}

async function getLastPollTime(sessionId: string): Promise<Date | null> {
  try {
    const key = LAST_POLL_PREFIX + sessionId;
    const stored = await secureGet(key);
    if (!stored) return null;
    return new Date(stored);
  } catch {
    return null;
  }
}

async function setLastPollTime(sessionId: string, time: Date): Promise<void> {
  try {
    const key = LAST_POLL_PREFIX + sessionId;
    await secureSet(key, time.toISOString());
  } catch (error) {
    console.error('[api1to1] Error setting poll time:', error);
  }
}

// ============================================
// NETTOYAGE COMPLET
// ============================================

export async function clearAll1to1Data(): Promise<void> {
  __DEV__ && console.log('[api1to1] Clearing all 1-to-1 data...');
  
  try {
    stopPolling();
    
    // v25.0: Nettoyer les buffers d'assemblage de chunks média
    clearAllAssemblyBuffers();
    clearAvatarHashCache();
    clearAllMediaFiles();
    
    // Vider les callbacks
    statusCallbacks.clear();
    reactionCallbacks.clear();
    messageCallbacks.clear();
    pollState.callbacks.clear();
    
    const allKeys = await AsyncStorage.getAllKeys();
    
    const keysToDelete = allKeys.filter(key => 
      key.startsWith(MESSAGES_1TO1_PREFIX) ||
      key.startsWith(LAST_POLL_PREFIX) ||
      key.startsWith(PROCESSED_IDS_PREFIX) ||
      key.startsWith(STATUS_PREFIX)
    );
    
    if (keysToDelete.length > 0) {
      await AsyncStorage.multiRemove(keysToDelete);
      __DEV__ && console.log(`[api1to1] Deleted ${keysToDelete.length} keys`);
    }
    
    __DEV__ && console.log('[api1to1] ✅ All 1-to-1 data cleared');
  } catch (error) {
    console.error('[api1to1] Error clearing data:', error);
    throw error;
  }
}

// ============================================
// COMPTEUR MESSAGES NON LUS (v6.1)
// ============================================

/**
 * Récupère le nombre de messages non lus pour une session
 */
export async function getUnreadCount(sessionId: string): Promise<number> {
  try {
    const key = UNREAD_COUNT_PREFIX + sessionId;
    const stored = await secureGet(key);
    return stored ? parseInt(stored, 10) : 0;
  } catch (error) {
    console.error('[api1to1] Error getting unread count:', error);
    return 0;
  }
}

/**
 * Incrémente le compteur de messages non lus
 */
export async function incrementUnreadCount(sessionId: string): Promise<void> {
  try {
    const current = await getUnreadCount(sessionId);
    const key = UNREAD_COUNT_PREFIX + sessionId;
    await secureSet(key, (current + 1).toString());
  } catch (error) {
    console.error('[api1to1] Error incrementing unread count:', error);
  }
}

/**
 * Remet à zéro le compteur de messages non lus (quand on ouvre la conversation)
 */
export async function clearUnreadCount(sessionId: string): Promise<void> {
  try {
    const key = UNREAD_COUNT_PREFIX + sessionId;
    await secureSet(key, '0');
  } catch (error) {
    console.error('[api1to1] Error clearing unread count:', error);
  }
}

/**
 * Récupère les compteurs de non-lus pour toutes les sessions
 */
export async function getAllUnreadCounts(): Promise<Map<string, number>> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const unreadKeys = keys.filter(k => k.startsWith(UNREAD_COUNT_PREFIX));
    
    const result = new Map<string, number>();
    
    if (unreadKeys.length === 0) return result;
    
    for (const key of unreadKeys) {
      const value = await secureGet(key);
      if (value) {
        const sessionId = key.replace(UNREAD_COUNT_PREFIX, '');
        result.set(sessionId, parseInt(value, 10) || 0);
      }
    }
    
    return result;
  } catch (error) {
    console.error('[api1to1] Error getting all unread counts:', error);
    return new Map();
  }
}

// ============================================
// CONVERSION VERS LocalMessage
// ============================================

export function toLocalMessage(msg: Message1to1): LocalMessage {
  return {
    id: msg.id,
    conversationId: msg.sessionId,
    content: msg.content,
    senderToken: msg.isMine ? 'me' : (msg.senderFingerprint || 'them'),
    timestamp: msg.timestamp,
    isMine: msg.isMine,
    displayName: msg.displayName,
  };
}

export function toLocalMessages(messages: Message1to1[]): LocalMessage[] {
  return messages.map(toLocalMessage);
}

// ============================================
// POLLING GLOBAL (v6.1) - Pour toutes les sessions
// ============================================

interface GlobalPollState {
  isRunning: boolean;
  intervalId: ReturnType<typeof setTimeout> | null;
  lastPollTime: Date;
  newMessageCallbacks: Set<(sessionId: string, message: Message1to1) => void>;
}

const globalPollState: GlobalPollState = {
  isRunning: false,
  intervalId: null,
  lastPollTime: new Date(),
  newMessageCallbacks: new Set(),
};

/**
 * Démarre le polling global pour toutes les sessions 1-à-1
 * + constant-rate traffic (decoys automatiques toutes les ~90s)
 * À appeler au démarrage de l'app
 */
// FIX: Boostrap du sealed sender extrait dans une fonction réutilisable.
// Peut être appelée tôt (dès l'init de l'app) pour éviter l'attente
// au moment de créer une invitation.
let _sealedSenderBootstrapStarted = false;
let _sealedSenderBootstrapPromise: Promise<boolean> | null = null;

// ============================================
// POW PRE-COMPUTATION
// ============================================
// Le PoW est du pur CPU (~1-2s à 18 bits). Il n'a AUCUNE dépendance
// (ni relay, ni session, ni réseau). On le lance dès que possible
// pour qu'il tourne en parallèle avec sessionService.initialize() et initRelay().

let _precomputedPowPromise: Promise<{ pow: any; difficulty: number }> | null = null;

/**
 * Lance le calcul du PoW immédiatement, en arrière-plan.
 * À appeler dès le début de l'init de l'app (avant sessionService.initialize).
 * Le résultat sera attendu plus tard par ensureSealedSenderBootstrap.
 */
export function precomputePoW(): void {
  if (_precomputedPowPromise) return;
  __DEV__ && console.log('[api1to1] ⛏️ Pre-computing PoW in background...');
  
  _precomputedPowPromise = (async () => {
    const { computeProofOfWork, POW_DIFFICULTY_BITS } = await import('./proofOfWork');
    const pow = await computeProofOfWork(POW_DIFFICULTY_BITS);
    __DEV__ && console.log(`[api1to1] ⛏️ PoW pre-computed: nonce=${pow.nonce}, difficulty=${POW_DIFFICULTY_BITS}`);
    return { pow, difficulty: POW_DIFFICULTY_BITS };
  })();
}

export function ensureSealedSenderBootstrap(): Promise<boolean> {
  if (_sealedSenderBootstrapPromise) return _sealedSenderBootstrapPromise;
  _sealedSenderBootstrapStarted = true;
  
  __DEV__ && console.log('[api1to1] 🛡️ Starting sealed sender bootstrap...');
  
  _sealedSenderBootstrapPromise = bootstrapSealedSender(async (): Promise<SenderCertificate | null> => {
    // Récupérer le PoW pré-calculé (ou le calculer maintenant si pas encore lancé)
    if (!_precomputedPowPromise) {
      precomputePoW();
    }
    
    let { pow, difficulty } = await _precomputedPowPromise!;
    const MAX_RETRIES = 2;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Retry avec une difficulté plus haute — recalcul nécessaire
        const { computeProofOfWork } = await import('./proofOfWork');
        pow = await computeProofOfWork(difficulty);
        __DEV__ && console.log(`[api1to1] ⛏️ PoW re-computed: nonce=${pow.nonce}, difficulty=${difficulty} (retry #${attempt})`);
      }

      // Obtenir le certificat anonyme via le relay OHTTP (with PoW)
      const { data, error } = await secureRpc('get_sealed_certificate', { pow });
      
      // ACTION 8: Handle adaptive difficulty — server may require higher PoW during surge
      if (error && typeof error === 'object' && 'requiredDifficulty' in error) {
        const serverDifficulty = (error as any).requiredDifficulty;
        if (typeof serverDifficulty === 'number' && serverDifficulty > difficulty && attempt < MAX_RETRIES) {
          __DEV__ && console.log(`[api1to1] ⛏️ Server requires difficulty ${serverDifficulty} (surge mode), retrying...`);
          difficulty = serverDifficulty;
          continue;
        }
      }
      
      if (error || !data) {
        __DEV__ && console.warn('[api1to1] ❌ Failed to get sealed certificate:', error?.message || error);
        return null;
      }
      return data as SenderCertificate;
    }
    
    return null;
  }).then(ready => {
    if (ready) {
      __DEV__ && console.log('[api1to1] 🛡️ Sealed sender ACTIVE — messages are anonymous');
    } else {
      console.error('[api1to1] ❌ Sealed sender FAILED — all sends BLOCKED until bootstrap succeeds');
    }
    return ready;
  }).catch(() => false);
  
  return _sealedSenderBootstrapPromise;
}

/**
 * Reset l'état du bootstrap sealed sender pour forcer un nouveau cycle.
 * À appeler si le bootstrap a échoué et qu'on veut retenter.
 */
export function resetSealedSenderBootstrap(): void {
  _sealedSenderBootstrapStarted = false;
  _sealedSenderBootstrapPromise = null;
  _precomputedPowPromise = null;
}

/**
 * Attend que le bootstrap sealed sender soit terminé (PoW + certificat).
 * Boucle avec retries : si le bootstrap échoue, reset et relance.
 * Ne retourne true que quand sealed sender est réellement opérationnel.
 * 
 * @param onStatus - Callback optionnel pour afficher le statut sur le splash
 * @param maxRetries - Nombre max de tentatives (default: 5)
 * @returns true si sealed sender est prêt, false après épuisement des retries
 */
export async function waitForSealedSender(
  onStatus?: (msg: string) => void,
  maxRetries: number = 5
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // S'assurer que le bootstrap est lancé
    const bootstrapPromise = ensureSealedSenderBootstrap();
    
    if (attempt === 1) {
      onStatus?.('Préparation de la connexion sécurisée…');
    } else {
      onStatus?.(`Nouvelle tentative de connexion (${attempt}/${maxRetries})…`);
      __DEV__ && console.log(`[api1to1] 🔄 Sealed sender bootstrap retry ${attempt}/${maxRetries}`);
    }
    
    const result = await bootstrapPromise;
    
    if (result && isSealedSenderReady()) {
      __DEV__ && console.log(`[api1to1] ✅ Sealed sender ready (attempt ${attempt})`);
      return true;
    }
    
    // Bootstrap a échoué — reset pour permettre un nouveau cycle
    if (attempt < maxRetries) {
      __DEV__ && console.warn(`[api1to1] ⚠️ Sealed sender bootstrap failed (attempt ${attempt}/${maxRetries}), retrying...`);
      resetSealedSenderBootstrap();
      precomputePoW(); // Relancer le PoW aussi
      await new Promise(r => setTimeout(r, 2000)); // Pause 2s entre retries
    }
  }
  
  console.error(`[api1to1] ❌ Sealed sender bootstrap FAILED after ${maxRetries} attempts`);
  return false;
}

// ============================================
// v25.1: SESSION-TARGETED DECOY
// ============================================
//
// Pendant le drain de chunks média, les decoys interleaved sont envoyés
// au MÊME tag de session que les chunks réels. Le serveur ne peut plus
// distinguer les decoys des vrais chunks par le tag de routage.
//
// Le destinataire reçoit le message, tente le déchiffrement Triple Ratchet,
// échoue (ciphertext aléatoire) → drop silencieux. Le ratchet n'avance pas
// sur un échec de déchiffrement (lecture seule des chaînes de réception).
//
// AVANT: 37 chunks → tag X, 13 decoys → tags uniques → 100% distinguable
// APRÈS: 37 chunks → tag X, 13 decoys → tag X aussi → 0% distinguable
//

async function sendSessionDecoy(sessionId: string): Promise<void> {
  try {
    const session = sessionService.getSession(sessionId);
    if (!session) return;
    
    // Obtenir le vrai tag de session (identique à celui des chunks)
    const tag = getSessionTag(session);
    
    // Générer un payload medium-tier (même taille que les chunks)
    const payload = generateSizedPayload('medium');
    
    // Emballer dans une enveloppe sealed sender avec le VRAI tag
    if (!isSealedSenderReady()) return;
    const envelope = createSealedSenderEnvelope(tag, payload);
    
    await secureRpc('send_sealed_message', {
      p_tag: envelope.tag,
      p_sealed_content: envelope.sealedContent,
      p_version: envelope.version,
    });
    
    __DEV__ && console.log('[api1to1] 👻🎯 Session-targeted decoy sent to', sessionId.slice(0, 8) + '...');
    
  } catch (e) {
    // Decoy failures are silent
  }
}

export function startGlobalPolling1to1(): void {
  if (globalPollState.isRunning) return;
  
  globalPollState.isRunning = true;
  __DEV__ && console.log('[api1to1] 🌍 Starting global polling + constant-rate traffic');
  
  // Audit Fix C-01: Bootstrap du sealed sender (async, non-bloquant).
  // ACTION 01: Sealed sender est OBLIGATOIRE.
  ensureSealedSenderBootstrap();
  
  // Démarrer le constant-rate traffic en arrière-plan
  // 1 decoy par slot (~30s), poll toutes les ~45s
  startConstantTraffic(
    () => sendSingleDecoy(),            // Decoy normal (70% small, 30% medium)
    () => performGlobalPoll(),           // Fonction poll (récupère les messages)
    () => sendSingleDecoyMediumTier()    // v25.0: Decoy medium-tier pour interleaving chunks
    // v25.2: session-targeted decoys retirés — causaient des erreurs de
    // déchiffrement chez le destinataire (ratchet tentait de décrypter du random)
  );
  
  // Premier poll immédiat
  performGlobalPoll();
}

/**
 * Arrête le polling global + constant-rate traffic
 */
export function stopGlobalPolling1to1(): void {
  globalPollState.isRunning = false;
  resetSealedSenderBootstrap(); // FIX: Reset pour permettre un re-bootstrap au resume
  
  if (globalPollState.intervalId) {
    clearTimeout(globalPollState.intervalId);
    globalPollState.intervalId = null;
  }
  
  // Arrêter le constant-rate traffic
  stopConstantTraffic();
  
  __DEV__ && console.log('[api1to1] 🌍 Global polling + constant-rate traffic stopped');
}

/**
 * S'abonne aux nouveaux messages de toutes les sessions
 */
export function subscribeToAllMessages1to1(
  callback: (sessionId: string, message: Message1to1) => void
): () => void {
  globalPollState.newMessageCallbacks.add(callback);
  
  if (!globalPollState.isRunning) {
    startGlobalPolling1to1();
  }
  
  return () => {
    globalPollState.newMessageCallbacks.delete(callback);
  };
}

// scheduleNextGlobalPoll supprimé — le constant-rate traffic gère le scheduling

async function performGlobalPoll(): Promise<void> {
  try {
    // S'assurer que sessionService est initialisé
    await sessionService.initialize();
    
    // Récupérer toutes les sessions
    const sessions = sessionService.getAllSessions();
    
    if (sessions.length === 0) return;
    
    const openSessions = Array.from(pollState.callbacks.keys());
    __DEV__ && console.log('[api1to1] 🌍 Global poll tick, sessions:', sessions.length, ', open:', openSessions.length);
    
    for (const session of sessions) {
      try {
        // v6.1: Ne pas poller les sessions qui ont un polling actif (conversation ouverte)
        // Cela évite les conflits entre le polling global et le polling par session
        if (pollState.callbacks.has(session.id)) {
          continue;
        }
        
        // Vérifier les nouveaux messages pour cette session
        const messages = await fetchMessages1to1(session.id);
        
        if (messages.length > 0) {
          __DEV__ && console.log('[api1to1] 🌍 Got', messages.length, 'new messages for session:', session.id.slice(0, 12) + '...');
        }
        
        // Notifier les callbacks pour chaque nouveau message
        for (const message of messages) {
          for (const callback of globalPollState.newMessageCallbacks) {
            try {
              callback(session.id, message);
            } catch (e) {
              console.error('[api1to1] Global callback error:', e);
            }
          }
        }
      } catch (e) {
        console.error('[api1to1] Global poll error for session:', session.id, e);
      }
    }
  } catch (error) {
    console.error('[api1to1] Global poll exception:', error);
  }
}

/**
 * Force un poll immédiat de toutes les sessions
 */
export async function forceGlobalPoll1to1(): Promise<void> {
  await performGlobalPoll();
}

/**
 * Force un fetch immédiat des messages pour une session spécifique
 * et notifie les callbacks enregistrés.
 * Utile après la fin d'un appel pour afficher immédiatement le message "Appel terminé"
 */
export async function forceFetchAndNotify1to1(sessionId: string): Promise<void> {
  __DEV__ && console.log('[api1to1] 🔄 Force fetch for session:', sessionId.slice(0, 12) + '...');
  
  try {
    const messages = await fetchMessages1to1(sessionId);
    
    if (messages.length > 0) {
      __DEV__ && console.log('[api1to1] 🔄 Force fetch got', messages.length, 'new messages');
      
      // Notifier le callback de session si enregistré
      const callback = pollState.callbacks.get(sessionId);
      if (callback) {
        for (const msg of messages) {
          callback(msg);
        }
      }
      
      // Aussi notifier les callbacks de messages
      const msgCallbacks = messageCallbacks.get(sessionId) || [];
      for (const cb of msgCallbacks) {
        for (const msg of messages) {
          try {
            cb(msg);
          } catch (e) {
            console.error('[api1to1] Force fetch callback error:', e);
          }
        }
      }
    }
  } catch (error) {
    console.error('[api1to1] Force fetch error:', error);
  }
}

// ============================================
// DEBUG
// ============================================

export function getPollingDebugInfo(): {
  isRunning: boolean;
  activeSessionsCount: number;
  activeSessions: string[];
  globalPollingActive: boolean;
  globalCallbacksCount: number;
} {
  return {
    isRunning: pollState.isRunning,
    activeSessionsCount: pollState.callbacks.size,
    activeSessions: Array.from(pollState.callbacks.keys()),
    globalPollingActive: globalPollState.isRunning,
    globalCallbacksCount: globalPollState.newMessageCallbacks.size,
  };
}