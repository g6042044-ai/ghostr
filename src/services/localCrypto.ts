// src/services/localCrypto.ts
// Chiffrement local ultra-rapide pour les données en cache
// v1.0 - Architecture optimisée : synchrone, incrémental, cache mémoire
//
// Optimisations appliquées :
// 1. Import statique (pas de dynamic import)
// 2. Fonctions synchrones (NaCl est synchrone)
// 3. Format binaire compact : [24 bytes nonce][ciphertext]
// 4. Cache mémoire pour éviter les re-déchiffrements
//
// Performance :
// - Ancien système : ~50-200ms par opération (import + JSON + bloc entier)
// - Nouveau système : ~0.1-1ms par opération

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { getOrCreateHardwareKey } from './hardwareKeyProvider';
import { sha256 } from '@noble/hashes/sha256';
import { sodiumMemzero } from './sodiumZeroize';

// React Native global — défini par Metro bundler
declare const __DEV__: boolean;

// ============================================
// CONSTANTES
// ============================================

const NONCE_LENGTH = nacl.secretbox.nonceLength; // 24 bytes
const ENCRYPTED_PREFIX = 'enc1:'; // Marqueur version 1

// ============================================
// ACTION 5: OPAQUE ASYNCSTORAGE KEYS
// ============================================
//
// Les noms de clés AsyncStorage (whisper_messages_xxx, whisper_participants_xxx, etc.)
// révèlent des métadonnées même sans déchiffrer le contenu (nombre de conversations,
// IDs de conversation). Cette fonction dérive un nom de clé opaque à partir du nom
// lisible + une clé secrète, rendant les noms de clés inutilisables sans la clé.

let opaqueKeySeed: Uint8Array | null = null;

/**
 * Initialise le seed pour les clés opaques.
 * Appelé au déverrouillage (après setEncryptionKey).
 */
export function setOpaqueKeySeed(seed: Uint8Array): void {
  opaqueKeySeed = new Uint8Array(seed);
}

/**
 * Efface le seed pour les clés opaques (au verrouillage).
 */
export function clearOpaqueKeySeed(): void {
  if (opaqueKeySeed) {
    opaqueKeySeed.fill(0);
    opaqueKeySeed = null;
  }
}

/**
 * Dérive un nom de clé AsyncStorage opaque à partir d'un nom lisible.
 * Format: "g_" + hex(SHA-256(seed || readableName))[0:32]
 *
 * Si le seed n'est pas encore initialisé (app pas encore déverrouillée),
 * retourne le nom lisible tel quel (backward compat).
 */
export function opaqueStorageKey(readableKey: string): string {
  if (!opaqueKeySeed) {
    return readableKey; // Fallback: pas encore initialisé
  }
  
  const keyBytes = decodeUTF8(readableKey);
  const combined = new Uint8Array(opaqueKeySeed.length + keyBytes.length);
  combined.set(opaqueKeySeed, 0);
  combined.set(keyBytes, opaqueKeySeed.length);
  
  const hash = sha256(combined);
  // 16 bytes hex = 32 chars → suffisamment unique, pas de collision pratique
  const hex = Array.from(hash.slice(0, 16))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  return 'g_' + hex;
}

// ============================================
// CLÉ DE CHIFFREMENT — AVEC ROTATION ANTI-FORENSIQUE
// ============================================
//
// ANTI-FORENSIQUE (Action 2):
//   À chaque déverrouillage de l'app, la clé de chiffrement est rotée:
//     1. PIN → PBKDF2 → localKey (toujours identique pour le même PIN)
//     2. localKey déchiffre SecureStore → récupère la rotatedKey actuelle
//     3. rotatedKey déchiffre AsyncStorage (les vraies données)
//     4. Génère newRotatedKey = random 32 bytes
//     5. Re-chiffre AsyncStorage avec newRotatedKey
//     6. Chiffre newRotatedKey avec localKey → écrase SecureStore
//
//   CRASH SAFETY:
//   La rotation utilise un commit en deux phases:
//     Phase A: stocker newRotatedKey en "pending" dans SecureStore
//     Phase B: re-chiffrer toutes les entrées AsyncStorage
//     Phase C: promouvoir "pending" en "current", supprimer l'ancien
//   Si crash pendant B: au prochain unlock, "pending" existe →
//     chaque entrée est déchiffrée avec current OU pending (celui qui marche).
//
//   CONCURRENCE:
//   La variable module `encryptionKey` n'est JAMAIS mutée pendant la
//   re-encryption. Toutes les opérations utilisent nacl.secretbox directement
//   avec des clés explicites. Le polling et le stockage de messages continuent
//   de fonctionner normalement pendant la rotation.

import AsyncStorageImport from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

let encryptionKey: Uint8Array | null = null;

// ACTION-04 (Phase 2): Hardware-backed key, separate from PIN key.
// This key is INVISIBLE to the rest of the codebase: isEncryptionEnabled()
// returns false when only the hardware key is active. This preserves the
// semantic meaning of "encryption enabled" = "user has a PIN" everywhere.
let hardwareKey: Uint8Array | null = null;

/**
 * Returns the active encryption key: PIN key takes priority over hardware key.
 * Returns null only if neither is set (should not happen after init).
 */
function getActiveKey(): Uint8Array | null {
  return encryptionKey || hardwareKey;
}

const ROTATION_KEY_STORE = 'ghostr_rotated_enc_key_v1';
const ROTATION_KEY_PENDING_STORE = 'ghostr_rotated_enc_key_v1_pending';

// ── Helpers SecureStore: chiffrer/déchiffrer une clé avec localKey ──

function wrapKeyForStorage(keyToStore: Uint8Array, localKey: Uint8Array): string {
  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const ciphertext = nacl.secretbox(keyToStore, nonce, localKey);
  const combined = new Uint8Array(NONCE_LENGTH + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, NONCE_LENGTH);
  return encodeBase64(combined);
}

function unwrapKeyFromStorage(stored: string, localKey: Uint8Array): Uint8Array | null {
  try {
    const combined = decodeBase64(stored);
    if (combined.length < NONCE_LENGTH + 16) return null;
    const nonce = combined.slice(0, NONCE_LENGTH);
    const ciphertext = combined.slice(NONCE_LENGTH);
    const decrypted = nacl.secretbox.open(ciphertext, nonce, localKey);
    return decrypted ? new Uint8Array(decrypted) : null;
  } catch {
    return null;
  }
}

// ── Helpers: encrypt/decrypt une entrée avec une clé EXPLICITE ──
// N'utilise PAS la variable module `encryptionKey` → safe pendant re-encryption

function encryptRaw(plaintext: string, key: Uint8Array): string {
  const plaintextBytes = decodeUTF8(plaintext);
  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const ciphertext = nacl.secretbox(plaintextBytes, nonce, key);
  const combined = new Uint8Array(NONCE_LENGTH + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, NONCE_LENGTH);
  return ENCRYPTED_PREFIX + encodeBase64(combined);
}

function decryptRaw(encrypted: string, key: Uint8Array): string | null {
  try {
    if (!encrypted.startsWith(ENCRYPTED_PREFIX)) return null;
    const combined = decodeBase64(encrypted.slice(ENCRYPTED_PREFIX.length));
    if (combined.length < NONCE_LENGTH + 16) return null;
    const nonce = combined.slice(0, NONCE_LENGTH);
    const ciphertext = combined.slice(NONCE_LENGTH);
    const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
    return plaintext ? encodeUTF8(plaintext) : null;
  } catch {
    return null;
  }
}

/**
 * Définit la clé de chiffrement local ET effectue la rotation.
 *
 * IMPORTANT: Cette fonction est BLOQUANTE. L'UI doit attendre sa complétion
 * avant de permettre l'accès aux données (sinon risque de race condition).
 *
 * @param key - localKey dérivée du PIN via PBKDF2 (toujours identique pour un même PIN)
 */
export async function setEncryptionKeyAndRotate(key: Uint8Array | string): Promise<void> {
  const localKey = typeof key === 'string' ? decodeBase64(key) : new Uint8Array(key);
  
  // ── Étape 1: Récupérer le(s) clé(s) de rotation depuis SecureStore ──
  let currentKey: Uint8Array | null = null;
  let pendingKey: Uint8Array | null = null;
  
  try {
    const storedCurrent = await SecureStore.getItemAsync(ROTATION_KEY_STORE);
    if (storedCurrent) currentKey = unwrapKeyFromStorage(storedCurrent, localKey);
    
    const storedPending = await SecureStore.getItemAsync(ROTATION_KEY_PENDING_STORE);
    if (storedPending) pendingKey = unwrapKeyFromStorage(storedPending, localKey);
  } catch {
    // SecureStore inaccessible → fallback
  }
  
  // ── Étape 2: Si "pending" existe, une re-encryption précédente a crashé ──
  if (pendingKey) {
    __DEV__ && console.log('[localCrypto] 🔄 Recovering interrupted re-encryption...');
    
    // Les données sont un mix de currentKey et pendingKey → finir le travail
    const recoverFrom = currentKey || new Uint8Array(localKey);
    await reencryptAllEntries(recoverFrom, pendingKey);
    
    // Promouvoir pending → current
    const wrapped = wrapKeyForStorage(pendingKey, localKey);
    await SecureStore.setItemAsync(ROTATION_KEY_STORE, wrapped);
    await SecureStore.deleteItemAsync(ROTATION_KEY_PENDING_STORE);
    
    // Activer la clé récupérée
    encryptionKey = new Uint8Array(pendingKey);
    if (currentKey) currentKey.fill(0);
    
    // Puis continuer avec une nouvelle rotation normale ci-dessous
    currentKey = pendingKey;
    pendingKey = null;
  }
  
  // ── Étape 3: Déterminer la clé qui déchiffre les données actuelles ──
  // Priority: currentKey (from rotation store) > current active key (device key or hardware key) > localKey
  // IMPORTANT: ensureDeviceLevelEncryption() may have set encryptionKey to a device-level key.
  // getActiveKey() returns encryptionKey (device key) || hardwareKey, whichever is active.
  let activeKey: Uint8Array;
  if (currentKey) {
    activeKey = currentKey;
  } else {
    const currentActive = getActiveKey();
    if (currentActive) {
      __DEV__ && console.log('[localCrypto] 🔄 Transitioning from current key to PIN-based encryption');
      activeKey = currentActive;
    } else {
      activeKey = new Uint8Array(localKey);
    }
  }
  
  // Activer cette clé pour le code concurrent (polling, etc.)
  encryptionKey = new Uint8Array(activeKey);
  
  // ── Étape 4: Générer une nouvelle clé de rotation ──
  const newKey = nacl.randomBytes(32);
  
  // ── Phase A: Stocker la nouvelle clé en "pending" AVANT de re-chiffrer ──
  try {
    const wrappedPending = wrapKeyForStorage(newKey, localKey);
    await SecureStore.setItemAsync(ROTATION_KEY_PENDING_STORE, wrappedPending);
  } catch (error) {
    __DEV__ && console.error('[localCrypto] ❌ Failed to store pending key, aborting rotation:', error);
    // Rien n'a été modifié → safe
    return;
  }
  
  // ── Phase B: Re-chiffrer toutes les entrées ──
  // encryptionKey reste sur activeKey → le code concurrent continue de fonctionner
  await reencryptAllEntries(activeKey, newKey);
  
  // ── Phase C: Promouvoir pending → current ──
  try {
    const wrappedNew = wrapKeyForStorage(newKey, localKey);
    await SecureStore.setItemAsync(ROTATION_KEY_STORE, wrappedNew);
    await SecureStore.deleteItemAsync(ROTATION_KEY_PENDING_STORE);
  } catch (error) {
    // Les données sont re-chiffrées avec newKey mais SecureStore a planté
    // → au prochain unlock, pendingKey sera récupéré et la recovery se fera
    __DEV__ && console.error('[localCrypto] ⚠️ Failed to finalize rotation (will recover on next unlock):', error);
  }
  
  // ── Activer la nouvelle clé ──
  encryptionKey = new Uint8Array(newKey);
  
  // Clean up device-level key from ensureDeviceLevelEncryption (no longer needed, PIN takes over)
  try {
    await SecureStore.deleteItemAsync('ghostr_device_encryption_key_v1');
  } catch {
    // Non-critical cleanup
  }
  
  // Zeroize
  activeKey.fill(0);
  if (currentKey) currentKey.fill(0);
  
  __DEV__ && console.log('[localCrypto] 🔄 Key rotated successfully');
}

/**
 * Re-chiffre toutes les entrées AsyncStorage enc1: de fromKey vers toKey.
 *
 * ACTION 7: ROTATION ATOMIQUE avec AsyncStorage.multiSet()
 * Au lieu de setItem individuel (fenêtre de vulnérabilité pendant l'itération),
 * on accumule les résultats et les écrit en un seul multiSet par batch.
 *
 * CONCURRENCE SAFE: n'utilise JAMAIS la variable module `encryptionKey`.
 * CRASH SAFE: chaque entrée est déchiffrée en essayant fromKey puis toKey.
 * ATOMICITÉ: multiSet écrit toutes les entrées d'un batch en une seule transaction SQLite.
 */
async function reencryptAllEntries(
  fromKey: Uint8Array,
  toKey: Uint8Array
): Promise<void> {
  const allKeys = await AsyncStorageImport.getAllKeys();
  
  let reencryptedCount = 0;
  let alreadyDoneCount = 0;
  let errorCount = 0;
  
  const BATCH_SIZE = 50;
  let batch: [string, string][] = [];
  
  for (const storageKey of allKeys) {
    try {
      const raw = await AsyncStorageImport.getItem(storageKey);
      if (!raw || !raw.startsWith(ENCRYPTED_PREFIX)) continue;
      
      // Essayer de déchiffrer avec fromKey (cas normal)
      let plaintext = decryptRaw(raw, fromKey);
      
      if (plaintext !== null) {
        // Cas normal: entrée chiffrée avec fromKey → re-chiffrer avec toKey
        const reencrypted = encryptRaw(plaintext, toKey);
        batch.push([storageKey, reencrypted]);
        reencryptedCount++;
        
        // Flush batch quand la taille est atteinte
        if (batch.length >= BATCH_SIZE) {
          await AsyncStorageImport.multiSet(batch);
          batch = [];
        }
        continue;
      }
      
      // Essayer avec toKey (entrée déjà re-chiffrée lors d'une rotation interrompue)
      plaintext = decryptRaw(raw, toKey);
      if (plaintext !== null) {
        alreadyDoneCount++;
        continue; // Déjà re-chiffrée → rien à faire
      }
      
      // Ni fromKey ni toKey → donnée corrompue ou chiffrée avec une clé inconnue
      errorCount++;
    } catch (e) {
      errorCount++;
    }
  }
  
  // Flush remaining batch
  if (batch.length > 0) {
    await AsyncStorageImport.multiSet(batch);
  }
  
  __DEV__ && console.log(
    `[localCrypto] 🔄 Re-encryption: ${reencryptedCount} done, ${alreadyDoneCount} already migrated, ${errorCount} errors`
  );
}

/**
 * Définit la clé de chiffrement local SANS rotation.
 * Utilisé pour la compatibilité (premier démarrage sans PIN, tests).
 */
export function setEncryptionKey(key: Uint8Array | string | null): void {
  if (key === null) {
    encryptionKey = null;
  } else if (typeof key === 'string') {
    encryptionKey = decodeBase64(key);
  } else {
    encryptionKey = key;
  }
}

/**
 * Récupère la clé de chiffrement local
 */
export function getEncryptionKey(): Uint8Array | null {
  return encryptionKey;
}

/**
 * Efface la clé de la mémoire (au verrouillage)
 */
export function clearEncryptionKey(): void {
  if (encryptionKey) {
    encryptionKey.fill(0); // Effacement sécurisé
  }
  encryptionKey = null;
  // Clear opaque key seed
  clearOpaqueKeySeed();
  // Vider aussi le cache (avec zéroisation)
  clearCache();
}

/**
 * Vérifie si le chiffrement local est actif
 */
export function isEncryptionEnabled(): boolean {
  return encryptionKey !== null;
}

// ============================================
// CHIFFREMENT SYNCHRONE OPTIMISÉ
// ============================================

/**
 * Chiffre une chaîne de caractères
 * Format de sortie : "enc1:" + base64([nonce 24B][ciphertext])
 * 
 * Performance : ~0.05ms pour 1KB
 */
export function encrypt(plaintext: string): string {
  const key = getActiveKey();
  if (!key) {
    throw new Error('Encryption key not set');
  }

  const plaintextBytes = decodeUTF8(plaintext);
  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const ciphertext = nacl.secretbox(plaintextBytes, nonce, key);

  if (!ciphertext) {
    throw new Error('Encryption failed');
  }

  // Format compact : nonce || ciphertext
  const combined = new Uint8Array(NONCE_LENGTH + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, NONCE_LENGTH);

  return ENCRYPTED_PREFIX + encodeBase64(combined);
}

/**
 * Déchiffre une chaîne de caractères
 * 
 * Performance : ~0.05ms pour 1KB
 */
export function decrypt(encrypted: string): string {
  const key = getActiveKey();
  if (!key) {
    throw new Error('Encryption key not set');
  }

  if (!encrypted.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error('Invalid encrypted format');
  }

  const combined = decodeBase64(encrypted.slice(ENCRYPTED_PREFIX.length));
  
  if (combined.length < NONCE_LENGTH + 16) { // 16 = minimum auth tag
    throw new Error('Encrypted data too short');
  }

  const nonce = combined.slice(0, NONCE_LENGTH);
  const ciphertext = combined.slice(NONCE_LENGTH);

  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);

  if (!plaintext) {
    throw new Error('Decryption failed - invalid key or corrupted data');
  }

  return encodeUTF8(plaintext);
}

/**
 * Chiffre si le chiffrement est activé, sinon retourne les données telles quelles
 */
export function encryptIfEnabled(data: string): string {
  if (!getActiveKey()) {
    return data;
  }
  return encrypt(data);
}

/**
 * Déchiffre si les données sont chiffrées, sinon retourne telles quelles
 */
export function decryptIfNeeded(data: string): string {
  if (!data.startsWith(ENCRYPTED_PREFIX)) {
    return data; // Données non chiffrées (compatibilité ascendante)
  }
  if (!getActiveKey()) {
    throw new Error('Data is encrypted but no key is available');
  }
  return decrypt(data);
}

// ============================================
// CHIFFREMENT PAR MESSAGE INDIVIDUEL
// ============================================

/**
 * Chiffre un objet message individuel
 * Retourne une chaîne chiffrée compacte
 */
export function encryptMessage(message: object): string {
  return encryptIfEnabled(JSON.stringify(message));
}

/**
 * Déchiffre un message individuel
 */
export function decryptMessage<T>(encrypted: string): T {
  const decrypted = decryptIfNeeded(encrypted);
  return JSON.parse(decrypted);
}

// ============================================
// CACHE MÉMOIRE DES MESSAGES DÉCHIFFRÉS — AVEC ZEROIZATION
// ============================================
// ACTION 6: Les données en clair sont stockées sous forme de Uint8Array (UTF-8 du JSON).
// À l'expiration ou éviction, le buffer est zéroïsé via sodiumMemzero() pour
// éliminer les données en clair de la mémoire avant le passage du GC.

interface SecureCacheEntry {
  dataBytes: Uint8Array;  // UTF-8 encoded JSON, zeroized on eviction
  parsed: WeakRef<object> | null; // WeakRef to avoid reparsing on same tick
  timestamp: number;
}

const messageCache = new Map<string, SecureCacheEntry>();
const CACHE_TTL_MS = 30 * 1000; // 30s — limite l'exposition en cas de memory dump
const MAX_CACHE_ENTRIES = 10; // 10 conversations en cache max

/**
 * Zéroïse et supprime une entrée du cache
 */
function evictCacheEntry(key: string): void {
  const entry = messageCache.get(key);
  if (entry) {
    // Zeroize the plaintext bytes
    const zeroed = sodiumMemzero(entry.dataBytes);
    if (!zeroed) {
      // Fallback si sodium n'est pas ready
      entry.dataBytes.fill(0);
    }
    entry.parsed = null;
    messageCache.delete(key);
  }
}

/**
 * Récupère des données du cache ou les déchiffre
 */
export function getCachedOrDecrypt<T>(
  key: string,
  encryptedData: string | null,
  parser: (data: string) => T
): T | null {
  if (!encryptedData) {
    return null;
  }

  // Vérifier le cache
  const cached = messageCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    // Try to get parsed object from WeakRef first
    const parsedObj = cached.parsed?.deref();
    if (parsedObj) {
      return parsedObj as T;
    }
    // WeakRef was collected, re-parse from bytes
    try {
      const text = encodeUTF8(cached.dataBytes);
      const result = parser(text);
      if (typeof result === 'object' && result !== null) {
        cached.parsed = new WeakRef(result as object);
      }
      return result;
    } catch {
      evictCacheEntry(key);
    }
  }

  // Déchiffrer et mettre en cache
  try {
    const decrypted = decryptIfNeeded(encryptedData);
    const parsed = parser(decrypted);
    
    // Gestion de la taille du cache (FIFO avec zeroization)
    if (messageCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = messageCache.keys().next().value;
      if (oldestKey) {
        evictCacheEntry(oldestKey);
      }
    }
    
    // Store as bytes for secure zeroization
    const dataBytes = decodeUTF8(decrypted);
    const entry: SecureCacheEntry = {
      dataBytes: new Uint8Array(dataBytes),
      parsed: (typeof parsed === 'object' && parsed !== null)
        ? new WeakRef(parsed as object)
        : null,
      timestamp: Date.now(),
    };
    
    messageCache.set(key, entry);
    return parsed;
  } catch (error) {
    __DEV__ && console.error('Decrypt/parse error:', error);
    return null;
  }
}

/**
 * Met à jour le cache après une modification
 */
export function updateCache<T>(key: string, data: T): void {
  // Evict old entry with zeroization
  evictCacheEntry(key);
  
  const json = JSON.stringify(data);
  const dataBytes = decodeUTF8(json);
  
  messageCache.set(key, {
    dataBytes: new Uint8Array(dataBytes),
    parsed: (typeof data === 'object' && data !== null)
      ? new WeakRef(data as object)
      : null,
    timestamp: Date.now(),
  });
}

/**
 * Invalide une entrée du cache (avec zéroisation)
 */
export function invalidateCache(key: string): void {
  evictCacheEntry(key);
}

/**
 * Vide tout le cache avec zéroisation sécurisée (au verrouillage de l'app)
 */
export function clearCache(): void {
  for (const key of messageCache.keys()) {
    evictCacheEntry(key);
  }
  messageCache.clear();
}

// ============================================
// COMPATIBILITÉ AVEC L'ANCIEN FORMAT
// ============================================

const OLD_ENCRYPTION_MARKER = 'whisper_encrypted_';

/**
 * Détecte et migre l'ancien format si nécessaire
 */
export function migrateOldFormat(data: string): string {
  if (data.startsWith(OLD_ENCRYPTION_MARKER)) {
    // Ancien format : whisper_encrypted_ + JSON({data, nonce})
    const key = getActiveKey();
    if (!key) {
      throw new Error('Cannot migrate: encryption key not set');
    }
    
    const oldEncrypted = data.substring(OLD_ENCRYPTION_MARKER.length);
    const { data: encData, nonce } = JSON.parse(oldEncrypted);
    
    const encryptedBytes = decodeBase64(encData);
    const nonceBytes = decodeBase64(nonce);
    
    const plaintext = nacl.secretbox.open(encryptedBytes, nonceBytes, key);
    if (!plaintext) {
      throw new Error('Migration failed: decryption error');
    }
    
    // Retourne le texte en clair (sera rechiffré au nouveau format lors de la sauvegarde)
    return encodeUTF8(plaintext);
  }
  
  return data;
}

/**
 * Déchiffre avec support de l'ancien format
 */
export function decryptWithMigration(data: string): string {
  // Nouveau format
  if (data.startsWith(ENCRYPTED_PREFIX)) {
    return decrypt(data);
  }
  
  // Ancien format
  if (data.startsWith(OLD_ENCRYPTION_MARKER)) {
    return migrateOldFormat(data);
  }
  
  // Non chiffré
  return data;
}

// ============================================
// UTILITAIRES
// ============================================

/**
 * Vérifie si une chaîne est chiffrée (nouveau ou ancien format)
 */
export function isEncrypted(data: string): boolean {
  return data.startsWith(ENCRYPTED_PREFIX) || data.startsWith(OLD_ENCRYPTION_MARKER);
}

/**
 * Génère une clé de chiffrement aléatoire (32 bytes)
 */
export function generateEncryptionKey(): Uint8Array {
  return nacl.randomBytes(32);
}
// ============================================
// ACTION-04 (Phase 2 Security): HARDWARE-BACKED TRANSPARENT ENCRYPTION
// ============================================

/**
 * Initializes transparent hardware-backed encryption.
 * 
 * Called when the app starts WITHOUT a PIN configured.
 * Loads a hardware-backed random key from SecureStore and activates it
 * as the encryption key for all AsyncStorage operations.
 * 
 * @returns true if hardware encryption was successfully initialized
 */
export async function initHardwareEncryption(): Promise<boolean> {
  try {
    const hwKey = await getOrCreateHardwareKey();
    
    // Set the HARDWARE key, NOT encryptionKey.
    // encryptionKey remains null → isEncryptionEnabled() returns false
    // → the rest of the codebase doesn't think a PIN is active.
    // getActiveKey() returns hardwareKey as fallback for encrypt/decrypt.
    hardwareKey = new Uint8Array(hwKey);
    
    __DEV__ && console.log('[localCrypto] 🔒 Hardware encryption initialized (no PIN mode)');
    return true;
  } catch (error) {
    __DEV__ && console.error('[localCrypto] ❌ Hardware encryption unavailable:', error);
    return false;
  }
}

/**
 * Transition from PIN-based encryption to hardware-backed encryption.
 * Called when the user disables the lock/PIN protection.
 *
 * Re-encrypts ALL AsyncStorage entries from the current active key (PIN-derived
 * rotation key) to a fresh hardware-backed key. Without this step, disabling
 * the PIN leaves data encrypted with a key that no longer exists on next boot,
 * making everything unreadable.
 *
 * Sequence:
 *   1. Read current active key (PIN rotation key or hardware key)
 *   2. Generate/load hardware key
 *   3. Re-encrypt all enc1: entries from current → hardware
 *   4. Clear PIN rotation keys from SecureStore
 *   5. Switch module state: encryptionKey = null, hardwareKey = new
 */
export async function transitionPinToHardware(): Promise<boolean> {
  try {
    const currentKey = getActiveKey();
    if (!currentKey) {
      __DEV__ && console.warn('[localCrypto] transitionPinToHardware: no active key');
      return false;
    }

    // Load or create hardware-backed key
    const hwKey = await getOrCreateHardwareKey();
    const newHwKey = new Uint8Array(hwKey);

    // Re-encrypt ALL AsyncStorage entries from PIN key → hardware key
    await reencryptAllEntries(currentKey, newHwKey);

    // Clear PIN rotation keys (wrapped with PIN-derived key, now useless)
    try {
      await SecureStore.deleteItemAsync(ROTATION_KEY_STORE);
      await SecureStore.deleteItemAsync(ROTATION_KEY_PENDING_STORE);
    } catch {
      // Non-critical
    }

    // Switch module state: PIN off, hardware on
    if (encryptionKey) {
      encryptionKey.fill(0);
    }
    encryptionKey = null;
    hardwareKey = newHwKey;

    __DEV__ && console.log('[localCrypto] ✅ Transitioned from PIN to hardware encryption');
    return true;
  } catch (error) {
    __DEV__ && console.error('[localCrypto] ❌ PIN→hardware transition failed:', error);
    return false;
  }
}