// src/services/webrtcService.ts
// Service de gestion WebRTC pour les appels vocaux
// Version 13.0 - AMÉLIORATIONS DOUBLE-HOP:
//   - v13.0: Meilleure gestion des erreurs de connexion
//   - v13.0: Validation des messages reçus
//   - v13.0: Retry intelligent avec backoff exponentiel
//   - v13.0: Support du fallback direct si relay indisponible
//   - v12.0: Gestion des messages non-JSON (ping/pong texte des relays)
//   - v11.0: Support du double-hop via Entry/Exit Relays
//
// ARCHITECTURE DOUBLE-HOP:
// [Client] ──► [Entry Relay (CF)] ──► [Exit Relay (Fly)] ──► [SFU]
//                    │                        │
//              Voit IP client           Voit IP Entry
//              Ne voit PAS SFU          Ne voit PAS Client
//
// SÉCURITÉ:
// - Le SFU ne voit jamais l'IP du client (anonymat total)
// - Chiffrement E2E préservé (SenderKeys)
// - Le relay ne voit que des paquets chiffrés opaques

import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { getRandomBytes, secureRandomInt } from './crypto';
import { decodeUTF8 } from 'tweetnacl-util';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

// ============================================
// RELAY AUTHENTICATION (HMAC-SHA256)
// ============================================

/**
 * Génère un token HMAC pour authentifier la connexion au relay.
 * Clé = authToken (dérivé de HKDF sur le secret de session Triple Ratchet).
 * Aucun secret statique dans le binaire client.
 * Format: base64(hmac):timestamp
 * Le relay vérifie le HMAC et la fraîcheur du timestamp (5 min max).
 */
async function generateRelayHmacToken(roomTag: string, peerId: string, authToken?: string): Promise<string | null> {
  if (!authToken) {
    return null;
  }
  
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `ghostr-relay-v2:${roomTag}:${peerId}:${timestamp}`;
    
    const keyBytes = decodeBase64(authToken);
    const msgBytes = decodeUTF8(message);
    const hmacResult = hmac(sha256, keyBytes, msgBytes);
    const hmacB64 = encodeBase64(hmacResult);
    
    return `${hmacB64}:${timestamp}`;
  } catch (error) {
    console.warn('🔌 Failed to generate relay HMAC token:', error);
    return null;
  }
}

// ============================================
// TYPES
// ============================================

export type ConnectionState = 
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface SfuMessage {
  type: 'join' | 'leave' | 'audio' | 'peer-joined' | 'peer-left' | 'error' | 'ping' | 'pong' | 'room-info' | 'peer-mute';
  peerId?: string;
  roomTag?: string;
  data?: string;
  senderToken?: string;
  error?: string;
  timestamp?: number;
  peers?: Array<{ peerId: string; senderToken: string; isMuted?: boolean }>;
  muted?: boolean;
}

export interface AudioPacketHeader {
  keyId: string;
  senderTokenHash: string;
  sequence: number;
}

type OnAudioReceivedCallback = (senderTokenHash: string, encryptedAudioData: Uint8Array) => void;

// ============================================
// CONFIGURATION DOUBLE-HOP
// ============================================

const ENTRY_RELAY_URL = process.env.EXPO_PUBLIC_ENTRY_RELAY_URL || '';

export type RelayRegion = 'eu-west' | 'eu-central' | 'us-east' | 'us-west' | 'asia' | 'auto';

const REGION_MAPPING: Record<string, RelayRegion> = {
  'FR': 'eu-west', 'GB': 'eu-west', 'ES': 'eu-west', 'PT': 'eu-west', 'IE': 'eu-west',
  'DE': 'eu-central', 'NL': 'eu-central', 'BE': 'eu-central', 'CH': 'eu-central',
  'AT': 'eu-central', 'PL': 'eu-central', 'IT': 'eu-central',
  'US': 'us-east',
  'JP': 'asia', 'KR': 'asia', 'CN': 'asia', 'SG': 'asia', 'AU': 'asia',
};

// ============================================
// CONFIGURATION
// ============================================

const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;
const PING_INTERVAL_MS = 15000;
const CONNECTION_TIMEOUT_MS = 15000;
const HEALTHCHECK_TIMEOUT_MS = 5000;

// ============================================
// ÉTAT DU SERVICE
// ============================================

interface WebRTCState {
  ws: WebSocket | null;
  connectionState: ConnectionState;
  myPeerId: string | null;
  mySenderTokenHash: string | null;
  roomTag: string | null;
  authToken: string | null;
  reconnectAttempts: number;
  pingInterval: ReturnType<typeof setInterval> | null;
  audioSequence: number;
  sfuUrl: string | null;
  isDisconnecting: boolean;
  disconnectInProgress: boolean;
  notifiedPeers: Set<string>;
  useDoubleHop: boolean;
  selectedRegion: RelayRegion;
  lastConnectParams: {
    sfuUrl: string;
    roomTag: string;
    peerId: string;
    senderTokenHash: string;
    authToken?: string;
    region?: RelayRegion;
  } | null;
  
  // Callbacks
  onConnectionStateChange: ((state: ConnectionState) => void) | null;
  onPeerJoined: ((peerId: string, senderTokenHash: string) => void) | null;
  onPeerLeft: ((peerId: string, senderTokenHash?: string) => void) | null;
  onAudioReceived: OnAudioReceivedCallback | null;
  onError: ((error: string) => void) | null;
}

const state: WebRTCState = {
  ws: null,
  connectionState: 'disconnected',
  myPeerId: null,
  mySenderTokenHash: null,
  roomTag: null,
  authToken: null,
  reconnectAttempts: 0,
  pingInterval: null,
  audioSequence: 0,
  sfuUrl: null,
  isDisconnecting: false,
  disconnectInProgress: false,
  notifiedPeers: new Set(),
  useDoubleHop: !!ENTRY_RELAY_URL,
  selectedRegion: 'auto',
  lastConnectParams: null,
  onConnectionStateChange: null,
  onPeerJoined: null,
  onPeerLeft: null,
  onAudioReceived: null,
  onError: null,
};

// ============================================
// CONFIGURATION DOUBLE-HOP
// ============================================

export function setDoubleHopEnabled(enabled: boolean): void {
  if (!ENTRY_RELAY_URL && enabled) {
    console.warn('🔌 Cannot enable double-hop: ENTRY_RELAY_URL not configured');
    return;
  }
  state.useDoubleHop = enabled;
  __DEV__ && console.log(`🔌 Double-hop ${enabled ? 'enabled' : 'disabled'}`);
}

export function isDoubleHopEnabled(): boolean {
  return state.useDoubleHop && !!ENTRY_RELAY_URL;
}

export function setPreferredRegion(region: RelayRegion): void {
  state.selectedRegion = region;
  __DEV__ && console.log(`🔌 Preferred relay region: ${region}`);
}

export function getOptimalRegion(countryCode?: string): RelayRegion {
  if (state.selectedRegion !== 'auto') {
    return state.selectedRegion;
  }
  if (countryCode && REGION_MAPPING[countryCode]) {
    return REGION_MAPPING[countryCode];
  }
  return 'eu-west';
}

// ============================================
// HEALTHCHECK DU RELAY
// ============================================

async function checkRelayHealth(): Promise<boolean> {
  if (!ENTRY_RELAY_URL) return false;
  
  try {
    // Convertir l'URL WebSocket en URL HTTP pour le healthcheck
    const healthUrl = ENTRY_RELAY_URL
      .replace(/^wss?:\/\//, 'https://')
      .replace(/\/$/, '') + '/health';
      
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);
    
    const response = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const data = await response.json();
      __DEV__ && console.log(`🔌 Relay health check: ${data.status} (v${data.version})`);
      return data.status === 'ok';
    }
    return false;
  } catch (error) {
    console.warn('🔌 Relay health check failed:', error);
    return false;
  }
}

// ============================================
// CONVERSION URL HTTP(S) -> WS(S)
// ============================================

function toWebSocketUrl(url: string): string {
  if (url.startsWith('wss://') || url.startsWith('ws://')) {
    return url;
  }
  if (url.startsWith('https://')) {
    return url.replace('https://', 'wss://');
  }
  if (url.startsWith('http://')) {
    return url.replace('http://', 'ws://');
  }
  return `wss://${url}`;
}

// ============================================
// CONSTRUCTION D'URL
// ============================================

async function buildConnectionUrl(
  sfuUrl: string,
  roomTag: string,
  peerId: string,
  authToken?: string,
  region?: RelayRegion
): Promise<string> {
  if (state.useDoubleHop && ENTRY_RELAY_URL) {
    const selectedRegion = region || getOptimalRegion();
    const entryBaseUrl = toWebSocketUrl(ENTRY_RELAY_URL);
    
    let url = `${entryBaseUrl}/relay/${selectedRegion}/room/${roomTag}?peerId=${peerId}`;
    if (authToken) {
      url += `&authToken=${encodeURIComponent(authToken)}`;
    }
    
    // Ajouter le token HMAC pour authentification relay (dérivé du authToken de session)
    const relayHmac = await generateRelayHmacToken(roomTag, peerId, authToken);
    if (relayHmac) {
      url += `&relayToken=${encodeURIComponent(relayHmac)}`;
    }
    
    __DEV__ && console.log(`🔌 Using double-hop via ${selectedRegion} (anonymity enabled)`);
    return url;
  }
  
  // Connexion directe au SFU (pas d'anonymat IP)
  const wsBaseUrl = toWebSocketUrl(sfuUrl);
  let url = `${wsBaseUrl}/room/${roomTag}?peerId=${peerId}`;
  if (authToken) {
    url += `&authToken=${encodeURIComponent(authToken)}`;
  }
  
  __DEV__ && console.log('🔌 Using direct connection to SFU (no IP anonymity)');
  return url;
}

// ============================================
// CONFIGURATION DES CALLBACKS
// ============================================

export function setWebRTCCallbacks(callbacks: {
  onConnectionStateChange?: (state: ConnectionState) => void;
  onPeerJoined?: (peerId: string, senderTokenHash: string) => void;
  onPeerLeft?: (peerId: string, senderTokenHash?: string) => void;
  onAudioReceived?: OnAudioReceivedCallback;
  onError?: (error: string) => void;
}): void {
  state.onConnectionStateChange = callbacks.onConnectionStateChange || null;
  state.onPeerJoined = callbacks.onPeerJoined || null;
  state.onPeerLeft = callbacks.onPeerLeft || null;
  state.onAudioReceived = callbacks.onAudioReceived || null;
  state.onError = callbacks.onError || null;
}

// ============================================
// CONNEXION AU SFU
// ============================================

export async function connectToSfu(
  sfuUrl: string,
  roomTag: string,
  peerId: string,
  senderTokenHash: string,
  authToken?: string,
  region?: RelayRegion
): Promise<boolean> {
  return new Promise(async (resolve) => {
    try {
      // Sauvegarder les paramètres pour reconnexion
      state.lastConnectParams = { sfuUrl, roomTag, peerId, senderTokenHash, authToken, region };
      
      // Fermer connexion existante si nécessaire
      if (state.ws) {
        __DEV__ && console.log('🔌 Closing existing connection before new connect');
        try {
          state.ws.close();
        } catch (e) {}
        state.ws = null;
      }
      
      // Reset état
      state.notifiedPeers.clear();
      state.isDisconnecting = false;
      state.disconnectInProgress = false;
      
      updateConnectionState('connecting');
      
      state.myPeerId = peerId;
      state.mySenderTokenHash = senderTokenHash;
      state.roomTag = roomTag;
      state.authToken = authToken || null;
      state.audioSequence = 0;
      state.sfuUrl = sfuUrl;
      
      // Vérifier la santé du relay si double-hop activé
      if (state.useDoubleHop && ENTRY_RELAY_URL) {
        const relayHealthy = await checkRelayHealth();
        if (!relayHealthy) {
          console.error('🔌 Relay unhealthy — refusing connection to protect IP anonymity');
          updateConnectionState('failed');
          resolve(false);
          return;
        }
      }
      
      // Construire l'URL
      const wsUrl = await buildConnectionUrl(sfuUrl, roomTag, peerId, authToken, region);
      
      __DEV__ && console.log(`🔌 Connecting to SFU:`);
      __DEV__ && console.log(`   Mode: ${state.useDoubleHop ? 'DOUBLE-HOP (anonymous)' : 'DIRECT'}`);
      __DEV__ && console.log(`   Room: ${roomTag.slice(0, 8)}...`);
      __DEV__ && console.log(`   PeerId: ${peerId.slice(0, 16)}...`);
      
      // Créer la WebSocket
      state.ws = new WebSocket(wsUrl);
      
      // Timeout de connexion
      const connectionTimeout = setTimeout(() => {
        if (state.connectionState === 'connecting') {
          console.error('🔌 Connection timeout');
          state.ws?.close();
          updateConnectionState('failed');
          resolve(false);
        }
      }, CONNECTION_TIMEOUT_MS);
      
      state.ws.onopen = () => {
        clearTimeout(connectionTimeout);
        __DEV__ && console.log('🔌 WebSocket connected, sending join...');
        state.reconnectAttempts = 0;
        
        // Envoyer le message join
        const joinMsg: SfuMessage = {
          type: 'join',
          peerId,
          roomTag,
          senderToken: senderTokenHash,
          timestamp: Date.now(),
        };
        sendMessage(joinMsg);
        
        // Démarrer le ping
        startPingInterval();
        
        updateConnectionState('connected');
        resolve(true);
      };
      
      state.ws.onmessage = (event) => {
        handleSfuMessage(event.data);
      };
      
      state.ws.onerror = (error) => {
        clearTimeout(connectionTimeout);
        console.error('🔌 WebSocket error');
        if (!state.isDisconnecting && !state.disconnectInProgress) {
          state.onError?.('WebSocket connection error');
        }
      };
      
      state.ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        __DEV__ && console.log(`🔌 WebSocket closed: ${event.code} - ${event.reason || 'No reason'}`);
        stopPingInterval();
        
        if (state.isDisconnecting || state.disconnectInProgress) {
          updateConnectionState('disconnected');
          return;
        }
        
        if (state.connectionState === 'connecting') {
          updateConnectionState('failed');
          resolve(false);
        } else if (state.connectionState !== 'disconnected') {
          handleDisconnect();
        }
      };
      
    } catch (error) {
      console.error('🔌 Connect error:', error);
      updateConnectionState('failed');
      resolve(false);
    }
  });
}

// ============================================
// DÉCONNEXION
// ============================================

export function disconnectFromSfu(): void {
  if (state.disconnectInProgress) {
    __DEV__ && console.log('🔌 Disconnect already in progress, ignoring');
    return;
  }
  
  if (state.connectionState === 'disconnected' && !state.ws) {
    __DEV__ && console.log('🔌 Already disconnected - skipping');
    return;
  }
  
  state.disconnectInProgress = true;
  state.isDisconnecting = true;
  
  __DEV__ && console.log('🔌 Disconnecting from SFU');
  
  stopPingInterval();
  
  // Sauvegarder les infos avant de nettoyer
  const savedPeerId = state.myPeerId;
  const savedSenderTokenHash = state.mySenderTokenHash;
  const savedRoomTag = state.roomTag;
  
  if (state.ws) {
    // Envoyer le message leave
    if (state.ws.readyState === WebSocket.OPEN) {
      const leaveMessage: SfuMessage = {
        type: 'leave',
        peerId: savedPeerId || undefined,
        senderToken: savedSenderTokenHash || undefined,
        roomTag: savedRoomTag || undefined,
        timestamp: Date.now(),
      };
      __DEV__ && console.log('🔌 Sending leave message');
      sendMessage(leaveMessage);
    }
    
    // Fermer après un court délai
    const wsToClose = state.ws;
    setTimeout(() => {
      try {
        if (wsToClose.readyState !== WebSocket.CLOSED) {
          wsToClose.close(1000, 'User disconnected');
        }
      } catch (e) {}
    }, 100);
    
    state.ws = null;
  }
  
  // Nettoyer
  state.notifiedPeers.clear();
  state.myPeerId = null;
  state.mySenderTokenHash = null;
  state.roomTag = null;
  state.authToken = null;
  state.audioSequence = 0;
  state.sfuUrl = null;
  state.lastConnectParams = null;
  
  updateConnectionState('disconnected');
  state.reconnectAttempts = 0;
  
  // Reset flags après un délai
  setTimeout(() => {
    state.isDisconnecting = false;
    state.disconnectInProgress = false;
  }, 500);
}

// ============================================
// GESTION DES MESSAGES SFU
// ============================================

function handleSfuMessage(data: string | ArrayBuffer): void {
  // Convertir en string si nécessaire
  const dataStr = typeof data === 'string' ? data : new TextDecoder().decode(data);
  
  const trimmed = dataStr.trim();
  
  // Ignorer les messages vides
  if (!trimmed) return;
  
  // Vérifier si c'est du JSON valide (commence par { ou [)
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    // Message non-JSON - probablement un ping/pong du relay
    // Ignorer silencieusement
    return;
  }
  
  try {
    const message: SfuMessage = JSON.parse(trimmed);
    
    // Valider le message
    if (!message || typeof message !== 'object' || !message.type) {
      console.warn('🔌 Invalid message structure');
      return;
    }
    
    switch (message.type) {
      case 'peer-joined':
        handlePeerJoined(message);
        break;
        
      case 'peer-left':
        handlePeerLeft(message);
        break;
        
      case 'audio':
        handleIncomingAudio(message);
        break;
        
      case 'room-info':
        handleRoomInfo(message);
        break;
        
      case 'peer-mute':
        // Gestion du mute (optionnel - peut être étendu)
        break;
        
      case 'pong':
        // Réponse au ping - connexion OK
        break;
        
      case 'error':
        console.error('🔌 SFU error:', message.error);
        if (!state.isDisconnecting && !state.disconnectInProgress) {
          state.onError?.(message.error || 'Unknown error');
        }
        break;
        
      default:
        // Ignorer les messages inconnus silencieusement
        break;
    }
    
  } catch (error) {
    // Erreur de parsing - ignorer (déjà filtré les non-JSON)
    console.warn('🔌 Parse error for apparent JSON:', dataStr.slice(0, 50));
  }
}

function handlePeerJoined(message: SfuMessage): void {
  if (!message.peerId || !message.senderToken) return;
  
  const peerKey = `${message.peerId}:${message.senderToken}`;
  
  // Vérifier si c'est nous-même
  if (state.mySenderTokenHash && message.senderToken === state.mySenderTokenHash) {
    __DEV__ && console.log(`👤 Skipping SELF peer-joined`);
    state.notifiedPeers.add(peerKey);
    return;
  }
  
  // Vérifier les doublons
  if (state.notifiedPeers.has(peerKey)) {
    __DEV__ && console.log(`👤 Skipping DUPLICATE peer-joined`);
    return;
  }
  
  state.notifiedPeers.add(peerKey);
  __DEV__ && console.log(`👤 Peer joined: ${message.peerId.slice(0, 16)}...`);
  state.onPeerJoined?.(message.peerId, message.senderToken);
}

function handlePeerLeft(message: SfuMessage): void {
  if (!message.peerId) return;
  
  __DEV__ && console.log(`👤 Peer left: ${message.peerId.slice(0, 16)}...`);
  
  if (message.senderToken) {
    const peerKey = `${message.peerId}:${message.senderToken}`;
    state.notifiedPeers.delete(peerKey);
  }
  
  state.onPeerLeft?.(message.peerId, message.senderToken);
}

function handleRoomInfo(message: SfuMessage): void {
  const roomInfo = message as any;
  const peers = message.peers || roomInfo.peers;
  
  if (!peers || !Array.isArray(peers)) {
    __DEV__ && console.log(`🏠 Room info received (no peer list)`);
    return;
  }
  
  __DEV__ && console.log(`🏠 Room info: ${peers.length} peers in room`);
  
  let notifiedCount = 0;
  let skippedCount = 0;
  
  for (const peer of peers) {
    if (!peer.peerId || !peer.senderToken) continue;
    
    const peerKey = `${peer.peerId}:${peer.senderToken}`;
    
    // Skip self
    if (state.mySenderTokenHash && peer.senderToken === state.mySenderTokenHash) {
      state.notifiedPeers.add(peerKey);
      skippedCount++;
      continue;
    }
    
    // Skip duplicates
    if (state.notifiedPeers.has(peerKey)) {
      skippedCount++;
      continue;
    }
    
    state.notifiedPeers.add(peerKey);
    __DEV__ && console.log(`🏠 Existing peer: ${peer.peerId.slice(0, 16)}...`);
    state.onPeerJoined?.(peer.peerId, peer.senderToken);
    notifiedCount++;
  }
  
  __DEV__ && console.log(`🏠 Room info processed: ${notifiedCount} new, ${skippedCount} skipped`);
}

let audioReceiveCount = 0;

function handleIncomingAudio(message: SfuMessage): void {
  audioReceiveCount++;
  
  if (!message.data || !message.senderToken) {
    if (audioReceiveCount % 50 === 1) {
      __DEV__ && console.log(`🔊 Received audio #${audioReceiveCount}: missing data or senderToken`);
    }
    return;
  }
  
  try {
    const encryptedAudio = decodeBase64(message.data);
    
    if (audioReceiveCount % 50 === 1) {
      __DEV__ && console.log(`🔊 Received audio #${audioReceiveCount}, size=${encryptedAudio.length}, from=${message.senderToken?.slice(0, 8)}...`);
    }
    
    if (state.onAudioReceived) {
      state.onAudioReceived(message.senderToken, encryptedAudio);
    } else {
      if (audioReceiveCount % 50 === 1) {
        __DEV__ && console.log(`🔊 No onAudioReceived callback!`);
      }
    }
  } catch (error) {
    console.error('🔊 Error processing audio:', error);
  }
}

// ============================================
// ENVOI AUDIO
// ============================================

let audioSendCount = 0;

export function sendAudio(encryptedAudioData: Uint8Array): boolean {
  audioSendCount++;
  
  if (!state.ws || state.connectionState !== 'connected') {
    if (audioSendCount % 50 === 1) {
      __DEV__ && console.log(`🔌 sendAudio #${audioSendCount} blocked: ws=${!!state.ws}, state=${state.connectionState}`);
    }
    return false;
  }
  
  if (state.ws.readyState !== WebSocket.OPEN) {
    if (audioSendCount % 50 === 1) {
      __DEV__ && console.log(`🔌 sendAudio #${audioSendCount} blocked: readyState=${state.ws.readyState}`);
    }
    return false;
  }
  
  if (state.isDisconnecting || state.disconnectInProgress) {
    return false;
  }
  
  try {
    const message: SfuMessage = {
      type: 'audio',
      peerId: state.myPeerId || undefined,
      senderToken: state.mySenderTokenHash || undefined,
      data: encodeBase64(encryptedAudioData),
      timestamp: Date.now(),
    };
    
    sendMessage(message);
    state.audioSequence++;
    
    if (audioSendCount % 50 === 1) {
      __DEV__ && console.log(`🔌 sendAudio #${audioSendCount} SUCCESS, seq=${state.audioSequence}`);
    }
    
    return true;
  } catch (error) {
    console.error('Send audio error:', error);
    return false;
  }
}

// ============================================
// HELPERS
// ============================================

function sendMessage(message: SfuMessage): void {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
  }
}

function updateConnectionState(newState: ConnectionState): void {
  const oldState = state.connectionState;
  state.connectionState = newState;
  
  if (oldState !== newState) {
    __DEV__ && console.log(`🔌 Connection state: ${oldState} → ${newState}`);
    state.onConnectionStateChange?.(newState);
  }
}

function handleDisconnect(): void {
  if (state.isDisconnecting || state.disconnectInProgress) {
    return;
  }
  
  if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS && state.lastConnectParams) {
    updateConnectionState('reconnecting');
    state.reconnectAttempts++;
    
    // Backoff exponentiel avec jitter
    const baseDelay = RECONNECT_DELAY_MS * Math.pow(2, state.reconnectAttempts - 1);
    const jitter = secureRandomInt(1000);
    const delay = Math.min(baseDelay + jitter, 10000);
    
    __DEV__ && console.log(`🔄 Reconnect attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay)}ms`);
    
    setTimeout(async () => {
      if (state.isDisconnecting || state.disconnectInProgress) {
        __DEV__ && console.log('🔄 Reconnect cancelled - disconnection in progress');
        return;
      }
      
      if (state.lastConnectParams) {
        const params = state.lastConnectParams;
        const connected = await connectToSfu(
          params.sfuUrl,
          params.roomTag,
          params.peerId,
          params.senderTokenHash,
          params.authToken,
          params.region
        );
        
        if (!connected && state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          handleDisconnect();
        }
      }
    }, delay);
    
  } else {
    updateConnectionState('failed');
    state.onError?.('Connection lost - max reconnect attempts reached');
  }
}

function startPingInterval(): void {
  stopPingInterval();
  
  state.pingInterval = setInterval(() => {
    if (state.ws?.readyState === WebSocket.OPEN && !state.isDisconnecting) {
      sendMessage({
        type: 'ping',
        timestamp: Date.now(),
      });
    }
  }, PING_INTERVAL_MS);
}

function stopPingInterval(): void {
  if (state.pingInterval) {
    clearInterval(state.pingInterval);
    state.pingInterval = null;
  }
}

export function hashSenderToken(senderToken: string): string {
  let hash = 0;
  for (let i = 0; i < senderToken.length; i++) {
    const char = senderToken.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// ============================================
// ÉTAT
// ============================================

export function getConnectionState(): ConnectionState {
  return state.connectionState;
}

export function isConnected(): boolean {
  return state.connectionState === 'connected' && 
         state.ws?.readyState === WebSocket.OPEN &&
         !state.isDisconnecting &&
         !state.disconnectInProgress;
}

export function getMyPeerId(): string | null {
  return state.myPeerId;
}

export function getMySenderTokenHash(): string | null {
  return state.mySenderTokenHash;
}

export function getAudioSequence(): number {
  return state.audioSequence;
}

export function isDisconnecting(): boolean {
  return state.isDisconnecting || state.disconnectInProgress;
}

export function clearNotifiedPeers(): void {
  state.notifiedPeers.clear();
  __DEV__ && console.log('🔌 Manually cleared notifiedPeers Set');
}

// ============================================
// CLEANUP
// ============================================

export function cleanupWebRTC(): void {
  disconnectFromSfu();
  state.onConnectionStateChange = null;
  state.onPeerJoined = null;
  state.onPeerLeft = null;
  state.onAudioReceived = null;
  state.onError = null;
}