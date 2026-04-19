// src/services/storage.ts
// Stockage sécurisé des clés et messages locaux
// v9.0 - AJOUT: Transmission cryptée des avatars dans les messages
//
// AMÉLIORATIONS v9.0:
// - getMyIdentity() inclut maintenant l'avatar
// - updateMessagesAvatarForSender() pour propager l'avatar aux messages précédents
// - getParticipantAvatar() pour récupérer l'avatar d'un participant
// - Avatar transmis dans le payload chiffré Double Ratchet
//
// AMÉLIORATIONS v8.0:
// - getGlobalAvatar() / setGlobalAvatar() pour gérer l'avatar photo
// - Avatar stocké en base64 (thumbnail 64x64 pour optimiser taille)
//
// AMÉLIORATIONS v7.1:
// - getConversationSenderToken() pour tokens non-corrélables entre conversations
// - Compatibilité ascendante avec getSenderToken() global pour anciens messages

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { deriveAllKeys, DerivedKeys, deriveConversationSenderToken } from './crypto';
import {
  encryptIfEnabled,
  decryptIfNeeded,
  decryptWithMigration,
  getCachedOrDecrypt,
  updateCache,
  invalidateCache,
  clearCache,
  setEncryptionKey as setLocalEncryptionKey,
  setEncryptionKeyAndRotate,
  clearEncryptionKey as clearLocalEncryptionKey,
  isEncryptionEnabled,
  initHardwareEncryption,
  transitionPinToHardware,
  opaqueStorageKey,
  setOpaqueKeySeed,
  clearOpaqueKeySeed,
} from './localCrypto';
import { getOrCreateHardwareConvKey, deleteHardwareKeys } from './hardwareKeyProvider';
// Legacy ratchet cleanup (inline, ratchetStorage.ts supprimé)
const LEGACY_RATCHET_PREFIX = 'whisper_ratchet_v1_';

// ============================================
// v15.2: SYSTÈME DE NOTIFICATION POUR MESSAGES D'APPEL UNIQUEMENT
// Permet aux hooks de recevoir les messages d'appel en temps réel
// NE PAS utiliser pour les messages normaux (ils ont leur propre système)
// ============================================

type CallMessageListener = (conversationId: string, message: LocalMessage) => void;
const callMessageListeners = new Set<CallMessageListener>();

/**
 * S'abonne aux nouveaux messages d'appel UNIQUEMENT
 * Retourne une fonction pour se désabonner
 */
export function subscribeToCallMessages(listener: CallMessageListener): () => void {
  callMessageListeners.add(listener);
  return () => {
    callMessageListeners.delete(listener);
  };
}

/**
 * Notifie tous les listeners d'un nouveau message d'appel
 * À appeler UNIQUEMENT pour les messages d'appel, pas pour les messages normaux
 */
export function notifyCallMessageAdded(conversationId: string, message: LocalMessage): void {
  __DEV__ && console.log(`📦 Notifying call message listeners for ${conversationId.slice(0, 8)}...`);
  callMessageListeners.forEach(listener => {
    try {
      listener(conversationId, message);
    } catch (error) {
      __DEV__ && console.error('Error in call message listener:', error);
    }
  });
}

// ============================================
// TYPES
// ============================================

export interface StoredConversation {
  id: string;                  // ID de conversation (dérivé) - usage LOCAL uniquement
  tag: string;                 // Tag anonyme pour le serveur (32 chars hex)
  name: string;                // Nom donné par l'utilisateur
  masterKeyBase64: string;     // Clé master en base64 (pour recalculer les dérivées)
  createdAt: number;
  lastMessageAt?: number;
  unreadCount?: number;
  lastPollAt?: number;         // Dernier polling pour cette conversation
  hasSession?: boolean;        // Signal Protocol
  safetyNumberVerified?: boolean;
  // v7.0 - Identity (commitment uniquement, pseudo est global)
  identityCommitment?: string; // Mon commitment pré-calculé pour cette conversation
  // v7.1 - SenderToken par conversation (cache)
  conversationSenderToken?: string;
}

export interface LocalMessage {
  id: string;
  conversationId: string;
  content: string;
  senderToken: string;
  timestamp: number;
  isMine: boolean;
  // v7.0 - Identity
  displayName?: string;          // Pseudo de l'expéditeur
  identityCommitment?: string;   // Commitment de l'expéditeur
  identityWarning?: boolean;     // Alerte si le commitment a changé
  // v8.0 - Avatar
  avatarBase64?: string;         // Avatar thumbnail en base64 (64x64)
}

// v7.0 - Participant d'une conversation
export interface ConversationParticipant {
  senderToken: string;
  displayName: string;
  identityCommitment: string;
  firstSeenAt: number;
  lastSeenAt: number;
  messageCount: number;
  // v8.0 - Avatar
  avatarBase64?: string;
}

// v8.0 - Profil utilisateur complet
export interface UserProfile {
  displayName: string;
  avatarBase64?: string;  // Image en base64 (data:image/jpeg;base64,...)
}

// v9.0 - Type étendu pour l'identité avec avatar
export interface MyIdentity {
  displayName: string | undefined;
  identityCommitment: string | undefined;
  discriminator: string | undefined;
  avatarBase64: string | undefined;  // v9.0 - NOUVEAU: Avatar pour transmission
}

// ============================================
// CONSTANTES
// ============================================

const CONVERSATIONS_KEY = 'whisper_conversations_v3';
const CONVERSATIONS_KEY_ENCRYPTED = 'whisper_conversations_encrypted_v6';
const SENDER_TOKEN_KEY = 'whisper_sender_token';
const USER_SECRET_KEY = 'whisper_user_secret_v1';
// Clés opaques pour le profil — ne révèlent pas le type de données stockées
const OPAQUE_DISPLAY_NAME_KEY = 'g_pd_v1';
const OPAQUE_AVATAR_KEY = 'g_pa_v1';
const MESSAGES_PREFIX = 'whisper_messages_';
const DELETED_IDS_PREFIX = 'whisper_deleted_';
const LAST_SEEN_PREFIX = 'whisper_lastseen_';
const PARTICIPANTS_PREFIX = 'whisper_participants_';

// ============================================
// ACTION 5: OPAQUE KEY HELPERS
// ============================================

/**
 * Génère la clé AsyncStorage opaque pour les données d'une conversation.
 * Quand le seed opaque est initialisé, les noms de clés sont hashés
 * pour cacher les métadonnées (nombre de conversations, IDs, etc.).
 */
function msgKey(conversationId: string): string {
  return opaqueStorageKey(MESSAGES_PREFIX + conversationId);
}

function deletedKey(conversationId: string): string {
  return opaqueStorageKey(DELETED_IDS_PREFIX + conversationId);
}

function lastSeenKey(conversationId: string): string {
  return opaqueStorageKey(LAST_SEEN_PREFIX + conversationId);
}

function participantsKey(conversationId: string): string {
  return opaqueStorageKey(PARTICIPANTS_PREFIX + conversationId);
}

// ============================================
// GESTION CLÉS DE CHIFFREMENT
// ============================================

let conversationsEncryptionKey: Uint8Array | null = null;

// ACTION-04: Hardware-backed key for conversations (separate from PIN key).
// Same pattern as localCrypto: invisible to the rest of the code.
let conversationsHardwareKey: Uint8Array | null = null;

/** Returns the active conversations key: PIN key takes priority over hardware key. */
function getActiveConvKey(): Uint8Array | null {
  return conversationsEncryptionKey || conversationsHardwareKey;
}

export function setEncryptionKey(
  localKey: Uint8Array | string | null,
  convKey?: Uint8Array | string | null
): void {
  setLocalEncryptionKey(localKey);
  
  if (convKey !== undefined) {
    if (convKey === null) {
      conversationsEncryptionKey = null;
    } else if (typeof convKey === 'string') {
      conversationsEncryptionKey = decodeBase64(convKey);
    } else {
      conversationsEncryptionKey = convKey;
    }
  } else if (localKey !== null) {
    if (typeof localKey === 'string') {
      conversationsEncryptionKey = decodeBase64(localKey);
    } else {
      conversationsEncryptionKey = localKey;
    }
  }
}

/**
 * Définit les clés de chiffrement ET déclenche la rotation anti-forensique.
 * Appelé au déverrouillage de l'app (LockScreen, SecurityScreen).
 *
 * ANTI-FORENSIQUE: La clé locale est rotée à chaque unlock via HKDF.
 * Un dump pris avant le dernier unlock ne peut plus être déchiffré.
 */
export async function setEncryptionKeys(
  localKey: Uint8Array | null,
  convKey: Uint8Array | null
): Promise<void> {
  if (localKey) {
    // ══════════════════════════════════════════════════════════════════
    // FIX: MIGRATION DES CLÉS OPAQUES ASYNCSTORAGE
    // ══════════════════════════════════════════════════════════════════
    // Quand on passe de hardware encryption → PIN encryption (ou inversement),
    // le seed opaque change → les noms de clés AsyncStorage changent.
    // reencryptAllEntries() re-chiffre les VALEURS en place mais ne renomme
    // pas les CLÉS. Il faut donc renommer les clés AVANT de changer le seed.
    //
    // On collecte les anciens noms opaques (avec l'ancien seed), on calcule
    // les nouveaux noms (avec le nouveau seed), et on renomme dans AsyncStorage.
    // ══════════════════════════════════════════════════════════════════

    // 1. Calculer le NOUVEAU seed (sans l'activer encore)
    const { sha256 } = await import('@noble/hashes/sha256');
    const seedInput = new Uint8Array(localKey.length + 11);
    seedInput.set(localKey, 0);
    seedInput.set(new TextEncoder().encode('opaque-seed'), localKey.length);
    const newSeed = sha256(seedInput);

    // 2. Migrer les clés opaques SI le seed va changer
    //    (= premier setup PIN, ou transition hardware → PIN)
    //    On le fait AVANT de changer le seed pour pouvoir calculer
    //    les anciens noms avec l'ancien seed.
    try {
      await migrateOpaqueKeys(newSeed);
    } catch (e) {
      __DEV__ && console.error('[storage] ⚠️ Opaque key migration error (non-fatal):', e);
    }

    // 3. Activer le nouveau seed
    setOpaqueKeySeed(newSeed);
    
    // Rotation de la clé locale (HKDF + re-chiffrement des sessions)
    await setEncryptionKeyAndRotate(localKey);
  } else {
    setLocalEncryptionKey(null);
    clearOpaqueKeySeed();
  }
  
  // ACTION-04 FIX: Re-encrypt conversations when transitioning keys.
  // If conversations are encrypted with the old key (e.g. hardware key),
  // we must read them with the old key before switching to the new one.
  if (convKey && getActiveConvKey()) {
    try {
      // Read with old key (getActiveConvKey() returns hardware or PIN key)
      const conversations = await getConversations();
      // Switch to new PIN key
      conversationsEncryptionKey = convKey;
      // Re-write with new key (getActiveConvKey() now returns PIN key)
      await saveConversations(conversations);
      __DEV__ && console.log('[storage] 🔄 Conversations re-encrypted with new key');
    } catch (e) {
      __DEV__ && console.error('[storage] ⚠️ Failed to re-encrypt conversations:', e);
      conversationsEncryptionKey = convKey;
    }
  } else {
    conversationsEncryptionKey = convKey;
  }
}

/**
 * Migre les noms de clés opaques AsyncStorage quand le seed change.
 *
 * Scénario: L'utilisateur a des données stockées avec seed_HW (hardware)
 * et active un PIN → seed_PIN. Les noms de clés changent.
 * Cette fonction renomme les entrées AsyncStorage de l'ancien nom vers le nouveau.
 *
 * IMPORTANT: Doit être appelée AVANT de changer le seed opaque.
 *
 * @param newSeed - Le nouveau seed qui sera activé après la migration
 */
async function migrateOpaqueKeys(newSeed: Uint8Array): Promise<void> {
  // Récupérer les conversation IDs depuis la liste chiffrée (SecureStore)
  // qui n'est PAS affectée par les clés opaques
  let conversations: StoredConversation[];
  try {
    conversations = await getConversations();
  } catch {
    return; // Pas de conversations → rien à migrer
  }

  if (conversations.length === 0) return;

  // Les préfixes de clés AsyncStorage liés aux conversations
  const PREFIXES = [
    MESSAGES_PREFIX,       // whisper_messages_
    DELETED_IDS_PREFIX,    // whisper_deleted_
    LAST_SEEN_PREFIX,      // whisper_lastseen_
    PARTICIPANTS_PREFIX,   // whisper_participants_
  ];

  // Fonction helper pour calculer un opaque key avec un seed spécifique
  const computeOpaque = (readableKey: string, seed: Uint8Array): string => {
    const { sha256: sha256Sync } = require('@noble/hashes/sha256');
    const keyBytes = new TextEncoder().encode(readableKey);
    const combined = new Uint8Array(seed.length + keyBytes.length);
    combined.set(seed, 0);
    combined.set(keyBytes, seed.length);
    const hash = sha256Sync(combined);
    const hex = Array.from(hash.slice(0, 16))
      .map((b: number) => b.toString(16).padStart(2, '0'))
      .join('');
    return 'g_' + hex;
  };

  // Collecter les renommages à effectuer
  const renames: [string, string][] = []; // [oldKey, newKey]

  for (const conv of conversations) {
    for (const prefix of PREFIXES) {
      const readableName = prefix + conv.id;

      // Calculer l'ancien nom (avec le seed actuel, encore actif)
      const oldName = opaqueStorageKey(readableName);

      // Calculer le nouveau nom (avec le nouveau seed)
      const newName = computeOpaque(readableName, newSeed);

      // Ne renommer que si les noms diffèrent
      if (oldName !== newName) {
        renames.push([oldName, newName]);
      }
    }
  }

  if (renames.length === 0) {
    __DEV__ && console.log('[storage] ✅ Opaque keys already aligned, no migration needed');
    return;
  }

  __DEV__ && console.log(`[storage] 🔄 Migrating ${renames.length} opaque AsyncStorage keys...`);

  // Effectuer les renommages (read old → write new → delete old)
  let migrated = 0;
  let skipped = 0;
  for (const [oldKey, newKey] of renames) {
    try {
      const value = await AsyncStorage.getItem(oldKey);
      if (value !== null) {
        await AsyncStorage.setItem(newKey, value);
        await AsyncStorage.removeItem(oldKey);
        migrated++;
      } else {
        skipped++; // Clé n'existait pas (normal si conversation vide)
      }
    } catch (e) {
      __DEV__ && console.error(`[storage] ⚠️ Failed to rename ${oldKey.slice(0, 10)}... → ${newKey.slice(0, 10)}...`, e);
    }
  }

  __DEV__ && console.log(`[storage] ✅ Opaque key migration: ${migrated} migrated, ${skipped} skipped`);
}

export function getEncryptionKey(): Uint8Array | null {
  const { getEncryptionKey: getKey } = require('./localCrypto');
  return getKey();
}

export function clearEncryptionKey(): void {
  clearLocalEncryptionKey();
  if (conversationsEncryptionKey) {
    conversationsEncryptionKey.fill(0);
  }
  conversationsEncryptionKey = null;

  // Vider le cache des tokens de conversation en mémoire.
  // Sans ça, les tokens restaient en RAM après verrouillage → un memory dump
  // pouvait révéler les mappings conversation-token.
  clearConversationTokenCache();

  // Verrouiller la mémoire de SessionService : zéroise toutes les clés privées
  // (identité Ed25519 + X25519, signed pre-keys, OTPKs, PQ signed keys, anciennes
  //  clés archivées, états de ratchet actifs et leurs header/chain keys).
  // require() synchrone + try/catch pour éviter les cycles d'import et gérer
  // le cas où le module ne serait pas encore chargé (premier démarrage).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sessionService } = require('./tripleRatchet');
    if (sessionService && typeof sessionService.lockMemory === 'function') {
      sessionService.lockMemory();
    }
  } catch (e) {
    __DEV__ && console.error('[storage] sessionService.lockMemory failed:', e);
  }
}

export { isEncryptionEnabled };

/**
 * ACTION-04 (Phase 2 Security): Initialize hardware-backed encryption for ALL local data.
 * Sets both the AsyncStorage encryption key (localCrypto) and the conversations encryption key.
 * Called at app startup when no PIN is configured.
 */
export async function initHardwareEncryptionAll(): Promise<boolean> {
  try {
    const localOk = await initHardwareEncryption();
    if (!localOk) return false;
    
    const hwConvKey = await getOrCreateHardwareConvKey();
    // Set HARDWARE conv key, NOT conversationsEncryptionKey.
    // conversationsEncryptionKey stays null → PIN-specific code unaffected.
    conversationsHardwareKey = new Uint8Array(hwConvKey);
    
    // ACTION 5: Initialize opaque key seed from hardware key
    const { sha256 } = await import('@noble/hashes/sha256');
    const seedInput = new Uint8Array(hwConvKey.length + 11);
    seedInput.set(hwConvKey, 0);
    seedInput.set(new TextEncoder().encode('opaque-seed'), hwConvKey.length);
    setOpaqueKeySeed(sha256(seedInput));
    
    __DEV__ && console.log('[storage] 🔒 Hardware encryption initialized for all local data');
    return true;
  } catch (error) {
    __DEV__ && console.error('[storage] ❌ Hardware encryption init failed:', error);
    return false;
  }
}

/**
 * Transition ALL encrypted data from PIN-based keys to hardware-backed keys.
 * Called when the user disables the lock/PIN protection.
 *
 * Without this step, disabling the PIN leaves data encrypted with PIN-derived
 * keys that no longer exist on next app start → everything becomes unreadable.
 *
 * Handles both layers:
 *   1. AsyncStorage (messages, sessions, ratchet states) via localCrypto
 *   2. Conversations list via storage's own encryption
 */
export async function transitionToHardwareEncryption(): Promise<boolean> {
  try {
    // 1. Transition AsyncStorage entries (localCrypto layer)
    const localOk = await transitionPinToHardware();
    if (!localOk) {
      __DEV__ && console.error('[storage] transitionToHardwareEncryption: localCrypto transition failed');
      return false;
    }

    // 2. Transition conversations (storage layer)
    // Read with current active key (still PIN key at this point for conversations)
    const conversations = await getConversations();

    // Switch to hardware conversation key
    const hwConvKey = await getOrCreateHardwareConvKey();
    if (conversationsEncryptionKey) {
      conversationsEncryptionKey.fill(0);
    }
    conversationsEncryptionKey = null;
    conversationsHardwareKey = new Uint8Array(hwConvKey);

    // Re-write conversations encrypted with hardware key
    await saveConversations(conversations);

    // 3. Update opaque key seed from hardware key
    const { sha256 } = await import('@noble/hashes/sha256');
    const seedInput = new Uint8Array(hwConvKey.length + 11);
    seedInput.set(hwConvKey, 0);
    seedInput.set(new TextEncoder().encode('opaque-seed'), hwConvKey.length);
    const newSeed = sha256(seedInput);

    // FIX: Migrate opaque AsyncStorage key names BEFORE changing the seed.
    // Without this, data stored under PIN-derived opaque names becomes
    // invisible after the seed switches to the hardware-derived one.
    try {
      await migrateOpaqueKeys(newSeed);
    } catch (e) {
      __DEV__ && console.error('[storage] ⚠️ Opaque key migration error (PIN→HW):', e);
    }

    setOpaqueKeySeed(newSeed);

    __DEV__ && console.log('[storage] ✅ Full transition PIN → hardware encryption complete');
    return true;
  } catch (error) {
    __DEV__ && console.error('[storage] ❌ transitionToHardwareEncryption failed:', error);
    return false;
  }
}

// ============================================
// CHIFFREMENT CONVERSATIONS
// ============================================

function encryptConversations(data: string): string {
  const key = getActiveConvKey();
  if (!key) {
    return data;
  }
  
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const dataBytes = new TextEncoder().encode(data);
  const encrypted = nacl.secretbox(dataBytes, nonce, key);
  
  if (!encrypted) {
    throw new Error('Conversations encryption failed');
  }
  
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  
  return 'enc_conv_v6:' + encodeBase64(combined);
}

function decryptConversations(data: string): string {
  if (!data.startsWith('enc_conv_v6:')) {
    return data;
  }
  
  const key = getActiveConvKey();
  if (!key) {
    throw new Error('Conversations are encrypted but no key is available');
  }
  
  const combined = decodeBase64(data.slice('enc_conv_v6:'.length));
  const nonce = combined.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = combined.slice(nacl.secretbox.nonceLength);
  
  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  
  if (!decrypted) {
    throw new Error('Conversations decryption failed');
  }
  
  return new TextDecoder().decode(decrypted);
}

// ============================================
// TOKEN EXPÉDITEUR - GLOBAL (legacy)
// ============================================

/**
 * Récupère le SenderToken GLOBAL (legacy)
 * 
 * ⚠️ ATTENTION: Ce token est le même pour toutes les conversations.
 * Utilisé uniquement pour:
 * - Compatibilité avec anciens messages (v6 et avant)
 * - Initialisation du ratchet (pour le hash de départ)
 * 
 * Pour les nouveaux messages, utiliser getConversationSenderToken()
 */
export async function getSenderToken(): Promise<string> {
  let token = await SecureStore.getItemAsync(SENDER_TOKEN_KEY);
  
  if (!token) {
    const { generateSenderToken } = await import('./crypto');
    token = await generateSenderToken();
    await SecureStore.setItemAsync(SENDER_TOKEN_KEY, token);
  }
  
  return token;
}

// ============================================
// TOKEN EXPÉDITEUR - PAR CONVERSATION (v7.1)
// ============================================

/**
 * Cache mémoire des tokens par conversation
 * Évite les recalculs HKDF répétés
 */
const conversationTokenCache = new Map<string, string>();

/**
 * Récupère le SenderToken UNIQUE pour une conversation
 * 
 * CORRECTION SÉCURITÉ v7.1:
 * Ce token est dérivé de: HKDF(userSecret || masterKey, "sender-token")
 * 
 * Propriétés:
 * - Différent pour chaque conversation → pas de corrélation cross-conversation
 * - Déterministe → même utilisateur = même token dans une conversation
 * - Impossible à prédire sans userSecret
 * 
 * @param conversationId - L'ID de la conversation
 * @returns Token unique en base64 (22 chars)
 */
export async function getConversationSenderToken(conversationId: string): Promise<string> {
  // 1. Vérifier le cache mémoire
  const cached = conversationTokenCache.get(conversationId);
  if (cached) {
    return cached;
  }
  
  // 2. Vérifier le cache persistant dans la conversation
  const conv = await getConversation(conversationId);
  if (conv?.conversationSenderToken) {
    conversationTokenCache.set(conversationId, conv.conversationSenderToken);
    return conv.conversationSenderToken;
  }
  
  // 3. Générer le token
  const masterKey = await getMasterKey(conversationId);
  if (!masterKey) {
    // Fallback sur le token global si pas de masterKey (ne devrait pas arriver)
    __DEV__ && console.warn('⚠️ getConversationSenderToken: No masterKey, falling back to global token');
    return getSenderToken();
  }
  
  const userSecret = await getOrCreateUserSecret();
  const token = await deriveConversationSenderToken(masterKey, userSecret);
  
  // 4. Sauvegarder dans le cache persistant
  await updateConversationSenderToken(conversationId, token);
  
  // 5. Mettre en cache mémoire
  conversationTokenCache.set(conversationId, token);
  
  return token;
}

/**
 * Met à jour le cache du token dans la conversation
 */
async function updateConversationSenderToken(conversationId: string, token: string): Promise<void> {
  const conversations = await getConversations();
  const conv = conversations.find(c => c.id === conversationId);
  if (conv) {
    conv.conversationSenderToken = token;
    await saveConversations(conversations);
  }
}

/**
 * Vérifie si un message vient de moi
 * Supporte à la fois l'ancien token global et le nouveau token par conversation
 * 
 * @param senderToken - Le token du message
 * @param conversationId - L'ID de la conversation
 * @returns true si c'est mon message
 */
export async function isMyMessage(senderToken: string, conversationId: string): Promise<boolean> {
  // Vérifier le nouveau token par conversation
  const myConvToken = await getConversationSenderToken(conversationId);
  if (senderToken === myConvToken) {
    return true;
  }
  
  // Fallback: vérifier l'ancien token global (pour anciens messages)
  const myGlobalToken = await getSenderToken();
  return senderToken === myGlobalToken;
}

/**
 * Vide le cache des tokens (appelé au verrouillage)
 */
export function clearConversationTokenCache(): void {
  conversationTokenCache.clear();
}

// ============================================
// USER SECRET (v7.0 - Identity Commitment)
// ============================================

/**
 * Récupère ou génère le secret utilisateur unique
 * Ce secret est utilisé pour générer les identity commitments
 * Il ne doit JAMAIS être partagé ou exporté
 */
export async function getOrCreateUserSecret(): Promise<Uint8Array> {
  let secretBase64 = await SecureStore.getItemAsync(USER_SECRET_KEY);
  
  if (!secretBase64) {
    // Générer un nouveau secret de 32 bytes
    const { getRandomBytesAsync } = await import('expo-crypto');
    const randomBytes = await getRandomBytesAsync(32);
    const secret = new Uint8Array(randomBytes);
    secretBase64 = encodeBase64(secret);
    await SecureStore.setItemAsync(USER_SECRET_KEY, secretBase64);
    __DEV__ && console.log('🔑 User secret generated');
  }
  
  return decodeBase64(secretBase64);
}

// ============================================
// PSEUDO GLOBAL (v7.0)
// ============================================

/**
 * Vérifie si le pseudo global est défini.
 * 
 * IMPORTANT : cette fonction est appelée dans le fast path de App.tsx
 * AVANT l'initialisation de la crypto. Elle ne doit PAS tenter de
 * déchiffrer — elle vérifie uniquement l'existence de la clé.
 * setGlobalDisplayName() valide que le nom est non-vide avant stockage,
 * donc si la clé existe et a du contenu, un profil est configuré.
 */
export async function hasGlobalDisplayName(): Promise<boolean> {
  try {
    // Vérifier l'existence sans déchiffrer (pas de crypto à ce stade)
    const raw = await AsyncStorage.getItem(OPAQUE_DISPLAY_NAME_KEY);
    if (raw && raw.length > 0) return true;
    
    // Fallback : sessionService peut avoir le profil si désynchronisation.
    // On vérifie seulement l'existence + parsing JSON (pas de decrypt ici,
    // la synchro vers OPAQUE_DISPLAY_NAME_KEY se fera au prochain
    // getGlobalDisplayName() quand la crypto sera initialisée).
    const sessionProfile = await AsyncStorage.getItem('ghostr_pq_my_profile');
    if (sessionProfile) {
      try {
        // Tenter le parse direct (données non chiffrées ou profil en clair)
        const profile = JSON.parse(sessionProfile);
        if (profile.displayName && 
            profile.displayName.trim().length > 0 && 
            profile.displayName !== 'Anonymous') {
          return true;
        }
      } catch {
        // JSON parse failed — probablement chiffré, on ne peut pas lire ici.
        // Ce n'est pas grave : après unlock/crypto init, getGlobalDisplayName()
        // sera appelé et pourra déchiffrer + synchroniser.
        // On retourne true car la présence de données (même chiffrées) indique
        // qu'un profil existe.
        return sessionProfile.length > 0;
      }
    }
    
    return false;
  } catch (error) {
    __DEV__ && console.error('❌ hasGlobalDisplayName error:', error);
    return false;
  }
}

/**
 * Récupère le pseudo global
 */
export async function getGlobalDisplayName(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(OPAQUE_DISPLAY_NAME_KEY);
    if (!raw) return null;
    return decryptIfNeeded(raw) || null;
  } catch (error) {
    __DEV__ && console.error('❌ getGlobalDisplayName error:', error);
    return null;
  }
}

/**
 * Définit le pseudo global
 */
export async function setGlobalDisplayName(name: string): Promise<void> {
  if (!name || name.trim().length === 0) {
    throw new Error('Le pseudo ne peut pas être vide');
  }
  try {
    await AsyncStorage.setItem(OPAQUE_DISPLAY_NAME_KEY, encryptIfEnabled(name.trim()));
  } catch (error) {
    __DEV__ && console.error('❌ setGlobalDisplayName error:', error);
    throw error;
  }
}

// ============================================
// AVATAR GLOBAL (v8.0)
// ============================================

/**
 * Récupère l'avatar global
 * @returns Avatar en base64 (data:image/...) ou null
 */
export async function getGlobalAvatar(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(OPAQUE_AVATAR_KEY);
    if (!raw) return null;
    return decryptIfNeeded(raw) || null;
  } catch (error) {
    __DEV__ && console.error('Failed to get avatar:', error);
    return null;
  }
}

/**
 * Définit l'avatar global
 * @param avatarBase64 - Image en base64 (data:image/...) ou null pour supprimer
 */
export async function setGlobalAvatar(avatarBase64: string | null): Promise<void> {
  try {
    if (avatarBase64) {
      await AsyncStorage.setItem(OPAQUE_AVATAR_KEY, encryptIfEnabled(avatarBase64));
    } else {
      await AsyncStorage.removeItem(OPAQUE_AVATAR_KEY);
    }
  } catch (error) {
    __DEV__ && console.error('Failed to set avatar:', error);
    throw error;
  }
}

/**
 * Récupère le profil complet de l'utilisateur
 */
export async function getUserProfile(): Promise<UserProfile | null> {
  const displayName = await getGlobalDisplayName();
  if (!displayName) return null;
  
  const avatarBase64 = await getGlobalAvatar();
  
  return {
    displayName,
    avatarBase64: avatarBase64 || undefined,
  };
}

/**
 * Vérifie si l'utilisateur a un profil complet (au minimum un pseudo)
 */
export async function hasUserProfile(): Promise<boolean> {
  return hasGlobalDisplayName();
}

// ============================================
// CONVERSATIONS
// ============================================

export async function getConversations(): Promise<StoredConversation[]> {
  try {
    const encryptedData = await SecureStore.getItemAsync(CONVERSATIONS_KEY_ENCRYPTED);
    if (encryptedData) {
      try {
        const decrypted = decryptConversations(encryptedData);
        return JSON.parse(decrypted);
      } catch (e) {
        __DEV__ && console.warn('Failed to decrypt conversations, trying legacy key');
      }
    }
    
    const legacyData = await SecureStore.getItemAsync(CONVERSATIONS_KEY);
    if (legacyData) {
      const conversations = JSON.parse(legacyData);
      await saveConversations(conversations);
      return conversations;
    }
    
    return [];
  } catch (error) {
    __DEV__ && console.error('Failed to get conversations:', error);
    return [];
  }
}

export async function saveConversations(conversations: StoredConversation[]): Promise<void> {
  const data = JSON.stringify(conversations);
  const encrypted = encryptConversations(data);
  await SecureStore.setItemAsync(CONVERSATIONS_KEY_ENCRYPTED, encrypted);
}

export async function getConversation(id: string): Promise<StoredConversation | null> {
  const conversations = await getConversations();
  return conversations.find(c => c.id === id) || null;
}

export async function addConversation(
  name: string,
  masterKeyBase64: string,
  conversationId: string,
  tag: string
): Promise<StoredConversation> {
  const conversations = await getConversations();
  
  const existing = conversations.find(c => c.id === conversationId);
  if (existing) {
    return existing;
  }
  
  const newConv: StoredConversation = {
    id: conversationId,
    tag,
    name,
    masterKeyBase64,
    createdAt: Date.now(),
  };
  
  conversations.push(newConv);
  await saveConversations(conversations);
  
  return newConv;
}

export async function getMasterKey(conversationId: string): Promise<Uint8Array | null> {
  const conv = await getConversation(conversationId);
  if (!conv) return null;
  return decodeBase64(conv.masterKeyBase64);
}

export async function getConversationKeys(conversationId: string): Promise<DerivedKeys | null> {
  const masterKey = await getMasterKey(conversationId);
  if (!masterKey) return null;
  return deriveAllKeys(masterKey);
}

export async function getConversationTag(conversationId: string): Promise<string | null> {
  const conv = await getConversation(conversationId);
  return conv?.tag || null;
}

export async function getAllConversationTags(): Promise<string[]> {
  const conversations = await getConversations();
  return conversations.map(c => c.tag);
}

/**
 * Retourne une Map tag → conversationId pour le polling
 * Utilisé par fetchAllNewMessages dans api.ts
 */
export async function getTagToConversationMap(): Promise<Map<string, string>> {
  const conversations = await getConversations();
  const map = new Map<string, string>();
  for (const conv of conversations) {
    if (conv.tag && conv.id) {
      map.set(conv.tag, conv.id);
    }
  }
  return map;
}

export async function renameConversation(id: string, newName: string): Promise<void> {
  const conversations = await getConversations();
  const conv = conversations.find(c => c.id === id);
  if (conv) {
    conv.name = newName;
    await saveConversations(conversations);
  }
}

// ============================================
// IDENTITY - v9.0 MISE À JOUR: Inclut Avatar
// ============================================

/**
 * Récupère l'identité complète de l'utilisateur pour une conversation
 * v9.0 - Inclut maintenant l'avatar pour transmission chiffrée
 * 
 * @param conversationId - L'ID de la conversation
 * @returns Identité avec displayName, commitment, discriminator ET avatar
 */
export async function getMyIdentity(conversationId: string): Promise<MyIdentity | null> {
  const conv = await getConversation(conversationId);
  if (!conv) return null;
  
  // Récupérer le pseudo global
  const displayName = await getGlobalDisplayName();
  
  // v9.0 - Récupérer l'avatar global
  const avatarBase64 = await getGlobalAvatar();
  
  // Générer ou récupérer le commitment pour cette conversation
  let commitment = conv.identityCommitment;
  
  if (!commitment) {
    try {
      const masterKey = decodeBase64(conv.masterKeyBase64);
      const userSecret = await getOrCreateUserSecret();
      const { generateIdentityCommitment } = await import('./crypto');
      commitment = await generateIdentityCommitment(masterKey, userSecret);
      
      // Sauvegarder pour la prochaine fois
      await updateIdentityCommitment(conversationId, commitment);
    } catch (e) {
      __DEV__ && console.warn('Failed to generate identity commitment:', e);
    }
  }
  
  // Générer le discriminateur (4 premiers caractères du commitment)
  const discriminator = commitment ? commitment.substring(0, 4).toUpperCase() : undefined;
  
  return {
    displayName: displayName || undefined,
    identityCommitment: commitment,
    discriminator,
    avatarBase64: avatarBase64 || undefined,  // v9.0 - NOUVEAU
  };
}

async function updateIdentityCommitment(id: string, commitment: string): Promise<void> {
  const conversations = await getConversations();
  const conv = conversations.find(c => c.id === id);
  if (conv) {
    conv.identityCommitment = commitment;
    await saveConversations(conversations);
  }
}

export async function updateLastMessage(id: string, timestamp: number): Promise<void> {
  const conversations = await getConversations();
  const conv = conversations.find(c => c.id === id);
  if (conv) {
    conv.lastMessageAt = timestamp;
    await saveConversations(conversations);
  }
}

export async function incrementUnreadCount(id: string): Promise<void> {
  const conversations = await getConversations();
  const conv = conversations.find(c => c.id === id);
  if (conv) {
    conv.unreadCount = (conv.unreadCount || 0) + 1;
    await saveConversations(conversations);
  }
}

export async function resetUnreadCount(id: string): Promise<void> {
  const conversations = await getConversations();
  const conv = conversations.find(c => c.id === id);
  if (conv && conv.unreadCount !== 0) {
    conv.unreadCount = 0;
    await saveConversations(conversations);
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const conversations = await getConversations();
  const filtered = conversations.filter(c => c.id !== id);
  await saveConversations(filtered);
  
  await AsyncStorage.removeItem(msgKey(id));
  await AsyncStorage.removeItem(deletedKey(id));
  await AsyncStorage.removeItem(lastSeenKey(id));
  await AsyncStorage.removeItem(participantsKey(id));
  
  invalidateCache(msgKey(id));
  
  conversationTokenCache.delete(id);
  
  // Nettoyage des états ratchet legacy (inline, ratchetStorage.ts supprimé)
  try {
    await AsyncStorage.removeItem(LEGACY_RATCHET_PREFIX + id);
  } catch (e) {
    // Silencieux - données legacy possiblement absentes
  }
}

export async function updateConversationSession(id: string, hasSession: boolean): Promise<void> {
  const conversations = await getConversations();
  const conv = conversations.find(c => c.id === id);
  if (conv) {
    conv.hasSession = hasSession;
    await saveConversations(conversations);
  }
}

export async function updateSafetyNumberVerified(id: string, verified: boolean): Promise<void> {
  const conversations = await getConversations();
  const conv = conversations.find(c => c.id === id);
  if (conv) {
    conv.safetyNumberVerified = verified;
    await saveConversations(conversations);
  }
}

// ============================================
// PARTICIPANTS
// ============================================

/**
 * Récupère tous les participants d'une conversation
 */
export async function getParticipants(
  conversationId: string
): Promise<Map<string, ConversationParticipant>> {
  try {
    const key = participantsKey(conversationId);
    const rawData = await AsyncStorage.getItem(key);
    
    if (!rawData) {
      return new Map();
    }
    
    const decrypted = decryptIfNeeded(rawData);
    const participants: ConversationParticipant[] = JSON.parse(decrypted);
    
    const map = new Map<string, ConversationParticipant>();
    for (const p of participants) {
      map.set(p.senderToken, p);
    }
    
    return map;
  } catch (error) {
    __DEV__ && console.error('Failed to get participants:', error);
    return new Map();
  }
}

/**
 * Récupère un participant spécifique
 */
export async function getParticipant(
  conversationId: string,
  senderToken: string
): Promise<ConversationParticipant | null> {
  const participants = await getParticipants(conversationId);
  return participants.get(senderToken) || null;
}

/**
 * v9.0 - Récupère l'avatar d'un participant
 */
export async function getParticipantAvatar(
  conversationId: string,
  senderToken: string
): Promise<string | undefined> {
  const participant = await getParticipant(conversationId, senderToken);
  return participant?.avatarBase64;
}

/**
 * Sauvegarde ou met à jour un participant
 * v9.0 - Gestion améliorée de l'avatar
 */
export async function saveParticipant(
  conversationId: string,
  participant: ConversationParticipant
): Promise<void> {
  const participants = await getParticipants(conversationId);
  
  const existing = participants.get(participant.senderToken);
  if (existing) {
    // Mise à jour
    existing.displayName = participant.displayName;
    existing.lastSeenAt = participant.lastSeenAt;
    existing.messageCount = (existing.messageCount || 0) + 1;
    // Ne pas écraser le commitment si déjà défini
    if (!existing.identityCommitment && participant.identityCommitment) {
      existing.identityCommitment = participant.identityCommitment;
    }
    // v9.0 - Mettre à jour l'avatar si fourni (le dernier reçu fait foi)
    if (participant.avatarBase64) {
      existing.avatarBase64 = participant.avatarBase64;
    }
  } else {
    // Nouveau participant
    participants.set(participant.senderToken, {
      ...participant,
      messageCount: 1,
    });
  }
  
  // Sauvegarder
  const key = participantsKey(conversationId);
  const data = JSON.stringify(Array.from(participants.values()));
  const encrypted = encryptIfEnabled(data);
  await AsyncStorage.setItem(key, encrypted);
}

/**
 * Vérifie si l'identity commitment d'un participant a changé
 * Retourne true si c'est une alerte (changement détecté)
 */
export async function verifyParticipantIdentity(
  conversationId: string,
  senderToken: string,
  newCommitment: string | undefined
): Promise<{ isNew: boolean; hasChanged: boolean; previousName?: string }> {
  if (!newCommitment) {
    return { isNew: true, hasChanged: false };
  }
  
  const existing = await getParticipant(conversationId, senderToken);
  
  if (!existing) {
    return { isNew: true, hasChanged: false };
  }
  
  if (!existing.identityCommitment) {
    // Participant existant mais sans commitment (anciens messages)
    return { isNew: false, hasChanged: false };
  }
  
  if (existing.identityCommitment !== newCommitment) {
    // ⚠️ ALERTE: Le commitment a changé !
    return {
      isNew: false,
      hasChanged: true,
      previousName: existing.displayName,
    };
  }
  
  return { isNew: false, hasChanged: false };
}

/**
 * Récupère le displayName d'un participant
 */
export async function getParticipantDisplayName(
  conversationId: string,
  senderToken: string
): Promise<string | undefined> {
  const participant = await getParticipant(conversationId, senderToken);
  return participant?.displayName;
}

// ============================================
// MESSAGES LOCAUX
// ============================================

export async function getLocalMessages(conversationId: string): Promise<LocalMessage[]> {
  const cacheKey = msgKey(conversationId);
  
  try {
    const rawData = await AsyncStorage.getItem(cacheKey);
    if (!rawData) return [];
    
    const messages = getCachedOrDecrypt<LocalMessage[]>(
      cacheKey,
      rawData,
      (data) => JSON.parse(decryptWithMigration(data))
    );
    
    return messages || [];
  } catch (error) {
    __DEV__ && console.error('Failed to get local messages:', error);
    return [];
  }
}

export async function addLocalMessage(message: LocalMessage): Promise<void> {
  const cacheKey = msgKey(message.conversationId);
  
  let messages = await getLocalMessages(message.conversationId);
  
  if (messages.some(m => m.id === message.id)) {
    return;
  }
  
  messages.push(message);
  messages.sort((a, b) => a.timestamp - b.timestamp);
  const trimmed = messages.slice(-1000);
  
  await saveLocalMessages(message.conversationId, trimmed);
  updateCache(cacheKey, trimmed);
  
  // v15.2: NE PAS notifier ici - les messages d'appel utilisent notifyCallMessageAdded()
  // Les messages normaux ont leur propre système (optimistic + polling)
}

async function saveLocalMessages(conversationId: string, messages: LocalMessage[]): Promise<void> {
  const dataToStore = encryptIfEnabled(JSON.stringify(messages));
  await AsyncStorage.setItem(msgKey(conversationId), dataToStore);
}

/**
 * v9.0 - Met à jour l'avatar pour tous les messages d'un expéditeur
 * C'est le dernier avatar reçu qui fait foi
 * 
 * @param conversationId - L'ID de la conversation
 * @param senderToken - Le token de l'expéditeur
 * @param avatarBase64 - Le nouvel avatar en base64
 */
export async function updateMessagesAvatarForSender(
  conversationId: string,
  senderToken: string,
  avatarBase64: string
): Promise<void> {
  const cacheKey = msgKey(conversationId);
  
  try {
    const messages = await getLocalMessages(conversationId);
    
    let updated = false;
    for (const message of messages) {
      if (message.senderToken === senderToken && message.avatarBase64 !== avatarBase64) {
        message.avatarBase64 = avatarBase64;
        updated = true;
      }
    }
    
    if (updated) {
      await saveLocalMessages(conversationId, messages);
      updateCache(cacheKey, messages);
      __DEV__ && console.log(`🖼️ Updated avatar for ${senderToken.slice(0, 8)}... in ${messages.filter(m => m.senderToken === senderToken).length} messages`);
    }
  } catch (error) {
    __DEV__ && console.error('Failed to update messages avatar:', error);
  }
}

/**
 * v9.0 - Récupère le dernier avatar connu pour un expéditeur
 * Utilisé comme fallback si pas d'avatar dans le message
 */
export async function getLatestAvatarForSender(
  conversationId: string,
  senderToken: string
): Promise<string | undefined> {
  // D'abord vérifier le participant
  const participantAvatar = await getParticipantAvatar(conversationId, senderToken);
  if (participantAvatar) {
    return participantAvatar;
  }
  
  // Sinon chercher dans les messages (du plus récent au plus ancien)
  const messages = await getLocalMessages(conversationId);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].senderToken === senderToken && messages[i].avatarBase64) {
      return messages[i].avatarBase64;
    }
  }
  
  return undefined;
}

export async function clearLocalMessages(conversationId: string): Promise<void> {
  await AsyncStorage.removeItem(msgKey(conversationId));
  invalidateCache(msgKey(conversationId));
}

export async function deleteLocalMessages(
  conversationId: string,
  messageIds: string[]
): Promise<void> {
  const cacheKey = msgKey(conversationId);
  const messages = await getLocalMessages(conversationId);
  const idsToDelete = new Set(messageIds);
  
  let maxDeletedTimestamp = 0;
  for (const msg of messages) {
    if (idsToDelete.has(msg.id) && msg.timestamp > maxDeletedTimestamp) {
      maxDeletedTimestamp = msg.timestamp;
    }
  }
  
  const filtered = messages.filter(m => !idsToDelete.has(m.id));
  
  await saveLocalMessages(conversationId, filtered);
  updateCache(cacheKey, filtered);
  
  await addDeletedMessageIds(conversationId, messageIds);
  
  if (maxDeletedTimestamp > 0) {
    const currentLastSeen = await getLastSeenTimestamp(conversationId);
    const newLastSeen = new Date(maxDeletedTimestamp);
    
    if (!currentLastSeen || newLastSeen > currentLastSeen) {
      await setLastSeenTimestamp(conversationId, newLastSeen);
    }
  }
}

export async function deleteAllLocalMessages(conversationId: string): Promise<void> {
  await setLastSeenTimestamp(conversationId, new Date());
  await saveLocalMessages(conversationId, []);
  invalidateCache(msgKey(conversationId));
  await AsyncStorage.removeItem(deletedKey(conversationId));
}

// ============================================
// LAST SEEN TIMESTAMP
// ============================================

export async function getLastSeenTimestamp(conversationId: string): Promise<Date | null> {
  try {
    const data = await AsyncStorage.getItem(lastSeenKey(conversationId));
    if (!data) return null;
    return new Date(parseInt(data, 10));
  } catch {
    return null;
  }
}

export async function setLastSeenTimestamp(conversationId: string, timestamp: Date): Promise<void> {
  await AsyncStorage.setItem(
    lastSeenKey(conversationId),
    timestamp.getTime().toString()
  );
}

// ============================================
// DELETED MESSAGE IDS
// ============================================

export async function getDeletedMessageIds(conversationId: string): Promise<Set<string>> {
  try {
    const data = await AsyncStorage.getItem(deletedKey(conversationId));
    if (!data) return new Set();
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

export async function addDeletedMessageIds(
  conversationId: string,
  messageIds: string[]
): Promise<void> {
  const existing = await getDeletedMessageIds(conversationId);
  messageIds.forEach(id => existing.add(id));
  
  const idsArray = Array.from(existing).slice(-1000);
  
  await AsyncStorage.setItem(
    deletedKey(conversationId),
    JSON.stringify(idsArray)
  );
}

export async function clearDeletedMessageIds(conversationId: string): Promise<void> {
  await AsyncStorage.removeItem(deletedKey(conversationId));
}

// ============================================
// BACKUP / RESTORE
// ============================================

export async function exportAllData(): Promise<string> {
  const conversations = await getConversations();
  const senderToken = await getSenderToken();
  
  return JSON.stringify({
    version: 2,
    exportedAt: Date.now(),
    senderToken,
    conversations,
  });
}

export async function importAllData(data: string): Promise<number> {
  const parsed = JSON.parse(data);
  
  if (parsed.version !== 2) {
    throw new Error('Unsupported backup version');
  }
  
  const existing = await getConversations();
  const existingIds = new Set(existing.map(c => c.id));
  
  let importedCount = 0;
  for (const conv of parsed.conversations) {
    if (!existingIds.has(conv.id)) {
      existing.push(conv);
      importedCount++;
    }
  }
  
  await saveConversations(existing);
  
  return importedCount;
}

export async function clearAllData(): Promise<void> {
  __DEV__ && console.log('[storage] Starting data wipe (preserving profile & PIN)...');
  
  // BUG FIX #6: Stopper TOUS les services réseau AVANT le nettoyage
  // Sans cela, le polling continue en arrière-plan et tente de déchiffrer
  // avec des sessions/clés qui n'existent plus → erreurs en boucle
  try {
    const { stopGlobalPolling1to1 } = await import('./api1to1');
    stopGlobalPolling1to1();
    __DEV__ && console.log('[storage] ✅ Global polling stopped');
  } catch (e) {
    __DEV__ && console.error('[storage] Failed to stop polling:', e);
  }
  try {
    const { stopConstantTraffic } = await import('./constantTraffic');
    stopConstantTraffic();
    __DEV__ && console.log('[storage] ✅ Constant traffic stopped');
  } catch (e) {
    __DEV__ && console.error('[storage] Failed to stop constant traffic:', e);
  }
  try {
    const { inviteWatcher } = await import('./inviteWatcher');
    inviteWatcher.stop();
    __DEV__ && console.log('[storage] ✅ Invite watcher stopped');
  } catch (e) {
    __DEV__ && console.error('[storage] Failed to stop invite watcher:', e);
  }
  try {
    const { pausePrivacyServices } = await import('./privacySettings');
    pausePrivacyServices();
    __DEV__ && console.log('[storage] ✅ Privacy services paused');
  } catch (e) {
    __DEV__ && console.error('[storage] Failed to pause privacy services:', e);
  }
  
  clearCache();
  clearConversationTokenCache();
  
  const conversations = await getConversations();
  
  for (const conv of conversations) {
    await AsyncStorage.removeItem(msgKey(conv.id));
    await AsyncStorage.removeItem(deletedKey(conv.id));
    await AsyncStorage.removeItem(lastSeenKey(conv.id));
    await AsyncStorage.removeItem(participantsKey(conv.id));
  }
  
  // Nettoyer les clés de conversation
  await SecureStore.deleteItemAsync(CONVERSATIONS_KEY);
  await SecureStore.deleteItemAsync(CONVERSATIONS_KEY_ENCRYPTED);
  await SecureStore.deleteItemAsync(SENDER_TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_SECRET_KEY);
  
  // NOTE: PIN et profil sont PRESERVÉS ici (reset depuis Settings).
  __DEV__ && console.log('[storage] PIN, display name and avatar PRESERVED');

  // ACTION-04 (Phase 2 Security): Delete hardware-backed encryption keys
  try {
    await deleteHardwareKeys();
    conversationsHardwareKey = null;
    __DEV__ && console.log('[storage] Hardware encryption keys deleted');
  } catch (e) {
    __DEV__ && console.log('[storage] Hardware key cleanup error:', e);
  }
  
  await AsyncStorage.removeItem(DEVICE_STATE_KEY);
  cachedDeviceState = null;
  
  // ======================================
  // NETTOYAGE TRIPLE RATCHET (1-à-1)
  // ======================================
  try {
    const { sessionService } = await import('./tripleRatchet');
    await sessionService.clearAllData();
    __DEV__ && console.log('[storage] Triple Ratchet cleared');
  } catch (e) {
    __DEV__ && console.error('[storage] Triple Ratchet cleanup error:', e);
  }
  
  // ======================================
  // NETTOYAGE MESSAGES 1-à-1
  // ======================================
  try {
    const { clearAll1to1Data } = await import('./api1to1');
    await clearAll1to1Data();
    __DEV__ && console.log('[storage] 1-to-1 messages cleared');
  } catch (e) {
    __DEV__ && console.error('[storage] 1-to-1 messages cleanup error:', e);
  }
  
  // ======================================
  // NETTOYAGE ASYNCSTORAGE (préserve profil)
  // ======================================
  try {
    const PROFILE_KEYS_TO_PRESERVE = [
      OPAQUE_DISPLAY_NAME_KEY,  // 'g_pd_v1'
      OPAQUE_AVATAR_KEY,        // 'g_pa_v1'
      'ghostr_pq_my_profile',   // Profil sessionService
    ];
    
    const allKeys = await AsyncStorage.getAllKeys();
    
    const ghostrKeys = allKeys.filter(key => 
      (key.startsWith('ghostr_') || 
       key.startsWith('@ghostr') ||
       key.startsWith('whisper_') ||
       key.startsWith('@whisper') ||
       key.startsWith('g_')) &&  // ACTION 5: opaque storage keys
      !PROFILE_KEYS_TO_PRESERVE.includes(key)
    );
    
    if (ghostrKeys.length > 0) {
      await AsyncStorage.multiRemove(ghostrKeys);
      __DEV__ && console.log(`[storage] Removed ${ghostrKeys.length} keys (profile preserved)`);
    }
    
    await AsyncStorage.removeItem('@ghostr_groups');
    await AsyncStorage.removeItem('ghostr_pending_group_invitations');
  } catch (e) {
    __DEV__ && console.error('[storage] Additional cleanup error:', e);
  }
  
  __DEV__ && console.log('[storage] ✅ Data cleared (profile & PIN preserved)');
}

/**
 * NUCLEAR RESET: Efface ABSOLUMENT TOUT.
 * PIN, profil, clés hardware, clés de rotation, conversations, sessions, onboarding.
 * Utilisé uniquement par le flag RESET_ALL_DATA dans App.tsx.
 * Après appel, l'app redémarre comme un fresh install.
 */
export async function nuclearReset(): Promise<void> {
  __DEV__ && console.log('[storage] ☢️ NUCLEAR RESET — erasing EVERYTHING...');
  
  // BUG FIX #6: Stopper TOUS les services réseau AVANT le nettoyage
  try {
    const { stopGlobalPolling1to1 } = await import('./api1to1');
    stopGlobalPolling1to1();
  } catch {}
  try {
    const { stopConstantTraffic } = await import('./constantTraffic');
    stopConstantTraffic();
  } catch {}
  try {
    const { inviteWatcher } = await import('./inviteWatcher');
    inviteWatcher.stop();
  } catch {}
  try {
    const { pausePrivacyServices } = await import('./privacySettings');
    pausePrivacyServices();
  } catch {}
  __DEV__ && console.log('[storage] ☢️ Network services stopped');
  
  // 1. Wipe ALL AsyncStorage (conversations, messages, onboarding flag, profile, everything)
  try {
    await AsyncStorage.clear();
    __DEV__ && console.log('[storage] ☢️ AsyncStorage cleared');
  } catch (e) {
    __DEV__ && console.error('[storage] AsyncStorage clear error:', e);
  }
  
  // 2. Wipe ALL SecureStore keys (PIN, lock data, conversations, tokens, secrets)
  const secureStoreKeys = [
    // Conversations
    CONVERSATIONS_KEY,
    CONVERSATIONS_KEY_ENCRYPTED,
    SENDER_TOKEN_KEY,
    USER_SECRET_KEY,
    // Lock / PIN (ALL versions)
    'whisper_lock_data_v6',
    'whisper_lock_data_v5',
    'whisper_lock_data_v4',
    'whisper_lock_data_v3',
    'whisper_lock_enabled',
    'whisper_lock_password_hash',
    'whisper_lock_settings',
    'whisper_encryption_key',
    'whisper_lock_salt',
    'whisper_password_hash',
    'whisper_password_salt',
    'whisper_use_biometrics',
    'whisper_lock_timeout',
    'whisper_failed_attempts',
    'whisper_lockout_until',
    // ACTION 1: New brute-force counters (SecureStore v2)
    'whisper_failed_attempts_v2',
    'whisper_lockout_until_v2',
    // ACTION 4: Auto-wipe setting
    'whisper_auto_wipe_enabled',
    // Crypto rotation keys
    'ghostr_rotated_enc_key_v1',
    'ghostr_rotated_enc_key_v1_pending',
    // Device-level encryption key (from ensureDeviceLevelEncryption)
    'ghostr_device_encryption_key_v1',
  ];
  
  for (const key of secureStoreKeys) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Key might not exist, that's fine
    }
  }
  __DEV__ && console.log('[storage] ☢️ SecureStore keys cleared');
  
  // 3. Hardware encryption keys
  try {
    await deleteHardwareKeys();
    conversationsHardwareKey = null;
    __DEV__ && console.log('[storage] ☢️ Hardware encryption keys deleted');
  } catch (e) {
    __DEV__ && console.log('[storage] Hardware key cleanup error:', e);
  }
  
  // 4. SessionService (identity keys, ratchet states, prekeys)
  try {
    const { sessionService } = await import('./tripleRatchet');
    await sessionService.clearAllData();
    __DEV__ && console.log('[storage] ☢️ SessionService cleared');
  } catch (e) {
    __DEV__ && console.error('[storage] SessionService cleanup error:', e);
  }
  
  // 5. 1-to-1 message data
  try {
    const { clearAll1to1Data } = await import('./api1to1');
    await clearAll1to1Data();
    __DEV__ && console.log('[storage] ☢️ 1-to-1 data cleared');
  } catch (e) {
    __DEV__ && console.error('[storage] 1-to-1 cleanup error:', e);
  }
  
  // 6. Reset in-memory state
  clearCache();
  clearConversationTokenCache();
  cachedDeviceState = null;
  
  __DEV__ && console.log('[storage] ☢️ NUCLEAR RESET COMPLETE — app is a blank slate');
}

// ============================================
// SIGNAL PROTOCOL - ÉTAT DU DEVICE
// ============================================

const DEVICE_STATE_KEY = '@whisper_device_state_v1';

export interface DeviceState {
  deviceId: string;
}

let cachedDeviceState: DeviceState | null = null;

async function generateDeviceId(): Promise<string> {
  const { getRandomBytesAsync } = await import('expo-crypto');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const charsLen = chars.length; // 62
  // Rejection sampling: largest multiple of 62 that fits in a byte (248)
  // Reject values >= 248 to eliminate modulo bias
  const limit = Math.floor(256 / charsLen) * charsLen; // 248
  let result = '';
  while (result.length < 16) {
    const randomBytes = await getRandomBytesAsync(32); // batch to reduce calls
    for (let i = 0; i < randomBytes.length && result.length < 16; i++) {
      if (randomBytes[i] < limit) {
        result += chars[randomBytes[i] % charsLen];
      }
    }
  }
  return result;
}

export async function getOrCreateDeviceState(): Promise<DeviceState> {
  if (cachedDeviceState) {
    return cachedDeviceState;
  }
  
  try {
    const stored = await AsyncStorage.getItem(DEVICE_STATE_KEY);
    if (stored) {
      cachedDeviceState = JSON.parse(stored);
      return cachedDeviceState!;
    }
  } catch (error) {
    __DEV__ && console.error('Failed to load device state:', error);
  }
  
  cachedDeviceState = {
    deviceId: await generateDeviceId(),
  };
  
  await AsyncStorage.setItem(DEVICE_STATE_KEY, JSON.stringify(cachedDeviceState));
  
  return cachedDeviceState;
}

/**
 * Helper pour obtenir l'ID du device
 * Wrapper autour de getOrCreateDeviceState pour faciliter l'usage
 */
export async function getDeviceId(): Promise<string> {
  const state = await getOrCreateDeviceState();
  return state.deviceId;
}

// ============================================
// NETTOYAGE DES CONVERSATIONS CORROMPUES
// ============================================

/**
 * Vérifie si une conversation est corrompue
 */
function isConversationCorrupted(conv: StoredConversation): boolean {
  // ID doit être une string
  if (typeof conv.id !== 'string') {
    return true;
  }
  
  // masterKeyBase64 doit être une string base64 de ~44 caractères
  if (typeof conv.masterKeyBase64 !== 'string' || conv.masterKeyBase64.length < 40) {
    return true;
  }
  
  return false;
}

/**
 * Nettoie les conversations corrompues
 * Retourne le nombre de conversations supprimées
 */
export async function cleanupCorruptedConversations(): Promise<{
  removed: number;
  kept: number;
  removedNames: string[];
}> {
  __DEV__ && console.log('🧹 Démarrage du nettoyage des conversations corrompues...');
  
  const removedNames: string[] = [];
  
  try {
    const conversations = await getConversations();
    
    if (conversations.length === 0) {
      __DEV__ && console.log('✅ Aucune conversation trouvée');
      return { removed: 0, kept: 0, removedNames: [] };
    }
    
    __DEV__ && console.log(`📦 ${conversations.length} conversations trouvées`);
    
    // Filtrer les conversations corrompues
    const validConversations: StoredConversation[] = [];
    
    for (const conv of conversations) {
      __DEV__ && console.log(`\n📝 Analyse: "${conv.name || conv.masterKeyBase64}"`);
      __DEV__ && console.log(`   - id type: ${typeof conv.id}`);
      
      if (isConversationCorrupted(conv)) {
        __DEV__ && console.log(`   ❌ CORROMPUE - sera supprimée`);
        removedNames.push(conv.masterKeyBase64 || conv.name || 'Unknown');
      } else {
        __DEV__ && console.log(`   ✅ Valide`);
        validConversations.push(conv);
      }
    }
    
    const removed = conversations.length - validConversations.length;
    
    if (removed > 0) {
      await saveConversations(validConversations);
      __DEV__ && console.log(`\n🗑️ ${removed} conversations corrompues supprimées`);
      __DEV__ && console.log(`✅ ${validConversations.length} conversations valides conservées`);
    } else {
      __DEV__ && console.log('\n✅ Aucune conversation corrompue trouvée');
    }
    
    return {
      removed,
      kept: validConversations.length,
      removedNames,
    };
    
  } catch (error) {
    __DEV__ && console.error('❌ Erreur lors du nettoyage:', error);
    throw error;
  }
}

/**
 * Affiche un diagnostic des conversations
 */
export async function diagnoseConversations(): Promise<void> {
  __DEV__ && console.log('\n========== DIAGNOSTIC CONVERSATIONS ==========\n');
  
  try {
    const conversations = await getConversations();
    __DEV__ && console.log(`Nombre de conversations: ${conversations.length}`);
    
    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      __DEV__ && console.log(`\n--- Conversation ${i + 1} ---`);
      __DEV__ && console.log('id type:', typeof conv.id);
      __DEV__ && console.log('id value:', typeof conv.id === 'string' ? conv.id.substring(0, 16) + '...' : JSON.stringify(conv.id).substring(0, 50) + '...');
      __DEV__ && console.log('name:', conv.name);
      __DEV__ && console.log('masterKeyBase64:', conv.masterKeyBase64?.substring(0, 20) + '...');
      __DEV__ && console.log('tag:', conv.tag?.substring(0, 16) + '...');
      __DEV__ && console.log('CORRUPTED:', isConversationCorrupted(conv) ? '❌ YES' : '✅ NO');
    }
  } catch (error) {
    __DEV__ && console.error('Erreur diagnostic:', error);
  }
  
  __DEV__ && console.log('\n========== FIN DIAGNOSTIC ==========\n');
}