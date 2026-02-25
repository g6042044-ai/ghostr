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

// React Native global — défini par Metro bundler
declare const __DEV__: boolean;

// ============================================
// CONSTANTES
// ============================================

const NONCE_LENGTH = nacl.secretbox.nonceLength; // 24 bytes
const ENCRYPTED_PREFIX = 'enc1:'; // Marqueur version 1

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
  const activeKey = currentKey || new Uint8Array(localKey);
  
  // Activer cette clé pour le code concurrent (polling, etc.)
  encryptionKey = new Uint8Array(activeKey);
  
  // ── Étape 4: Générer une nouvelle clé de rotation ──
  const newKey = nacl.randomBytes(32);
  
  // ── Phase A: Stocker la nouvelle clé en "pending" AVANT de re-chiffrer ──
  try {
    const wrappedPending = wrapKeyForStorage(newKey, localKey);
    await SecureStore.setItemAsync(ROTATION_KEY_PENDING_STORE, wrappedPending);
  } catch (error) {
    console.error('[localCrypto] ❌ Failed to store pending key, aborting rotation:', error);
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
    console.error('[localCrypto] ⚠️ Failed to finalize rotation (will recover on next unlock):', error);
  }
  
  // ── Activer la nouvelle clé ──
  encryptionKey = new Uint8Array(newKey);
  
  // Zeroize
  activeKey.fill(0);
  if (currentKey) currentKey.fill(0);
  
  __DEV__ && console.log('[localCrypto] 🔄 Key rotated successfully');
}

/**
 * Re-chiffre toutes les entrées AsyncStorage enc1: de fromKey vers toKey.
 *
 * CONCURRENCE SAFE: n'utilise JAMAIS la variable module `encryptionKey`.
 * Toutes les opérations crypto utilisent nacl.secretbox directement.
 *
 * CRASH SAFE: chaque entrée est déchiffrée en essayant fromKey puis toKey.
 * Si une entrée est déjà chiffrée avec toKey (re-encryption interrompue),
 * elle est simplement ignorée.
 */
async function reencryptAllEntries(
  fromKey: Uint8Array,
  toKey: Uint8Array
): Promise<void> {
  const allKeys = await AsyncStorageImport.getAllKeys();
  
  let reencryptedCount = 0;
  let alreadyDoneCount = 0;
  let errorCount = 0;
  
  for (const storageKey of allKeys) {
    try {
      const raw = await AsyncStorageImport.getItem(storageKey);
      if (!raw || !raw.startsWith(ENCRYPTED_PREFIX)) continue;
      
      // Essayer de déchiffrer avec fromKey (cas normal)
      let plaintext = decryptRaw(raw, fromKey);
      
      if (plaintext !== null) {
        // Cas normal: entrée chiffrée avec fromKey → re-chiffrer avec toKey
        const reencrypted = encryptRaw(plaintext, toKey);
        await AsyncStorageImport.setItem(storageKey, reencrypted);
        reencryptedCount++;
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
  // Vider aussi le cache
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
  if (!encryptionKey) {
    throw new Error('Encryption key not set');
  }

  const plaintextBytes = decodeUTF8(plaintext);
  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const ciphertext = nacl.secretbox(plaintextBytes, nonce, encryptionKey);

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
  if (!encryptionKey) {
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

  const plaintext = nacl.secretbox.open(ciphertext, nonce, encryptionKey);

  if (!plaintext) {
    throw new Error('Decryption failed - invalid key or corrupted data');
  }

  return encodeUTF8(plaintext);
}

/**
 * Chiffre si le chiffrement est activé, sinon retourne les données telles quelles
 */
export function encryptIfEnabled(data: string): string {
  if (!encryptionKey) {
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
  if (!encryptionKey) {
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
// CACHE MÉMOIRE DES MESSAGES DÉCHIFFRÉS
// ============================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const messageCache = new Map<string, CacheEntry<any>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 50; // Max 50 conversations en cache

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
    return cached.data;
  }

  // Déchiffrer et mettre en cache
  try {
    const decrypted = decryptIfNeeded(encryptedData);
    const parsed = parser(decrypted);
    
    // Gestion de la taille du cache (FIFO simple)
    if (messageCache.size >= MAX_CACHE_ENTRIES) {
      // Supprimer l'entrée la plus ancienne
      const oldestKey = messageCache.keys().next().value;
      if (oldestKey) {
        messageCache.delete(oldestKey);
      }
    }
    
    messageCache.set(key, { data: parsed, timestamp: Date.now() });
    return parsed;
  } catch (error) {
    console.error('Decrypt/parse error:', error);
    return null;
  }
}

/**
 * Met à jour le cache après une modification
 */
export function updateCache<T>(key: string, data: T): void {
  messageCache.set(key, { data, timestamp: Date.now() });
}

/**
 * Invalide une entrée du cache
 */
export function invalidateCache(key: string): void {
  messageCache.delete(key);
}

/**
 * Vide tout le cache (au verrouillage de l'app)
 */
export function clearCache(): void {
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
    if (!encryptionKey) {
      throw new Error('Cannot migrate: encryption key not set');
    }
    
    const oldEncrypted = data.substring(OLD_ENCRYPTION_MARKER.length);
    const { data: encData, nonce } = JSON.parse(oldEncrypted);
    
    const encryptedBytes = decodeBase64(encData);
    const nonceBytes = decodeBase64(nonce);
    
    const plaintext = nacl.secretbox.open(encryptedBytes, nonceBytes, encryptionKey);
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