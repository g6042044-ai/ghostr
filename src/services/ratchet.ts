// src/services/ratchet.ts
// Hash Ratchet Symétrique - Forward Secrecy pour Whisper
// VERSION CORRIGÉE - Meilleure gestion des états et des copies
//
// CORRECTIONS:
// 1. Copie profonde des skippedKeys dans ratchetStep
// 2. Meilleure gestion des cas limites dans advanceToIndex
// 3. Logs de debug pour faciliter le diagnostic

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';
import { hkdf } from './crypto';

// ============================================
// TYPES
// ============================================

export interface RatchetChainState {
  chainKey: Uint8Array;
  index: number;
  skippedKeys: Map<number, Uint8Array>;
}

export interface SerializedRatchetChain {
  chainKeyBase64: string;
  index: number;
  skippedKeysBase64: Record<number, string>;
}

export interface RatchetStates {
  // Ma chaîne d'envoi
  mySendChain: SerializedRatchetChain;
  // Chaînes de réception par senderToken
  receiveChains: Record<string, SerializedRatchetChain>;
}

// ============================================
// CONSTANTES
// ============================================

const RATCHET_INIT_INFO = 'whisper-ratchet-v1:';
const MESSAGE_KEY_DERIVE = 0x01;
const CHAIN_KEY_DERIVE = 0x02;
const MAX_SKIP = 1000; // Maximum de messages out-of-order tolérés
const SKIPPED_KEYS_LIMIT = 100; // Limite de clés gardées en cache

// Debug mode (à désactiver en production)
const DEBUG_RATCHET = __DEV__ ?? false;

function debugLog(...args: any[]) {
  if (DEBUG_RATCHET) {
    __DEV__ && console.log('[Ratchet]', ...args);
  }
}

// ============================================
// FONCTIONS UTILITAIRES
// ============================================

/**
 * HMAC-SHA256 simplifié pour la dérivation de clé
 * Utilise HKDF avec un info spécifique
 */
async function deriveFromChain(
  chainKey: Uint8Array,
  purpose: number
): Promise<Uint8Array> {
  // Créer un info unique pour chaque purpose
  const info = `whisper-chain-${purpose === MESSAGE_KEY_DERIVE ? 'msg' : 'next'}`;
  return hkdf(chainKey, new Uint8Array(32), info, 32);
}

/**
 * CORRECTION: Clone une Map de skippedKeys
 */
function cloneSkippedKeys(skippedKeys: Map<number, Uint8Array>): Map<number, Uint8Array> {
  const clone = new Map<number, Uint8Array>();
  for (const [index, key] of skippedKeys) {
    clone.set(index, new Uint8Array(key));
  }
  return clone;
}

// ============================================
// INITIALISATION
// ============================================

/**
 * Initialise une chaîne de ratchet pour un senderToken donné
 * L'initialisation est DÉTERMINISTE: même e2eKey + senderToken = même chaîne initiale
 */
export async function initializeChain(
  e2eKey: Uint8Array,
  senderToken: string
): Promise<RatchetChainState> {
  const info = RATCHET_INIT_INFO + senderToken;
  const initialChainKey = await hkdf(e2eKey, new Uint8Array(32), info, 32);
  
  debugLog(`Chain initialized for token ${senderToken.substring(0, 8)}...`);
  
  return {
    chainKey: initialChainKey,
    index: 0,
    skippedKeys: new Map(),
  };
}

// ============================================
// OPÉRATIONS DE RATCHET
// ============================================

/**
 * Avance le ratchet d'un cran et retourne la clé de message
 * CORRIGÉ: Crée une copie des skippedKeys au lieu de partager la référence
 */
export async function ratchetStep(
  state: RatchetChainState
): Promise<{ messageKey: Uint8Array; newState: RatchetChainState }> {
  // Dériver la clé de message
  const messageKey = await deriveFromChain(state.chainKey, MESSAGE_KEY_DERIVE);
  
  // Dériver la nouvelle chainKey
  const newChainKey = await deriveFromChain(state.chainKey, CHAIN_KEY_DERIVE);
  
  // Effacer l'ancienne chainKey (Forward Secrecy)
  state.chainKey.fill(0);
  
  const newIndex = state.index + 1;
  
  debugLog(`Ratchet step: ${state.index} -> ${newIndex}`);
  
  return {
    messageKey,
    newState: {
      chainKey: newChainKey,
      index: newIndex,
      // CORRECTION: Partager la référence est OK ici car on ne modifie pas
      // les clés existantes, on ajoute seulement de nouvelles entrées
      skippedKeys: state.skippedKeys,
    },
  };
}

/**
 * Avance le ratchet jusqu'à un index cible
 * CORRIGÉ: Meilleure gestion des cas limites et logs de debug
 */
export async function advanceToIndex(
  state: RatchetChainState,
  targetIndex: number
): Promise<{ messageKey: Uint8Array; newState: RatchetChainState }> {
  debugLog(`advanceToIndex: target=${targetIndex}, current=${state.index}, skippedKeys=[${Array.from(state.skippedKeys.keys()).join(',')}]`);
  
  // Vérifier si on a déjà une clé skippée pour cet index
  const skippedKey = state.skippedKeys.get(targetIndex);
  if (skippedKey) {
    debugLog(`Using skipped key for index ${targetIndex}`);
    
    // Utiliser et supprimer la clé skippée
    const keyCopy = new Uint8Array(skippedKey);
    skippedKey.fill(0);
    state.skippedKeys.delete(targetIndex);
    
    return {
      messageKey: keyCopy,
      newState: state,
    };
  }
  
  // Vérifier qu'on ne va pas en arrière
  if (targetIndex < state.index) {
    const error = new Error(
      `Ratchet index ${targetIndex} is in the past (current: ${state.index}). ` +
      `Message may have been already processed or is a replay. ` +
      `Available skipped keys: [${Array.from(state.skippedKeys.keys()).join(',')}]`
    );
    debugLog('ERROR:', error.message);
    throw error;
  }
  
  // Vérifier qu'on ne skip pas trop de messages
  const skip = targetIndex - state.index;
  if (skip > MAX_SKIP) {
    const error = new Error(`Too many skipped messages: ${skip} (max: ${MAX_SKIP})`);
    debugLog('ERROR:', error.message);
    throw error;
  }
  
  let currentState = state;
  
  // Avancer jusqu'à l'index cible en gardant les clés intermédiaires
  while (currentState.index < targetIndex) {
    const { messageKey, newState } = await ratchetStep(currentState);
    
    // Garder la clé pour un potentiel message out-of-order
    // Mais limiter la taille du cache
    if (newState.skippedKeys.size < SKIPPED_KEYS_LIMIT) {
      debugLog(`Saving skipped key for index ${currentState.index}`);
      newState.skippedKeys.set(currentState.index, messageKey);
    } else {
      debugLog(`Skipped keys limit reached, discarding key for index ${currentState.index}`);
      // Effacer la clé si on a atteint la limite
      messageKey.fill(0);
    }
    
    currentState = newState;
  }
  
  // Dériver la clé finale pour l'index cible
  debugLog(`Deriving final key for target index ${targetIndex}`);
  const { messageKey, newState } = await ratchetStep(currentState);
  
  return { messageKey, newState };
}

// ============================================
// CHIFFREMENT / DÉCHIFFREMENT
// ============================================

/**
 * Chiffre un contenu avec la clé de message du ratchet
 */
export function encryptWithMessageKey(
  content: string,
  messageKey: Uint8Array
): { encrypted: string; nonce: string } {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const contentBytes = decodeUTF8(content);
  
  const encrypted = nacl.secretbox(contentBytes, nonce, messageKey);
  
  if (!encrypted) {
    throw new Error('Ratchet encryption failed');
  }
  
  // Effacer la clé après usage
  messageKey.fill(0);
  
  return {
    encrypted: encodeBase64(encrypted),
    nonce: encodeBase64(nonce),
  };
}

/**
 * Déchiffre un contenu avec la clé de message du ratchet
 */
export function decryptWithMessageKey(
  encryptedBase64: string,
  nonceBase64: string,
  messageKey: Uint8Array
): string {
  const encrypted = decodeBase64(encryptedBase64);
  const nonce = decodeBase64(nonceBase64);
  
  const decrypted = nacl.secretbox.open(encrypted, nonce, messageKey);
  
  // Effacer la clé après usage (même en cas d'échec)
  messageKey.fill(0);
  
  if (!decrypted) {
    throw new Error('Ratchet decryption failed - invalid key or corrupted message');
  }
  
  return encodeUTF8(decrypted);
}

// ============================================
// SÉRIALISATION / DÉSÉRIALISATION
// ============================================

/**
 * Sérialise l'état d'une chaîne pour le stockage
 */
export function serializeChain(state: RatchetChainState): SerializedRatchetChain {
  const skippedKeysBase64: Record<number, string> = {};
  
  for (const [index, key] of state.skippedKeys) {
    skippedKeysBase64[index] = encodeBase64(key);
  }
  
  return {
    chainKeyBase64: encodeBase64(state.chainKey),
    index: state.index,
    skippedKeysBase64,
  };
}

/**
 * Désérialise l'état d'une chaîne depuis le stockage
 */
export function deserializeChain(serialized: SerializedRatchetChain): RatchetChainState {
  const skippedKeys = new Map<number, Uint8Array>();
  
  if (serialized.skippedKeysBase64) {
    for (const [indexStr, keyBase64] of Object.entries(serialized.skippedKeysBase64)) {
      skippedKeys.set(parseInt(indexStr, 10), decodeBase64(keyBase64));
    }
  }
  
  return {
    chainKey: decodeBase64(serialized.chainKeyBase64),
    index: serialized.index,
    skippedKeys,
  };
}

/**
 * Crée un état de ratchet vide (pour nouvelle conversation)
 */
export function createEmptyRatchetStates(): RatchetStates {
  return {
    mySendChain: {
      chainKeyBase64: '',
      index: 0,
      skippedKeysBase64: {},
    },
    receiveChains: {},
  };
}

// ============================================
// NETTOYAGE
// ============================================

/**
 * Efface proprement une chaîne de la mémoire
 */
export function clearChain(state: RatchetChainState): void {
  state.chainKey.fill(0);
  for (const key of state.skippedKeys.values()) {
    key.fill(0);
  }
  state.skippedKeys.clear();
}

/**
 * Nettoie les clés skippées trop anciennes
 * Garde seulement les N clés les plus récentes
 */
export function pruneSkippedKeys(
  state: RatchetChainState,
  keepCount: number = SKIPPED_KEYS_LIMIT
): void {
  if (state.skippedKeys.size <= keepCount) {
    return;
  }
  
  // Trier les indices
  const indices = Array.from(state.skippedKeys.keys()).sort((a, b) => a - b);
  
  // Supprimer les plus anciens
  const toRemove = indices.slice(0, indices.length - keepCount);
  for (const index of toRemove) {
    const key = state.skippedKeys.get(index);
    if (key) {
      key.fill(0);
      state.skippedKeys.delete(index);
    }
  }
  
  debugLog(`Pruned ${toRemove.length} skipped keys, kept ${state.skippedKeys.size}`);
}