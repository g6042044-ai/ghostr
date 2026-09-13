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
  
  // ──────────────────────────────────────────────────────────────────────────
  // CRASH RECOVERY — entrées orphelines sur DEVICE_ENCRYPTION_KEY
  // ──────────────────────────────────────────────────────────────────────────
  // Si une `transitionPinToHardware` (désactivation du PIN) a crashé en cours,
  // certaines entrées AsyncStorage peuvent encore être chiffrées avec le device
  // key au lieu de la rotation key. Le pass standard ci-dessus (Phase B) a
  // raté ces entrées car ni `activeKey` ni `newKey` ne peuvent les déchiffrer.
  //
  // Sans cette récupération, la suppression de DEVICE_ENCRYPTION_KEY juste
  // après rendrait ces entrées DÉFINITIVEMENT illisibles. Avec elle, on les
  // migre proprement vers la nouvelle rotation key avant cleanup.
  //
  // Cas normal (pas de crash récent) : aucune entrée n'est sur deviceKey →
  // reencryptAllEntries termine son `getAllKeys` rapidement avec `errorCount`
  // sur tout, sans aucune écriture. Coût ~10-50 ms par unlock, acceptable.
  //
  // Skip si activeKey === deviceKey (cas où le device key était déjà la clé
  // active utilisée par le pass standard) : pas besoin de re-itérer.
  // ──────────────────────────────────────────────────────────────────────────
  let deviceKeyRecover: Uint8Array | null = null;
  try {
    const deviceKeyB64 = await SecureStore.getItemAsync('ghostr_device_encryption_key_v1');
    if (deviceKeyB64) {
      const decoded = decodeBase64(deviceKeyB64);
      if (decoded.length === 32) {
        // Vérifier si c'est la même clé que activeKey (déjà traitée)
        let same = activeKey.length === decoded.length;
        if (same) {
          for (let i = 0; i < activeKey.length; i++) {
            if (activeKey[i] !== decoded[i]) { same = false; break; }
          }
        }
        if (!same) {
          deviceKeyRecover = decoded;
        } else {
          decoded.fill(0);
        }
      } else {
        decoded.fill(0);
      }
    }
  } catch {
    // SecureStore inaccessible → pas de récupération possible, mais
    // si la clé était lisible avant, le pass standard suffit dans la majorité
    // des cas. Continuer sans bloquer.
  }
  
  if (deviceKeyRecover) {
    __DEV__ && console.log('[localCrypto] 🔄 Recovery pass: migrating any device-key entries to new rotation key');
    await reencryptAllEntries(deviceKeyRecover, newKey);
    deviceKeyRecover.fill(0);
  }
  
  // Clean up device-level key from ensureDeviceLevelEncryption.
  // Now safe : si des entrées étaient encore sur cette clé (crash recovery
  // ci-dessus), elles ont été migrées vers newKey juste avant. Aucune perte
  // de données possible ici.
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
 * ═══════════════════════════════════════════════════════════════════════════
 * PERF (correctif) — LECTURES PAR LOT via multiGet()
 * ═══════════════════════════════════════════════════════════════════════════
 * AVANT : boucle `for` avec `await AsyncStorage.getItem(k)` clé par clé.
 *   Chaque getItem est un aller-retour complet pont JS ↔ natif ↔ SQLite,
 *   soit ~1 à 3 ms sur Android. Cette fonction s'exécutant à CHAQUE
 *   déverrouillage (rotation anti-forensique), le coût était linéaire en
 *   nombre d'entrées et bloquait l'affichage :
 *       3 000 entrées  →  3 à 10 s
 *      10 000 entrées  →  30 s et plus
 *   C'était la première cause de lenteur perçue au démarrage.
 *
 * APRÈS : `multiGet` par lots de READ_BATCH_SIZE. Le nombre d'allers-retours
 *   passe de N à N/200. Le travail cryptographique est inchangé, mais il
 *   n'était pas le goulot d'étranglement — le pont l'était.
 *
 * Un `await` de respiration est inséré entre les lots pour rendre la main à
 * la boucle d'événements : sur un très gros magasin, l'UI de chargement
 * continue de s'animer au lieu de geler.
 *
 * CONCURRENCE SAFE: n'utilise JAMAIS la variable module `encryptionKey`.
 * CRASH SAFE: chaque entrée est déchiffrée en essayant fromKey puis toKey.
 * ATOMICITÉ: multiSet écrit toutes les entrées d'un batch en une seule transaction SQLite.
 */

/** Nombre de clés lues par appel multiGet. 200 = compromis mémoire/latence. */
const READ_BATCH_SIZE = 200;

/** Nombre d'entrées écrites par appel multiSet (inchangé). */
const WRITE_BATCH_SIZE = 50;

async function reencryptAllEntries(
  fromKey: Uint8Array,
  toKey: Uint8Array
): Promise<void> {
  const startedAt = Date.now();
  const allKeys = await AsyncStorageImport.getAllKeys();

  let reencryptedCount = 0;
  let alreadyDoneCount = 0;
  let errorCount = 0;

  let batch: [string, string][] = [];

  const flush = async () => {
    if (batch.length > 0) {
      await AsyncStorageImport.multiSet(batch);
      batch = [];
    }
  };

  for (let i = 0; i < allKeys.length; i += READ_BATCH_SIZE) {
    const chunk = allKeys.slice(i, i + READ_BATCH_SIZE);

    let entries: readonly [string, string | null][];
    try {
      // multiGet : UN seul aller-retour pour tout le lot.
      entries = await AsyncStorageImport.multiGet(chunk as string[]);
    } catch (e) {
      // Repli défensif : si multiGet échoue (implémentation exotique,
      // lot trop gros sur un vieil Android), on retombe sur des lectures
      // unitaires pour CE lot uniquement. La rotation ne doit jamais
      // échouer en bloc — une entrée non migrée est récupérable au
      // prochain déverrouillage, une rotation avortée ne l'est pas.
      __DEV__ && console.warn('[localCrypto] multiGet indisponible, repli getItem sur ce lot:', e);
      const fallback: [string, string | null][] = [];
      for (const k of chunk) {
        try { fallback.push([k, await AsyncStorageImport.getItem(k)]); }
        catch { fallback.push([k, null]); }
      }
      entries = fallback;
    }

    for (const [storageKey, raw] of entries) {
      try {
        if (!raw || !raw.startsWith(ENCRYPTED_PREFIX)) continue;

        // Essayer de déchiffrer avec fromKey (cas normal)
        let plaintext = decryptRaw(raw, fromKey);

        if (plaintext !== null) {
          // Cas normal: entrée chiffrée avec fromKey → re-chiffrer avec toKey
          const reencrypted = encryptRaw(plaintext, toKey);
          batch.push([storageKey, reencrypted]);
          reencryptedCount++;

          if (batch.length >= WRITE_BATCH_SIZE) {
            await flush();
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

    // Rendre la main à la boucle d'événements entre deux lots (UI fluide).
    if (i + READ_BATCH_SIZE < allKeys.length) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  // Flush remaining batch
  await flush();

  __DEV__ && console.log(
    `[localCrypto] ⏱️ Rotation: ${allKeys.length} clés parcourues en ${Date.now() - startedAt} ms`
  );
  
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
 * Vérifie si le chiffrement local est actif (PIN-mode).
 *
 * ⚠️ ATTENTION SÉMANTIQUE : retourne false si SEULE la `hardwareKey` est
 * chargée (mode "no-PIN"). Le rest du codebase utilisait historiquement ce
 * prédicat comme "le PIN est actif". Pour vérifier si on peut chiffrer ou
 * déchiffrer (PIN OU hardware), utiliser `hasAnyEncryptionKey()`.
 */
export function isEncryptionEnabled(): boolean {
  return encryptionKey !== null;
}

/**
 * Vérifie si UNE clé (PIN ou hardware) est disponible pour chiffrer/déchiffrer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE PRÉDICAT EXISTE — bug de migration (mai 2026)
 * ════════════════════════════════════════════════════════════════════════════
 * `isEncryptionEnabled()` ne regarde QUE `encryptionKey` (la clé PIN-derivée),
 * jamais `hardwareKey`. Or `encryptIfEnabled` / `decryptIfNeeded` utilisent
 * `getActiveKey()` qui retourne `encryptionKey || hardwareKey`. Cela créait
 * une asymétrie : les écritures réussissent (chiffrées avec hardwareKey) mais
 * les lectures via secureGet() ailleurs dans le code échouent parce qu'elles
 * gardent `if (raw.startsWith('enc1:') && !isEncryptionEnabled()) return null;`.
 *
 * Symptôme observé : après import de migration sans PIN, les conversations
 * sont visibles (lues via getConversations qui utilise conversationsHardwareKey)
 * mais les messages reviennent vides et l'envoi/réception est cassé (secureGet
 * dans api1to1.ts retourne null sur toutes les entrées chiffrées).
 *
 * Ce prédicat est ce qu'il aurait toujours dû y avoir dans les gardes
 * "données chiffrées mais pas de clé en RAM" : on veut savoir s'il existe UNE
 * clé permettant le déchiffrement, pas si l'utilisateur a un PIN.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function hasAnyEncryptionKey(): boolean {
  return getActiveKey() !== null;
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
 * Transition from PIN-based encryption to no-PIN device-level encryption.
 * Called when the user disables the lock/PIN protection.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * INVARIANT CRITIQUE — À LIRE AVANT TOUTE MODIFICATION
 * ════════════════════════════════════════════════════════════════════════════
 * Cette fonction DOIT re-chiffrer les données vers la MÊME clé que
 * `sessionService.ensureDeviceLevelEncryption()` chargera au prochain boot,
 * c'est-à-dire la clé device-level stockée sous DEVICE_ENCRYPTION_KEY
 * ('ghostr_device_encryption_key_v1') dans SecureStore.
 *
 * Si on re-chiffre vers une autre clé (par exemple `getOrCreateHardwareKey`
 * de hardwareKeyProvider, qui génère une clé DIFFÉRENTE) :
 *   - La transition réussit visuellement dans la session courante (la clé
 *     est en RAM, les données sont lisibles).
 *   - Mais au prochain cold start, `ensureDeviceLevelEncryption` ne trouve
 *     pas de DEVICE_ENCRYPTION_KEY (puisque setupLock l'a supprimée et
 *     personne ne l'a recréée), génère une NOUVELLE clé, et active cette
 *     dernière comme `encryptionKey`. La clé qui chiffre réellement les
 *     données sur disque (l'ancienne clé hardware) n'est plus utilisée.
 *   - Toutes les lectures AsyncStorage échouent (MAC Poly1305 invalide) :
 *     messages invisibles, participants disparus, sessions Triple Ratchet
 *     régénérées par les blocs catch → identités cryptographiques détruites.
 *
 * Le bug a été découvert en mai 2026 par un utilisateur qui rapportait
 * "perdre toutes les conversations et contacts" après avoir activé puis
 * désactivé le PIN. La séquence buggée était :
 *   setupLock → unlock → setEncryptionKeyAndRotate (supprime DEVICE_KEY) →
 *   disableLock → transition (re-chiffre vers hwKey ≠ DEVICE_KEY) →
 *   restart → ensureDeviceLevelEncryption génère NEW DEVICE_KEY → mismatch.
 *
 * Le correctif : utiliser/recréer DEVICE_ENCRYPTION_KEY ici, puis activer
 * cette même clé via `encryptionKey = deviceKey`. Au prochain boot,
 * `ensureDeviceLevelEncryption` trouvera la clé existante (au lieu d'en
 * générer une nouvelle) et l'activera dans `encryptionKey` à l'identique.
 * Les données restent lisibles indéfiniment.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Sequence:
 *   1. Read current active key (PIN rotation key, device key, or hardware key)
 *   2. Load existing DEVICE_ENCRYPTION_KEY from SecureStore, or create one
 *      (recréée si supprimée par setupLock précédent — boot-cohérent)
 *   3. Re-encrypt all enc1: entries from current → device key
 *   4. Clear PIN rotation keys from SecureStore (wrapped by localKey, useless
 *      maintenant que le PIN est désactivé)
 *   5. Switch module state: encryptionKey = device key (cohérent avec ce que
 *      ensureDeviceLevelEncryption fera au prochain boot)
 */
const DEVICE_ENCRYPTION_KEY_STORE = 'ghostr_device_encryption_key_v1';

export async function transitionPinToHardware(): Promise<boolean> {
  try {
    const currentKey = getActiveKey();
    if (!currentKey) {
      __DEV__ && console.warn('[localCrypto] transitionPinToHardware: no active key');
      return false;
    }

    // ────────────────────────────────────────────────────────────────────────
    // ÉTAPE 1 : Charger ou recréer le device key.
    //
    // Le device key persiste entre lock/unlock/relock/disable. Il a pu être
    // supprimé par `setEncryptionKeyAndRotate` (ligne 286 de ce fichier) lors
    // de la première activation du PIN. Dans ce cas on le régénère — la clé
    // précédente était de toute façon désactivée et toutes les données ont
    // depuis été ré-écrites avec la rotation key.
    //
    // IMPORTANT: les options SecureStore sont identiques à celles utilisées
    // par sessionService.ensureDeviceLevelEncryption (WHEN_UNLOCKED_THIS_DEVICE_ONLY)
    // pour que la clé soit lisible par le prochain boot sans friction.
    // ────────────────────────────────────────────────────────────────────────
    let deviceKey: Uint8Array;
    let needsWrite = false;

    try {
      const stored = await SecureStore.getItemAsync(DEVICE_ENCRYPTION_KEY_STORE);
      if (stored) {
        const parsed = decodeBase64(stored);
        if (parsed.length === 32) {
          deviceKey = parsed;
          __DEV__ && console.log('[localCrypto] 🔄 Reusing existing device-level key for transition');
        } else {
          // Clé corrompue (taille inattendue) → regénérer
          deviceKey = nacl.randomBytes(32);
          needsWrite = true;
          __DEV__ && console.warn('[localCrypto] ⚠️ Existing device key has wrong length, regenerating');
        }
      } else {
        // Clé absente (cas typique : setupLock l'a supprimée)
        deviceKey = nacl.randomBytes(32);
        needsWrite = true;
        __DEV__ && console.log('[localCrypto] 🔑 No device key found, generating fresh one for transition');
      }
    } catch (e) {
      // SecureStore inaccessible → générer une clé volatile pour ne pas
      // bloquer la session courante. Le prochain boot tentera une nouvelle
      // génération via ensureDeviceLevelEncryption.
      __DEV__ && console.warn('[localCrypto] ⚠️ SecureStore read failed during transition:', e);
      deviceKey = nacl.randomBytes(32);
      needsWrite = true;
    }

    // ────────────────────────────────────────────────────────────────────────
    // ÉTAPE 2 : Persister le device key AVANT la re-encryption.
    //
    // Si l'app crashe entre la persistence et la re-encryption, on aura juste
    // un device key non-utilisé en SecureStore — inoffensif. Si on faisait
    // l'inverse (re-encrypt PUIS persist) et que ça crashait entre les deux,
    // les données seraient chiffrées avec un device key qui n'existe nulle
    // part → unreadable. L'ordre matters.
    // ────────────────────────────────────────────────────────────────────────
    if (needsWrite) {
      try {
        await SecureStore.setItemAsync(
          DEVICE_ENCRYPTION_KEY_STORE,
          encodeBase64(deviceKey),
          { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
        );
      } catch (e) {
        // Échec d'écriture SecureStore : on ne peut pas garantir la cohérence
        // au prochain boot. Abort la transition pour ne pas corrompre les données.
        __DEV__ && console.error('[localCrypto] ❌ Failed to persist device key, aborting transition:', e);
        deviceKey.fill(0);
        return false;
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // ÉTAPE 3 : Re-chiffrer toutes les entrées AsyncStorage.
    // currentKey (rotation key PIN-derived) → deviceKey (persistant en SecureStore)
    //
    // No-op gracieux si currentKey === deviceKey (cas rare : disableLock
    // appelé juste après setupLock sans unlock entre les deux). reencryptAllEntries
    // déchiffre puis re-chiffre avec un nonce frais — overhead léger mais safe.
    // ────────────────────────────────────────────────────────────────────────
    await reencryptAllEntries(currentKey, deviceKey);

    // ────────────────────────────────────────────────────────────────────────
    // ÉTAPE 4 : Effacer les clés de rotation PIN (wrappées par localKey,
    // désormais inutiles puisque le PIN est désactivé).
    // ────────────────────────────────────────────────────────────────────────
    try {
      await SecureStore.deleteItemAsync(ROTATION_KEY_STORE);
      await SecureStore.deleteItemAsync(ROTATION_KEY_PENDING_STORE);
    } catch {
      // Non-critique : si la suppression échoue, ces clés resteront en place
      // mais ne pourront pas être déwrappées (localKey perdu) — donc inertes.
    }

    // ────────────────────────────────────────────────────────────────────────
    // ÉTAPE 5 : Activer le device key dans l'état module.
    //
    // On set encryptionKey (PAS hardwareKey) pour être cohérent avec ce que
    // ensureDeviceLevelEncryption fera au prochain boot (`localCryptoSetKey(deviceKey)`
    // qui set encryptionKey). Ainsi getActiveKey() retournera la même clé
    // dans la session courante et après redémarrage : la donnée est lisible
    // de manière déterministe à travers tous les cycles d'app.
    //
    // hardwareKey reste tel qu'il était (peut être null si on était en flow
    // PIN, ou hwKey si initHardwareEncryption a été appelé). Sans importance :
    // encryptionKey a la priorité dans getActiveKey().
    // ────────────────────────────────────────────────────────────────────────
    if (encryptionKey) {
      encryptionKey.fill(0);
    }
    encryptionKey = new Uint8Array(deviceKey);
    deviceKey.fill(0); // la copie originale n'est plus utile

    __DEV__ && console.log('[localCrypto] ✅ Transitioned PIN → device-level encryption (boot-consistent)');
    return true;
  } catch (error) {
    __DEV__ && console.error('[localCrypto] ❌ PIN→device transition failed:', error);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RÉCUPÉRATION POST-BUG (mai 2026) — adopt hardwareKey as deviceKey
// ════════════════════════════════════════════════════════════════════════════
/**
 * Tente de récupérer un état orphelin causé par l'ancienne version buggée de
 * `transitionPinToHardware` (avant mai 2026). À cette époque, désactiver le
 * PIN re-chiffrait les données AsyncStorage avec `hwKey` (de hardwareKeyProvider)
 * mais ne créait pas de DEVICE_ENCRYPTION_KEY. Au prochain boot,
 * `ensureDeviceLevelEncryption` ne trouvait pas de DEVICE_ENCRYPTION_KEY,
 * en générait une nouvelle, et perdait l'accès aux données chiffrées avec hwKey.
 *
 * Cette fonction est appelée par `ensureDeviceLevelEncryption` AVANT de générer
 * une nouvelle clé. Elle vérifie si les données AsyncStorage existantes sont
 * déchiffrables avec `hardwareKey` (qui est toujours dans SecureStore et chargée
 * en mémoire par `initHardwareEncryptionAll`). Si oui, c'est la signature de
 * l'ancien bug : on adopte `hardwareKey` comme `deviceKey` permanent en la
 * persistant dans `DEVICE_ENCRYPTION_KEY` et en l'activant dans `encryptionKey`.
 *
 * SÉCURITÉ DE LA DÉTECTION :
 *   - Le test repose sur le déchiffrement AEAD (XSalsa20-Poly1305).
 *   - Probabilité de faux positif (MAC valide avec mauvaise clé) : ~2⁻¹²⁸
 *   - On exige TOUS les échantillons valides (zéro tolérance aux échecs)
 *   - Il faut au moins 1 entrée chiffrée pour activer la récupération
 *     (un fresh install n'a rien et tombera dans le chemin "génération")
 *
 * @returns true si la récupération a réussi (encryptionKey est activée),
 *          false si non applicable (laisse l'appelant générer une nouvelle clé)
 */
const SAMPLE_SIZE_FOR_RECOVERY = 5;

export async function tryRecoverFromPreFixBug(): Promise<boolean> {
  // Pré-condition : hardwareKey doit être déjà chargée (par initHardwareEncryptionAll)
  if (!hardwareKey) {
    return false;
  }

  // Pré-condition : DEVICE_ENCRYPTION_KEY doit être absent (sinon pas besoin de
  // récupération — le chemin normal s'occupe du chargement)
  try {
    const existing = await SecureStore.getItemAsync(DEVICE_ENCRYPTION_KEY_STORE);
    if (existing) {
      return false; // Pas un cas de récupération
    }
  } catch {
    return false;
  }

  // Sample quelques entrées AsyncStorage chiffrées et tester avec hardwareKey
  let allKeys: readonly string[];
  try {
    allKeys = await AsyncStorageImport.getAllKeys();
  } catch {
    return false;
  }

  let testedSamples = 0;
  let successfulDecryptions = 0;

  for (const storageKey of allKeys) {
    if (testedSamples >= SAMPLE_SIZE_FOR_RECOVERY) break;
    try {
      const value = await AsyncStorageImport.getItem(storageKey);
      if (!value || !value.startsWith(ENCRYPTED_PREFIX)) continue;

      testedSamples++;
      if (decryptRaw(value, hardwareKey) !== null) {
        successfulDecryptions++;
      } else {
        // Un échec suffit à abandonner la récupération — pas de "majorité"
        // possible ici, on est strict pour ne jamais corrompre des données.
        __DEV__ && console.log('[localCrypto] Recovery aborted: sample failed to decrypt with hardwareKey');
        return false;
      }
    } catch {
      // Erreur de lecture isolée → ignore cette entrée, continue
      continue;
    }
  }

  // Aucune donnée chiffrée trouvée → fresh install, pas de récupération
  if (testedSamples === 0) {
    return false;
  }

  // Tous les échantillons (au moins 1) ont déchiffré avec succès → c'est bien
  // hardwareKey qui chiffre les données. Adopter cette clé comme deviceKey.
  if (successfulDecryptions === testedSamples && testedSamples > 0) {
    try {
      await SecureStore.setItemAsync(
        DEVICE_ENCRYPTION_KEY_STORE,
        encodeBase64(hardwareKey),
        { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
      );
    } catch (e) {
      __DEV__ && console.error('[localCrypto] Recovery: failed to persist adopted key:', e);
      return false; // Sans persistence on ne peut pas garantir le prochain boot
    }

    // Activer dans encryptionKey (cohérent avec le contrat post-fix de
    // ensureDeviceLevelEncryption : encryptionKey != null après init).
    if (encryptionKey) encryptionKey.fill(0);
    encryptionKey = new Uint8Array(hardwareKey);

    __DEV__ && console.log(
      `[localCrypto] 🔧 Pre-fix bug recovered: adopted hardwareKey as deviceKey ` +
      `(${testedSamples}/${testedSamples} samples decrypted successfully)`
    );
    return true;
  }

  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// PROMOTION PROACTIVE — utilisée par la migration import (mai 2026)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Promeut la `hardwareKey` actuellement en RAM en clé device-level persistante.
 *
 * Effets, dans l'ordre :
 *   1. Persiste `hardwareKey` dans SecureStore sous `DEVICE_ENCRYPTION_KEY_STORE`
 *      (= `ghostr_device_encryption_key_v1`). Au prochain cold boot,
 *      `sessionService.ensureDeviceLevelEncryption()` chargera CETTE valeur
 *      via `localCryptoSetKey(deviceKeyB64)`. La clé est donc stable à travers
 *      les redémarrages.
 *   2. Active `encryptionKey = hardwareKey` en mémoire. Conséquence immédiate :
 *      `isEncryptionEnabled()` retourne true, ce qui débloque les gardes
 *      `!isEncryptionEnabled()` éparpillées dans le codebase (api1to1.secureGet,
 *      pendingInvites.load, etc.) qui sinon retourneraient `null` sur toutes
 *      les entrées `enc1:` fraîchement écrites.
 *
 * RATIONALE — pourquoi cette fonction existe :
 *
 * Le flow d'IMPORT de migration faisait :
 *   nuclearReset()
 *     ├─ supprime DEVICE_ENCRYPTION_KEY
 *     └─ supprime les hardware keys
 *   initHardwareEncryptionAll()
 *     ├─ régénère hardwareKey
 *     └─ NE PERSISTE PAS DEVICE_ENCRYPTION_KEY
 *   writeEncrypted(...) × N
 *     └─ chiffre avec hardwareKey, mais encryptionKey reste null
 *
 * Au prochain boot, `ensureDeviceLevelEncryption` cherchait DEVICE_ENCRYPTION_KEY,
 * ne le trouvait pas, et déléguait à `tryRecoverFromPreFixBug()`. Cette
 * récupération est un mécanisme post-mortem : elle sample 5 entrées AsyncStorage
 * et exige qu'elles déchiffrent toutes avec `hardwareKey`. Si une seule échoue
 * (entrée écrite par un autre service avec une clé éphémère, donnée corrompue,
 * etc.) → recovery abandonnée → génération d'une NOUVELLE deviceKey → les
 * données chiffrées avec l'ancienne hardwareKey deviennent illisibles → toutes
 * les sessions Triple Ratchet sont chargées vides → l'app génère une nouvelle
 * identité → "tout a disparu" du point de vue utilisateur.
 *
 * En appelant cette fonction au moment de l'import, on transforme un chemin
 * de récupération fragile en un chemin nominal déterministe.
 *
 * Idempotente : safe à appeler plusieurs fois (la 2e écriture est identique
 * à la 1re puisque hardwareKey n'a pas changé).
 *
 * @returns true si la promotion a réussi (persistence + activation),
 *          false si hardwareKey n'est pas en RAM ou si la persistence a échoué.
 */
export async function promoteHardwareKeyToDeviceKey(): Promise<boolean> {
  if (!hardwareKey) {
    __DEV__ && console.warn(
      '[localCrypto] promoteHardwareKeyToDeviceKey: no hardwareKey in RAM — ' +
      'call initHardwareEncryption() first'
    );
    return false;
  }

  // 1. Persister AVANT d'activer en mémoire.
  //    Si un crash survient entre la persistence et l'activation, le prochain
  //    boot trouvera DEVICE_ENCRYPTION_KEY et chargera la bonne clé — état
  //    cohérent. À l'inverse, si on activait d'abord puis crashait avant
  //    persister, le prochain boot ne trouverait rien et régénérerait une
  //    clé différente → toutes les données enc1: deviennent illisibles.
  try {
    await SecureStore.setItemAsync(
      DEVICE_ENCRYPTION_KEY_STORE,
      encodeBase64(hardwareKey),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
    );
  } catch (e) {
    __DEV__ && console.error(
      '[localCrypto] promoteHardwareKeyToDeviceKey: SecureStore write failed:',
      e
    );
    return false;
  }

  // 2. Vérification défensive : relire ce qu'on vient d'écrire. Sur certains
  //    appareils (vieux Android, émulateurs avec Keystore défaillant), une
  //    écriture SecureStore peut renvoyer sans erreur mais ne pas être
  //    réellement persistée. Sans cette vérif, on activerait encryptionKey
  //    et tout marcherait jusqu'au reboot, où les données seraient orphelines.
  try {
    const verify = await SecureStore.getItemAsync(DEVICE_ENCRYPTION_KEY_STORE);
    if (!verify) {
      __DEV__ && console.error(
        '[localCrypto] promoteHardwareKeyToDeviceKey: persistence verification ' +
        'failed (write returned but readback is empty)'
      );
      return false;
    }
    // Sanity check sur la valeur écrite
    const decoded = decodeBase64(verify);
    if (decoded.length !== 32) {
      __DEV__ && console.error(
        '[localCrypto] promoteHardwareKeyToDeviceKey: persisted key has ' +
        `unexpected length ${decoded.length}, expected 32`
      );
      return false;
    }
  } catch (e) {
    __DEV__ && console.error(
      '[localCrypto] promoteHardwareKeyToDeviceKey: readback failed:',
      e
    );
    return false;
  }

  // 3. Activer dans encryptionKey. À partir d'ici, `isEncryptionEnabled()`
  //    retourne true et tous les call sites peuvent lire/écrire normalement.
  if (encryptionKey) encryptionKey.fill(0);
  encryptionKey = new Uint8Array(hardwareKey);

  __DEV__ && console.log(
    '[localCrypto] ✅ hardwareKey promoted to persistent deviceKey ' +
    '(encryptionKey activated, DEVICE_ENCRYPTION_KEY persisted)'
  );
  return true;
}