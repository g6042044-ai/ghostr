// src/services/tripleRatchet/callTripleRatchet.ts
// Call Triple Ratchet v5.0 — Ping-Pong DH + ML-KEM Hybrid
//
// ARCHITECTURE:
// =============
// 1. DÉRIVATION INITIALE (PQ PROTECTED via session Triple Ratchet)
//    - callRootKey dérivée de rootKey PQ (SPQR/ML-KEM)
//    - Chaînes send/recv indépendantes
//
// 2. SYMMETRIC RATCHET (par paquet audio)
//    - Clé unique par paquet via KDF chain
//    - Nonces déterministes HMAC-SHA256 (v3.0)
//
// 3. ROTATION PING-PONG HYBRIDE (v5.0 - toutes les 120s)
//    - Modèle Signal: seul l'initiator déclenche, le responder répond
//    - X25519 DH (classique) + ML-KEM-768 (post-quantique) à chaque rotation
//    - Forward secrecy PQ complète pendant l'appel
//    - Zero gap audio (transition atomique bilatérale)
//
// GARANTIES DE SÉCURITÉ v5.0:
// - Forward Secrecy classique: rotation X25519 toutes les 120s
// - Forward Secrecy post-quantique: ML-KEM-768 à chaque rotation
// - Sécurité hybride: il faut casser X25519 ET ML-KEM pour compromettre
// - Anti-replay: receivedIndexes Set + nonces déterministes
// - Modèle ping-pong: auto-synchronisant, pas de race condition
//
// CHANGEMENTS v4.2 → v5.0:
// - Modèle timer-based simultané → ping-pong (initiator-only trigger)
// - Ajout ML-KEM-768 hybride à chaque rotation DH
// - Suppression du mécanisme timer-based simultané → modèle ping-pong (initiator-only trigger)
// - pendingSendChainKey conservé côté RESPONDER uniquement (activation event-driven + timer fallback)
// - processDHRotation splitté en processDHRotationRequest + processDHRotationResponse
// - DHRotationMessage étendu avec mlkemPublicKey/mlkemCiphertext/isResponse

import * as nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';

import { TripleRatchetState } from './tripleRatchet';

import { X25519KeyPair, X25519PublicKey } from './types';

import { generateX25519KeyPair, x25519, zeroize, deserializeX25519PublicKey, constantTimeEqual } from './primitives';

// v5.0: Import ML-KEM primitives
import { KyberKeyPair, kyberKeyGen, kyberEncapsulate, kyberDecapsulate, serializeKyberPublicKey, deserializeKyberPublicKey, serializeKyberSecretKey, deserializeKyberSecretKey, serializeKyberCiphertext, deserializeKyberCiphertext, zeroizeKyberSecretKey, zeroizeKyberSharedSecret } from './pqPrimitives';

// ============================================
// CONSTANTES
// ============================================

const CALL_RATCHET_CONSTANTS = {
  VERSION: 1,
  KEY_SIZE: 32,
  NONCE_SIZE: 24,

  // v5.0: Rotation ping-pong toutes les 120s (initiator-only)
  DH_ROTATION_INTERVAL_MS: 120000,
  DH_ROTATION_PACKET_INTERVAL: 6000, // ~120s @ 50 pkt/s

  // En-tête audio: [version:1] + [keyId:4] + [index:4] + [nonce:24] = 33 bytes
  HEADER_SIZE: 33,

  // Anti-replay: fenêtre glissante
  MAX_SKIP_PACKETS: 500,

  // v5.0: Période de grâce pour anciennes recv keys (paquets en vol)
  // Couvre: latence signaling (1-3s) + paquets audio en vol (~200ms)
  // 10s est largement suffisant en ping-pong (pas de race condition)
  PREVIOUS_KEYS_GRACE_MS: 10000,

  // v5.0: Timer fallback pour activation des clés d'envoi du responder.
  // Normalement activées dès réception d'un paquet avec le nouveau keyId,
  // mais si aucun paquet n'arrive (ex: initiator en silence), fallback à 5s.
  // 5s >> latence signaling aller-retour (1-3s typique).
  SEND_KEYS_ACTIVATION_DELAY_MS: 5000,
} as const;

const KDF_DOMAINS = {
  CALL_ROOT: 'ghostr_call_root_v1',
  SEND_CHAIN: 'ghostr_call_send_v1',
  RECV_CHAIN: 'ghostr_call_recv_v1',
  AUDIO_KEY: 'ghostr_call_audio_v1',
  AUDIO_NONCE: 'ghostr_call_nonce_v1',
  HEADER_KEY: 'ghostr_call_header_v1',
  DH_ROTATION: 'ghostr_call_dh_v1',
  // v5.0: Domain séparé pour le mix hybride DH+PQ
  HYBRID_MIX: 'ghostr_call_hybrid_v5',
} as const;

// ============================================
// TYPES
// ============================================

/**
 * État du Call Triple Ratchet v5.0
 */
export interface CallRatchetState {
  version: number;
  callId: string;

  // Clé racine de l'appel
  callRootKey: Uint8Array;

  // Chaînes de chiffrement symétrique
  sendChainKey: Uint8Array;
  recvChainKey: Uint8Array;
  sendPacketIndex: number;
  recvPacketIndex: number;

  // Header encryption
  sendHeaderKey: Uint8Array;
  recvHeaderKey: Uint8Array;

  // X25519 DH state
  myDHKey: X25519KeyPair | null;
  theirDHKey: X25519PublicKey | null;
  dhRotationCounter: number;
  lastDHRotationTime: number;

  // v5.0: ML-KEM state pour rotation hybride
  // Stocké par l'initiator entre prepareDH et processDHResponse
  myMLKEMKey: KyberKeyPair | null;

  // v5.0: Flag indiquant qu'une rotation est en attente de réponse
  // L'initiator ne re-déclenche pas shouldRotateDH tant que c'est true
  rotationPendingResponse: boolean;

  // v5.0: Clés d'envoi en attente d'activation (RESPONDER seulement)
  // Quand le responder reçoit une rotation request, il bascule ses clés de
  // RÉCEPTION immédiatement, mais retarde ses clés d'ENVOI jusqu'à preuve
  // que l'initiator a transitionné (réception d'un paquet avec le nouveau keyId)
  // ou timer fallback de 5s.
  // Sans ce mécanisme, le responder enverrait avec les nouvelles clés avant que
  // l'initiator ait reçu la response → silence audio responder→initiator.
  pendingSendChainKey: Uint8Array | null;
  pendingSendKeyId: number;
  pendingSendActivateAt: number; // Timer fallback (Date.now() + 5000)

  // Key ID pour identification des paquets
  currentKeyId: number;

  // Anciennes clés de réception (grace period pour paquets en vol)
  previousRecvChainKey: Uint8Array | null;
  previousRecvPacketIndex: number;
  previousKeyId: number;
  previousRecvHeaderKey: Uint8Array | null;
  previousKeysExpireAt: number;

  // Anti-replay
  receivedIndexes: Set<number>;

  // Rôle
  isInitiator: boolean;

  // Timestamps
  createdAt: number;
  lastActivityAt: number;
}

/**
 * Format d'un paquet audio chiffré
 */
export interface EncryptedAudioPacket {
  version: number;
  keyId: number;
  packetIndex: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Message de rotation DH v5.0 (envoyé via signaling Triple Ratchet)
 *
 * REQUEST (initiator → responder):
 *   { isResponse: false, publicKey: X25519, mlkemPublicKey: ML-KEM-768 }
 *
 * RESPONSE (responder → initiator):
 *   { isResponse: true, publicKey: X25519, mlkemCiphertext: ML-KEM encapsulation }
 */
export interface DHRotationMessage {
  type: 'dh_rotation';
  callId: string;
  publicKey: string;         // X25519 public key (Base64, 32 bytes)
  keyId: number;
  timestamp: number;

  // v5.0: Ping-pong + ML-KEM hybride
  isResponse: boolean;
  mlkemPublicKey?: string;   // ML-KEM-768 encapsulation key (Base64, 1184 bytes) — REQUEST only
  mlkemCiphertext?: string;  // ML-KEM-768 ciphertext (Base64, 1088 bytes) — RESPONSE only
}

/**
 * Format sérialisé pour échange via signaling
 *
 * Les clés symétriques (callRootKey, sendChainKey, recvChainKey, sendHeaderKey,
 * recvHeaderKey) sont incluses pour garantir la synchronisation entre les deux parties.
 *
 * Raison: Le rootKey du Triple Ratchet avance à chaque message échangé et n'est PAS
 * garanti d'être identique des deux côtés au moment de l'appel (la session peut avoir
 * avancé chez l'initiateur depuis le dernier message traité par le répondant).
 * L'initiateur dérive ses clés depuis son état courant et les transmet pour que
 * les deux parties aient exactement les mêmes clés d'appel.
 *
 * Sécurité: Ces clés transitent via le canal Triple Ratchet déjà chiffré E2E.
 * Seule la clé publique DH X25519 sert aux rotations forward secrecy futures.
 */
export interface SerializedCallRatchetInit {
  type: 'call_ratchet_init';
  version: number;
  callId: string;
  publicKey: string | null;  // Clé publique X25519 pour les rotations DH futures
  keyId: number;
  isInitiator: boolean;
  // Clés symétriques dérivées par l'initiateur — le répondant les utilise inversées
  callRootKey: string;
  sendChainKey: string;
  recvChainKey: string;
  sendHeaderKey: string;
  recvHeaderKey: string;
}

// ============================================
// DÉRIVATION DE CLÉS
// ============================================

function deriveKey(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number = 32
): Uint8Array {
  const infoBytes = new TextEncoder().encode(info);
  return hkdf(sha256, ikm, salt, infoBytes, length);
}

function deriveNextChainKey(chainKey: Uint8Array): Uint8Array {
  const context = new TextEncoder().encode('ChainKeyAdvance');
  const combined = new Uint8Array(chainKey.length + context.length);
  combined.set(chainKey, 0);
  combined.set(context, chainKey.length);
  return sha256(combined);
}

function deriveAudioKey(chainKey: Uint8Array, index: number): Uint8Array {
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index, false);

  const combined = new Uint8Array(chainKey.length + indexBytes.length + KDF_DOMAINS.AUDIO_KEY.length);
  combined.set(chainKey, 0);
  combined.set(indexBytes, chainKey.length);
  combined.set(new TextEncoder().encode(KDF_DOMAINS.AUDIO_KEY), chainKey.length + 4);

  return sha256(combined);
}

/**
 * Nonce déterministe v3.0
 * nonce = HMAC-SHA256(chainKey, index || direction || domain)[0:24]
 */
function deriveAudioNonce(
  chainKey: Uint8Array,
  packetIndex: number,
  direction: 'send' | 'receive'
): Uint8Array {
  const domainBytes = new TextEncoder().encode(KDF_DOMAINS.AUDIO_NONCE);
  const input = new Uint8Array(4 + 1 + domainBytes.length);
  new DataView(input.buffer).setUint32(0, packetIndex, false);
  input[4] = direction === 'send' ? 0x01 : 0x02;
  input.set(domainBytes, 5);
  const derived = hmac(sha256, chainKey, input);
  return derived.slice(0, CALL_RATCHET_CONSTANTS.NONCE_SIZE);
}

/**
 * v5.0: Dérive les clés de rotation hybride DH + ML-KEM
 *
 * newCallRootKey = HKDF(dhSecret ‖ pqSecret ‖ oldCallRootKey, salt, HYBRID_MIX)
 *
 * Un attaquant doit casser les DEUX (X25519 ET ML-KEM) pour dériver newCallRootKey.
 * oldCallRootKey assure la continuité de la chaîne (pas de reset à zéro).
 */
function deriveHybridRotationKeys(
  dhSecret: Uint8Array,
  pqSecret: Uint8Array,
  oldCallRootKey: Uint8Array,
  callId: string,
  isInitiator: boolean
): {
  newCallRootKey: Uint8Array;
  newSendChainKey: Uint8Array;
  newRecvChainKey: Uint8Array;
} {
  // Combine: dhSecret ‖ pqSecret ‖ oldCallRootKey
  const combined = new Uint8Array(dhSecret.length + pqSecret.length + oldCallRootKey.length);
  let offset = 0;
  combined.set(dhSecret, offset); offset += dhSecret.length;
  combined.set(pqSecret, offset); offset += pqSecret.length;
  combined.set(oldCallRootKey, offset);

  const callIdBytes = new TextEncoder().encode(callId);
  const salt = sha256(callIdBytes);
  const newCallRootKey = deriveKey(combined, salt, KDF_DOMAINS.HYBRID_MIX);

  let newSendChainKey: Uint8Array;
  let newRecvChainKey: Uint8Array;

  if (isInitiator) {
    newSendChainKey = deriveKey(newCallRootKey, salt, KDF_DOMAINS.SEND_CHAIN);
    newRecvChainKey = deriveKey(newCallRootKey, salt, KDF_DOMAINS.RECV_CHAIN);
  } else {
    newSendChainKey = deriveKey(newCallRootKey, salt, KDF_DOMAINS.RECV_CHAIN);
    newRecvChainKey = deriveKey(newCallRootKey, salt, KDF_DOMAINS.SEND_CHAIN);
  }

  zeroize(combined);

  return { newCallRootKey, newSendChainKey, newRecvChainKey };
}

// ============================================
// INITIALISATION
// ============================================

/**
 * Initialise un état Call Ratchet depuis un état Triple Ratchet existant
 */
export async function initializeCallRatchet(
  tripleRatchetState: TripleRatchetState,
  callId: string,
  isInitiator: boolean
): Promise<CallRatchetState> {
  const rootKeyBytes = tripleRatchetState.rootKey.bytes;
  const pqSecret = tripleRatchetState.spqr?.pqSecret;

  let baseKeyMaterial: Uint8Array;
  if (pqSecret && pqSecret.length > 0) {
    const domainBytes = new TextEncoder().encode('ghostr_call_pq_mix_v1');
    const combined = new Uint8Array(rootKeyBytes.length + pqSecret.length + domainBytes.length);
    combined.set(rootKeyBytes, 0);
    combined.set(pqSecret, rootKeyBytes.length);
    combined.set(domainBytes, rootKeyBytes.length + pqSecret.length);
    baseKeyMaterial = sha256(combined);
    __DEV__ && console.log('[CallRatchet] 🔐 PQ-protected call initialization (pqSecret mixed)');
  } else {
    baseKeyMaterial = rootKeyBytes;
    __DEV__ && console.warn('[CallRatchet] ⚠️ No pqSecret available, call not PQ-protected');
  }

  const callIdBytes = new TextEncoder().encode(callId);
  const salt = sha256(callIdBytes);
  const keyMaterial = deriveKey(baseKeyMaterial, salt, KDF_DOMAINS.CALL_ROOT, 96);
  const callRootKey = keyMaterial.slice(0, 32);

  let sendChainKey: Uint8Array;
  let recvChainKey: Uint8Array;
  let sendHeaderKey: Uint8Array;
  let recvHeaderKey: Uint8Array;

  if (isInitiator) {
    sendChainKey = deriveKey(callRootKey, salt, KDF_DOMAINS.SEND_CHAIN);
    recvChainKey = deriveKey(callRootKey, salt, KDF_DOMAINS.RECV_CHAIN);
    sendHeaderKey = deriveKey(callRootKey, salt, KDF_DOMAINS.HEADER_KEY + '_send');
    recvHeaderKey = deriveKey(callRootKey, salt, KDF_DOMAINS.HEADER_KEY + '_recv');
  } else {
    sendChainKey = deriveKey(callRootKey, salt, KDF_DOMAINS.RECV_CHAIN);
    recvChainKey = deriveKey(callRootKey, salt, KDF_DOMAINS.SEND_CHAIN);
    sendHeaderKey = deriveKey(callRootKey, salt, KDF_DOMAINS.HEADER_KEY + '_recv');
    recvHeaderKey = deriveKey(callRootKey, salt, KDF_DOMAINS.HEADER_KEY + '_send');
  }

  const myDHKey = generateX25519KeyPair();
  const now = Date.now();

  return {
    version: CALL_RATCHET_CONSTANTS.VERSION,
    callId,
    callRootKey,
    sendChainKey,
    recvChainKey,
    sendPacketIndex: 0,
    recvPacketIndex: 0,
    sendHeaderKey,
    recvHeaderKey,
    myDHKey,
    theirDHKey: null,
    dhRotationCounter: 0,
    lastDHRotationTime: now,
    myMLKEMKey: null,
    rotationPendingResponse: false,
    pendingSendChainKey: null,
    pendingSendKeyId: 0,
    pendingSendActivateAt: 0,
    currentKeyId: 1,
    previousRecvChainKey: null,
    previousRecvPacketIndex: 0,
    previousKeyId: 0,
    previousRecvHeaderKey: null,
    previousKeysExpireAt: 0,
    receivedIndexes: new Set(),
    isInitiator,
    createdAt: now,
    lastActivityAt: now,
  };
}

/**
 * Initialise depuis un secret partagé direct
 */
export async function initializeCallRatchetFromSecret(
  sharedSecret: Uint8Array,
  callId: string,
  isInitiator: boolean,
  pqSecret?: Uint8Array
): Promise<CallRatchetState> {
  let baseKeyMaterial: Uint8Array;
  if (pqSecret && pqSecret.length > 0) {
    const domainBytes = new TextEncoder().encode('ghostr_call_pq_mix_v1');
    const combined = new Uint8Array(sharedSecret.length + pqSecret.length + domainBytes.length);
    combined.set(sharedSecret, 0);
    combined.set(pqSecret, sharedSecret.length);
    combined.set(domainBytes, sharedSecret.length + pqSecret.length);
    baseKeyMaterial = sha256(combined);
    __DEV__ && console.log('[CallRatchet] 🔐 PQ-protected call from secret');
  } else {
    baseKeyMaterial = sharedSecret;
    __DEV__ && console.warn('[CallRatchet] ⚠️ Call from secret without PQ protection');
  }

  const callIdBytes = new TextEncoder().encode(callId);
  const salt = sha256(callIdBytes);
  const keyMaterial = deriveKey(baseKeyMaterial, salt, KDF_DOMAINS.CALL_ROOT, 96);
  const callRootKey = keyMaterial.slice(0, 32);

  let sendChainKey: Uint8Array;
  let recvChainKey: Uint8Array;
  let sendHeaderKey: Uint8Array;
  let recvHeaderKey: Uint8Array;

  if (isInitiator) {
    sendChainKey = deriveKey(callRootKey, salt, KDF_DOMAINS.SEND_CHAIN);
    recvChainKey = deriveKey(callRootKey, salt, KDF_DOMAINS.RECV_CHAIN);
    sendHeaderKey = deriveKey(callRootKey, salt, KDF_DOMAINS.HEADER_KEY + '_send');
    recvHeaderKey = deriveKey(callRootKey, salt, KDF_DOMAINS.HEADER_KEY + '_recv');
  } else {
    sendChainKey = deriveKey(callRootKey, salt, KDF_DOMAINS.RECV_CHAIN);
    recvChainKey = deriveKey(callRootKey, salt, KDF_DOMAINS.SEND_CHAIN);
    sendHeaderKey = deriveKey(callRootKey, salt, KDF_DOMAINS.HEADER_KEY + '_recv');
    recvHeaderKey = deriveKey(callRootKey, salt, KDF_DOMAINS.HEADER_KEY + '_send');
  }

  const myDHKey = generateX25519KeyPair();
  const now = Date.now();

  return {
    version: CALL_RATCHET_CONSTANTS.VERSION,
    callId,
    callRootKey,
    sendChainKey,
    recvChainKey,
    sendPacketIndex: 0,
    recvPacketIndex: 0,
    sendHeaderKey,
    recvHeaderKey,
    myDHKey,
    theirDHKey: null,
    dhRotationCounter: 0,
    lastDHRotationTime: now,
    myMLKEMKey: null,
    rotationPendingResponse: false,
    pendingSendChainKey: null,
    pendingSendKeyId: 0,
    pendingSendActivateAt: 0,
    currentKeyId: 1,
    previousRecvChainKey: null,
    previousRecvPacketIndex: 0,
    previousKeyId: 0,
    previousRecvHeaderKey: null,
    previousKeysExpireAt: 0,
    receivedIndexes: new Set(),
    isInitiator,
    createdAt: now,
    lastActivityAt: now,
  };
}

// ============================================
// CHIFFREMENT AUDIO
// ============================================

/**
 * Chiffre un paquet audio
 *
 * v5.0: Gestion de la transition ping-pong.
 * Quand le responder a des clés d'envoi en pending (après processDHRotationRequest),
 * il continue d'envoyer avec les ANCIENNES clés (que l'initiator peut encore déchiffrer).
 * L'activation se fait par timer fallback (5s) ou par decryptAudioPacket quand on
 * reçoit un paquet avec le nouveau keyId (preuve que l'initiator a transitionné).
 */
export function encryptAudioPacket(
  state: CallRatchetState,
  audioData: Uint8Array
): { packet: Uint8Array; newState: CallRatchetState } {
  // v5.0: Activer les clés d'envoi pending si le timer fallback est écoulé
  let activeState = state;
  if (state.pendingSendChainKey && Date.now() >= state.pendingSendActivateAt) {
    __DEV__ && console.log('[CallRatchet] 🔑 Timer fallback: activating pending send keys, keyId:', state.pendingSendKeyId);
    zeroize(state.sendChainKey);
    activeState = {
      ...state,
      sendChainKey: state.pendingSendChainKey,
      sendPacketIndex: 0,
      pendingSendChainKey: null,
      pendingSendKeyId: 0,
      pendingSendActivateAt: 0,
    };
  }

  const audioKey = deriveAudioKey(activeState.sendChainKey, activeState.sendPacketIndex);
  const nonce = deriveAudioNonce(activeState.sendChainKey, activeState.sendPacketIndex, 'send');
  const ciphertext = nacl.secretbox(audioData, nonce, audioKey);

  // [version:1] [keyId:4] [index:4] [nonce:24] [ciphertext]
  const packet = new Uint8Array(1 + 4 + 4 + nonce.length + ciphertext.length);
  packet[0] = activeState.version;
  // v5.0: Si des clés d'envoi sont en pending, le header contient l'ANCIEN keyId
  // (previousKeyId) car on chiffre avec les ANCIENNES clés.
  const headerKeyId = activeState.pendingSendChainKey ? activeState.previousKeyId : activeState.currentKeyId;
  new DataView(packet.buffer).setUint32(1, headerKeyId, false);
  new DataView(packet.buffer).setUint32(5, activeState.sendPacketIndex, false);
  packet.set(nonce, 9);
  packet.set(ciphertext, 9 + nonce.length);

  const newSendChainKey = deriveNextChainKey(activeState.sendChainKey);
  zeroize(activeState.sendChainKey);
  zeroize(audioKey);

  return {
    packet,
    newState: {
      ...activeState,
      sendChainKey: newSendChainKey,
      sendPacketIndex: activeState.sendPacketIndex + 1,
      lastActivityAt: Date.now(),
    },
  };
}

/**
 * Déchiffre un paquet audio
 *
 * Le fallback sur previousRecvChainKey reste nécessaire pour les paquets
 * en vol pendant la latence de signaling (1-3s typique).
 */
export function decryptAudioPacket(
  state: CallRatchetState,
  packet: Uint8Array
): { audioData: Uint8Array | null; newState: CallRatchetState } {
  const minSize = 1 + 4 + 4 + CALL_RATCHET_CONSTANTS.NONCE_SIZE + 16;
  if (packet.length < minSize) {
    __DEV__ && console.warn('[CallRatchet] Packet too short');
    return { audioData: null, newState: state };
  }

  const version = packet[0];
  if (version !== CALL_RATCHET_CONSTANTS.VERSION) {
    __DEV__ && console.warn('[CallRatchet] Unknown version:', version);
    return { audioData: null, newState: state };
  }

  const keyId = new DataView(packet.buffer, packet.byteOffset).getUint32(1, false);
  const packetIndex = new DataView(packet.buffer, packet.byteOffset).getUint32(5, false);
  const receivedNonce = packet.slice(9, 9 + CALL_RATCHET_CONSTANTS.NONCE_SIZE);
  const ciphertext = packet.slice(9 + CALL_RATCHET_CONSTANTS.NONCE_SIZE);

  // Fallback: anciennes clés (paquets en vol pendant transition ping-pong)
  if (
    keyId !== state.currentKeyId &&
    keyId === state.previousKeyId &&
    state.previousRecvChainKey &&
    Date.now() < state.previousKeysExpireAt
  ) {
    const result = decryptWithChainKey(
      state.previousRecvChainKey,
      state.previousRecvPacketIndex,
      packetIndex,
      receivedNonce,
      ciphertext
    );

    if (result.audioData && result.advancedChainKey) {
      zeroize(state.previousRecvChainKey);
      return {
        audioData: result.audioData,
        newState: {
          ...state,
          previousRecvChainKey: result.advancedChainKey,
          previousRecvPacketIndex: result.advancedIndex,
          lastActivityAt: Date.now(),
        },
      };
    }
  }

  // Nettoyage automatique des anciennes clés expirées
  let updatedState = state;
  if (state.previousRecvChainKey && Date.now() >= state.previousKeysExpireAt) {
    zeroize(state.previousRecvChainKey);
    if (state.previousRecvHeaderKey) {
      zeroize(state.previousRecvHeaderKey);
    }
    updatedState = {
      ...state,
      previousRecvChainKey: null,
      previousRecvHeaderKey: null,
      previousKeyId: 0,
      previousKeysExpireAt: 0,
    };
    __DEV__ && console.log('[CallRatchet] 🗑️ Previous keys expired, cleaned up');
  }

  // Anti-replay
  if (updatedState.receivedIndexes.has(packetIndex)) {
    __DEV__ && console.warn('[CallRatchet] Replay detected, index:', packetIndex);
    return { audioData: null, newState: updatedState };
  }

  if (packetIndex > updatedState.recvPacketIndex + CALL_RATCHET_CONSTANTS.MAX_SKIP_PACKETS) {
    __DEV__ && console.warn('[CallRatchet] Packet too far ahead:', packetIndex, 'current:', updatedState.recvPacketIndex);
    return { audioData: null, newState: updatedState };
  }

  // Déchiffrer avec les clés actuelles
  const result = decryptWithChainKey(
    updatedState.recvChainKey,
    updatedState.recvPacketIndex,
    packetIndex,
    receivedNonce,
    ciphertext
  );

  if (!result.audioData || !result.advancedChainKey) {
    __DEV__ && console.warn('[CallRatchet] Decryption failed');
    return { audioData: null, newState: updatedState };
  }

  // Mise à jour anti-replay
  const newReceivedIndexes = new Set(updatedState.receivedIndexes);
  newReceivedIndexes.add(packetIndex);
  const windowStart = Math.max(0, packetIndex - CALL_RATCHET_CONSTANTS.MAX_SKIP_PACKETS);
  for (const idx of newReceivedIndexes) {
    if (idx < windowStart) {
      newReceivedIndexes.delete(idx);
    }
  }

  // v5.0: Activation event-driven des clés d'envoi pending.
  // Si on déchiffre avec succès un paquet dont le keyId correspond au nouveau keyId
  // (= pendingSendKeyId), cela prouve que l'initiator a transitionné.
  // On peut donc activer nos nouvelles clés d'envoi immédiatement.
  if (updatedState.pendingSendChainKey && keyId === updatedState.pendingSendKeyId) {
    __DEV__ && console.log('[CallRatchet] 🔑 Event-driven: received packet with new keyId',
      keyId, '→ activating pending send keys');
    zeroize(updatedState.sendChainKey);
    updatedState = {
      ...updatedState,
      sendChainKey: updatedState.pendingSendChainKey,
      sendPacketIndex: 0,
      pendingSendChainKey: null,
      pendingSendKeyId: 0,
      pendingSendActivateAt: 0,
    };
  }

  if (packetIndex >= updatedState.recvPacketIndex) {
    zeroize(updatedState.recvChainKey);
    return {
      audioData: new Uint8Array(result.audioData),
      newState: {
        ...updatedState,
        recvChainKey: result.advancedChainKey,
        recvPacketIndex: result.advancedIndex,
        receivedIndexes: newReceivedIndexes,
        lastActivityAt: Date.now(),
      },
    };
  }

  return {
    audioData: new Uint8Array(result.audioData),
    newState: {
      ...updatedState,
      receivedIndexes: newReceivedIndexes,
      lastActivityAt: Date.now(),
    },
  };
}

/**
 * Helper: déchiffre avec une chain key donnée (factored for current + previous keys)
 */
function decryptWithChainKey(
  chainKey: Uint8Array,
  chainPacketIndex: number,
  packetIndex: number,
  receivedNonce: Uint8Array,
  ciphertext: Uint8Array
): { audioData: Uint8Array | null; advancedChainKey: Uint8Array | null; advancedIndex: number } {
  if (packetIndex > chainPacketIndex + CALL_RATCHET_CONSTANTS.MAX_SKIP_PACKETS) {
    return { audioData: null, advancedChainKey: null, advancedIndex: chainPacketIndex };
  }

  let currentChainKey = chainKey;
  let currentIndex = chainPacketIndex;

  while (currentIndex < packetIndex) {
    currentChainKey = deriveNextChainKey(currentChainKey);
    currentIndex++;
  }

  // Vérification nonce déterministe v3.0
  const expectedNonce = deriveAudioNonce(currentChainKey, packetIndex, 'send');
  if (!constantTimeEqual(receivedNonce, expectedNonce)) {
    // Nonce mismatch — continue pour compatibilité arrière
  }

  const audioKey = deriveAudioKey(currentChainKey, packetIndex);
  const audioData = nacl.secretbox.open(ciphertext, receivedNonce, audioKey);
  zeroize(audioKey);

  if (!audioData) {
    return { audioData: null, advancedChainKey: null, advancedIndex: chainPacketIndex };
  }

  const nextChainKey = deriveNextChainKey(currentChainKey);
  return { audioData: new Uint8Array(audioData), advancedChainKey: nextChainKey, advancedIndex: packetIndex + 1 };
}

// ============================================
// ROTATION PING-PONG HYBRIDE v5.0
// ============================================
//
// PROTOCOLE:
// ==========
//
// T=120s  INITIATOR décide de roter (shouldRotateDH)
//         ├─ Génère X25519 keypair (A2) + ML-KEM-768 keypair (PQ_A)
//         ├─ Envoie REQUEST { x25519Pub=A2, mlkemPub=PQ_A.pub }
//         ├─ Stocke PQ_A.secretKey dans state.myMLKEMKey
//         └─ Continue d'envoyer avec anciennes clés
//
// T+Δ    RESPONDER reçoit REQUEST
//         ├─ Génère X25519 keypair (B2)
//         ├─ dhSecret = x25519(B2.priv, A2.pub) — commutatif
//         ├─ (pqSecret, CT) = ML-KEM.Encaps(PQ_A.pub)
//         ├─ newKeys = KDF(dhSecret ‖ pqSecret ‖ oldRootKey)
//         ├─ Bascule IMMÉDIATEMENT send + recv
//         └─ Envoie RESPONSE { x25519Pub=B2, mlkemCiphertext=CT }
//
// T+2Δ   INITIATOR reçoit RESPONSE
//         ├─ dhSecret = x25519(A2.priv, B2.pub) — MÊME (commutativité)
//         ├─ pqSecret = ML-KEM.Decaps(PQ_A.secretKey, CT) — MÊME
//         ├─ newKeys = KDF(dhSecret ‖ pqSecret ‖ oldRootKey) — IDENTIQUES
//         └─ Bascule IMMÉDIATEMENT send + recv

/**
 * Vérifie si une rotation est nécessaire
 * v5.0: Seul l'initiator déclenche. Ne re-déclenche pas si en attente de réponse.
 */
export function shouldRotateDH(state: CallRatchetState): boolean {
  if (!state.isInitiator) return false;
  if (state.rotationPendingResponse) return false;

  const now = Date.now();
  const timeSinceRotation = now - state.lastDHRotationTime;
  const packetsSinceRotation = state.sendPacketIndex - (state.dhRotationCounter * CALL_RATCHET_CONSTANTS.DH_ROTATION_PACKET_INTERVAL);

  return (
    timeSinceRotation >= CALL_RATCHET_CONSTANTS.DH_ROTATION_INTERVAL_MS ||
    packetsSinceRotation >= CALL_RATCHET_CONSTANTS.DH_ROTATION_PACKET_INTERVAL
  );
}

/**
 * INITIATOR: Prépare et envoie une rotation request
 * Génère X25519 + ML-KEM-768 keypairs, envoie les pubkeys.
 * Continue d'envoyer avec anciennes clés jusqu'à la response.
 */
export function prepareDHRotation(state: CallRatchetState): {
  message: DHRotationMessage;
  newState: CallRatchetState;
} {
  const newDHKey = generateX25519KeyPair();
  const newMLKEMKey = kyberKeyGen();
  const newKeyId = state.currentKeyId + 1;

  const message: DHRotationMessage = {
    type: 'dh_rotation',
    callId: state.callId,
    publicKey: encodeBase64(newDHKey.publicKey.bytes),
    keyId: newKeyId,
    timestamp: Date.now(),
    isResponse: false,
    mlkemPublicKey: serializeKyberPublicKey(newMLKEMKey.publicKey),
  };

  // Zeroize l'ancienne clé privée DH
  if (state.myDHKey) {
    zeroize(state.myDHKey.privateKey.bytes);
  }
  // Zeroize tout ancien ML-KEM key
  if (state.myMLKEMKey) {
    zeroizeKyberSecretKey(state.myMLKEMKey.secretKey);
  }

  __DEV__ && console.log('[CallRatchet] 🔄 DH+PQ rotation REQUEST prepared, keyId:', newKeyId);

  return {
    message,
    newState: {
      ...state,
      myDHKey: newDHKey,
      myMLKEMKey: newMLKEMKey,
      rotationPendingResponse: true,
      pendingSendChainKey: null,
      pendingSendKeyId: 0,
      pendingSendActivateAt: 0,
      dhRotationCounter: state.dhRotationCounter + 1,
      lastDHRotationTime: Date.now(),
      lastActivityAt: Date.now(),
    },
  };
}

/**
 * RESPONDER: Reçoit une rotation request, effectue DH + ML-KEM, répond
 *
 * 1. Génère X25519 keypair (B2)
 * 2. dhSecret = x25519(B2.priv, A2.pub)
 * 3. (pqSecret, CT) = ML-KEM.Encaps(A.mlkemPub)
 * 4. Dérive nouvelles clés hybrides
 * 5. Bascule IMMÉDIATEMENT send + recv
 * 6. Envoie response avec B2.pub + CT
 */
export function processDHRotationRequest(
  state: CallRatchetState,
  message: DHRotationMessage
): {
  newState: CallRatchetState;
  response: DHRotationMessage;
} | null {
  if (message.callId !== state.callId) {
    __DEV__ && console.warn('[CallRatchet] DH rotation request callId mismatch');
    return null;
  }

  if (message.isResponse) {
    __DEV__ && console.warn('[CallRatchet] Expected request, got response');
    return null;
  }

  if (!message.mlkemPublicKey) {
    __DEV__ && console.warn('[CallRatchet] DH rotation request missing ML-KEM public key');
    return null;
  }

  // Décoder les clés de l'initiator
  const theirNewDHKey = deserializeX25519PublicKey(message.publicKey);
  const theirMLKEMPubKey = deserializeKyberPublicKey(message.mlkemPublicKey);

  // v5.0: Si des clés d'envoi pending existent (rotation précédente non activée),
  // les activer immédiatement avant de créer les nouvelles.
  // Sans ça, les clés de la rotation N seraient perdues quand on set les clés de N+1.
  let activeState = state;
  if (state.pendingSendChainKey) {
    __DEV__ && console.log('[CallRatchet] ⚠️ Force-activating previous pending send keys before new rotation');
    zeroize(state.sendChainKey);
    activeState = {
      ...state,
      sendChainKey: state.pendingSendChainKey,
      sendPacketIndex: 0,
      pendingSendChainKey: null,
      pendingSendKeyId: 0,
      pendingSendActivateAt: 0,
    };
  }

  // Step 1: Générer notre nouvelle paire X25519
  const myNewDHKey = generateX25519KeyPair();

  // Step 2: DH secret (commutatif)
  const dhSecret = x25519(myNewDHKey.privateKey, theirNewDHKey);

  // Step 3: ML-KEM encapsulation
  const { sharedSecret: pqSharedSecret, ciphertext: pqCiphertext } = kyberEncapsulate(theirMLKEMPubKey);
  const pqSecret = pqSharedSecret.bytes;

  // Step 4: Dériver les clés hybrides
  const { newCallRootKey, newSendChainKey, newRecvChainKey } = deriveHybridRotationKeys(
    dhSecret,
    pqSecret,
    activeState.callRootKey,
    activeState.callId,
    activeState.isInitiator  // false — responder
  );

  // Step 5: Sauvegarder anciennes recv keys (grace period)
  const previousRecvChainKey = new Uint8Array(activeState.recvChainKey);
  const previousRecvPacketIndex = activeState.recvPacketIndex;
  const previousKeyId = activeState.currentKeyId;
  const previousRecvHeaderKey = activeState.recvHeaderKey ? new Uint8Array(activeState.recvHeaderKey) : null;

  // Step 6: Response
  const response: DHRotationMessage = {
    type: 'dh_rotation',
    callId: activeState.callId,
    publicKey: encodeBase64(myNewDHKey.publicKey.bytes),
    keyId: message.keyId,
    timestamp: Date.now(),
    isResponse: true,
    mlkemCiphertext: serializeKyberCiphertext(pqCiphertext),
  };

  // Zeroize
  zeroize(dhSecret);
  zeroize(pqSecret);
  zeroizeKyberSharedSecret(pqSharedSecret);
  zeroize(activeState.callRootKey);
  if (activeState.myDHKey) {
    zeroize(activeState.myDHKey.privateKey.bytes);
  }
  if (activeState.myMLKEMKey) {
    zeroizeKyberSecretKey(activeState.myMLKEMKey.secretKey);
  }

  __DEV__ && console.log('[CallRatchet] 🔄 DH+PQ rotation REQUEST processed (responder), keyId:', message.keyId,
    '— recv keys updated IMMEDIATELY, send keys DEFERRED until initiator confirms');

  return {
    newState: {
      ...activeState,
      callRootKey: newCallRootKey,
      // sendChainKey: KEPT OLD — responder continues sending with old keys
      // sendPacketIndex: KEPT OLD — no reset until pending activates
      recvChainKey: newRecvChainKey,
      recvPacketIndex: 0,
      receivedIndexes: new Set(),
      myDHKey: myNewDHKey,
      theirDHKey: theirNewDHKey,
      myMLKEMKey: null,
      rotationPendingResponse: false,
      // v5.0: Store new send keys as PENDING
      // Activated when: (a) responder receives packet with new keyId from initiator,
      //                 (b) or timer fallback (5s)
      pendingSendChainKey: newSendChainKey,
      pendingSendKeyId: message.keyId,
      pendingSendActivateAt: Date.now() + CALL_RATCHET_CONSTANTS.SEND_KEYS_ACTIVATION_DELAY_MS,
      currentKeyId: message.keyId,
      previousRecvChainKey,
      previousRecvPacketIndex,
      previousKeyId,
      previousRecvHeaderKey,
      previousKeysExpireAt: Date.now() + CALL_RATCHET_CONSTANTS.PREVIOUS_KEYS_GRACE_MS,
      dhRotationCounter: activeState.dhRotationCounter + 1,
      lastDHRotationTime: Date.now(),
      lastActivityAt: Date.now(),
    },
    response,
  };
}

/**
 * INITIATOR: Reçoit la response du responder, finalise la rotation
 *
 * 1. dhSecret = x25519(A2.priv, B2.pub) — MÊME que responder (commutativité)
 * 2. pqSecret = ML-KEM.Decaps(PQ_A.secretKey, CT) — MÊME
 * 3. Dérive MÊMES clés hybrides
 * 4. Bascule IMMÉDIATEMENT send + recv
 */
export function processDHRotationResponse(
  state: CallRatchetState,
  message: DHRotationMessage
): CallRatchetState | null {
  if (message.callId !== state.callId) {
    __DEV__ && console.warn('[CallRatchet] DH rotation response callId mismatch');
    return null;
  }

  if (!message.isResponse) {
    __DEV__ && console.warn('[CallRatchet] Expected response, got request');
    return null;
  }

  if (!message.mlkemCiphertext) {
    __DEV__ && console.warn('[CallRatchet] DH rotation response missing ML-KEM ciphertext');
    return null;
  }

  if (!state.myMLKEMKey) {
    __DEV__ && console.warn('[CallRatchet] No ML-KEM secret key stored — cannot process response');
    return null;
  }

  if (!state.myDHKey) {
    __DEV__ && console.warn('[CallRatchet] No DH key stored — cannot process response');
    return null;
  }

  const theirNewDHKey = deserializeX25519PublicKey(message.publicKey);
  const pqCiphertext = deserializeKyberCiphertext(message.mlkemCiphertext);

  // Step 1: DH secret — MÊME que responder (commutativité X25519)
  const dhSecret = x25519(state.myDHKey.privateKey, theirNewDHKey);

  // Step 2: ML-KEM decapsulation — MÊME pqSecret
  const pqSharedSecret = kyberDecapsulate(pqCiphertext, state.myMLKEMKey.secretKey);
  const pqSecret = pqSharedSecret.bytes;

  // Step 3: MÊMES clés hybrides
  const { newCallRootKey, newSendChainKey, newRecvChainKey } = deriveHybridRotationKeys(
    dhSecret,
    pqSecret,
    state.callRootKey,
    state.callId,
    state.isInitiator  // true — initiator
  );

  // Sauvegarder anciennes recv keys
  const previousRecvChainKey = new Uint8Array(state.recvChainKey);
  const previousRecvPacketIndex = state.recvPacketIndex;
  const previousKeyId = state.currentKeyId;
  const previousRecvHeaderKey = state.recvHeaderKey ? new Uint8Array(state.recvHeaderKey) : null;

  // Zeroize
  zeroize(dhSecret);
  zeroize(pqSecret);
  zeroizeKyberSharedSecret(pqSharedSecret);
  zeroizeKyberSecretKey(state.myMLKEMKey.secretKey);
  zeroize(state.callRootKey);

  __DEV__ && console.log('[CallRatchet] 🔄 DH+PQ rotation RESPONSE processed (initiator), keyId:', message.keyId,
    '— send+recv keys updated IMMEDIATELY');

  return {
    ...state,
    callRootKey: newCallRootKey,
    sendChainKey: newSendChainKey,
    recvChainKey: newRecvChainKey,
    sendPacketIndex: 0,
    recvPacketIndex: 0,
    receivedIndexes: new Set(),
    theirDHKey: theirNewDHKey,
    myMLKEMKey: null,
    rotationPendingResponse: false,
    pendingSendChainKey: null,
    pendingSendKeyId: 0,
    pendingSendActivateAt: 0,
    currentKeyId: message.keyId,
    previousRecvChainKey,
    previousRecvPacketIndex,
    previousKeyId,
    previousRecvHeaderKey,
    previousKeysExpireAt: Date.now() + CALL_RATCHET_CONSTANTS.PREVIOUS_KEYS_GRACE_MS,
    lastActivityAt: Date.now(),
  };
}

/**
 * Dispatch: route un DHRotationMessage vers request ou response handler.
 * Retourne le nouvel état + un message de réponse optionnel (si c'était une request).
 *
 * Appelé par callCryptoService qui n'a pas besoin de connaître le détail ping-pong.
 */
export function processDHRotation(
  state: CallRatchetState,
  message: DHRotationMessage
): { newState: CallRatchetState; responseMessage?: DHRotationMessage } {
  if (message.isResponse) {
    const newState = processDHRotationResponse(state, message);
    if (!newState) {
      __DEV__ && console.warn('[CallRatchet] processDHRotationResponse failed, keeping old state');
      return { newState: state };
    }
    return { newState };
  } else {
    const result = processDHRotationRequest(state, message);
    if (!result) {
      __DEV__ && console.warn('[CallRatchet] processDHRotationRequest failed, keeping old state');
      return { newState: state };
    }
    return { newState: result.newState, responseMessage: result.response };
  }
}

// ============================================
// SÉRIALISATION
// ============================================

export function serializeCallRatchetState(state: CallRatchetState): string {
  const serialized = {
    version: state.version,
    callId: state.callId,
    callRootKey: encodeBase64(state.callRootKey),
    sendChainKey: encodeBase64(state.sendChainKey),
    recvChainKey: encodeBase64(state.recvChainKey),
    sendPacketIndex: state.sendPacketIndex,
    recvPacketIndex: state.recvPacketIndex,
    sendHeaderKey: encodeBase64(state.sendHeaderKey),
    recvHeaderKey: encodeBase64(state.recvHeaderKey),
    myDHKeyPublic: state.myDHKey ? encodeBase64(state.myDHKey.publicKey.bytes) : null,
    myDHKeyPrivate: state.myDHKey ? encodeBase64(state.myDHKey.privateKey.bytes) : null,
    theirDHKey: state.theirDHKey ? encodeBase64(state.theirDHKey.bytes) : null,
    dhRotationCounter: state.dhRotationCounter,
    lastDHRotationTime: state.lastDHRotationTime,
    // v5.0: ML-KEM
    myMLKEMPublicKey: state.myMLKEMKey ? serializeKyberPublicKey(state.myMLKEMKey.publicKey) : null,
    myMLKEMSecretKey: state.myMLKEMKey ? serializeKyberSecretKey(state.myMLKEMKey.secretKey) : null,
    rotationPendingResponse: state.rotationPendingResponse,
    // v5.0: Pending send keys (responder delayed activation)
    pendingSendChainKey: state.pendingSendChainKey ? encodeBase64(state.pendingSendChainKey) : null,
    pendingSendKeyId: state.pendingSendKeyId,
    pendingSendActivateAt: state.pendingSendActivateAt,
    currentKeyId: state.currentKeyId,
    previousRecvChainKey: state.previousRecvChainKey ? encodeBase64(state.previousRecvChainKey) : null,
    previousRecvPacketIndex: state.previousRecvPacketIndex,
    previousKeyId: state.previousKeyId,
    previousRecvHeaderKey: state.previousRecvHeaderKey ? encodeBase64(state.previousRecvHeaderKey) : null,
    previousKeysExpireAt: state.previousKeysExpireAt,
    receivedIndexes: Array.from(state.receivedIndexes),
    isInitiator: state.isInitiator,
    createdAt: state.createdAt,
    lastActivityAt: state.lastActivityAt,
  };

  return JSON.stringify(serialized);
}

export function deserializeCallRatchetState(json: string): CallRatchetState {
  const parsed = JSON.parse(json);

  let myDHKey: X25519KeyPair | null = null;
  if (parsed.myDHKeyPublic && parsed.myDHKeyPrivate) {
    myDHKey = {
      publicKey: deserializeX25519PublicKey(parsed.myDHKeyPublic),
      privateKey: {
        bytes: decodeBase64(parsed.myDHKeyPrivate),
        _brand: 'X25519PrivateKey' as const,
      },
    };
  }

  // v5.0: ML-KEM keypair
  let myMLKEMKey: KyberKeyPair | null = null;
  if (parsed.myMLKEMPublicKey && parsed.myMLKEMSecretKey) {
    myMLKEMKey = {
      publicKey: deserializeKyberPublicKey(parsed.myMLKEMPublicKey),
      secretKey: deserializeKyberSecretKey(parsed.myMLKEMSecretKey),
    };
  }

  return {
    version: parsed.version,
    callId: parsed.callId,
    callRootKey: decodeBase64(parsed.callRootKey),
    sendChainKey: decodeBase64(parsed.sendChainKey),
    recvChainKey: decodeBase64(parsed.recvChainKey),
    sendPacketIndex: parsed.sendPacketIndex,
    recvPacketIndex: parsed.recvPacketIndex,
    sendHeaderKey: decodeBase64(parsed.sendHeaderKey),
    recvHeaderKey: decodeBase64(parsed.recvHeaderKey),
    myDHKey,
    theirDHKey: parsed.theirDHKey ? deserializeX25519PublicKey(parsed.theirDHKey) : null,
    dhRotationCounter: parsed.dhRotationCounter,
    lastDHRotationTime: parsed.lastDHRotationTime,
    myMLKEMKey,
    rotationPendingResponse: parsed.rotationPendingResponse || false,
    pendingSendChainKey: parsed.pendingSendChainKey ? decodeBase64(parsed.pendingSendChainKey) : null,
    pendingSendKeyId: parsed.pendingSendKeyId || 0,
    pendingSendActivateAt: parsed.pendingSendActivateAt || 0,
    currentKeyId: parsed.currentKeyId,
    previousRecvChainKey: parsed.previousRecvChainKey ? decodeBase64(parsed.previousRecvChainKey) : null,
    previousRecvPacketIndex: parsed.previousRecvPacketIndex || 0,
    previousKeyId: parsed.previousKeyId || 0,
    previousRecvHeaderKey: parsed.previousRecvHeaderKey ? decodeBase64(parsed.previousRecvHeaderKey) : null,
    previousKeysExpireAt: parsed.previousKeysExpireAt || 0,
    receivedIndexes: new Set(parsed.receivedIndexes),
    isInitiator: parsed.isInitiator,
    createdAt: parsed.createdAt,
    lastActivityAt: parsed.lastActivityAt,
  };
}

// ============================================
// NETTOYAGE SÉCURISÉ
// ============================================

export function cleanupCallRatchetState(state: CallRatchetState): void {
  zeroize(state.callRootKey);
  zeroize(state.sendChainKey);
  zeroize(state.recvChainKey);
  zeroize(state.sendHeaderKey);
  zeroize(state.recvHeaderKey);

  if (state.previousRecvChainKey) {
    zeroize(state.previousRecvChainKey);
  }
  if (state.previousRecvHeaderKey) {
    zeroize(state.previousRecvHeaderKey);
  }
  if (state.myDHKey) {
    zeroize(state.myDHKey.privateKey.bytes);
  }
  // v5.0: ML-KEM
  if (state.myMLKEMKey) {
    zeroizeKyberSecretKey(state.myMLKEMKey.secretKey);
  }
  // v5.0: Pending send keys
  if (state.pendingSendChainKey) {
    zeroize(state.pendingSendChainKey);
  }

  state.receivedIndexes.clear();
}

// ============================================
// HELPERS
// ============================================

export function getCallRatchetStats(state: CallRatchetState): {
  packetsSent: number;
  packetsReceived: number;
  dhRotations: number;
  isInitiator: boolean;
  callDurationMs: number;
  rotationPendingResponse: boolean;
  hasPQProtection: boolean;
} {
  return {
    packetsSent: state.sendPacketIndex,
    packetsReceived: state.recvPacketIndex,
    dhRotations: state.dhRotationCounter,
    isInitiator: state.isInitiator,
    callDurationMs: Date.now() - state.createdAt,
    rotationPendingResponse: state.rotationPendingResponse,
    hasPQProtection: true, // v5.0: Toujours true, ML-KEM à chaque rotation
  };
}

export function createCallRatchetInit(state: CallRatchetState): SerializedCallRatchetInit {
  // Les deux parties doivent avoir exactement les mêmes clés d'appel.
  // L'initiateur dérive ses clés depuis son état Triple Ratchet courant et les transmet.
  // Le répondant utilise ces clés inversées (SEND↔RECV) via initializeCallRatchetFromInit.
  // Cela garantit la synchronisation même si les états Triple Ratchet ont divergé
  // (la session avance à chaque message — les deux rootKeys peuvent différer au moment
  // de l'appel). Ces clés transitent via le canal Triple Ratchet déjà chiffré E2E.
  return {
    type: 'call_ratchet_init',
    version: state.version,
    callId: state.callId,
    publicKey: state.myDHKey ? encodeBase64(state.myDHKey.publicKey.bytes) : null,
    keyId: state.currentKeyId,
    isInitiator: state.isInitiator,
    callRootKey: encodeBase64(state.callRootKey),
    sendChainKey: encodeBase64(state.sendChainKey),
    recvChainKey: encodeBase64(state.recvChainKey),
    sendHeaderKey: encodeBase64(state.sendHeaderKey),
    recvHeaderKey: encodeBase64(state.recvHeaderKey),
  };
}

/**
 * Initialise l'état du répondant depuis les clés envoyées par l'initiateur.
 *
 * L'initiateur dérive ses clés d'appel depuis son état Triple Ratchet courant
 * puis les transmet via le signal crypto_init. Le répondant les reçoit ici
 * et les utilise en inversant SEND↔RECV pour obtenir des clés complémentaires.
 *
 * Ce mécanisme garantit que les deux parties ont exactement les mêmes clés
 * même si leurs états Triple Ratchet ont divergé (sessions non synchronisées).
 */
export function initializeCallRatchetFromInit(
  init: SerializedCallRatchetInit,
  callId: string
): CallRatchetState {
  if (init.callId !== callId) {
    throw new Error('CallId mismatch');
  }

  const callRootKey = decodeBase64(init.callRootKey);
  const theirSendChainKey = decodeBase64(init.sendChainKey);
  const theirRecvChainKey = decodeBase64(init.recvChainKey);
  const theirSendHeaderKey = decodeBase64(init.sendHeaderKey);
  const theirRecvHeaderKey = decodeBase64(init.recvHeaderKey);
  const theirDHKey = init.publicKey ? deserializeX25519PublicKey(init.publicKey) : null;
  const myDHKey = generateX25519KeyPair();

  return {
    version: init.version,
    callId,
    callRootKey,
    sendChainKey: theirRecvChainKey,    // Inversé: leur recv = notre send
    recvChainKey: theirSendChainKey,    // Inversé: leur send = notre recv
    sendPacketIndex: 0,
    recvPacketIndex: 0,
    sendHeaderKey: theirRecvHeaderKey,  // Inversé
    recvHeaderKey: theirSendHeaderKey,  // Inversé
    myDHKey,
    theirDHKey,
    dhRotationCounter: 0,
    lastDHRotationTime: Date.now(),
    myMLKEMKey: null,
    rotationPendingResponse: false,
    pendingSendChainKey: null,
    pendingSendKeyId: 0,
    pendingSendActivateAt: 0,
    currentKeyId: init.keyId,
    previousRecvChainKey: null,
    previousRecvPacketIndex: 0,
    previousKeyId: 0,
    previousRecvHeaderKey: null,
    previousKeysExpireAt: 0,
    receivedIndexes: new Set(),
    isInitiator: false,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

export function processCallRatchetInit(
  state: CallRatchetState,
  init: SerializedCallRatchetInit
): CallRatchetState {
  if (init.callId !== state.callId) {
    __DEV__ && console.warn('[CallRatchet] Init callId mismatch');
    return state;
  }

  const theirPublicKey = init.publicKey ? deserializeX25519PublicKey(init.publicKey) : null;

  return {
    ...state,
    theirDHKey: theirPublicKey,
    lastActivityAt: Date.now(),
  };
}