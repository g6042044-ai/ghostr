// src/services/ratchetStorage.ts
// Stockage de l'état du Hash Ratchet par conversation
// VERSION CORRIGÉE v2.1 - Tokens par conversation
//
// CORRECTIONS:
// 1. Deep copy du cache pour éviter les mutations non contrôlées
// 2. Mutex par conversation pour éviter les race conditions
// 3. Gestion atomique des mises à jour
// 4. v2.1 - Utilisation de getConversationSenderToken() pour tokens non-corrélables

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  RatchetStates,
  SerializedRatchetChain,
  RatchetChainState,
  initializeChain,
  serializeChain,
  deserializeChain,
  ratchetStep,
  advanceToIndex,
  createEmptyRatchetStates,
} from './ratchet';
import {
  encryptIfEnabled,
  decryptIfNeeded,
} from './localCrypto';
import { getConversationKeys, getSenderToken, getConversationSenderToken } from './storage';
import { securityLogger } from './securityLogger';

// ============================================
// CONSTANTES
// ============================================

const RATCHET_PREFIX = 'whisper_ratchet_v1_';

// Cache mémoire pour éviter les lectures répétées
const ratchetCache = new Map<string, RatchetStates>();

// ============================================
// MUTEX SIMPLE POUR ÉVITER LES RACE CONDITIONS
// ============================================

const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Attendre que le lock précédent soit libéré
  while (locks.has(key)) {
    await locks.get(key);
  }
  
  // Créer un nouveau lock
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  locks.set(key, lockPromise);
  
  try {
    return await fn();
  } finally {
    locks.delete(key);
    releaseLock!();
  }
}

// ============================================
// DEEP COPY DES ÉTATS (CRITIQUE!)
// ============================================

function deepCopyRatchetStates(states: RatchetStates): RatchetStates {
  return {
    mySendChain: { ...states.mySendChain, skippedKeysBase64: { ...states.mySendChain.skippedKeysBase64 } },
    receiveChains: Object.fromEntries(
      Object.entries(states.receiveChains).map(([key, chain]) => [
        key,
        { ...chain, skippedKeysBase64: { ...chain.skippedKeysBase64 } }
      ])
    ),
  };
}

// ============================================
// FONCTIONS DE STOCKAGE
// ============================================

/**
 * Récupère l'état du ratchet pour une conversation
 * CORRIGÉ: Retourne une COPIE profonde pour éviter les mutations
 */
export async function getRatchetStates(conversationId: string): Promise<RatchetStates | null> {
  // Vérifier le cache
  const cached = ratchetCache.get(conversationId);
  if (cached) {
    // CORRECTION: Retourner une copie profonde, pas la référence!
    return deepCopyRatchetStates(cached);
  }

  try {
    const key = RATCHET_PREFIX + conversationId;
    const rawData = await AsyncStorage.getItem(key);
    
    if (!rawData) {
      return null;
    }

    // Déchiffrer si nécessaire
    const decrypted = decryptIfNeeded(rawData);
    const states: RatchetStates = JSON.parse(decrypted);
    
    // Mettre en cache (la version originale)
    ratchetCache.set(conversationId, states);
    
    // Retourner une copie
    return deepCopyRatchetStates(states);
  } catch (error) {
    __DEV__ && console.error('Failed to get ratchet states:', error);
    return null;
  }
}

/**
 * Sauvegarde l'état du ratchet pour une conversation
 */
export async function saveRatchetStates(
  conversationId: string,
  states: RatchetStates
): Promise<void> {
  try {
    const key = RATCHET_PREFIX + conversationId;
    const jsonData = JSON.stringify(states);
    const encrypted = encryptIfEnabled(jsonData);
    
    await AsyncStorage.setItem(key, encrypted);
    
    // Mettre à jour le cache avec une copie
    ratchetCache.set(conversationId, deepCopyRatchetStates(states));
  } catch (error) {
    __DEV__ && console.error('Failed to save ratchet states:', error);
    throw error;
  }
}

/**
 * Supprime l'état du ratchet d'une conversation
 */
export async function deleteRatchetStates(conversationId: string): Promise<void> {
  try {
    const key = RATCHET_PREFIX + conversationId;
    await AsyncStorage.removeItem(key);
    ratchetCache.delete(conversationId);
  } catch (error) {
    __DEV__ && console.error('Failed to delete ratchet states:', error);
  }
}

/**
 * Vide le cache mémoire (appelé lors du verrouillage de l'app)
 */
export function clearRatchetCache(): void {
  ratchetCache.clear();
}

// ============================================
// FONCTIONS DE HAUT NIVEAU - AVEC MUTEX
// ============================================

/**
 * Initialise ou récupère l'état du ratchet pour l'envoi
 * CORRIGÉ v2.1: Utilise le token par conversation (non-corrélable)
 */
export async function getOrInitSendChain(
  conversationId: string
): Promise<{ chain: RatchetChainState; states: RatchetStates }> {
  return withLock(`send:${conversationId}`, async () => {
    const keys = await getConversationKeys(conversationId);
    if (!keys) {
      throw new Error('Conversation keys not found');
    }
    
    // v2.1 - Utiliser le token par conversation (non-corrélable)
    const mySenderToken = await getConversationSenderToken(conversationId);
    let states = await getRatchetStates(conversationId);
    
    // Si pas d'état existant, initialiser
    if (!states || !states.mySendChain.chainKeyBase64) {
      const initialChain = await initializeChain(keys.e2eKey, mySenderToken);
      
      states = {
        mySendChain: serializeChain(initialChain),
        receiveChains: states?.receiveChains || {},
      };
      
      await saveRatchetStates(conversationId, states);
      
      return { chain: initialChain, states };
    }
    
    // Désérialiser la chaîne existante
    const chain = deserializeChain(states.mySendChain);
    return { chain, states };
  });
}

/**
 * Met à jour la chaîne d'envoi après un message
 */
export async function updateSendChain(
  conversationId: string,
  newChain: RatchetChainState,
  currentStates: RatchetStates
): Promise<void> {
  return withLock(`send:${conversationId}`, async () => {
    // IMPORTANT: Relire l'état actuel pour éviter d'écraser des changements
    const freshStates = await getRatchetStates(conversationId) || currentStates;
    freshStates.mySendChain = serializeChain(newChain);
    await saveRatchetStates(conversationId, freshStates);
  });
}

/**
 * Récupère ou initialise une chaîne de réception pour un expéditeur donné
 * CORRIGÉ: Utilise un mutex par (conversation, sender) pour éviter les race conditions
 */
export async function getOrInitReceiveChain(
  conversationId: string,
  senderToken: string
): Promise<{ chain: RatchetChainState; states: RatchetStates }> {
  return withLock(`recv:${conversationId}:${senderToken}`, async () => {
    const keys = await getConversationKeys(conversationId);
    if (!keys) {
      throw new Error('Conversation keys not found');
    }
    
    let states = await getRatchetStates(conversationId);
    
    // Si pas d'état existant, créer un nouvel état
    if (!states) {
      states = createEmptyRatchetStates();
    }
    
    // Vérifier si on a déjà une chaîne pour ce sender
    const existingChain = states.receiveChains[senderToken];
    
    if (existingChain && existingChain.chainKeyBase64) {
      const chain = deserializeChain(existingChain);
      return { chain, states };
    }
    
    // Initialiser une nouvelle chaîne pour ce sender
    const newChain = await initializeChain(keys.e2eKey, senderToken);
    states.receiveChains[senderToken] = serializeChain(newChain);
    
    await saveRatchetStates(conversationId, states);
    
    return { chain: newChain, states };
  });
}

/**
 * Met à jour la chaîne de réception après déchiffrement d'un message
 */
export async function updateReceiveChain(
  conversationId: string,
  senderToken: string,
  newChain: RatchetChainState,
  currentStates: RatchetStates
): Promise<void> {
  return withLock(`recv:${conversationId}:${senderToken}`, async () => {
    // IMPORTANT: Relire l'état actuel pour éviter d'écraser des changements
    const freshStates = await getRatchetStates(conversationId) || currentStates;
    freshStates.receiveChains[senderToken] = serializeChain(newChain);
    await saveRatchetStates(conversationId, freshStates);
  });
}

// ============================================
// FONCTIONS UTILITAIRES POUR L'API - CORRIGÉES
// ============================================

/**
 * Prépare une clé de message pour l'envoi
 * CORRIGÉ: Mise à jour atomique de l'état
 */
export async function prepareMessageKey(
  conversationId: string
): Promise<{
  messageKey: Uint8Array;
  ratchetIndex: number;
  updateFn: () => Promise<void>;
}> {
  return withLock(`send:${conversationId}`, async () => {
    const { chain, states } = await getOrInitSendChainInternal(conversationId);
    const currentIndex = chain.index;
    
    // Avancer le ratchet
    const { messageKey, newState } = await ratchetStep(chain);
    
    // CORRECTION: Mettre à jour l'état IMMÉDIATEMENT pour éviter les doublons d'index
    states.mySendChain = serializeChain(newState);
    await saveRatchetStates(conversationId, states);
    
    // La fonction updateFn devient un no-op car on a déjà mis à jour
    const updateFn = async () => {
      // Déjà fait ci-dessus
    };
    
    return {
      messageKey,
      ratchetIndex: currentIndex,
      updateFn,
    };
  });
}

// Version interne sans lock (appelée depuis une fonction déjà lockée)
// v2.1 - Utilise le token par conversation
async function getOrInitSendChainInternal(
  conversationId: string
): Promise<{ chain: RatchetChainState; states: RatchetStates }> {
  const keys = await getConversationKeys(conversationId);
  if (!keys) {
    throw new Error('Conversation keys not found');
  }
  
  // v2.1 - Token par conversation
  const mySenderToken = await getConversationSenderToken(conversationId);
  let states = await getRatchetStates(conversationId);
  
  if (!states || !states.mySendChain.chainKeyBase64) {
    const initialChain = await initializeChain(keys.e2eKey, mySenderToken);
    
    states = {
      mySendChain: serializeChain(initialChain),
      receiveChains: states?.receiveChains || {},
    };
    
    await saveRatchetStates(conversationId, states);
    
    return { chain: initialChain, states };
  }
  
  const chain = deserializeChain(states.mySendChain);
  return { chain, states };
}

/**
 * Récupère une clé de message pour le déchiffrement
 * CORRIGÉ: Gestion atomique et meilleure gestion des erreurs
 * v2.2: Ne pas lancer d'erreur pour les anciens messages, retourner null
 */
export async function getMessageKeyForDecrypt(
  conversationId: string,
  senderToken: string,
  ratchetIndex: number
): Promise<{
  messageKey: Uint8Array;
  updateFn: () => Promise<void>;
} | null> {
  return withLock(`recv:${conversationId}:${senderToken}`, async () => {
    const { chain, states } = await getOrInitReceiveChainInternal(conversationId, senderToken);
    
    // v2.2 - Vérification plus tolérante pour les anciens messages
    if (ratchetIndex < chain.index && !chain.skippedKeys.has(ratchetIndex)) {
      // Ce message a probablement déjà été traité - le skipper silencieusement
      __DEV__ && console.log(
        `⏭️ Skipping old message: index ${ratchetIndex} < current ${chain.index} ` +
        `(key not in skippedKeys). Probably already processed.`
      );
      
      // Logger la désynchronisation potentielle (en arrière-plan)
      securityLogger.logRatchetDesync(conversationId, chain.index, ratchetIndex).catch(() => {});
      
      return null;
    }
    
    // Avancer jusqu'à l'index demandé
    const { messageKey, newState } = await advanceToIndex(chain, ratchetIndex);
    
    // CORRECTION: Mettre à jour l'état IMMÉDIATEMENT
    states.receiveChains[senderToken] = serializeChain(newState);
    await saveRatchetStates(conversationId, states);
    
    // La fonction updateFn devient un no-op
    const updateFn = async () => {
      // Déjà fait ci-dessus
    };
    
    return {
      messageKey,
      updateFn,
    };
  });
}

// Version interne sans lock
async function getOrInitReceiveChainInternal(
  conversationId: string,
  senderToken: string
): Promise<{ chain: RatchetChainState; states: RatchetStates }> {
  const keys = await getConversationKeys(conversationId);
  if (!keys) {
    throw new Error('Conversation keys not found');
  }
  
  let states = await getRatchetStates(conversationId);
  
  if (!states) {
    states = createEmptyRatchetStates();
  }
  
  const existingChain = states.receiveChains[senderToken];
  
  if (existingChain && existingChain.chainKeyBase64) {
    const chain = deserializeChain(existingChain);
    return { chain, states };
  }
  
  const newChain = await initializeChain(keys.e2eKey, senderToken);
  states.receiveChains[senderToken] = serializeChain(newChain);
  
  await saveRatchetStates(conversationId, states);
  
  return { chain: newChain, states };
}