// src/services/voiceCall.ts
// Service de gestion des appels vocaux anonymes et chiffrés
// Version 15.0 - SÉCURITÉ ET STABILITÉ:
//   - v15.0: Ajout de sequenceNumber pour ordonner les signaux et éviter les race conditions
//   - v15.0: Validation stricte des tokens (leavingParticipant/rejoiningParticipant === senderToken)
//   - v15.0: Protection contre l'usurpation de call-leave/call-rejoin
//   - v14.0: Suppression du système parallèle de leftParticipants
//   - v14.0: Utilisation de callHeartbeat comme SOURCE UNIQUE
//   - v14.0: Ajout du signal 'call-rejoin' pour annuler les call-leave tardifs
//   - v14.0: Suppression de la persistence AsyncStorage (données éphémères)
//   - v14.0: Simplification de la logique de processedCallIds
//
// ARCHITECTURE:
// - callHeartbeat.ts = SOURCE UNIQUE pour le tracking des participants
// - voiceCall.ts = Gestion des sessions et signaux
// - Pas de duplication de state entre les deux services
//
// SÉCURITÉ v15.0:
// - Les signaux call-leave et call-rejoin sont validés: le token dans le signal
//   DOIT correspondre au senderToken de l'enveloppe chiffrée
// - Les numéros de séquence permettent d'ignorer les signaux arrivant dans le désordre

import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { hkdf, getRandomBytes, generateRoomAuthToken } from './crypto';
import {
  SenderKey,
  SenderKeyDistribution,
  generateSenderKey,
  prepareSenderKeyDistribution,
  receiveSenderKeyDistribution,
  encryptAudioPacket,
  decryptAudioPacket,
  clearSenderKey,
  serializeSenderKey,
  deserializeSenderKey,
  rotateSenderKey,
  SerializedSenderKey,
} from './senderKeys';
import { getMasterKey, getConversationKeys, getSenderToken, getConversationSenderToken } from './storage';

// Import depuis callHeartbeat (SOURCE UNIQUE)
import {
  hasParticipantRecentlyLeft,
  markParticipantAsLeft,
  markParticipantAsRejoined,
  clearRecentlyLeftParticipant,
  clearAllCachesForRejoin,
  isRejoinInProgress,
  removeParticipantFromCall,
} from './callHeartbeat';

// v19.0: Import de hashSenderToken pour inclure dans les signaux SenderKey
import { hashSenderToken } from './webrtcService';

// ============================================
// TYPES
// ============================================

export type CallState = 
  | 'idle'           // Pas d'appel
  | 'initiating'     // J'initie un appel
  | 'ringing'        // J'ai reçu une offre d'appel
  | 'connecting'     // Connexion au SFU en cours
  | 'connected'      // Audio actif
  | 'reconnecting'   // Tentative de reconnexion
  | 'ended';         // Appel terminé

export type CallEndReason =
  | 'user_hangup'    // L'utilisateur a raccroché
  | 'remote_hangup'  // L'autre a raccroché (1-to-1 only)
  | 'declined'       // Appel refusé
  | 'timeout'        // Pas de réponse
  | 'error'          // Erreur technique
  | 'network_lost';  // Perte de connexion

export interface CallParticipant {
  peerId: string;
  senderToken: string;
  displayName?: string;
  senderKeyId?: string;
  isMuted: boolean;
  isSpeaking: boolean;
  joinedAt: number;
  avatarBase64?: string;
  isCurrentUser?: boolean;
}

export interface CallSession {
  callId: string;
  conversationId: string;
  roomTag: string;
  roomAuthToken: string;
  state: CallState;
  isOutgoing: boolean;
  participants: Map<string, CallParticipant>;
  mySenderKey: SenderKey | null;
  remoteSenderKeys: Map<string, SenderKey>;
  startedAt: number | null;
  endedAt: number | null;
  endReason: CallEndReason | null;
  isMuted: boolean;
  isSpeakerOn: boolean;
  callerName?: string;
  isEnding?: boolean;
}

// v15.0: Ajout de 'call-rejoin' pour les rejoins explicites + sequenceNumber pour l'ordonnancement
export interface CallSignal {
  type: 'call-offer' | 'call-answer' | 'call-decline' | 'call-hangup' | 'call-leave' | 'call-rejoin' | 'call-ice' | 'call-senderkey' | 'call-senderkey-rotation' | 'call-heartbeat';
  callId: string;
  offerSdp?: string;
  answerSdp?: string;
  candidate?: string;
  senderKeyDistribution?: SenderKeyDistribution;
  senderTokenHash?: string;  // v19.0: Hash du senderToken pour mapper audio reçu
  oldKeyId?: string;
  leavingParticipant?: string;
  rejoiningParticipant?: string;  // v14.0: Token du participant qui rejoint
  timestamp: number;
  sequenceNumber?: number;  // v15.0: Numéro de séquence pour ordonner les signaux par participant
}

export interface CallConfig {
  sfuUrl: string;
  ringTimeout: number;
  keyRotationInterval: number;
  preferredCodec: 'opus' | 'pcmu';
  audioBitrate: number;
}

type OnRotationSignalCallback = (signal: CallSignal) => void;
type OnParticipantLeftCallback = (senderToken: string) => void;

// ============================================
// CONFIGURATION PAR DÉFAUT
// ============================================

const DEFAULT_CONFIG: CallConfig = {
  sfuUrl: process.env.EXPO_PUBLIC_SFU_URL || 'wss://sfu.whisper.app',
  ringTimeout: 30000,
  keyRotationInterval: 300000,
  preferredCodec: 'opus',
  audioBitrate: 24,
};

// ============================================
// v14.0: TTL SIMPLIFIÉ pour processedCallIds
// ============================================

const PROCESSED_CALL_IDS_TTL_MS = 2 * 60 * 1000; // 2 minutes
const processedCallIdsMap: Map<string, number> = new Map();

// ============================================
// v15.0: SYSTÈME DE NUMÉROS DE SÉQUENCE
// Permet d'ordonner les signaux et d'ignorer les signaux out-of-order
// ============================================

// Compteur de séquence global pour mes propres signaux
let mySequenceCounter = 0;

// Tracking des derniers numéros de séquence reçus par participant
// Clé: `${callId}:${senderToken}` -> dernier sequenceNumber traité
const lastReceivedSequence: Map<string, number> = new Map();

// TTL pour nettoyer les entrées obsolètes (10 minutes)
const SEQUENCE_TRACKING_TTL_MS = 10 * 60 * 1000;
const sequenceTrackingTimestamps: Map<string, number> = new Map();

/**
 * v15.0: Génère le prochain numéro de séquence pour mes signaux
 */
export function getNextSequenceNumber(): number {
  return ++mySequenceCounter;
}

/**
 * v15.0: Réinitialise le compteur de séquence (appelé au début d'un nouvel appel)
 */
export function resetSequenceCounter(): void {
  mySequenceCounter = 0;
  __DEV__ && console.log('📞 Sequence counter reset');
}

/**
 * v15.0: Vérifie si un signal est dans l'ordre ou doit être ignoré
 * Retourne true si le signal doit être traité, false s'il est out-of-order
 */
export function shouldProcessSignal(callId: string, senderToken: string, sequenceNumber?: number): boolean {
  // Si pas de numéro de séquence, traiter (compatibilité rétro)
  if (sequenceNumber === undefined || sequenceNumber === null) {
    return true;
  }
  
  const key = `${callId}:${senderToken}`;
  const lastSeq = lastReceivedSequence.get(key);
  
  // Premier signal de ce participant pour cet appel
  if (lastSeq === undefined) {
    lastReceivedSequence.set(key, sequenceNumber);
    sequenceTrackingTimestamps.set(key, Date.now());
    return true;
  }
  
  // Signal out-of-order (ancien)
  if (sequenceNumber <= lastSeq) {
    __DEV__ && console.log(`📞 SECURITY: Out-of-order signal ignored (seq=${sequenceNumber}, lastSeq=${lastSeq}) from ${senderToken.slice(0, 8)}...`);
    return false;
  }
  
  // Signal dans l'ordre, mettre à jour
  lastReceivedSequence.set(key, sequenceNumber);
  sequenceTrackingTimestamps.set(key, Date.now());
  return true;
}

/**
 * v15.0: Nettoie les entrées de tracking obsolètes
 */
export function cleanupSequenceTracking(): void {
  const now = Date.now();
  for (const [key, timestamp] of sequenceTrackingTimestamps) {
    if (now - timestamp > SEQUENCE_TRACKING_TTL_MS) {
      lastReceivedSequence.delete(key);
      sequenceTrackingTimestamps.delete(key);
    }
  }
}

/**
 * v15.0: Réinitialise le tracking pour un appel spécifique (lors d'un rejoin)
 */
export function clearSequenceTrackingForCall(callId: string): void {
  const keysToDelete: string[] = [];
  for (const key of lastReceivedSequence.keys()) {
    if (key.startsWith(`${callId}:`)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    lastReceivedSequence.delete(key);
    sequenceTrackingTimestamps.delete(key);
  }
  __DEV__ && console.log(`📞 Cleared sequence tracking for call ${callId.slice(0, 8)}... (${keysToDelete.length} entries)`);
}

// ============================================
// ÉTAT GLOBAL DU SERVICE
// ============================================

interface CallServiceState {
  currentSession: CallSession | null;
  config: CallConfig;
  onStateChange: ((state: CallState) => void) | null;
  onParticipantJoined: ((participant: CallParticipant) => void) | null;
  onParticipantLeft: ((peerId: string) => void) | null;
  onRemoteParticipantLeft: OnParticipantLeftCallback | null;
  onAudioReceived: ((peerId: string, audioData: Uint8Array) => void) | null;
  onError: ((error: Error) => void) | null;
  onRotationSignal: OnRotationSignalCallback | null;
  onIncomingCall: ((conversationId: string, callId: string, callerToken: string) => void) | null;
  keyRotationTimer: ReturnType<typeof setInterval> | null;
  ringTimeout: ReturnType<typeof setTimeout> | null;
  pendingSenderKeys: Map<string, { signal: CallSignal; senderToken: string; conversationId: string; displayName?: string; avatarBase64?: string }>;  // v15.0: + avatarBase64
}

const state: CallServiceState = {
  currentSession: null,
  config: DEFAULT_CONFIG,
  onStateChange: null,
  onParticipantJoined: null,
  onParticipantLeft: null,
  onRemoteParticipantLeft: null,
  onAudioReceived: null,
  onError: null,
  onRotationSignal: null,
  onIncomingCall: null,
  keyRotationTimer: null,
  ringTimeout: null,
  pendingSenderKeys: new Map(),
};

// ============================================
// v14.0: GESTION processedCallIds (SIMPLIFIÉE)
// ============================================

function hasProcessedCallId(callId: string): boolean {
  // Ne pas bloquer si rejoin en cours
  if (isRejoinInProgress()) {
    return false;
  }
  
  const timestamp = processedCallIdsMap.get(callId);
  if (!timestamp) return false;
  
  const now = Date.now();
  if (now - timestamp > PROCESSED_CALL_IDS_TTL_MS) {
    processedCallIdsMap.delete(callId);
    return false;
  }
  
  return true;
}

function markCallIdAsProcessed(callId: string): void {
  processedCallIdsMap.set(callId, Date.now());
  cleanupProcessedCallIds();
}

function cleanupProcessedCallIds(): void {
  const now = Date.now();
  for (const [callId, timestamp] of processedCallIdsMap) {
    if (now - timestamp > PROCESSED_CALL_IDS_TTL_MS) {
      processedCallIdsMap.delete(callId);
    }
  }
}

export function clearProcessedCallId(callId: string): void {
  processedCallIdsMap.delete(callId);
  __DEV__ && console.log(`📞 Cleared callId ${callId.slice(0, 8)}... from processedCallIds`);
}

// ============================================
// UTILITAIRES
// ============================================

function updateState(newState: CallState): void {
  if (state.currentSession) {
    state.currentSession.state = newState;
    __DEV__ && console.log(`📞 Call state: ${newState}`);
    state.onStateChange?.(newState);
  }
}

async function generateRoomTag(masterKey: Uint8Array, callId: string): Promise<string> {
  const info = `whisper-room-v1:${callId}`;
  const tagBytes = await hkdf(masterKey, new Uint8Array(32), info, 16);
  
  let hex = '';
  for (let i = 0; i < tagBytes.length; i++) {
    hex += tagBytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function generateSfuAuthToken(masterKey: Uint8Array, callId: string): Promise<string> {
  return generateRoomAuthToken(masterKey, callId);
}

function generateCallId(): string {
  return encodeBase64(getRandomBytes(16));
}

function generatePeerId(): string {
  return encodeBase64(getRandomBytes(8));
}

function clearRingTimeout(): void {
  if (state.ringTimeout) {
    clearTimeout(state.ringTimeout);
    state.ringTimeout = null;
  }
}

function startRingTimeout(): void {
  clearRingTimeout();
  
  state.ringTimeout = setTimeout(() => {
    if (state.currentSession?.state === 'ringing' || 
        state.currentSession?.state === 'initiating') {
      __DEV__ && console.log('📞 Call timeout - no answer');
      endCallSession('timeout');
    }
  }, state.config.ringTimeout);
}

// ============================================
// KEY ROTATION
// ============================================

function startKeyRotationTimer(): void {
  stopKeyRotationTimer();
  
  state.keyRotationTimer = setInterval(async () => {
    if (!state.currentSession?.mySenderKey || !state.currentSession.conversationId) return;
    
    // Ne pas rotater si la session se termine
    if (state.currentSession.isEnding) {
      __DEV__ && console.log('📞 Session ending, not rotating SenderKey');
      return;
    }
    
    try {
      const keys = await getConversationKeys(state.currentSession.conversationId);
      if (!keys) {
        __DEV__ && console.warn('📞 Cannot rotate SenderKey: no conversation keys');
        return;
      }
      
      const mySenderToken = await getConversationSenderToken(state.currentSession.conversationId);
      
      const oldKeyId = state.currentSession.mySenderKey.keyId;
      const { newKey } = rotateSenderKey(state.currentSession.mySenderKey);
      state.currentSession.mySenderKey = newKey;
      
      const distribution = prepareSenderKeyDistribution(
        newKey,
        keys.e2eKey,
        mySenderToken
      );
      
      const rotationSignal: CallSignal = {
        type: 'call-senderkey-rotation',
        callId: state.currentSession.callId,
        senderKeyDistribution: distribution,
        oldKeyId,
        timestamp: Date.now(),
      };
      
      state.onRotationSignal?.(rotationSignal);
      __DEV__ && console.log(`📞 Key rotated: ${oldKeyId} -> ${newKey.keyId}`);
      
    } catch (error) {
      __DEV__ && console.error('Key rotation error:', error);
    }
  }, state.config.keyRotationInterval);
}

function stopKeyRotationTimer(): void {
  if (state.keyRotationTimer) {
    clearInterval(state.keyRotationTimer);
    state.keyRotationTimer = null;
  }
}

// ============================================
// FIN DE SESSION
// ============================================

function endCallSession(reason: CallEndReason): void {
  if (!state.currentSession) return;
  
  if (state.currentSession.isEnding) {
    __DEV__ && console.log('📞 Session already ending, ignored');
    return;
  }
  
  state.currentSession.isEnding = true;
  
  clearRingTimeout();
  stopKeyRotationTimer();
  
  state.currentSession.state = 'ended';
  state.currentSession.endedAt = Date.now();
  state.currentSession.endReason = reason;
  
  if (state.currentSession.mySenderKey) {
    clearSenderKey(state.currentSession.mySenderKey);
    state.currentSession.mySenderKey = null;
  }
  
  state.currentSession.remoteSenderKeys.clear();
  
  __DEV__ && console.log(`📞 Call ended: ${reason}`);
  state.onStateChange?.('ended');
  
  setTimeout(() => {
    if (state.currentSession?.state === 'ended') {
      state.currentSession = null;
    }
  }, 1000);
}

// ============================================
// URL SFU
// ============================================

export function getSfuUrl(): string | null {
  const session = state.currentSession;
  if (!session) return null;
  
  const baseUrl = state.config.sfuUrl;
  const params = new URLSearchParams();
  
  if (session.roomAuthToken) {
    params.append('authToken', session.roomAuthToken);
  }
  
  return `${baseUrl}/room/${session.roomTag}?${params.toString()}`;
}

// ============================================
// DÉMARRER UN APPEL
// ============================================

export async function startCall(
  conversationId: string,

): Promise<{
  success: boolean;
  callId?: string;
  signal?: CallSignal;
  error?: string;
  roomTag?: string;
  roomAuthToken?: string;
}> {
  try {
    if (state.currentSession && 
        state.currentSession.state !== 'idle' && 
        state.currentSession.state !== 'ended' &&
        !state.currentSession.isEnding) {
      return { success: false, error: 'Call already in progress' };
    }
    
    // v15.0: Réinitialiser le compteur de séquence pour un nouvel appel
    resetSequenceCounter();
    
    let roomTag: string;
    let roomAuthToken: string;
    let mySenderToken: string;
    let callId: string;
    
    {
      // Pour les 1:1, utiliser la masterKey
      const masterKey = await getMasterKey(conversationId);
      if (!masterKey) {
        return { success: false, error: 'Conversation keys not found' };
      }
      
      mySenderToken = await getConversationSenderToken(conversationId);
      callId = generateCallId();
      roomTag = await generateRoomTag(masterKey, callId);
      roomAuthToken = await generateSfuAuthToken(masterKey, callId);
    }
    
    const myPeerId = generatePeerId();
    const mySenderKey = generateSenderKey();
    
    const session: CallSession = {
      callId,
      conversationId,
      roomTag,
      roomAuthToken,
      state: 'initiating',
      isOutgoing: true,
      participants: new Map([[myPeerId, {
        peerId: myPeerId,
        senderToken: mySenderToken,
        senderKeyId: mySenderKey.keyId,
        isMuted: false,
        isSpeaking: false,
        joinedAt: Date.now(),
        isCurrentUser: true,
      }]]),
      mySenderKey,
      remoteSenderKeys: new Map(),
      startedAt: Date.now(),
      endedAt: null,
      endReason: null,
      isMuted: false,
      isSpeakerOn: false,
      isEnding: false,
    };
    
    state.currentSession = session;
    markCallIdAsProcessed(callId);
    updateState('initiating');
    
    {
      startRingTimeout();
    }
    
    const callSignal: CallSignal = {
      type: 'call-offer',
      callId,
      timestamp: Date.now(),
    };
    
    __DEV__ && console.log(`📞 Starting call: ${callId}`);
    
    return {
      success: true,
      callId,
      signal: callSignal,
      roomTag,
      roomAuthToken,
    };
    
  } catch (error) {
    __DEV__ && console.error('Start call error:', error);
    return { success: false, error: String(error) };
  }
}

// ============================================
// RECEVOIR UN APPEL
// ============================================

export async function handleIncomingCall(
  conversationId: string,
  signal: CallSignal,
  callerSenderToken: string
): Promise<{
  success: boolean;
  shouldSwitchToThisCall?: boolean;
  newCallId?: string;
  error?: string;
}> {
  try {
    cleanupProcessedCallIds();
    
    if (hasProcessedCallId(signal.callId)) {
      __DEV__ && console.log(`📞 Ignoring duplicate call-offer: ${signal.callId.slice(0, 8)}...`);
      return { success: true };
    }
    
    if (state.currentSession && 
        state.currentSession.state !== 'idle' && 
        state.currentSession.state !== 'ended' &&
        !state.currentSession.isEnding) {
      
      // TIE-BREAKING
      if (state.currentSession.state === 'initiating' && 
          state.currentSession.conversationId === conversationId) {
        
        const myCallId = state.currentSession.callId;
        const theirCallId = signal.callId;
        
        if (theirCallId < myCallId) {
          __DEV__ && console.log(`📞 TIE-BREAKING: Switching to their call`);
          markCallIdAsProcessed(myCallId);
          return { 
            success: true, 
            shouldSwitchToThisCall: true,
            newCallId: theirCallId
          };
        } else {
          __DEV__ && console.log(`📞 TIE-BREAKING: Keeping my call`);
          markCallIdAsProcessed(theirCallId);
          return { success: true };
        }
      }
      
      __DEV__ && console.log(`📞 Already in call, ignoring new offer`);
      return { success: false, error: 'Already in a call' };
    }
    
    if (signal.type !== 'call-offer') {
      return { success: false, error: 'Invalid signal type' };
    }
    
    const masterKey = await getMasterKey(conversationId);
    if (!masterKey) {
      return { success: false, error: 'Conversation keys not found' };
    }
    
    const mySenderToken = await getConversationSenderToken(conversationId);
    
    if (callerSenderToken === mySenderToken) {
      __DEV__ && console.log(`📞 Ignoring my own call-offer`);
      return { success: true };
    }
    
    const roomTag = await generateRoomTag(masterKey, signal.callId);
    const roomAuthToken = await generateSfuAuthToken(masterKey, signal.callId);
    const myPeerId = generatePeerId();
    const mySenderKey = generateSenderKey();
    
    const session: CallSession = {
      callId: signal.callId,
      conversationId,
      roomTag,
      roomAuthToken,
      state: 'ringing',
      isOutgoing: false,
      participants: new Map([[myPeerId, {
        peerId: myPeerId,
        senderToken: mySenderToken,
        senderKeyId: mySenderKey.keyId,
        isMuted: false,
        isSpeaking: false,
        joinedAt: Date.now(),
        isCurrentUser: true,
      }]]),
      mySenderKey,
      remoteSenderKeys: new Map(),
      startedAt: null,
      endedAt: null,
      endReason: null,
      isMuted: false,
      isSpeakerOn: false,
      isEnding: false,
    };
    
    state.currentSession = session;
    markCallIdAsProcessed(signal.callId);
    updateState('ringing');
    
    // Traiter SenderKeys en attente
    if (state.pendingSenderKeys.size > 0) {
      __DEV__ && console.log(`📞 Processing ${state.pendingSenderKeys.size} pending SenderKeys...`);
      for (const [token, pending] of state.pendingSenderKeys) {
        await receiveSenderKeyFromPeer(pending.senderToken, pending.signal, pending.conversationId, pending.displayName, pending.avatarBase64);
      }
      state.pendingSenderKeys.clear();
    }
    
    state.onIncomingCall?.(conversationId, signal.callId, callerSenderToken);
    
    __DEV__ && console.log(`📞 Incoming call: ${signal.callId} from ${callerSenderToken.slice(0, 8)}...`);
    
    return { success: true };
    
  } catch (error) {
    __DEV__ && console.error('Handle incoming call error:', error);
    return { success: false, error: String(error) };
  }
}

// ============================================
// APPEL DE GROUPE ENTRANT
// ============================================


export async function acceptCall(): Promise<{
  success: boolean;
  signal?: CallSignal;
  error?: string;
}> {
  try {
    if (!state.currentSession) {
      return { success: false, error: 'No call session' };
    }
    
    if (state.currentSession.isEnding) {
      return { success: false, error: 'Session is ending' };
    }
    
    if (state.currentSession.state !== 'ringing') {
      return { success: false, error: `Cannot accept call in state: ${state.currentSession.state}` };
    }
    
    clearRingTimeout();
    updateState('connecting');
    state.currentSession.startedAt = Date.now();
    
    const callSignal: CallSignal = {
      type: 'call-answer',
      callId: state.currentSession.callId,
      timestamp: Date.now(),
    };
    
    __DEV__ && console.log(`📞 Call accepted: ${state.currentSession.callId}`);
    
    return { success: true, signal: callSignal };
    
  } catch (error) {
    __DEV__ && console.error('Accept call error:', error);
    return { success: false, error: String(error) };
  }
}

// ============================================
// REJOINDRE UN APPEL EXISTANT
// ============================================

export async function joinCallById(
  conversationId: string,
  callId: string
): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    __DEV__ && console.log(`📞 joinCallById: Starting for call ${callId.slice(0, 8)}...`);
    
    // v15.0: Réinitialiser le compteur de séquence pour un rejoin
    resetSequenceCounter();
    
    // v15.0: Nettoyer le tracking de séquence pour cet appel
    clearSequenceTrackingForCall(callId);
    
    // Nettoyer TOUS les caches via callHeartbeat (SOURCE UNIQUE)
    const mySenderToken = await getConversationSenderToken(conversationId);
    clearAllCachesForRejoin(callId, mySenderToken);
    
    // Aussi nettoyer le processedCallId local
    clearProcessedCallId(callId);
    
    if (state.currentSession && 
        state.currentSession.state !== 'idle' && 
        state.currentSession.state !== 'ended' &&
        !state.currentSession.isEnding) {
      if (state.currentSession.callId === callId) {
        __DEV__ && console.log(`📞 Already in this call: ${callId.slice(0, 8)}...`);
        return { success: true };
      }
      return { success: false, error: 'Already in a different call' };
    }
    
    const masterKey = await getMasterKey(conversationId);
    if (!masterKey) {
      return { success: false, error: 'Conversation keys not found' };
    }
    
    const roomTag = await generateRoomTag(masterKey, callId);
    const roomAuthToken = await generateSfuAuthToken(masterKey, callId);
    const myPeerId = generatePeerId();
    const mySenderKey = generateSenderKey();
    
    const session: CallSession = {
      callId,
      conversationId,
      roomTag,
      roomAuthToken,
      state: 'connecting',
      isOutgoing: false,
      participants: new Map([[myPeerId, {
        peerId: myPeerId,
        senderToken: mySenderToken,
        senderKeyId: mySenderKey.keyId,
        isMuted: false,
        isSpeaking: false,
        joinedAt: Date.now(),
        isCurrentUser: true,
      }]]),
      mySenderKey,
      remoteSenderKeys: new Map(),
      startedAt: Date.now(),
      endedAt: null,
      endReason: null,
      isMuted: false,
      isSpeakerOn: false,
      isEnding: false,
    };
    
    state.currentSession = session;
    markCallIdAsProcessed(callId);
    updateState('connecting');
    
    __DEV__ && console.log(`📞 Joining existing call: ${callId.slice(0, 8)}...`);
    
    // Traiter SenderKeys en attente
    if (state.pendingSenderKeys.size > 0) {
      __DEV__ && console.log(`📞 Processing ${state.pendingSenderKeys.size} pending SenderKeys...`);
      for (const [token, pending] of state.pendingSenderKeys) {
        await receiveSenderKeyFromPeer(pending.senderToken, pending.signal, pending.conversationId, pending.displayName, pending.avatarBase64);
      }
      state.pendingSenderKeys.clear();
    }
    
    return { success: true };
    
  } catch (error) {
    __DEV__ && console.error('Join call by ID error:', error);
    return { success: false, error: String(error) };
  }
}

// ============================================
// REFUSER UN APPEL
// ============================================

export async function declineCall(): Promise<{
  success: boolean;
  signal?: CallSignal;
  error?: string;
}> {
  try {
    if (!state.currentSession) {
      return { success: false, error: 'No call session' };
    }
    
    if (state.currentSession.state !== 'ringing') {
      return { success: false, error: `Cannot decline call in state: ${state.currentSession.state}` };
    }
    
    const callSignal: CallSignal = {
      type: 'call-decline',
      callId: state.currentSession.callId,
      timestamp: Date.now(),
    };
    
    endCallSession('declined');
    
    __DEV__ && console.log(`📞 Call declined`);
    
    return { success: true, signal: callSignal };
    
  } catch (error) {
    __DEV__ && console.error('Decline call error:', error);
    return { success: false, error: String(error) };
  }
}

// ============================================
// RACCROCHER
// ============================================

export async function hangUp(): Promise<{
  success: boolean;
  signal?: CallSignal;
  error?: string;
}> {
  try {
    if (!state.currentSession) {
      return { success: false, error: 'No active call' };
    }
    
    if (state.currentSession.isEnding) {
      __DEV__ && console.log('📞 Session already ending, hangUp ignored');
      return { success: true };
    }
    
    const conversationId = state.currentSession.conversationId;
    const callId = state.currentSession.callId;
    const mySenderToken = await getConversationSenderToken(conversationId);
    
    // Marquer comme parti via callHeartbeat (SOURCE UNIQUE)
    markParticipantAsLeft(mySenderToken, callId);
    
    // v15.0: Inclure le sequenceNumber pour l'ordonnancement
    const callSignal: CallSignal = {
      type: 'call-leave',
      callId,
      leavingParticipant: mySenderToken,
      timestamp: Date.now(),
      sequenceNumber: getNextSequenceNumber(),
    };
    
    endCallSession('user_hangup');
    
    __DEV__ && console.log(`📞 Left the call (sent call-leave, seq=${callSignal.sequenceNumber})`);
    
    return { success: true, signal: callSignal };
    
  } catch (error) {
    __DEV__ && console.error('Hang up error:', error);
    return { success: false, error: String(error) };
  }
}

// ============================================
// v15.0: CRÉER UN SIGNAL CALL-REJOIN avec séquence
// ============================================

export async function createRejoinSignal(conversationId: string, callId: string): Promise<CallSignal | null> {
  try {
    const mySenderToken = await getConversationSenderToken(conversationId);
    
    // v15.0: Inclure le sequenceNumber pour l'ordonnancement
    const signal: CallSignal = {
      type: 'call-rejoin',
      callId,
      rejoiningParticipant: mySenderToken,
      timestamp: Date.now(),
      sequenceNumber: getNextSequenceNumber(),
    };
    
    __DEV__ && console.log(`📞 Created call-rejoin signal for ${mySenderToken.slice(0, 8)}... (seq=${signal.sequenceNumber})`);
    
    return signal;
    
  } catch (error) {
    __DEV__ && console.error('Create rejoin signal error:', error);
    return null;
  }
}

// ============================================
// TRAITEMENT DES SIGNAUX
// v15.0: Ajout de avatarBase64
// ============================================

export async function handleCallSignal(
  conversationId: string,
  signal: CallSignal,
  senderToken: string,
  displayName?: string,
  avatarBase64?: string
): Promise<{
  success: boolean;
  shouldSwitchToThisCall?: boolean;
  newCallId?: string;
  error?: string;
}> {
  try {
    __DEV__ && console.log(`📞 Received signal: ${signal.type} from ${senderToken.slice(0, 8)}...`);
    
    switch (signal.type) {
      case 'call-offer':
        return handleIncomingCall(conversationId, signal, senderToken);
        
      case 'call-answer':
        return handleCallAnswer(signal);
        
      case 'call-decline':
        return handleCallDecline(signal);
        
      case 'call-leave':
        return handleCallLeave(signal, senderToken, conversationId);
        
      case 'call-rejoin':
        return handleCallRejoin(signal, senderToken);
        
      case 'call-senderkey':
      case 'call-senderkey-rotation':
        // v15.0: Passer avatarBase64 directement
        return receiveSenderKeyFromPeer(senderToken, signal, conversationId, displayName, avatarBase64);
        
      default:
        return { success: true };
    }
    
  } catch (error) {
    __DEV__ && console.error('Handle call signal error:', error);
    return { success: false, error: String(error) };
  }
}

async function handleCallAnswer(signal: CallSignal): Promise<{ success: boolean; error?: string }> {
  if (!state.currentSession) {
    return { success: false, error: 'No call session' };
  }
  
  if (state.currentSession.callId !== signal.callId) {
    return { success: false, error: 'Wrong call ID' };
  }
  
  clearRingTimeout();
  updateState('connecting');
  startKeyRotationTimer();
  
  __DEV__ && console.log(`📞 Call answered`);
  
  return { success: true };
}

async function handleCallDecline(signal: CallSignal): Promise<{ success: boolean; error?: string }> {
  if (!state.currentSession) {
    return { success: true };
  }
  
  if (state.currentSession.callId !== signal.callId) {
    return { success: true };
  }
  
  endCallSession('declined');
  
  __DEV__ && console.log(`📞 Call declined by remote`);
  
  return { success: true };
}

async function handleCallLeave(signal: CallSignal, senderToken: string, conversationId: string): Promise<{ success: boolean; error?: string }> {
  if (!state.currentSession) {
    // v15.0: Même sans session locale, on doit retirer le participant de callHeartbeat
    // car l'autre utilisateur voit toujours ce participant dans son UI
    if (signal.callId && conversationId) {
      const leavingToken = signal.leavingParticipant || senderToken;
      
      // Valider le token d'abord
      if (signal.leavingParticipant && signal.leavingParticipant !== senderToken) {
        __DEV__ && console.warn(`📞 SECURITY: call-leave token mismatch (no session)`);
        return { success: false, error: 'Token mismatch' };
      }
      
      __DEV__ && console.log(`📞 Received call-leave from ${leavingToken.slice(0, 8)}... (no local session)`);
      await removeParticipantFromCall(conversationId, leavingToken, signal.callId);
    }
    return { success: true };
  }
  
  const leavingToken = signal.leavingParticipant || senderToken;
  
  // v15.0: SÉCURITÉ - Valider que le token dans le signal correspond au senderToken de l'enveloppe
  // Ceci empêche l'usurpation: un attaquant ne peut pas forger un call-leave pour un autre utilisateur
  if (signal.leavingParticipant && signal.leavingParticipant !== senderToken) {
    __DEV__ && console.warn(`📞 SECURITY: call-leave token mismatch! leavingParticipant=${signal.leavingParticipant.slice(0, 8)}... != senderToken=${senderToken.slice(0, 8)}...`);
    __DEV__ && console.warn(`📞 SECURITY: Ignoring potentially forged call-leave signal`);
    return { success: false, error: 'Token mismatch - potential forgery' };
  }
  
  // v15.0: Vérifier le numéro de séquence pour éviter les signaux out-of-order
  if (!shouldProcessSignal(signal.callId, senderToken, signal.sequenceNumber)) {
    __DEV__ && console.log(`📞 Ignoring out-of-order call-leave from ${senderToken.slice(0, 8)}...`);
    return { success: true }; // Pas une erreur, juste ignoré
  }
  
  __DEV__ && console.log(`📞 Participant ${leavingToken.slice(0, 8)}... left the call (seq=${signal.sequenceNumber || 'none'})`);
  
  // v15.0 FIX: Utiliser removeParticipantFromCall pour RETIRER le participant de participantTokens
  // Pas juste markParticipantAsLeft qui ne fait que marquer
  const effectiveConversationId = conversationId || state.currentSession.conversationId;
  if (signal.callId && effectiveConversationId) {
    await removeParticipantFromCall(effectiveConversationId, leavingToken, signal.callId);
  }
  
  // Retirer des participants locaux de la session voiceCall
  for (const [peerId, participant] of state.currentSession.participants) {
    if (participant.senderToken === leavingToken && !participant.isCurrentUser) {
      state.currentSession.participants.delete(peerId);
      state.currentSession.remoteSenderKeys.delete(leavingToken);
      state.onParticipantLeft?.(peerId);
      break;
    }
  }
  
  state.onRemoteParticipantLeft?.(leavingToken);
  
  return { success: true };
}

// v15.0: Traitement du signal call-rejoin avec validation sécurisée
async function handleCallRejoin(signal: CallSignal, senderToken: string): Promise<{ success: boolean; error?: string }> {
  const rejoiningToken = signal.rejoiningParticipant || senderToken;
  
  // v15.0: SÉCURITÉ - Valider que le token dans le signal correspond au senderToken de l'enveloppe
  // Ceci empêche l'usurpation: un attaquant ne peut pas forger un call-rejoin pour un autre utilisateur
  if (signal.rejoiningParticipant && signal.rejoiningParticipant !== senderToken) {
    __DEV__ && console.warn(`📞 SECURITY: call-rejoin token mismatch! rejoiningParticipant=${signal.rejoiningParticipant.slice(0, 8)}... != senderToken=${senderToken.slice(0, 8)}...`);
    __DEV__ && console.warn(`📞 SECURITY: Ignoring potentially forged call-rejoin signal`);
    return { success: false, error: 'Token mismatch - potential forgery' };
  }
  
  // v15.0 FIX: call-rejoin BYPASS la vérification de séquence car il réinitialise la session
  // On réinitialise le tracking de séquence pour ce participant à la valeur du rejoin
  // Ceci permet d'accepter les futurs signaux même après un leave/rejoin
  if (signal.sequenceNumber !== undefined) {
    const key = `${signal.callId}:${senderToken}`;
    const oldSeq = lastReceivedSequence.get(key);
    lastReceivedSequence.set(key, signal.sequenceNumber);
    sequenceTrackingTimestamps.set(key, Date.now());
    __DEV__ && console.log(`📞 call-rejoin: Reset sequence tracking for ${senderToken.slice(0, 8)}... (was ${oldSeq || 'none'}, now ${signal.sequenceNumber})`);
  }
  
  __DEV__ && console.log(`📞 Participant ${rejoiningToken.slice(0, 8)}... rejoined the call (seq=${signal.sequenceNumber || 'none'})`);
  
  // Marquer comme rejoint via callHeartbeat (SOURCE UNIQUE)
  // Ceci annule tout call-leave précédent
  if (signal.callId) {
    markParticipantAsRejoined(rejoiningToken, signal.callId);
  }
  
  return { success: true };
}

// ============================================
// SENDERKEY
// ============================================

async function receiveSenderKeyFromPeer(
  senderToken: string,
  signal: CallSignal,
  conversationId: string,
  displayName?: string,
  avatarBase64?: string  // v15.0: Avatar transmis directement (chiffré E2E)
): Promise<{ success: boolean; error?: string }> {
  // Ne pas ignorer les SenderKeys même si le participant était marqué comme "parti"
  // Une SenderKey prouve la PRÉSENCE du participant
  
  if (!signal.senderKeyDistribution) {
    return { success: false, error: 'No SenderKey distribution in signal' };
  }
  
  // v15.0 FIX: Une SenderKey prouve la présence active du participant
  // Réinitialiser le tracking de séquence car le participant est clairement actif
  if (signal.callId) {
    const key = `${signal.callId}:${senderToken}`;
    const oldSeq = lastReceivedSequence.get(key);
    if (oldSeq !== undefined) {
      // Réinitialiser à 0 pour accepter les futurs signaux
      lastReceivedSequence.delete(key);
      sequenceTrackingTimestamps.delete(key);
      __DEV__ && console.log(`📞 SenderKey received: Reset sequence tracking for ${senderToken.slice(0, 8)}... (was ${oldSeq})`);
    }
  }
  
  // Si participant était marqué comme parti, le marquer comme rejoint
  if (hasParticipantRecentlyLeft(senderToken, signal.callId)) {
    __DEV__ && console.log(`📞 Participant ${senderToken.slice(0, 8)}... sent SenderKey - marking as rejoined`);
    markParticipantAsRejoined(senderToken, signal.callId);
  }
  
  // Si pas de session, mettre en attente (incluant l'avatar)
  if (!state.currentSession) {
    state.pendingSenderKeys.set(senderToken, { signal, senderToken, conversationId, displayName, avatarBase64 });
    __DEV__ && console.log(`📞 SenderKey queued (no session): ${senderToken.slice(0, 8)}...`);
    return { success: true };
  }
  
  // Vérifier le callId
  if (signal.callId !== state.currentSession.callId) {
    __DEV__ && console.log(`📞 SenderKey from different call, ignoring`);
    return { success: true };
  }
  
  // Ne pas traiter si la session se termine
  if (state.currentSession.isEnding) {
    __DEV__ && console.log(`📞 Session ending, ignoring SenderKey from ${senderToken.slice(0, 8)}...`);
    return { success: true };
  }
  
  try {
    // Récupérer les clés de conversation pour le déchiffrement
    const keys = await getConversationKeys(state.currentSession.conversationId);
    
    let e2eKey: Uint8Array;
    
    if (keys) {
      // Conversation 1:1 avec masterKey
      e2eKey = keys.e2eKey;
    } else {
      // No keys available — refuse to proceed with insecure fallback
      __DEV__ && console.error('[VoiceCall] No conversation keys available for sender key distribution');
      return { success: false, error: 'No conversation keys available' };
    }
    
    const result = receiveSenderKeyDistribution(
      signal.senderKeyDistribution,
      e2eKey
    );
    
    // v19.0: Extraire la SenderKey du résultat (qui contient aussi freshEntropy pour PCS)
    const senderKey = result.senderKey;
    
    // Stocker la SenderKey
    state.currentSession.remoteSenderKeys.set(senderToken, senderKey);
    
    // Ajouter le participant s'il n'existe pas
    const existingParticipant = Array.from(state.currentSession.participants.values())
      .find(p => p.senderToken === senderToken);
    
    if (!existingParticipant) {
      const newPeerId = `remote-${senderToken.slice(0, 8)}-${Date.now()}`;
      
      // v15.0: Utiliser l'avatar transmis directement (chiffré E2E)
      // PAS de chargement depuis le storage - l'avatar vient du signal d'appel
      
      // Calculer le numéro du participant
      const remoteParticipantCount = Array.from(state.currentSession.participants.values())
        .filter(p => p.peerId.startsWith('remote-')).length;
      
      const newParticipant: CallParticipant = {
        peerId: newPeerId,
        senderToken,
        displayName: displayName || `Participant ${remoteParticipantCount + 1}`,
        senderKeyId: senderKey.keyId,
        isMuted: false,
        isSpeaking: false,
        joinedAt: Date.now(),
        avatarBase64,  // v15.0: Avatar transmis directement
        isCurrentUser: false,
      };
      
      state.currentSession.participants.set(newPeerId, newParticipant);
      state.onParticipantJoined?.(newParticipant);
      
      __DEV__ && console.log(`📞 New participant from SenderKey: ${displayName || senderToken.slice(0, 8)}... (avatar: ${avatarBase64 ? 'yes' : 'no'})`);
      __DEV__ && console.log(`📞 Total participants: ${state.currentSession.participants.size}`);
    } else {
      // Mettre à jour la SenderKey et éventuellement l'avatar
      existingParticipant.senderKeyId = senderKey.keyId;
      if (displayName && existingParticipant.displayName !== displayName) {
        existingParticipant.displayName = displayName;
      }
      // v15.0: Mettre à jour l'avatar si fourni
      if (avatarBase64) {
        existingParticipant.avatarBase64 = avatarBase64;
      }
    }
    
    __DEV__ && console.log(`📞 Received SenderKey from ${senderToken.slice(0, 8)}...: ${senderKey.keyId}`);
    __DEV__ && console.log(`📞 Total remoteSenderKeys: ${state.currentSession.remoteSenderKeys.size}`);
    
    return { success: true };
    
  } catch (error) {
    __DEV__ && console.error('Receive SenderKey error:', error);
    return { success: false, error: String(error) };
  }
}

export async function distributeMySenderKey(): Promise<CallSignal | null> {
  if (!state.currentSession?.mySenderKey || !state.currentSession.conversationId) {
    __DEV__ && console.warn('📞 Cannot distribute SenderKey: no session or key');
    return null;
  }
  
  // Ne pas distribuer si la session se termine
  if (state.currentSession.isEnding) {
    __DEV__ && console.log('📞 Session ending, not distributing SenderKey');
    return null;
  }
  
  try {
    const conversationId = state.currentSession.conversationId;
    
    // Récupérer la clé e2e pour la distribution
    let e2eKey: Uint8Array;
    let mySenderToken: string;
    
    const keys = await getConversationKeys(conversationId);
    if (keys) {
      // Conversation 1:1 avec masterKey
      e2eKey = keys.e2eKey;
      mySenderToken = await getConversationSenderToken(conversationId);
    } else {
      // No keys available — refuse to proceed with insecure fallback
      throw new Error('VoiceCall: No conversation keys available — cannot initiate secure call');
    }
    
    const distribution = prepareSenderKeyDistribution(
      state.currentSession.mySenderKey,
      e2eKey,
      'initial'  // v19.0: Correction - passer la raison, pas le token
    );
    
    // v19.0: Calculer le hash du senderToken pour permettre le mapping côté récepteur
    const myTokenHash = hashSenderToken(mySenderToken);
    
    const signal: CallSignal = {
      type: 'call-senderkey',
      callId: state.currentSession.callId,
      senderKeyDistribution: distribution,
      senderTokenHash: myTokenHash,  // v19.0: Inclure le hash pour le mapping audio
      timestamp: Date.now(),
    };
    
    __DEV__ && console.log(`📞 Distributing my SenderKey: ${state.currentSession.mySenderKey.keyId}`);
    
    return signal;
    
  } catch (error) {
    __DEV__ && console.error('Distribute sender key error:', error);
    return null;
  }
}

// ============================================
// CHIFFREMENT AUDIO
// ============================================

export function encryptOutgoingAudio(audioData: Uint8Array): { encrypted: Uint8Array; keyId: string } | null {
  if (!state.currentSession?.mySenderKey) {
    return null;
  }
  
  try {
    // CORRECTIF: Arguments dans le bon ordre (senderKey, audioData)
    const encrypted = encryptAudioPacket(state.currentSession.mySenderKey, audioData);
    return {
      encrypted: encrypted,
      keyId: state.currentSession.mySenderKey.keyId,
    };
  } catch (error) {
    __DEV__ && console.error('Encrypt audio error:', error);
    return null;
  }
}

export function decryptIncomingAudio(encryptedData: Uint8Array, senderToken: string): Uint8Array | null {
  if (!state.currentSession) {
    return null;
  }
  
  const senderKey = state.currentSession.remoteSenderKeys.get(senderToken);
  
  if (!senderKey) {
    return null;
  }
  
  try {
    // CORRECTIF: Arguments dans le bon ordre (senderKey, encryptedData)
    return decryptAudioPacket(senderKey, encryptedData);
  } catch (error) {
    __DEV__ && console.error(`📞 decryptAudioPacket error:`, error);
    return null;
  }
}

// ============================================
// CONTRÔLES
// ============================================

export function toggleMute(): boolean {
  if (state.currentSession && !state.currentSession.isEnding) {
    state.currentSession.isMuted = !state.currentSession.isMuted;
    return state.currentSession.isMuted;
  }
  return false;
}

export function toggleSpeaker(): boolean {
  if (state.currentSession && !state.currentSession.isEnding) {
    state.currentSession.isSpeakerOn = !state.currentSession.isSpeakerOn;
    return state.currentSession.isSpeakerOn;
  }
  return false;
}

export function isMuted(): boolean {
  return state.currentSession?.isMuted || false;
}

export function isSpeakerOn(): boolean {
  return state.currentSession?.isSpeakerOn || false;
}

// ============================================
// GETTERS
// ============================================

export function getCurrentSession(): CallSession | null {
  return state.currentSession;
}

export function getCurrentState(): CallState {
  return state.currentSession?.state || 'idle';
}

export function getParticipants(): CallParticipant[] {
  if (!state.currentSession) return [];
  
  const participants = Array.from(state.currentSession.participants.values());
  
  // Filtrer les doublons par senderToken (garder le plus récent)
  const seenTokens = new Map<string, CallParticipant>();
  for (const participant of participants) {
    const existing = seenTokens.get(participant.senderToken);
    if (!existing || participant.joinedAt > existing.joinedAt) {
      seenTokens.set(participant.senderToken, participant);
    }
  }
  
  return Array.from(seenTokens.values());
}

/**
 * v18.5: Retire un participant de la session par senderToken
 * Utilisé quand quelqu'un quitte via call-hangup
 */
export function removeParticipantBySenderToken(senderToken: string): boolean {
  if (!state.currentSession) return false;
  
  let removed = false;
  for (const [peerId, participant] of state.currentSession.participants) {
    if (participant.senderToken === senderToken && !participant.isCurrentUser) {
      state.currentSession.participants.delete(peerId);
      state.currentSession.remoteSenderKeys.delete(senderToken);
      state.onParticipantLeft?.(peerId);
      state.onRemoteParticipantLeft?.(senderToken);
      removed = true;
      __DEV__ && console.log(`📞 Removed participant ${senderToken.slice(0, 8)}... from voiceCall session`);
      break;
    }
  }
  
  return removed;
}

export function getCallDuration(): number {
  if (!state.currentSession?.startedAt) return 0;
  if (state.currentSession.endedAt) {
    return Math.floor((state.currentSession.endedAt - state.currentSession.startedAt) / 1000);
  }
  return Math.floor((Date.now() - state.currentSession.startedAt) / 1000);
}

export function hasSenderKeyFor(senderToken: string): boolean {
  return state.currentSession?.remoteSenderKeys.has(senderToken) || false;
}

export function getReceivedSenderKeysCount(): number {
  return state.currentSession?.remoteSenderKeys.size || 0;
}

// v14.0: Délégué à callHeartbeat
export function hasParticipantLeft(senderToken: string): boolean {
  return hasParticipantRecentlyLeft(senderToken);
}

export function isSessionEnding(): boolean {
  return state.currentSession?.isEnding || false;
}

export function hasIncomingCall(): boolean {
  return state.currentSession?.state === 'ringing' && 
         !state.currentSession.isOutgoing &&
         !state.currentSession.isEnding;
}

export function getIncomingCallInfo(): { conversationId: string; callId: string } | null {
  if (!hasIncomingCall() || !state.currentSession) return null;
  return {
    conversationId: state.currentSession.conversationId,
    callId: state.currentSession.callId,
  };
}

// ============================================
// CONFIGURATION
// ============================================

export function setCallEventHandlers(handlers: {
  onStateChange?: (state: CallState) => void;
  onParticipantJoined?: (participant: CallParticipant) => void;
  onParticipantLeft?: (peerId: string) => void;
  onRemoteParticipantLeft?: OnParticipantLeftCallback;
  onAudioReceived?: (peerId: string, audioData: Uint8Array) => void;
  onError?: (error: Error) => void;
  onRotationSignal?: OnRotationSignalCallback;
  onIncomingCall?: (conversationId: string, callId: string, callerToken: string) => void;
}): void {
  if (handlers.onStateChange) state.onStateChange = handlers.onStateChange;
  if (handlers.onParticipantJoined) state.onParticipantJoined = handlers.onParticipantJoined;
  if (handlers.onParticipantLeft) state.onParticipantLeft = handlers.onParticipantLeft;
  if (handlers.onRemoteParticipantLeft) state.onRemoteParticipantLeft = handlers.onRemoteParticipantLeft;
  if (handlers.onAudioReceived) state.onAudioReceived = handlers.onAudioReceived;
  if (handlers.onError) state.onError = handlers.onError;
  if (handlers.onRotationSignal) state.onRotationSignal = handlers.onRotationSignal;
  if (handlers.onIncomingCall) state.onIncomingCall = handlers.onIncomingCall;
}

export function setCallConfig(config: Partial<CallConfig>): void {
  state.config = { ...state.config, ...config };
}

// ============================================
// NETTOYAGE
// ============================================

export function cleanupCallService(): void {
  if (state.currentSession && !state.currentSession.isEnding) {
    endCallSession('error');
  }
  
  clearRingTimeout();
  stopKeyRotationTimer();
  
  state.currentSession = null;
  state.onStateChange = null;
  state.onParticipantJoined = null;
  state.onParticipantLeft = null;
  state.onRemoteParticipantLeft = null;
  state.onAudioReceived = null;
  state.onError = null;
  state.onRotationSignal = null;
  state.onIncomingCall = null;
  
  cleanupProcessedCallIds();
  
  // v15.0: Nettoyer le tracking des séquences
  cleanupSequenceTracking();
  
  __DEV__ && console.log('📞 Call service cleaned up');
}

export async function resetCallService(): Promise<void> {
  cleanupCallService();
  
  processedCallIdsMap.clear();
  state.pendingSenderKeys.clear();
  
  // v15.0: Réinitialiser le compteur de séquence
  resetSequenceCounter();
  
  __DEV__ && console.log('📞 Call service reset');
}

export async function initializeCallService(): Promise<void> {
  cleanupProcessedCallIds();
  // v15.0: Nettoyer le tracking des séquences au démarrage
  cleanupSequenceTracking();
  __DEV__ && console.log('📞 Call service initialized');
}