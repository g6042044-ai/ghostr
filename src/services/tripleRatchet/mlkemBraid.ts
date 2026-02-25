// src/services/tripleRatchet/mlkemBraid.ts
// ML-KEM Braid Protocol - Implémentation Signal SPQR
// Version 1.0 - Conforme Signal Triple Ratchet (Eurocrypt 2025)
//
// ML-KEM BRAID:
// =============
// Le Braid permet l'échange parallèle de clés ML-KEM:
// - Alice envoie un "header" de EK (32 bytes) contenant le seed
// - Bob peut commencer à générer son EK et répondre IMMÉDIATEMENT
// - Alice et Bob envoient leurs chunks EN PARALLÈLE (interleaved)
// - PCS atteinte en ~12-15 messages au lieu de ~56 avec RS séquentiel
//
// AVANTAGES vs Reed-Solomon séquentiel:
// - 4x plus rapide pour atteindre PCS
// - Échange symétrique (les deux parties ont PCS équivalente)
// - Tolérance aux pertes de messages (opportunistic sending)
// - Conforme à l'implémentation Signal (Eurocrypt 2025)
//
// RÉFÉRENCE: Signal SPQR + ML-KEM Braid Protocol

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { zeroize, secureClone, hmacSha256 } from './primitives';

// ============================================
// CONSTANTES BRAID
// ============================================

export const BRAID_CONSTANTS = {
  // Taille des chunks (Signal utilise 42 bytes pour optimisation)
  CHUNK_SIZE: 42,
  
  // Header EK - seed pour la matrice publique A
  // Les 32 premiers bytes de ML-KEM EK contiennent le seed ρ
  EK_HEADER_SIZE: 32,
  
  // Tailles ML-KEM-768
  EK_TOTAL_SIZE: 1184,  // Encapsulation Key
  CT_TOTAL_SIZE: 1088,  // Ciphertext
  SS_SIZE: 32,          // Shared Secret
  
  // Nombre de chunks pour EK (après header)
  // = ceil((1184 - 32) / 42) = ceil(1152 / 42) = 28 chunks
  EK_BODY_CHUNKS: 28,
  
  // Nombre de chunks pour CT
  // = ceil(1088 / 42) = 26 chunks
  CT_TOTAL_CHUNKS: 26,
  
  // Chunks maximum par message (opportunistic sending)
  MAX_CHUNKS_PER_MESSAGE: 4,
  
  // Timeout pour un échange incomplet (ms)
  EXCHANGE_TIMEOUT_MS: 120000, // 2 minutes (foreground)
  
  // CORRECTION MINEUR (Audit Février 2026 — Phase 0 §3):
  // Timeouts réduits pour iOS NSE (budget 30s total)
  NSE_EXCHANGE_TIMEOUT_MS: 15000, // 15 secondes
  NSE_MAX_RECONSTRUCTION_ATTEMPTS: 2,
  
  // Intervalle de rotation (messages entre deux échanges Braid)
  DEFAULT_ROTATION_INTERVAL: 50,
} as const;

// Domain separation pour KDF
const BRAID_KDF_DOMAINS = {
  MIX_SECRETS: 'ghostr_braid_mix_v1',
  DERIVE_FINAL: 'ghostr_braid_final_v1',
} as const;

// ============================================
// TYPES BRAID
// ============================================

/**
 * Phase du protocole Braid
 */
export type BraidPhase = 
  | 'idle'                  // Pas d'échange en cours
  | 'initiating'            // On initie, envoi de notre EK
  | 'responding'            // On répond à un EK reçu
  | 'exchanging'            // Échange parallèle de chunks
  | 'completing'            // Tous chunks reçus, finalisation en cours
  | 'completed';            // Secret PQ dérivé avec succès

/**
 * Rôle dans l'échange Braid courant
 */
export type BraidRole = 'initiator' | 'responder';

/**
 * Chunk Braid pour transmission
 */
export interface BraidChunk {
  /** Index du chunk (0-based) */
  index: number;
  
  /** Type: encapsulation key ou ciphertext */
  type: 'ek' | 'ct';
  
  /** Données du chunk (42 bytes max) */
  data: Uint8Array;
  
  /** Epoch de l'échange */
  epoch: number;
}

/**
 * Payload Braid attaché à un message Triple Ratchet
 */
export interface BraidPayload {
  /** Epoch de l'échange */
  epoch: number;
  
  /** Header EK (32 bytes) - envoyé uniquement au début */
  ekHeader?: Uint8Array;
  
  /** Chunks EK (body, après header) */
  ekChunks: BraidChunk[];
  
  /** Chunks CT */
  ctChunks: BraidChunk[];
  
  /** Flag indiquant qu'on a fini d'envoyer */
  sendingComplete: boolean;
}

/**
 * État complet du protocole Braid
 */
export interface BraidState {
  // === État général ===
  
  /** Phase actuelle du protocole */
  phase: BraidPhase;
  
  /** Rôle dans l'échange courant */
  role: BraidRole | null;
  
  /** Epoch courante (incrémentée à chaque échange réussi) */
  epoch: number;
  
  /** Compteur de messages depuis le dernier échange */
  messagesSinceLastExchange: number;
  
  // === État LOCAL (ce qu'on envoie) ===
  
  /** Notre paire de clés ML-KEM pour cet échange */
  localKeyPair: {
    publicKey: Uint8Array;  // 1184 bytes
    secretKey: Uint8Array;  // 2400 bytes
  } | null;
  
  /** Header de notre EK (32 bytes) */
  localEKHeader: Uint8Array | null;
  
  /** Body de notre EK découpé en chunks */
  localEKBodyChunks: BraidChunk[];
  
  /** Nombre de chunks EK body envoyés */
  localEKChunksSent: number;
  
  /** Flag: header EK envoyé */
  localEKHeaderSent: boolean;
  
  /** Notre CT généré (après réception de leur EK complet) */
  localCT: Uint8Array | null;
  
  /** Notre CT découpé en chunks */
  localCTChunks: BraidChunk[];
  
  /** Nombre de chunks CT envoyés */
  localCTChunksSent: number;
  
  // === État DISTANT (ce qu'on reçoit) ===
  
  /** Header EK distant reçu */
  remoteEKHeader: Uint8Array | null;
  
  /** Chunks EK body distants reçus (index -> data) */
  remoteEKBodyChunks: Map<number, Uint8Array>;
  
  /** EK distant reconstruit complet */
  remoteEKComplete: Uint8Array | null;
  
  /** Chunks CT distants reçus (index -> data) */
  remoteCTChunks: Map<number, Uint8Array>;
  
  /** CT distant reconstruit complet */
  remoteCTComplete: Uint8Array | null;
  
  // === Secrets intermédiaires ===
  
  /** Secret obtenu lors de notre encapsulation vers leur clé */
  localEncapSecret: Uint8Array | null;
  
  /** Secret obtenu lors de la décapsulation de leur CT */
  remoteDecapSecret: Uint8Array | null;
  
  // === Résultat ===
  
  /** Secret partagé dérivé de l'échange (combinaison des deux secrets) */
  sharedSecret: Uint8Array | null;
  
  /** Timestamp de début d'échange */
  exchangeStartedAt: number | null;
}

/**
 * Configuration du Braid
 */
export interface BraidConfig {
  /** Activer le protocole Braid */
  enabled: boolean;
  
  /** Intervalle de rotation en nombre de messages */
  rotationInterval: number;
  
  /** Nombre max de chunks par message */
  chunksPerMessage: number;
  
  /** Timeout pour échange incomplet (ms) */
  exchangeTimeoutMs: number;
  
  /**
   * Contexte d'exécution — CORRECTION MINEUR (Audit Février 2026 — Phase 0 §3)
   * 
   * 'foreground' : App au premier plan, timeouts standards.
   * 'nse'        : iOS Notification Service Extension, budget 30s total.
   *                Les timeouts sont réduits pour respecter le budget NSE :
   *                - exchangeTimeoutMs plafonné à 15000ms
   *                - Maximum 2 tentatives de reconstruction
   *                - Si timeout : déchiffrer avec dernière clé PQ connue,
   *                  marquer pour re-traitement au retour foreground
   */
  context?: 'foreground' | 'nse';
}

// ============================================
// CONFIGURATION PAR DÉFAUT
// ============================================

export const DEFAULT_BRAID_CONFIG: BraidConfig = {
  enabled: true,
  rotationInterval: BRAID_CONSTANTS.DEFAULT_ROTATION_INTERVAL,
  chunksPerMessage: BRAID_CONSTANTS.MAX_CHUNKS_PER_MESSAGE,
  exchangeTimeoutMs: BRAID_CONSTANTS.EXCHANGE_TIMEOUT_MS,
  context: 'foreground',
};

// ============================================
// INITIALISATION
// ============================================

/**
 * Crée un état Braid initial (vide)
 */
export function createInitialBraidState(): BraidState {
  return {
    phase: 'idle',
    role: null,
    epoch: 0,
    messagesSinceLastExchange: 0,
    
    localKeyPair: null,
    localEKHeader: null,
    localEKBodyChunks: [],
    localEKChunksSent: 0,
    localEKHeaderSent: false,
    localCT: null,
    localCTChunks: [],
    localCTChunksSent: 0,
    
    remoteEKHeader: null,
    remoteEKBodyChunks: new Map(),
    remoteEKComplete: null,
    remoteCTChunks: new Map(),
    remoteCTComplete: null,
    
    localEncapSecret: null,
    remoteDecapSecret: null,
    sharedSecret: null,
    exchangeStartedAt: null,
  };
}

// ============================================
// CHUNKING ML-KEM
// ============================================

/**
 * Extrait le header de EK (seed ρ pour la matrice A)
 */
function extractEKHeader(ek: Uint8Array): Uint8Array {
  if (ek.length !== BRAID_CONSTANTS.EK_TOTAL_SIZE) {
    throw new Error(`Invalid EK size: ${ek.length}, expected ${BRAID_CONSTANTS.EK_TOTAL_SIZE}`);
  }
  return secureClone(ek.slice(0, BRAID_CONSTANTS.EK_HEADER_SIZE));
}

/**
 * Extrait le body de EK (après le header)
 */
function extractEKBody(ek: Uint8Array): Uint8Array {
  return ek.slice(BRAID_CONSTANTS.EK_HEADER_SIZE);
}

/**
 * Découpe des données en chunks de taille fixe
 */
function chunkData(
  data: Uint8Array, 
  type: 'ek' | 'ct', 
  epoch: number
): BraidChunk[] {
  const chunks: BraidChunk[] = [];
  const { CHUNK_SIZE } = BRAID_CONSTANTS;
  
  let offset = 0;
  let index = 0;
  
  while (offset < data.length) {
    const end = Math.min(offset + CHUNK_SIZE, data.length);
    chunks.push({
      index,
      type,
      data: secureClone(data.slice(offset, end)),
      epoch,
    });
    offset = end;
    index++;
  }
  
  return chunks;
}

/**
 * Reconstruit des données depuis une map de chunks
 */
function reconstructFromChunks(
  chunks: Map<number, Uint8Array>,
  expectedSize: number,
  totalChunks: number
): Uint8Array | null {
  // Vérifier qu'on a tous les chunks
  if (chunks.size < totalChunks) {
    return null;
  }
  
  // Vérifier la continuité des indices
  for (let i = 0; i < totalChunks; i++) {
    if (!chunks.has(i)) {
      return null;
    }
  }
  
  // Reconstruire
  const result = new Uint8Array(expectedSize);
  let offset = 0;
  
  for (let i = 0; i < totalChunks; i++) {
    const chunk = chunks.get(i)!;
    const copyLen = Math.min(chunk.length, expectedSize - offset);
    result.set(chunk.slice(0, copyLen), offset);
    offset += copyLen;
  }
  
  return result;
}

/**
 * Reconstruit EK complet depuis header + body chunks
 */
function reconstructEK(
  header: Uint8Array | null,
  bodyChunks: Map<number, Uint8Array>
): Uint8Array | null {
  if (!header || header.length !== BRAID_CONSTANTS.EK_HEADER_SIZE) {
    return null;
  }
  
  // Reconstruire le body
  const bodySize = BRAID_CONSTANTS.EK_TOTAL_SIZE - BRAID_CONSTANTS.EK_HEADER_SIZE;
  const body = reconstructFromChunks(
    bodyChunks,
    bodySize,
    BRAID_CONSTANTS.EK_BODY_CHUNKS
  );
  
  if (!body) {
    return null;
  }
  
  // Assembler header + body
  const ek = new Uint8Array(BRAID_CONSTANTS.EK_TOTAL_SIZE);
  ek.set(header, 0);
  ek.set(body, BRAID_CONSTANTS.EK_HEADER_SIZE);
  
  return ek;
}

/**
 * Reconstruit CT depuis les chunks
 */
function reconstructCT(chunks: Map<number, Uint8Array>): Uint8Array | null {
  return reconstructFromChunks(
    chunks,
    BRAID_CONSTANTS.CT_TOTAL_SIZE,
    BRAID_CONSTANTS.CT_TOTAL_CHUNKS
  );
}

// ============================================
// OPÉRATIONS ML-KEM
// ============================================

/**
 * Génère une nouvelle paire de clés ML-KEM-768
 */
function generateMLKEMKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const { publicKey, secretKey } = ml_kem768.keygen();
  return {
    publicKey: new Uint8Array(publicKey),
    secretKey: new Uint8Array(secretKey),
  };
}

/**
 * Encapsule vers une clé publique ML-KEM
 */
function mlkemEncapsulate(ek: Uint8Array): { 
  ciphertext: Uint8Array; 
  sharedSecret: Uint8Array;
} {
  const result = ml_kem768.encapsulate(ek);
  return {
    ciphertext: new Uint8Array(result.cipherText),
    sharedSecret: new Uint8Array(result.sharedSecret),
  };
}

/**
 * Décapsule un ciphertext ML-KEM
 */
function mlkemDecapsulate(ct: Uint8Array, sk: Uint8Array): Uint8Array {
  const sharedSecret = ml_kem768.decapsulate(ct, sk);
  return new Uint8Array(sharedSecret);
}

// ============================================
// MACHINE À ÉTATS BRAID
// ============================================

/**
 * Vérifie si on doit initier un nouvel échange Braid
 */
export function shouldInitiateBraid(
  state: BraidState, 
  config: BraidConfig
): boolean {
  // Vérifier si Braid est activé
  if (!config.enabled) {
    return false;
  }
  
  // Ne pas initier si un échange est déjà en cours
  if (state.phase !== 'idle' && state.phase !== 'completed') {
    return false;
  }
  
  // Initier si on a dépassé l'intervalle de rotation
  return state.messagesSinceLastExchange >= config.rotationInterval;
}

/**
 * Initie un nouvel échange Braid (côté initiateur)
 */
export function initiateBraid(state: BraidState): BraidState {
  const newEpoch = state.epoch + 1;
  
  // Générer nouvelle paire de clés ML-KEM
  const keyPair = generateMLKEMKeyPair();
  
  // Extraire header et body, créer les chunks
  const ekHeader = extractEKHeader(keyPair.publicKey);
  const ekBody = extractEKBody(keyPair.publicKey);
  const ekBodyChunks = chunkData(ekBody, 'ek', newEpoch);
  
  __DEV__ && console.log(`[Braid] 🚀 Initiating exchange epoch ${newEpoch} (${ekBodyChunks.length} EK chunks)`);
  
  return {
    ...createInitialBraidState(),
    phase: 'initiating',
    role: 'initiator',
    epoch: newEpoch,
    messagesSinceLastExchange: 0,
    
    localKeyPair: keyPair,
    localEKHeader: ekHeader,
    localEKBodyChunks: ekBodyChunks,
    
    exchangeStartedAt: Date.now(),
  };
}

/**
 * Répond à un échange Braid initié par l'autre partie
 */
export function respondToBraid(
  state: BraidState,
  remoteEKHeader: Uint8Array,
  epoch: number,
  initialEKChunks: BraidChunk[] = []
): BraidState {
  // Générer notre paire de clés ML-KEM
  const keyPair = generateMLKEMKeyPair();
  
  // Préparer nos chunks EK
  const ekHeader = extractEKHeader(keyPair.publicKey);
  const ekBody = extractEKBody(keyPair.publicKey);
  const ekBodyChunks = chunkData(ekBody, 'ek', epoch);
  
  // Initialiser la map des chunks distants avec les chunks initiaux
  const remoteEKBodyChunks = new Map<number, Uint8Array>();
  for (const chunk of initialEKChunks) {
    if (chunk.type === 'ek') {
      remoteEKBodyChunks.set(chunk.index, secureClone(chunk.data));
    }
  }
  
  __DEV__ && console.log(`[Braid] 📨 Responding to exchange epoch ${epoch} (${remoteEKBodyChunks.size} initial EK chunks)`);
  
  const newState: BraidState = {
    ...createInitialBraidState(),
    phase: 'responding',
    role: 'responder',
    epoch,
    messagesSinceLastExchange: 0,
    
    localKeyPair: keyPair,
    localEKHeader: ekHeader,
    localEKBodyChunks: ekBodyChunks,
    
    remoteEKHeader: secureClone(remoteEKHeader),
    remoteEKBodyChunks,
    
    exchangeStartedAt: Date.now(),
  };
  
  // Tenter de reconstruire EK si on a déjà tous les chunks
  const reconstructedEK = reconstructEK(newState.remoteEKHeader, newState.remoteEKBodyChunks);
  if (reconstructedEK) {
    newState.remoteEKComplete = reconstructedEK;
    __DEV__ && console.log(`[Braid] ✅ Remote EK reconstructed immediately`);
    return generateLocalCT(newState);
  }
  
  return newState;
}

/**
 * Traite un payload Braid reçu
 */
export function processReceivedBraidPayload(
  state: BraidState,
  payload: BraidPayload
): BraidState {
  // Cas spécial: on est idle et on reçoit un header EK -> devenir responder
  // Passer aussi les chunks EK initiaux qui sont dans le même payload
  if (state.phase === 'idle' && payload.ekHeader) {
    return respondToBraid(state, payload.ekHeader, payload.epoch, payload.ekChunks);
  }
  
  // Vérifier l'epoch
  if (payload.epoch !== state.epoch) {
    console.warn(`[Braid] ⚠️ Epoch mismatch: expected ${state.epoch}, got ${payload.epoch}`);
    return state;
  }
  
  let newState = { ...state };
  
  // Copier les Maps pour éviter les mutations
  newState.remoteEKBodyChunks = new Map(state.remoteEKBodyChunks);
  newState.remoteCTChunks = new Map(state.remoteCTChunks);
  
  // 1. Traiter le header EK si présent et pas encore reçu
  if (payload.ekHeader && !newState.remoteEKHeader) {
    newState.remoteEKHeader = secureClone(payload.ekHeader);
    __DEV__ && console.log(`[Braid] 📥 Received remote EK header`);
  }
  
  // 2. Traiter les chunks EK body
  for (const chunk of payload.ekChunks) {
    if (chunk.type === 'ek' && !newState.remoteEKBodyChunks.has(chunk.index)) {
      newState.remoteEKBodyChunks.set(chunk.index, secureClone(chunk.data));
    }
  }
  
  // 3. Traiter les chunks CT
  for (const chunk of payload.ctChunks) {
    if (chunk.type === 'ct' && !newState.remoteCTChunks.has(chunk.index)) {
      newState.remoteCTChunks.set(chunk.index, secureClone(chunk.data));
    }
  }
  
  // 4. Tenter de reconstruire EK distant si pas encore fait
  if (!newState.remoteEKComplete) {
    const reconstructed = reconstructEK(
      newState.remoteEKHeader,
      newState.remoteEKBodyChunks
    );
    if (reconstructed) {
      newState.remoteEKComplete = reconstructed;
      __DEV__ && console.log(`[Braid] ✅ Remote EK reconstructed (${newState.remoteEKBodyChunks.size} body chunks)`);
      
      // Générer notre CT maintenant qu'on a leur EK
      if (!newState.localCT) {
        newState = generateLocalCT(newState);
      }
    }
  }
  
  // 5. Tenter de reconstruire CT distant si pas encore fait
  if (!newState.remoteCTComplete) {
    const reconstructed = reconstructCT(newState.remoteCTChunks);
    if (reconstructed) {
      newState.remoteCTComplete = reconstructed;
      __DEV__ && console.log(`[Braid] ✅ Remote CT reconstructed (${newState.remoteCTChunks.size} chunks)`);
      
      // Décapsuler leur CT pour obtenir le shared secret
      if (newState.localKeyPair && !newState.remoteDecapSecret) {
        newState.remoteDecapSecret = mlkemDecapsulate(
          reconstructed,
          newState.localKeyPair.secretKey
        );
        __DEV__ && console.log(`[Braid] 🔓 Remote CT decapsulated`);
      }
    }
  }
  
  // 6. Mettre à jour la phase
  newState = updateBraidPhase(newState);
  
  // 7. Finaliser si possible
  if (canFinalizeBraid(newState)) {
    newState = finalizeBraid(newState);
  }
  
  return newState;
}

/**
 * Génère le CT local une fois qu'on a le EK distant complet
 */
function generateLocalCT(state: BraidState): BraidState {
  if (!state.remoteEKComplete) {
    return state;
  }
  
  // Encapsuler vers leur clé publique
  const { ciphertext, sharedSecret: encapSecret } = mlkemEncapsulate(state.remoteEKComplete);
  
  // Créer les chunks CT
  const ctChunks = chunkData(ciphertext, 'ct', state.epoch);
  
  __DEV__ && console.log(`[Braid] 🔐 Generated CT (${ctChunks.length} chunks)`);
  
  return {
    ...state,
    localCT: ciphertext,
    localCTChunks: ctChunks,
    localCTChunksSent: 0,
    localEncapSecret: encapSecret, // Stocker le secret d'encapsulation
  };
}

/**
 * Met à jour la phase du protocole
 */
function updateBraidPhase(state: BraidState): BraidState {
  if (state.sharedSecret) {
    return { ...state, phase: 'completed' };
  }
  
  // Vérifier si on peut finaliser
  if (canFinalizeBraid(state)) {
    return { ...state, phase: 'completing' };
  }
  
  // On est en échange actif
  if (state.localEKBodyChunks.length > 0 || state.localCTChunks.length > 0) {
    return { ...state, phase: 'exchanging' };
  }
  
  return state;
}

/**
 * Vérifie si on peut finaliser l'échange
 * On a besoin des deux secrets: celui de notre encapsulation et celui de leur CT
 */
export function canFinalizeBraid(state: BraidState): boolean {
  return state.localEncapSecret !== null && state.remoteDecapSecret !== null;
}

/**
 * Combine deux secrets avec HMAC pour produire le secret final
 */
function combineSecrets(secret1: Uint8Array, secret2: Uint8Array): Uint8Array {
  const combined = new Uint8Array(secret1.length + secret2.length);
  combined.set(secret1, 0);
  combined.set(secret2, secret1.length);
  
  const domain = new TextEncoder().encode('ghostr_braid_combine_v1');
  const result = hmacSha256(domain, combined);
  
  zeroize(combined);
  return result;
}

/**
 * Finalise l'échange et dérive le secret partagé
 * Combine les deux secrets (encapsulation + décapsulation)
 */
export function finalizeBraid(state: BraidState): BraidState {
  if (!state.localEncapSecret || !state.remoteDecapSecret) {
    console.error('[Braid] ❌ Cannot finalize: missing encap or decap secrets');
    return state;
  }
  
  // Combiner les deux secrets de manière déterministe basée sur le rôle
  // Cela garantit que les deux parties obtiennent le même secret final
  let sharedSecret: Uint8Array;
  if (state.role === 'initiator') {
    sharedSecret = combineSecrets(state.remoteDecapSecret, state.localEncapSecret);
  } else {
    sharedSecret = combineSecrets(state.localEncapSecret, state.remoteDecapSecret);
  }
  
  __DEV__ && console.log(`[Braid] ✅ Exchange finalized - epoch ${state.epoch}`);
  
  return {
    ...state,
    phase: 'completed',
    sharedSecret,
    // IMPORTANT: Remettre le compteur à zéro pour le prochain cycle
    messagesSinceLastExchange: 0,
  };
}

// ============================================
// GÉNÉRATION DU PAYLOAD SORTANT
// ============================================

/**
 * Génère le payload Braid à inclure dans le prochain message
 * 
 * Principe "Opportunistic Sending":
 * - Envoyer autant que possible sans bloquer
 * - Priorité: header EK > chunks EK > chunks CT
 */
export function generateBraidPayload(
  state: BraidState,
  config: BraidConfig
): { payload: BraidPayload | null; newState: BraidState } {
  // Si idle ou completed sans rien à envoyer, pas de payload
  if (state.phase === 'idle') {
    return { 
      payload: null, 
      newState: { ...state, messagesSinceLastExchange: state.messagesSinceLastExchange + 1 }
    };
  }
  
  if (state.phase === 'completed' && 
      state.localEKChunksSent >= state.localEKBodyChunks.length &&
      state.localCTChunksSent >= state.localCTChunks.length) {
    return { 
      payload: null, 
      newState: { ...state, messagesSinceLastExchange: state.messagesSinceLastExchange + 1 }
    };
  }
  
  let newState = { ...state };
  const payload: BraidPayload = {
    epoch: state.epoch,
    ekChunks: [],
    ctChunks: [],
    sendingComplete: false,
  };
  
  let chunksRemaining = config.chunksPerMessage;
  
  // 1. Envoyer le header EK si pas encore fait
  if (!newState.localEKHeaderSent && newState.localEKHeader) {
    payload.ekHeader = newState.localEKHeader;
    newState.localEKHeaderSent = true;
    // Le header ne compte pas dans la limite de chunks
  }
  
  // 2. Envoyer les chunks EK body
  while (
    chunksRemaining > 0 &&
    newState.localEKChunksSent < newState.localEKBodyChunks.length
  ) {
    const chunk = newState.localEKBodyChunks[newState.localEKChunksSent];
    payload.ekChunks.push(chunk);
    newState.localEKChunksSent++;
    chunksRemaining--;
  }
  
  // 3. Envoyer les chunks CT (si on a généré le CT)
  while (
    chunksRemaining > 0 &&
    newState.localCTChunks.length > 0 &&
    newState.localCTChunksSent < newState.localCTChunks.length
  ) {
    const chunk = newState.localCTChunks[newState.localCTChunksSent];
    payload.ctChunks.push(chunk);
    newState.localCTChunksSent++;
    chunksRemaining--;
  }
  
  // Vérifier si on a fini d'envoyer
  const allEKSent = newState.localEKHeaderSent && 
                    newState.localEKChunksSent >= newState.localEKBodyChunks.length;
  const allCTSent = newState.localCTChunks.length === 0 ||
                    newState.localCTChunksSent >= newState.localCTChunks.length;
  
  payload.sendingComplete = allEKSent && allCTSent;
  
  // Log de progression
  const ekProgress = `EK: ${newState.localEKChunksSent}/${newState.localEKBodyChunks.length}`;
  const ctProgress = newState.localCTChunks.length > 0 
    ? ` CT: ${newState.localCTChunksSent}/${newState.localCTChunks.length}`
    : '';
  __DEV__ && console.log(`[Braid] 📤 Sending ${payload.ekChunks.length + payload.ctChunks.length} chunks (${ekProgress}${ctProgress})`);
  
  return { payload, newState };
}

// ============================================
// SÉRIALISATION / DÉSÉRIALISATION
// ============================================

export interface SerializedBraidState {
  phase: BraidPhase;
  role: BraidRole | null;
  epoch: number;
  messagesSinceLastExchange: number;
  
  localKeyPair?: {
    publicKey: string;  // base64
    secretKey: string;  // base64
  };
  
  localEKHeader?: string;
  localEKChunksSent: number;
  localEKHeaderSent: boolean;
  localCT?: string;
  localCTChunksSent: number;
  
  remoteEKHeader?: string;
  remoteEKBodyChunksCount: number;
  remoteEKComplete?: string;
  remoteCTChunksCount: number;
  remoteCTComplete?: string;
  
  // Secrets intermédiaires
  localEncapSecret?: string;
  remoteDecapSecret?: string;
  
  sharedSecret?: string;
  exchangeStartedAt: number | null;
}

/**
 * Sérialise l'état Braid pour stockage
 */
export function serializeBraidState(state: BraidState): SerializedBraidState {
  const encodeBytes = (bytes: Uint8Array | null): string | undefined => {
    if (!bytes) return undefined;
    return btoa(String.fromCharCode(...bytes));
  };
  
  return {
    phase: state.phase,
    role: state.role,
    epoch: state.epoch,
    messagesSinceLastExchange: state.messagesSinceLastExchange,
    
    localKeyPair: state.localKeyPair ? {
      publicKey: encodeBytes(state.localKeyPair.publicKey)!,
      secretKey: encodeBytes(state.localKeyPair.secretKey)!,
    } : undefined,
    
    localEKHeader: encodeBytes(state.localEKHeader),
    localEKChunksSent: state.localEKChunksSent,
    localEKHeaderSent: state.localEKHeaderSent,
    localCT: encodeBytes(state.localCT),
    localCTChunksSent: state.localCTChunksSent,
    
    remoteEKHeader: encodeBytes(state.remoteEKHeader),
    remoteEKBodyChunksCount: state.remoteEKBodyChunks.size,
    remoteEKComplete: encodeBytes(state.remoteEKComplete),
    remoteCTChunksCount: state.remoteCTChunks.size,
    remoteCTComplete: encodeBytes(state.remoteCTComplete),
    
    localEncapSecret: encodeBytes(state.localEncapSecret),
    remoteDecapSecret: encodeBytes(state.remoteDecapSecret),
    
    sharedSecret: encodeBytes(state.sharedSecret),
    exchangeStartedAt: state.exchangeStartedAt,
  };
}

/**
 * Désérialise l'état Braid depuis le stockage
 */
export function deserializeBraidState(data: SerializedBraidState): BraidState {
  const decodeBytes = (str: string | undefined): Uint8Array | null => {
    if (!str) return null;
    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
  };
  
  const state: BraidState = {
    phase: data.phase,
    role: data.role,
    epoch: data.epoch,
    messagesSinceLastExchange: data.messagesSinceLastExchange,
    
    localKeyPair: data.localKeyPair ? {
      publicKey: decodeBytes(data.localKeyPair.publicKey)!,
      secretKey: decodeBytes(data.localKeyPair.secretKey)!,
    } : null,
    
    localEKHeader: decodeBytes(data.localEKHeader),
    localEKBodyChunks: [],
    localEKChunksSent: data.localEKChunksSent,
    localEKHeaderSent: data.localEKHeaderSent,
    localCT: decodeBytes(data.localCT),
    localCTChunks: [],
    localCTChunksSent: data.localCTChunksSent,
    
    remoteEKHeader: decodeBytes(data.remoteEKHeader),
    remoteEKBodyChunks: new Map(),
    remoteEKComplete: decodeBytes(data.remoteEKComplete),
    remoteCTChunks: new Map(),
    remoteCTComplete: decodeBytes(data.remoteCTComplete),
    
    localEncapSecret: decodeBytes(data.localEncapSecret),
    remoteDecapSecret: decodeBytes(data.remoteDecapSecret),
    
    sharedSecret: decodeBytes(data.sharedSecret),
    exchangeStartedAt: data.exchangeStartedAt,
  };
  
  // Reconstruire les chunks locaux si nécessaire
  if (state.localKeyPair && state.localEKChunksSent < BRAID_CONSTANTS.EK_BODY_CHUNKS) {
    const ekBody = extractEKBody(state.localKeyPair.publicKey);
    state.localEKBodyChunks = chunkData(ekBody, 'ek', state.epoch);
  }
  
  if (state.localCT && state.localCTChunksSent < BRAID_CONSTANTS.CT_TOTAL_CHUNKS) {
    state.localCTChunks = chunkData(state.localCT, 'ct', state.epoch);
  }
  
  return state;
}

// ============================================
// CLEANUP
// ============================================

/**
 * Nettoie l'état Braid de manière sécurisée
 */
export function cleanupBraidState(state: BraidState): void {
  // Zeroize les secrets
  if (state.localKeyPair) {
    zeroize(state.localKeyPair.secretKey);
  }
  if (state.localEncapSecret) {
    zeroize(state.localEncapSecret);
  }
  if (state.remoteDecapSecret) {
    zeroize(state.remoteDecapSecret);
  }
  if (state.sharedSecret) {
    zeroize(state.sharedSecret);
  }
  if (state.localCT) {
    zeroize(state.localCT);
  }
  if (state.remoteCTComplete) {
    zeroize(state.remoteCTComplete);
  }
  
  // Zeroize les chunks
  for (const chunk of state.localEKBodyChunks) {
    zeroize(chunk.data);
  }
  for (const chunk of state.localCTChunks) {
    zeroize(chunk.data);
  }
  for (const [_, data] of state.remoteEKBodyChunks) {
    zeroize(data);
  }
  for (const [_, data] of state.remoteCTChunks) {
    zeroize(data);
  }
}

// ============================================
// HELPERS POUR INTÉGRATION SPQR
// ============================================

/**
 * Mixe deux secrets PQ via HMAC-SHA256
 */
export function mixBraidSecrets(
  existingSecret: Uint8Array | null,
  newSecret: Uint8Array
): Uint8Array {
  if (!existingSecret) {
    return secureClone(newSecret);
  }
  
  // Combiner les deux secrets
  const combined = new Uint8Array(existingSecret.length + newSecret.length);
  combined.set(existingSecret);
  combined.set(newSecret, existingSecret.length);
  
  // Dériver via HMAC-SHA256
  const domain = new TextEncoder().encode(BRAID_KDF_DOMAINS.MIX_SECRETS);
  const mixed = hmacSha256(domain, combined);
  
  // Cleanup
  zeroize(combined);
  
  return mixed;
}

/**
 * Vérifie si un échange Braid a expiré
 * 
 * CORRECTION MINEUR (Audit Février 2026 — Phase 0 §3):
 * En contexte NSE, le timeout est réduit à 15s (budget iOS = 30s).
 * En foreground, le timeout reste à 120s (configurable via config.exchangeTimeoutMs).
 */
export function isBraidExchangeExpired(
  state: BraidState,
  config: BraidConfig
): boolean {
  if (state.phase === 'idle' || state.phase === 'completed') {
    return false;
  }
  
  if (!state.exchangeStartedAt) {
    return false;
  }
  
  // En contexte NSE, utiliser le timeout réduit (15s) pour respecter le budget iOS
  const effectiveTimeout = config.context === 'nse'
    ? Math.min(config.exchangeTimeoutMs, BRAID_CONSTANTS.NSE_EXCHANGE_TIMEOUT_MS)
    : config.exchangeTimeoutMs;
  
  return Date.now() - state.exchangeStartedAt > effectiveTimeout;
}

/**
 * Réinitialise un échange Braid expiré
 */
export function resetExpiredBraidExchange(state: BraidState): BraidState {
  console.warn(`[Braid] ⚠️ Exchange expired, resetting to idle`);
  
  // Cleanup l'ancien état
  cleanupBraidState(state);
  
  return {
    ...createInitialBraidState(),
    epoch: state.epoch,
    messagesSinceLastExchange: 0,
  };
}