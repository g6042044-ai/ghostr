// src/services/tripleRatchet/spqr.ts
// SPQR - Sparse Post-Quantum Ratchet
// Version 1.0 - Implémentation conforme Signal Triple Ratchet
//
// ARCHITECTURE TRIPLE RATCHET:
// ============================
// Le Triple Ratchet combine trois mécanismes de ratcheting:
// 1. DH Ratchet (X25519) - À chaque changement de direction de message
// 2. Symmetric Ratchet (KDF) - À chaque message
// 3. SPQR (ML-KEM) - Périodiquement pour résistance post-quantique
//
// SPQR BRAID PATTERN:
// - Les clés ML-KEM sont échangées de manière "sparse" (non systématique)
// - Utilise un "braid" de fragments de clés via erasure coding
// - Permet de distribuer les grandes clés ML-KEM sur plusieurs messages
// - Forward Secrecy maintenue même si certains messages perdus
//
// RÉFÉRENCE: Signal PQXDH + Triple Ratchet (Eurocrypt 2025)

import {
  SymmetricKey,
  ChainKey,
  RootKey,
  MessageKey,
  HeaderKey,
  X25519KeyPair,
  X25519PublicKey,
  CRYPTO_CONSTANTS,
} from './types';

import {
  generateX25519KeyPair,
  x25519,
  protocolHkdf,
  zeroize,
  zeroizeAll,
  createSymmetricKey,
  createChainKey,
  createRootKey,
  createHeaderKey,
  secureClone,
  getSecureRandomBytes,
  bytesToHex,
} from './primitives';

import {
  KyberKeyPair,
  KyberPublicKey,
  KyberSecretKey,
  KyberCiphertext,
  KyberSharedSecret,
  KyberChunk,
  kyberKeyGen,
  kyberEncapsulate,
  kyberDecapsulate,
  chunkPublicKey,
  chunkCiphertext,
  reconstructFromChunks,
  serializeKyberPublicKey,
  deserializeKyberPublicKey,
  serializeKyberCiphertext,
  deserializeKyberCiphertext,
  serializeKyberChunk,
  deserializeKyberChunk,
  zeroizeKyberSecretKey,
  zeroizeKyberSharedSecret,
  KYBER_CONSTANTS,
} from './pqPrimitives';

// ML-KEM Braid imports
import {
  BraidState,
  BraidPayload,
  BraidConfig,
  SerializedBraidState,
  createInitialBraidState,
  initiateBraid,
  processReceivedBraidPayload,
  generateBraidPayload,
  shouldInitiateBraid,
  canFinalizeBraid,
  finalizeBraid,
  cleanupBraidState,
  serializeBraidState,
  deserializeBraidState,
  mixBraidSecrets,
  isBraidExchangeExpired,
  resetExpiredBraidExchange,
  DEFAULT_BRAID_CONFIG,
  BRAID_CONSTANTS,
} from './mlkemBraid';

// ============================================
// CONSTANTES SPQR
// ============================================

const SPQR_CONSTANTS = {
  // Intervalle de rotation SPQR (nombre de messages)
  // ACTION 17 (Audit Fix): Réduit de 50 à 20 (recommandation Signal).
  // 50 messages = fenêtre post-quantum 2.5× trop large.
  // 20 messages ≈ +1KB trafic ML-KEM par rotation supplémentaire — négligeable.
  RATCHET_INTERVAL: 20,
  
  // Nombre de messages avant rotation forcée
  MAX_MESSAGES_WITHOUT_PQ: 100,
  
  // Taille des epochs SPQR
  EPOCH_SIZE: 100,
  
  // Chunking configuration
  MAX_CHUNKS_PER_MESSAGE: 4, // Fragments ML-KEM par message
  MIN_CHUNKS_FOR_RECONSTRUCTION: 15, // Minimum pour reconstruire
  
  // Buffer de clés PQ en attente
  MAX_PENDING_PQ_KEYS: 5,
  
  // Timeout pour les chunks incomplets (ms)
  CHUNK_TIMEOUT_MS: 60000, // 1 minute (foreground)
  
  // CORRECTION MINEUR (Audit Février 2026 — Phase 0 §3):
  // Timeout réduit pour iOS NSE (budget 30s). Si timeout en NSE :
  // déchiffrer avec la dernière clé PQ connue, marquer pour re-traitement foreground.
  NSE_CHUNK_TIMEOUT_MS: 15000, // 15 secondes
  NSE_MAX_RETRY_ATTEMPTS: 2,
  
  // SÉCURITÉ: Limite maximale de secrets PQ historiques
  // Empêche les fuites mémoire et limite l'exposition des anciens secrets
  // 20 epochs = environ 2000 messages avec EPOCH_SIZE=100
  MAX_PQ_SECRET_HISTORY: 20,
} as const;

// Domain separation pour SPQR
const SPQR_KDF_DOMAINS = {
  ROOT_UPDATE: 'spqr_root_update_v1',
  CHAIN_KEY: 'spqr_chain_key_v1',
  MESSAGE_KEY: 'spqr_message_key_v1',
  PQ_MIX: 'spqr_pq_mix_v1',
  BRAID: 'spqr_braid_v1',
  HEADER_KEY: 'spqr_header_key_v1',
  ROOT_UPDATE_HE: 'spqr_root_update_he_v1',
} as const;

// ============================================
// FONCTIONS UTILITAIRES INTERNES
// ============================================

/**
 * Ajoute un secret PQ à l'historique avec nettoyage automatique des anciens secrets.
 * 
 * SÉCURITÉ:
 * - Limite l'historique à MAX_PQ_SECRET_HISTORY entrées
 * - Zeroize les secrets supprimés avant de les retirer du Map
 * - Empêche les fuites mémoire
 * - Limite l'exposition temporelle des anciens secrets
 * 
 * @param history - Map des secrets PQ par epoch
 * @param epoch - Epoch du nouveau secret
 * @param secret - Secret PQ à ajouter (sera cloné)
 */
function addToPQSecretHistory(
  history: Map<number, Uint8Array>,
  epoch: number,
  secret: Uint8Array
): void {
  // Ajouter le nouveau secret (cloné pour éviter les références partagées)
  history.set(epoch, secureClone(secret));
  
  // Nettoyer si on dépasse la limite
  if (history.size > SPQR_CONSTANTS.MAX_PQ_SECRET_HISTORY) {
    // Trouver les epochs les plus anciens à supprimer
    const epochs = Array.from(history.keys()).sort((a, b) => a - b);
    const toRemove = epochs.slice(0, history.size - SPQR_CONSTANTS.MAX_PQ_SECRET_HISTORY);
    
    for (const oldEpoch of toRemove) {
      const oldSecret = history.get(oldEpoch);
      if (oldSecret) {
        // SÉCURITÉ: Zeroize avant de supprimer
        zeroize(oldSecret);
      }
      history.delete(oldEpoch);
    }
    
  }
}

// ============================================
// TYPES SPQR
// ============================================

/**
 * État du SPQR (Sparse Post-Quantum Ratchet)
 * Version 2.0 - Utilise ML-KEM Braid au lieu de Reed-Solomon
 */
export interface SPQRState {
  // Epoch courante
  epoch: number;
  
  // Compteur de messages dans l'epoch
  messageCount: number;
  
  // Ma paire de clés ML-KEM courante (legacy, utilisé pour PQXDH initial)
  myKyberKeyPair: KyberKeyPair | null;
  
  // Clé publique ML-KEM du correspondant (legacy)
  theirKyberPublicKey: KyberPublicKey | null;
  
  // Secret PQ accumulé (mixé avec DH à chaque rotation)
  pqSecret: Uint8Array | null;
  
  // Indicateur si une rotation PQ est en attente (legacy)
  pendingPQRotation: boolean;
  
  // Chunks reçus en attente de reconstruction (legacy)
  pendingChunks: {
    epoch: number;
    chunks: KyberChunk[];
    timestamp: number;
  }[];
  
  // Chunks à envoyer (legacy)
  outgoingChunks: KyberChunk[];
  
  // Historique des secrets PQ (pour déchiffrement des anciens messages)
  pqSecretHistory: Map<number, Uint8Array>;
  
  // === ML-KEM BRAID ===
  // État du protocole Braid pour échange parallèle de clés
  braid: BraidState;
}

/**
 * Configuration SPQR
 */
export interface SPQRConfig {
  ratchetInterval: number;
  maxMessagesWithoutPQ: number;
  enableBraid: boolean;
  chunksPerMessage: number;
  
  // Configuration Braid
  braid: BraidConfig;
  
  /**
   * Contexte d'exécution — CORRECTION MINEUR (Audit Février 2026 — Phase 0 §3)
   * 
   * 'foreground' : App au premier plan, timeouts standards (60s chunks, 120s braid).
   * 'nse'        : iOS Notification Service Extension, budget 30s total.
   *                Timeouts réduits à 15s, max 2 tentatives de reconstruction.
   *                Si timeout : utiliser dernière clé PQ connue (pqSecretHistory),
   *                et marquer l'échange pour re-traitement au retour foreground.
   */
  context?: 'foreground' | 'nse';
}

/**
 * Payload Braid sérialisé pour inclusion dans les messages
 */
export interface SerializedBraidPayload {
  epoch: number;
  ekHeader?: string;  // Base64
  ekChunks: { index: number; data: string }[];  // Base64
  ctChunks: { index: number; data: string }[];  // Base64
  sendingComplete: boolean;
}

/**
 * Métadonnées SPQR attachées aux messages
 * Version 2.0 - Supporte ML-KEM Braid
 */
export interface SPQRMessageMeta {
  // Epoch du message
  epoch: number;
  
  // Indique si ce message contient une rotation PQ
  hasPQRotation: boolean;
  
  // Clé publique ML-KEM (legacy, si rotation)
  kyberPublicKey?: string; // Sérialisée
  
  // Ciphertext ML-KEM (legacy, si réponse à rotation)
  kyberCiphertext?: string; // Sérialisé
  
  // Chunks ML-KEM (legacy, si braid RS activé)
  kyberChunks?: string[]; // Sérialisés
  
  // === ML-KEM BRAID PAYLOAD ===
  braidPayload?: SerializedBraidPayload;
}

/**
 * État combiné Double Ratchet + SPQR
 */
export interface HybridRatchetState {
  // État Double Ratchet classique
  rootKey: RootKey;
  sendingChainKey: ChainKey | null;
  receivingChainKey: ChainKey | null;
  sendingRatchetKey: X25519KeyPair;
  receivingRatchetKey: X25519PublicKey | null;
  previousSendingChainLength: number;
  messageNumberSend: number;
  messageNumberReceive: number;
  
  // État SPQR
  spqr: SPQRState;
  
  // Clés sautées (pour messages hors-ordre)
  skippedKeys: Map<string, MessageKey>;
}

// ============================================
// INITIALISATION SPQR
// ============================================

/**
 * Crée un état SPQR initial
 */
export function createInitialSPQRState(): SPQRState {
  return {
    epoch: 0,
    messageCount: 0,
    myKyberKeyPair: null,
    theirKyberPublicKey: null,
    pqSecret: null,
    pendingPQRotation: false,
    pendingChunks: [],
    outgoingChunks: [],
    pqSecretHistory: new Map(),
    // ML-KEM Braid
    braid: createInitialBraidState(),
  };
}

/**
 * Initialise SPQR avec une paire de clés ML-KEM
 * 
 * IMPORTANT: Si un initialPQSecret est fourni (depuis PQXDH), on ne déclenche
 * PAS de rotation PQ immédiate car on a déjà une protection post-quantique.
 * La rotation SPQR ne commencera qu'après l'intervalle configuré.
 */
export function initializeSPQR(
  initialPQSecret?: Uint8Array
): SPQRState {
  // Générer la première paire de clés ML-KEM
  const kyberKeyPair = kyberKeyGen();
  
  const state: SPQRState = {
    epoch: 0,
    messageCount: 0,
    myKyberKeyPair: kyberKeyPair,
    theirKyberPublicKey: null,
    pqSecret: initialPQSecret ? secureClone(initialPQSecret) : null,
    // CORRECTION CRITIQUE: Si on a déjà un pqSecret de PQXDH, pas besoin de rotation immédiate
    // La rotation commencera après ratchetInterval messages
    pendingPQRotation: !initialPQSecret, // false si on a un secret initial, true sinon
    pendingChunks: [],
    outgoingChunks: [],
    pqSecretHistory: new Map(),
    // ML-KEM Braid: Initialisé mais pas encore actif
    braid: createInitialBraidState(),
  };
  
  // Si on a un secret initial, le sauvegarder dans l'historique
  if (initialPQSecret) {
    addToPQSecretHistory(state.pqSecretHistory, 0, initialPQSecret);
  } else {
  }
  
  return state;
}

// ============================================
// ROTATION SPQR
// ============================================

/**
 * Vérifie si une rotation SPQR est nécessaire
 */
export function shouldRotateSPQR(state: SPQRState, config: SPQRConfig): boolean {
  // Rotation si on dépasse l'intervalle configuré
  if (state.messageCount >= config.ratchetInterval) {
    return true;
  }
  
  // Rotation forcée si trop de messages sans PQ
  if (state.messageCount >= config.maxMessagesWithoutPQ && !state.pqSecret) {
    return true;
  }
  
  // Rotation si on a reçu une nouvelle clé PQ du correspondant
  if (state.theirKyberPublicKey && state.pendingPQRotation) {
    return true;
  }
  
  return false;
}

/**
 * Effectue une rotation SPQR (génère nouvelles clés ML-KEM)
 */
export function rotateSPQR(state: SPQRState): {
  newState: SPQRState;
  publicKeyToSend: KyberPublicKey;
} {
  // Sauvegarder l'ancien secret si existant
  if (state.pqSecret) {
    addToPQSecretHistory(state.pqSecretHistory, state.epoch, state.pqSecret);
  }
  
  // Effacer l'ancienne paire de clés
  if (state.myKyberKeyPair) {
    zeroizeKyberSecretKey(state.myKyberKeyPair.secretKey);
  }
  
  // Générer une nouvelle paire
  const newKeyPair = kyberKeyGen();
  
  const newState: SPQRState = {
    ...state,
    epoch: state.epoch + 1,
    messageCount: 0,
    myKyberKeyPair: newKeyPair,
    pendingPQRotation: true,
  };
  
  return {
    newState,
    publicKeyToSend: newKeyPair.publicKey,
  };
}

/**
 * Traite la réception d'une nouvelle clé publique ML-KEM
 */
export function receivePQPublicKey(
  state: SPQRState,
  theirPublicKey: KyberPublicKey
): SPQRState {
  return {
    ...state,
    theirKyberPublicKey: theirPublicKey,
    pendingPQRotation: true, // On doit répondre avec un ciphertext
  };
}

/**
 * Effectue l'encapsulation ML-KEM et met à jour le secret PQ
 */
export async function encapsulatePQ(
  state: SPQRState
): Promise<{
  newState: SPQRState;
  ciphertext: KyberCiphertext;
  newPQSecret: Uint8Array;
}> {
  if (!state.theirKyberPublicKey) {
    throw new Error('SPQR: No peer PQ public key available');
  }
  
  // Encapsuler
  const { ciphertext, sharedSecret } = kyberEncapsulate(state.theirKyberPublicKey);
  
  // Mixer avec le secret PQ existant si présent
  const newPQSecret = state.pqSecret
    ? await mixPQSecrets(state.pqSecret, sharedSecret.bytes)
    : secureClone(sharedSecret.bytes);
  
  // Cleanup
  zeroizeKyberSharedSecret(sharedSecret);
  
  const newState: SPQRState = {
    ...state,
    pqSecret: newPQSecret,
    pendingPQRotation: false,
    messageCount: 0,
  };
  
  // Sauvegarder dans l'historique (avec nettoyage automatique des anciens)
  addToPQSecretHistory(newState.pqSecretHistory, state.epoch, newPQSecret);
  
  return {
    newState,
    ciphertext,
    newPQSecret,
  };
}

/**
 * Traite la réception d'un ciphertext ML-KEM
 */
export async function decapsulatePQ(
  state: SPQRState,
  ciphertext: KyberCiphertext
): Promise<{
  newState: SPQRState;
  newPQSecret: Uint8Array;
}> {
  if (!state.myKyberKeyPair) {
    throw new Error('SPQR: No local PQ key pair available');
  }
  
  // Décapsuler
  const sharedSecret = kyberDecapsulate(ciphertext, state.myKyberKeyPair.secretKey);
  
  // Mixer avec le secret PQ existant
  const newPQSecret = state.pqSecret
    ? await mixPQSecrets(state.pqSecret, sharedSecret.bytes)
    : secureClone(sharedSecret.bytes);
  
  // Cleanup
  zeroizeKyberSharedSecret(sharedSecret);
  
  const newState: SPQRState = {
    ...state,
    pqSecret: newPQSecret,
    pendingPQRotation: false,
  };
  
  // Sauvegarder dans l'historique (avec nettoyage automatique des anciens)
  addToPQSecretHistory(newState.pqSecretHistory, state.epoch, newPQSecret);
  
  return {
    newState,
    newPQSecret,
  };
}

/**
 * Mixe deux secrets PQ via KDF
 */
async function mixPQSecrets(
  existingSecret: Uint8Array,
  newSecret: Uint8Array
): Promise<Uint8Array> {
  const combined = new Uint8Array(existingSecret.length + newSecret.length);
  combined.set(existingSecret);
  combined.set(newSecret, existingSecret.length);
  
  const mixed = await protocolHkdf(
    combined,
    new Uint8Array(32),
    SPQR_KDF_DOMAINS.PQ_MIX,
    32
  );
  
  zeroize(combined);
  
  return mixed;
}

// ============================================
// BRAID PATTERN (Chunking)
// ============================================

/**
 * Prépare les chunks ML-KEM pour envoi via braid
 */
export function prepareBraidChunks(
  publicKey: KyberPublicKey,
  config: SPQRConfig
): KyberChunk[] {
  if (!config.enableBraid) {
    return [];
  }
  
  return chunkPublicKey(publicKey);
}

/**
 * Prépare les chunks de ciphertext pour envoi
 */
export function prepareCiphertextChunks(
  ciphertext: KyberCiphertext,
  config: SPQRConfig
): KyberChunk[] {
  if (!config.enableBraid) {
    return [];
  }
  
  return chunkCiphertext(ciphertext);
}

/**
 * Récupère les chunks à envoyer avec le prochain message
 */
export function getChunksForMessage(
  state: SPQRState,
  maxChunks: number
): {
  chunks: KyberChunk[];
  remainingState: SPQRState;
} {
  const chunksToSend = state.outgoingChunks.slice(0, maxChunks);
  const remainingChunks = state.outgoingChunks.slice(maxChunks);
  
  return {
    chunks: chunksToSend,
    remainingState: {
      ...state,
      outgoingChunks: remainingChunks,
    },
  };
}

/**
 * Traite les chunks reçus et tente la reconstruction
 * 
 * @param context - 'foreground' (60s timeout) ou 'nse' (15s timeout, max 2 tentatives)
 */
export function processReceivedChunks(
  state: SPQRState,
  chunks: KyberChunk[],
  epoch: number,
  context: 'foreground' | 'nse' = 'foreground'
): {
  newState: SPQRState;
  reconstructedKey?: KyberPublicKey;
  reconstructedCiphertext?: KyberCiphertext;
} {
  // CORRECTION MINEUR (Audit Février 2026 — Phase 0 §3):
  // Timeout adapté au contexte d'exécution
  const chunkTimeoutMs = context === 'nse'
    ? SPQR_CONSTANTS.NSE_CHUNK_TIMEOUT_MS
    : SPQR_CONSTANTS.CHUNK_TIMEOUT_MS;
  
  // Trouver ou créer l'entrée pour cette epoch
  let pending = state.pendingChunks.find(p => p.epoch === epoch);
  
  if (!pending) {
    pending = {
      epoch,
      chunks: [],
      timestamp: Date.now(),
    };
    state.pendingChunks.push(pending);
  }
  
  // Ajouter les nouveaux chunks
  pending.chunks.push(...chunks);
  pending.timestamp = Date.now();
  
  // Nettoyer les chunks expirés (timeout adapté au contexte)
  const now = Date.now();
  const validPending = state.pendingChunks.filter(
    p => now - p.timestamp < chunkTimeoutMs
  );
  
  // Tenter la reconstruction
  let reconstructedKey: KyberPublicKey | undefined;
  let reconstructedCiphertext: KyberCiphertext | undefined;
  
  const ekChunks = pending.chunks.filter(c => c.type === 'ek');
  const ctChunks = pending.chunks.filter(c => c.type === 'ct');
  
  if (ekChunks.length >= SPQR_CONSTANTS.MIN_CHUNKS_FOR_RECONSTRUCTION) {
    const reconstructed = reconstructFromChunks(ekChunks, 'ek');
    if (reconstructed) {
      // P11 fix: Validate reconstructed key size matches ML-KEM-768 spec
      if (reconstructed.length !== KYBER_CONSTANTS.PUBLIC_KEY_SIZE) {
        console.warn(`[SPQR] Reconstructed EK has invalid size: ${reconstructed.length}, expected ${KYBER_CONSTANTS.PUBLIC_KEY_SIZE}. Discarding.`);
      } else {
        reconstructedKey = {
          _brand: 'KyberPublicKey',
          bytes: reconstructed,
        };
      }
    }
  }
  
  if (ctChunks.length >= SPQR_CONSTANTS.MIN_CHUNKS_FOR_RECONSTRUCTION) {
    const reconstructed = reconstructFromChunks(ctChunks, 'ct');
    if (reconstructed) {
      // P11 fix: Validate reconstructed ciphertext size matches ML-KEM-768 spec
      if (reconstructed.length !== KYBER_CONSTANTS.CIPHERTEXT_SIZE) {
        console.warn(`[SPQR] Reconstructed CT has invalid size: ${reconstructed.length}, expected ${KYBER_CONSTANTS.CIPHERTEXT_SIZE}. Discarding.`);
      } else {
        reconstructedCiphertext = {
          _brand: 'KyberCiphertext',
          bytes: reconstructed,
        };
      }
    }
  }
  
  return {
    newState: {
      ...state,
      pendingChunks: validPending,
    },
    reconstructedKey,
    reconstructedCiphertext,
  };
}

// ============================================
// INTÉGRATION AVEC DOUBLE RATCHET
// ============================================

/**
 * Combine le secret DH avec le secret PQ pour dériver la nouvelle root key
 */
export async function deriveHybridRootKey(
  dhSecret: Uint8Array,
  pqSecret: Uint8Array | null,
  previousRootKey: RootKey
): Promise<{
  newRootKey: RootKey;
  newChainKey: ChainKey;
}> {
  // Combiner DH et PQ secrets
  let combinedSecret: Uint8Array;
  
  if (pqSecret) {
    combinedSecret = new Uint8Array(dhSecret.length + pqSecret.length);
    combinedSecret.set(dhSecret);
    combinedSecret.set(pqSecret, dhSecret.length);
  } else {
    combinedSecret = dhSecret;
  }
  
  // Dériver via HKDF
  const derivedKeys = await protocolHkdf(
    combinedSecret,
    previousRootKey.bytes,
    SPQR_KDF_DOMAINS.ROOT_UPDATE,
    64 // 32 bytes root key + 32 bytes chain key
  );
  
  // Cleanup
  if (pqSecret) {
    zeroize(combinedSecret);
  }
  
  return {
    newRootKey: createRootKey(derivedKeys.slice(0, 32)),
    newChainKey: createChainKey(derivedKeys.slice(32, 64)),
  };
}

/**
 * Dérive les clés racine, chaîne ET header pour le Header Encryption
 * 
 * Cette fonction étend deriveHybridRootKey pour supporter le chiffrement d'en-têtes
 * conformément à la spécification Signal avec header encryption.
 * 
 * La dérivation produit 96 bytes:
 * - 32 bytes: nouvelle Root Key
 * - 32 bytes: nouvelle Chain Key  
 * - 32 bytes: nouvelle Header Key
 * 
 * @param dhSecret - Secret DH issu de X25519
 * @param pqSecret - Secret post-quantique (optionnel, de SPQR)
 * @param previousRootKey - Root key précédente pour la dérivation
 */
export async function deriveHybridRootKeyWithHE(
  dhSecret: Uint8Array,
  pqSecret: Uint8Array | null,
  previousRootKey: RootKey
): Promise<{
  newRootKey: RootKey;
  newChainKey: ChainKey;
  newHeaderKey: HeaderKey;
}> {
  // Combiner DH et PQ secrets
  let combinedSecret: Uint8Array;
  
  if (pqSecret) {
    combinedSecret = new Uint8Array(dhSecret.length + pqSecret.length);
    combinedSecret.set(dhSecret);
    combinedSecret.set(pqSecret, dhSecret.length);
  } else {
    combinedSecret = dhSecret;
  }
  
  // Dériver via HKDF - 96 bytes pour inclure la header key
  const derivedKeys = await protocolHkdf(
    combinedSecret,
    previousRootKey.bytes,
    SPQR_KDF_DOMAINS.ROOT_UPDATE_HE,
    96 // 32 bytes root key + 32 bytes chain key + 32 bytes header key
  );
  
  // Cleanup
  if (pqSecret) {
    zeroize(combinedSecret);
  }
  
  return {
    newRootKey: createRootKey(derivedKeys.slice(0, 32)),
    newChainKey: createChainKey(derivedKeys.slice(32, 64)),
    newHeaderKey: createHeaderKey(derivedKeys.slice(64, 96)),
  };
}

/**
 * Met à jour l'état hybride lors d'une rotation DH
 */
export async function performHybridDHRatchet(
  state: HybridRatchetState,
  theirNewPublicKey: X25519PublicKey
): Promise<HybridRatchetState> {
  // 1. Calculer le nouveau secret DH
  const dhSecret = x25519(
    state.sendingRatchetKey.privateKey,
    theirNewPublicKey
  );
  
  // 2. Vérifier si on doit inclure le secret PQ
  const pqSecret = state.spqr.pqSecret;
  
  // 3. Dériver les nouvelles clés
  const { newRootKey, newChainKey } = await deriveHybridRootKey(
    dhSecret,
    pqSecret,
    state.rootKey
  );
  
  // 4. Générer nouvelle paire DH
  const newRatchetKey = generateX25519KeyPair();
  
  // 5. Recalculer pour la chaîne d'envoi
  const dhSecret2 = x25519(newRatchetKey.privateKey, theirNewPublicKey);
  const { newRootKey: rootKey2, newChainKey: sendingChainKey } = await deriveHybridRootKey(
    dhSecret2,
    pqSecret,
    newRootKey
  );
  
  // 6. Cleanup
  zeroize(dhSecret);
  zeroize(dhSecret2);
  
  // 7. Mettre à jour l'état SPQR
  const newSPQRState: SPQRState = {
    ...state.spqr,
    messageCount: state.spqr.messageCount + 1,
  };
  
  return {
    ...state,
    rootKey: rootKey2,
    sendingChainKey,
    receivingChainKey: newChainKey,
    sendingRatchetKey: newRatchetKey,
    receivingRatchetKey: theirNewPublicKey,
    previousSendingChainLength: state.messageNumberSend,
    messageNumberSend: 0,
    messageNumberReceive: 0,
    spqr: newSPQRState,
  };
}

// ============================================
// CRÉATION DES MÉTADONNÉES SPQR
// ============================================

/**
 * Crée les métadonnées SPQR à joindre à un message
 * Version 2.0 - Utilise ML-KEM Braid pour l'échange de clés
 */
export function createSPQRMessageMeta(
  state: SPQRState,
  config: SPQRConfig
): {
  meta: SPQRMessageMeta;
  newState: SPQRState;
} {
  let newState = { ...state };
  const meta: SPQRMessageMeta = {
    epoch: state.braid.epoch,
    hasPQRotation: false,
  };
  
  // === ML-KEM BRAID ===
  // Vérification défensive: s'assurer que config.braid existe (rétrocompatibilité)
  const braidConfig = config.braid || DEFAULT_BRAID_CONFIG;
  
  if (braidConfig.enabled) {
    // Vérifier si un échange en cours a expiré
    if (isBraidExchangeExpired(state.braid, braidConfig)) {
      console.warn('[SPQR] Braid exchange expired, resetting');
      newState.braid = resetExpiredBraidExchange(state.braid);
    }
    
    // Vérifier si on doit initier un nouvel échange Braid
    if (shouldInitiateBraid(newState.braid, braidConfig)) {
      __DEV__ && console.log('[SPQR] Initiating new Braid exchange');
      newState.braid = initiateBraid(newState.braid);
    }
    
    // Obtenir le payload Braid pour ce message
    const { payload, newState: braidNewState } = generateBraidPayload(
      newState.braid,
      braidConfig
    );
    newState.braid = braidNewState;
    
    // Ajouter le payload au message si non-vide
    if (payload && (payload.ekHeader || payload.ekChunks.length > 0 || payload.ctChunks.length > 0)) {
      meta.braidPayload = serializeBraidPayloadToMeta(payload);
      meta.hasPQRotation = true;
      meta.epoch = payload.epoch;
    }
    
    // Mettre à jour pqSecret si Braid terminé
    if (newState.braid.sharedSecret && newState.braid.phase === 'completed') {
      newState = updatePQSecretFromBraid(newState);
    }
    
    // Mettre à jour le compteur de messages
    newState.messageCount++;
    
    return { meta, newState };
  }
  
  // === LEGACY: Ancien système (désactivé par défaut) ===
  // Vérifier si on doit envoyer notre clé publique PQ
  if (state.pendingPQRotation && state.myKyberKeyPair) {
    meta.hasPQRotation = true;
    meta.kyberPublicKey = serializeKyberPublicKey(state.myKyberKeyPair.publicKey);
    
    // ASSERTION DÉFENSIVE (Audit Février 2026 — Phase 0 §1):
    // Si pendingPQRotation est true mais qu'on n'a pas pu sérialiser la clé,
    // la rotation PQ échouera silencieusement. On préfère crasher explicitement.
    if (!meta.kyberPublicKey) {
      throw new Error('SPQR legacy: pendingPQRotation=true mais kyberPublicKey sérialisation a échoué');
    }
  } else if (state.pendingPQRotation && !state.myKyberKeyPair) {
    // ASSERTION DÉFENSIVE: pendingPQRotation=true sans keyPair est un état incohérent
    console.error('[SPQR] ERREUR: pendingPQRotation=true mais myKyberKeyPair est null — état incohérent');
  }
  
  // Ajouter les chunks si braid RS activé (legacy)
  if (config.enableBraid && state.outgoingChunks.length > 0) {
    const { chunks, remainingState } = getChunksForMessage(
      state,
      config.chunksPerMessage
    );
    
    if (chunks.length > 0) {
      meta.kyberChunks = chunks.map(serializeKyberChunk);
    }
    
    newState = remainingState;
  }
  
  return { meta, newState };
}

/**
 * Sérialise un payload Braid pour inclusion dans SPQRMessageMeta
 */
function serializeBraidPayloadToMeta(payload: BraidPayload): SerializedBraidPayload {
  const encodeBytes = (bytes: Uint8Array): string => {
    return btoa(String.fromCharCode(...bytes));
  };
  
  return {
    epoch: payload.epoch,
    ekHeader: payload.ekHeader ? encodeBytes(payload.ekHeader) : undefined,
    ekChunks: payload.ekChunks.map(c => ({
      index: c.index,
      data: encodeBytes(c.data),
    })),
    ctChunks: payload.ctChunks.map(c => ({
      index: c.index,
      data: encodeBytes(c.data),
    })),
    sendingComplete: payload.sendingComplete,
  };
}

/**
 * Désérialise un payload Braid depuis SPQRMessageMeta
 */
function deserializeBraidPayloadFromMeta(
  serialized: SerializedBraidPayload
): BraidPayload {
  const decodeBytes = (str: string): Uint8Array => {
    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
  };
  
  return {
    epoch: serialized.epoch,
    ekHeader: serialized.ekHeader ? decodeBytes(serialized.ekHeader) : undefined,
    ekChunks: serialized.ekChunks.map(c => ({
      index: c.index,
      type: 'ek' as const,
      data: decodeBytes(c.data),
      epoch: serialized.epoch,
    })),
    ctChunks: serialized.ctChunks.map(c => ({
      index: c.index,
      type: 'ct' as const,
      data: decodeBytes(c.data),
      epoch: serialized.epoch,
    })),
    sendingComplete: serialized.sendingComplete,
  };
}

/**
 * Met à jour le pqSecret depuis le résultat Braid
 */
function updatePQSecretFromBraid(state: SPQRState): SPQRState {
  if (!state.braid.sharedSecret) {
    return state;
  }
  
  // Mixer le nouveau secret Braid avec l'existant
  const newPQSecret = mixBraidSecrets(state.pqSecret, state.braid.sharedSecret);
  
  // Sauvegarder dans l'historique
  const newHistory = new Map(state.pqSecretHistory);
  addToPQSecretHistory(newHistory, state.braid.epoch, newPQSecret);
  
  __DEV__ && console.log(`[SPQR-Braid] ✅ PQ Secret updated from Braid epoch ${state.braid.epoch}`);
  
  return {
    ...state,
    pqSecret: newPQSecret,
    pqSecretHistory: newHistory,
    epoch: state.braid.epoch,
  };
}

/**
 * Applique la mise à jour du secret Braid APRÈS le déchiffrement réussi
 * 
 * IMPORTANT: Cette fonction doit être appelée APRÈS le déchiffrement du message,
 * car le message a été chiffré avec l'ancien pqSecret.
 * 
 * @returns Le nouvel état avec le pqSecret mis à jour si nécessaire
 */
export function applyPendingBraidSecret(state: SPQRState): SPQRState {
  // Vérifier si un secret Braid est en attente d'application
  if (state.braid.sharedSecret && state.braid.phase === 'completed') {
    return updatePQSecretFromBraid(state);
  }
  return state;
}

/**
 * Traite les métadonnées SPQR reçues
 * 
 * Version 2.0 - Supporte ML-KEM Braid
 * 
 * IMPORTANT: Cette fonction NE DOIT PAS changer le pqSecret immédiatement car le message
 * courant a été chiffré avec l'ANCIEN pqSecret. Les rotations PQ prennent
 * effet pour les messages SUIVANTS.
 * 
 * @returns pendingPQOperation - Opération PQ à effectuer APRÈS le déchiffrement
 */
export async function processSPQRMessageMeta(
  state: SPQRState,
  meta: SPQRMessageMeta,
  config: SPQRConfig
): Promise<{
  newState: SPQRState;
  responseMeta?: SPQRMessageMeta;
  pendingPQOperation?: {
    type: 'encapsulate' | 'decapsulate';
    publicKey?: KyberPublicKey;
    ciphertext?: KyberCiphertext;
  };
}> {
  let newState = { ...state };
  let responseMeta: SPQRMessageMeta | undefined;
  let pendingPQOperation: {
    type: 'encapsulate' | 'decapsulate';
    publicKey?: KyberPublicKey;
    ciphertext?: KyberCiphertext;
  } | undefined;
  
  // === ML-KEM BRAID ===
  // Vérification défensive: s'assurer que config.braid existe (rétrocompatibilité)
  const braidConfig = config.braid || DEFAULT_BRAID_CONFIG;
  
  if (meta.braidPayload && braidConfig.enabled) {
    // Désérialiser le payload Braid
    const braidPayload = deserializeBraidPayloadFromMeta(meta.braidPayload);
    
    // Traiter avec la machine à états Braid
    newState.braid = processReceivedBraidPayload(newState.braid, braidPayload);
    
    // IMPORTANT: NE PAS mettre à jour pqSecret ici !
    // Le message courant a été chiffré avec l'ANCIEN pqSecret.
    // La mise à jour doit se faire APRÈS le déchiffrement réussi
    // via applyBraidSecretUpdate() appelé depuis tripleRatchet.ts
    
    // Incrémenter le compteur de messages
    newState.messageCount++;
    
    // Pas de pendingPQOperation pour Braid, tout est géré automatiquement
    return { newState, responseMeta, pendingPQOperation: undefined };
  }
  
  // === LEGACY: Ancien système ===
  
  // Traiter la clé publique PQ reçue - DIFFÉRER l'encapsulation
  if (meta.hasPQRotation && meta.kyberPublicKey) {
    const theirKey = deserializeKyberPublicKey(meta.kyberPublicKey);
    
    // Stocker la clé pour encapsulation ultérieure, mais NE PAS changer pqSecret
    newState.theirKyberPublicKey = theirKey;
    
    // Marquer qu'on doit faire une encapsulation après déchiffrement
    pendingPQOperation = {
      type: 'encapsulate',
      publicKey: theirKey,
    };
  }
  
  // Traiter le ciphertext PQ reçu - DIFFÉRER la décapsulation
  if (meta.kyberCiphertext) {
    const ciphertext = deserializeKyberCiphertext(meta.kyberCiphertext);
    
    // Marquer qu'on doit faire une décapsulation après déchiffrement
    pendingPQOperation = {
      type: 'decapsulate',
      ciphertext: ciphertext,
    };
  }
  
  // Traiter les chunks reçus (reconstruction seulement, pas de changement de secret)
  if (meta.kyberChunks && meta.kyberChunks.length > 0) {
    const chunks = meta.kyberChunks.map(deserializeKyberChunk);
    const result = processReceivedChunks(newState, chunks, meta.epoch, config.context || 'foreground');
    newState = result.newState;
    
    // Si on a reconstruit une clé, la stocker pour plus tard
    if (result.reconstructedKey) {
      newState.theirKyberPublicKey = result.reconstructedKey;
      pendingPQOperation = {
        type: 'encapsulate',
        publicKey: result.reconstructedKey,
      };
    }
    
    // Si on a reconstruit un ciphertext, le stocker pour plus tard
    if (result.reconstructedCiphertext) {
      pendingPQOperation = {
        type: 'decapsulate',
        ciphertext: result.reconstructedCiphertext,
      };
    }
  }
  
  // Incrémenter le compteur de messages
  newState.messageCount++;
  
  return { newState, responseMeta, pendingPQOperation };
}

/**
 * Applique une opération PQ différée (à appeler APRÈS le déchiffrement)
 */
export async function applyPendingPQOperation(
  state: SPQRState,
  operation: {
    type: 'encapsulate' | 'decapsulate';
    publicKey?: KyberPublicKey;
    ciphertext?: KyberCiphertext;
  }
): Promise<{
  newState: SPQRState;
  responseMeta?: SPQRMessageMeta;
}> {
  let newState = { ...state };
  let responseMeta: SPQRMessageMeta | undefined;
  
  if (operation.type === 'encapsulate' && operation.publicKey) {
    newState = receivePQPublicKey(newState, operation.publicKey);
    
    const { newState: afterEncap, ciphertext } = await encapsulatePQ(newState);
    newState = afterEncap;
    
    responseMeta = {
      epoch: newState.epoch,
      hasPQRotation: false,
      kyberCiphertext: serializeKyberCiphertext(ciphertext),
    };
  } else if (operation.type === 'decapsulate' && operation.ciphertext) {
    const { newState: afterDecap } = await decapsulatePQ(newState, operation.ciphertext);
    newState = afterDecap;
  }
  
  return { newState, responseMeta };
}

// ============================================
// SÉRIALISATION DE L'ÉTAT SPQR
// ============================================

// encodeBase64/decodeBase64 re-exported from primitives.ts
import { encodeBase64, decodeBase64 } from './primitives';

export interface SerializedSPQRState {
  epoch: number;
  messageCount: number;
  myKyberKeyPair?: {
    pk: string;
    sk: string;
  };
  theirKyberPublicKey?: string;
  pqSecret?: string;
  pendingPQRotation: boolean;
  // ML-KEM Braid state
  braid?: SerializedBraidState;
}

/**
 * Sérialise l'état SPQR pour stockage
 */
export function serializeSPQRState(state: SPQRState): SerializedSPQRState {
  const result: SerializedSPQRState = {
    epoch: state.epoch,
    messageCount: state.messageCount,
    pendingPQRotation: state.pendingPQRotation,
    // ML-KEM Braid
    braid: serializeBraidState(state.braid),
  };
  
  if (state.myKyberKeyPair) {
    result.myKyberKeyPair = {
      pk: serializeKyberPublicKey(state.myKyberKeyPair.publicKey),
      sk: encodeBase64(state.myKyberKeyPair.secretKey.bytes),
    };
  }
  
  if (state.theirKyberPublicKey) {
    result.theirKyberPublicKey = serializeKyberPublicKey(state.theirKyberPublicKey);
  }
  
  if (state.pqSecret) {
    result.pqSecret = encodeBase64(state.pqSecret);
  }
  
  return result;
}

/**
 * Désérialise l'état SPQR depuis le stockage
 */
export function deserializeSPQRState(data: SerializedSPQRState): SPQRState {
  const state: SPQRState = {
    epoch: data.epoch,
    messageCount: data.messageCount,
    myKyberKeyPair: null,
    theirKyberPublicKey: null,
    pqSecret: null,
    pendingPQRotation: data.pendingPQRotation,
    pendingChunks: [],
    outgoingChunks: [],
    pqSecretHistory: new Map(),
    // ML-KEM Braid
    braid: data.braid ? deserializeBraidState(data.braid) : createInitialBraidState(),
  };
  
  if (data.myKyberKeyPair) {
    state.myKyberKeyPair = {
      publicKey: deserializeKyberPublicKey(data.myKyberKeyPair.pk),
      secretKey: {
        _brand: 'KyberSecretKey',
        bytes: decodeBase64(data.myKyberKeyPair.sk),
      },
    };
  }
  
  if (data.theirKyberPublicKey) {
    state.theirKyberPublicKey = deserializeKyberPublicKey(data.theirKyberPublicKey);
  }
  
  if (data.pqSecret) {
    state.pqSecret = decodeBase64(data.pqSecret);
  }
  
  return state;
}

// ============================================
// CLEANUP
// ============================================

/**
 * Efface tous les secrets SPQR de la mémoire
 */
export function cleanupSPQRState(state: SPQRState): void {
  if (state.myKyberKeyPair) {
    zeroizeKyberSecretKey(state.myKyberKeyPair.secretKey);
  }
  
  if (state.pqSecret) {
    zeroize(state.pqSecret);
  }
  
  // Cleanup ML-KEM Braid
  cleanupBraidState(state.braid);
  
  // Effacer l'historique
  for (const secret of state.pqSecretHistory.values()) {
    zeroize(secret);
  }
  state.pqSecretHistory.clear();
}

// ============================================
// CONFIGURATION PAR DÉFAUT
// ============================================

export const DEFAULT_SPQR_CONFIG: SPQRConfig = {
  ratchetInterval: SPQR_CONSTANTS.RATCHET_INTERVAL,
  maxMessagesWithoutPQ: SPQR_CONSTANTS.MAX_MESSAGES_WITHOUT_PQ,
  enableBraid: true,
  chunksPerMessage: SPQR_CONSTANTS.MAX_CHUNKS_PER_MESSAGE,
  context: 'foreground',
  // ML-KEM Braid configuration
  braid: DEFAULT_BRAID_CONFIG,
};

/**
 * Crée une configuration SPQR adaptée au contexte NSE iOS.
 * 
 * CORRECTION MINEUR (Audit Février 2026 — Phase 0 §3):
 * Le NSE iOS dispose de 30s maximum. Cette configuration réduit tous les
 * timeouts pour respecter ce budget :
 * - Braid exchange timeout : 15s (vs 120s foreground)
 * - Chunk timeout : 15s (vs 60s foreground)
 * - Max 2 tentatives de reconstruction (vs illimité foreground)
 * 
 * Si un échange Braid ne peut pas se terminer dans le budget NSE,
 * le message est déchiffré avec la dernière clé PQ connue (pqSecretHistory)
 * et l'échange est marqué pour re-traitement au retour en foreground.
 * 
 * USAGE dans le NSE iOS :
 * ```typescript
 * const nseConfig = createNSESPQRConfig(existingConfig);
 * const { plaintext, newState } = await tripleRatchetDecrypt(state, message, nseConfig);
 * ```
 */
export function createNSESPQRConfig(baseConfig?: SPQRConfig): SPQRConfig {
  const base = baseConfig || DEFAULT_SPQR_CONFIG;
  return {
    ...base,
    context: 'nse',
    braid: {
      ...base.braid,
      context: 'nse',
      exchangeTimeoutMs: Math.min(
        base.braid.exchangeTimeoutMs,
        BRAID_CONSTANTS.NSE_EXCHANGE_TIMEOUT_MS
      ),
    },
  };
}

// ============================================
// EXPORTS
// ============================================

export {
  SPQR_CONSTANTS,
  SPQR_KDF_DOMAINS,
};