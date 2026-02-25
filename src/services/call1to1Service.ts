// src/services/call1to1Service.ts
// Service de gestion des appels vocaux 1-à-1 via SFU avec double-hop
// Version 3.0 - Audio Triple Ratchet avec Forward Secrecy et Protection Post-Quantique
//
// ARCHITECTURE DOUBLE-HOP:
// [Alice] ─► [Entry Relay (CF)] ─► [Exit Relay (Fly)] ─► [SFU] ◄─ [Exit] ◄─ [Entry] ◄─ [Bob]
//
// SÉCURITÉ:
// - Les IPs des participants sont masquées par le double-hop
// - Audio chiffré E2E avec Triple Ratchet Audio (forward secrecy par paquet)
// - Signaling via Triple Ratchet (chiffré E2E)
// - Protection post-quantique via dérivation depuis session PQ
// - Rotation DH périodique pour forward secrecy maximale
//
// FLUX D'APPEL:
// 1. Appelant: génère callId, roomTag, authToken
// 2. Appelant: initialise Audio Triple Ratchet depuis la session existante
// 3. Appelant: se connecte au SFU, envoie offer via Triple Ratchet
// 4. Appelé: reçoit offer, initialise son Audio Triple Ratchet (mêmes clés dérivées)
// 5. Les deux peuvent communiquer avec forward secrecy

import { encodeBase64 } from 'tweetnacl-util';
import { getRandomBytes, generateRoomAuthToken } from './crypto';
import {
  connectToSfu,
  disconnectFromSfu,
  sendAudio,
  setWebRTCCallbacks,
  hashSenderToken,
  clearNotifiedPeers,
} from './webrtcService';
import {
  callCryptoService,
  initializeCallCrypto,
  encryptCallAudio,
  decryptCallAudio,
  handleCallCryptoSignal,
  setCallCryptoSignalCallback,
  setCallCryptoOnDecryptedAudio,
  cleanupCallCrypto,
  isCallCryptoInitialized,
  CallCryptoSignal,
} from './callCryptoService';
import {
  initializeAudio,
  startCapture,
  stopCapture,
  startPlayback,
  stopPlayback,
  addAudioToBuffer,
  setMuted as setAudioMuted,
  setSpeaker as setAudioSpeaker,
  cleanupAudio,
} from './audioService';
import { sendCallEndedMessage1to1, forceFetchAndNotify1to1 } from './api1to1';
import { sessionService } from './tripleRatchet';  // v7.0: Pour récupérer l'avatar du contact
import { startRingback, startRingtone, playConnectedBeep, playBusyTone, stopTone } from './callTones';

// ============================================
// TYPES
// ============================================

export type Call1to1State = 
  | 'idle'           // Pas d'appel
  | 'outgoing'       // Appel sortant en cours de sonnerie
  | 'incoming'       // Appel entrant
  | 'connecting'     // Connexion au SFU en cours
  | 'connected'      // Appel actif
  | 'ended';         // Appel terminé

export type CallEndReason = 
  | 'local_hangup'   // J'ai raccroché
  | 'remote_hangup'  // L'autre a raccroché
  | 'declined'       // Refusé
  | 'busy'           // Occupé
  | 'timeout'        // Pas de réponse
  | 'error';         // Erreur technique

export interface Call1to1Info {
  callId: string;
  sessionId: string;
  state: Call1to1State;
  isOutgoing: boolean;
  remoteDisplayName: string;
  remoteAvatarBase64?: string;  // v7.0: Avatar du contact distant
  startedAt: number | null;
  duration: number;
  isMuted: boolean;
  isSpeakerOn: boolean;
}

// Signaux d'appel envoyés via Triple Ratchet
export interface CallSignalData {
  type: 'offer' | 'answer' | 'crypto' | 'hangup' | 'decline' | 'busy';
  callId: string;
  // Pour offer
  roomTag?: string;
  authToken?: string;
  // Pour answer - timestamp de début d'appel (pour synchroniser les chronos)
  callStartedAt?: number;
  // Pour crypto - Signal de chiffrement (init ou DH rotation)
  cryptoSignal?: CallCryptoSignal;
  timestamp: number;
}

type CallStateListener = (info: Call1to1Info | null) => void;
// v7.0: Ajout de callerAvatarBase64 pour afficher l'avatar dans l'écran d'appel entrant
type IncomingCallListener = (sessionId: string, callId: string, callerName: string, callerAvatarBase64?: string) => void;

// ============================================
// CONFIGURATION
// ============================================

const SFU_URL = process.env.EXPO_PUBLIC_SFU_URL || '';
const CALL_TIMEOUT_MS = 45000; // 45 secondes pour répondre

// ============================================
// ÉTAT GLOBAL
// ============================================

class Call1to1Manager {
  private currentCall: Call1to1Info | null = null;
  private callTimeout: ReturnType<typeof setTimeout> | null = null;
  private durationInterval: ReturnType<typeof setInterval> | null = null;
  
  // Token pour le SFU (identification, pas chiffrement)
  private mySenderToken: string = '';
  private remoteSenderTokenHash: string = '';
  
  // Room info
  private roomTag: string = '';
  private authToken: string = '';
  
  // Pending offer pour l'appelé
  private pendingOffer: {
    callId: string;
    roomTag: string;
    authToken: string;
    callerName: string;
    callerAvatarBase64?: string;  // v7.0: Avatar de l'appelant
  } | null = null;
  
  // Listeners
  private stateListeners: Set<CallStateListener> = new Set();
  private incomingCallListeners: Set<IncomingCallListener> = new Set();
  
  // Callback pour envoyer les signaux
  private signalCallback: ((sessionId: string, signal: CallSignalData) => Promise<void>) | null = null;
  
  // Flag pour savoir si le crypto est prêt
  private cryptoReady: boolean = false;
  
  // FIX: Promise de cleanup en cours — empêche un nouvel appel avant que
  // le cleanup du précédent (y compris le message call-ended) soit terminé.
  private cleanupPromise: Promise<void> | null = null;

  // v7.2 Edge #2: Tracking des messages call-ended reçus (pour annuler le fallback du callee)
  private receivedCallEndedIds: Set<string> = new Set();

  /**
   * v7.2 FIX #1: Connecte le callback pour livrer les paquets audio
   * déchiffrés lors du flush du buffer précoce vers le playback.
   */
  private setupCryptoFlushCallback(): void {
    setCallCryptoOnDecryptedAudio((audioData: Uint8Array) => {
      const participantId = this.remoteSenderTokenHash || 'flushed_early';
      addAudioToBuffer(participantId, audioData);
    });
  }

  /**
   * v7.2 Edge #2: Marque un callId comme ayant reçu son message call-ended.
   * Appelé depuis api1to1.ts quand un message de type 'call' est reçu.
   */
  markCallEndedReceived(callId: string): void {
    this.receivedCallEndedIds.add(callId);
    // Cleanup après 30s pour éviter les fuites mémoire
    setTimeout(() => this.receivedCallEndedIds.delete(callId), 30000);
  }

  private callEndedMessageReceived(callId: string): boolean {
    return this.receivedCallEndedIds.has(callId);
  }

  // ============================================
  // LISTENERS
  // ============================================

  addStateListener(listener: CallStateListener): () => void {
    this.stateListeners.add(listener);
    if (this.currentCall) {
      listener(this.currentCall);
    }
    return () => this.stateListeners.delete(listener);
  }

  addIncomingCallListener(listener: IncomingCallListener): () => void {
    this.incomingCallListeners.add(listener);
    return () => this.incomingCallListeners.delete(listener);
  }

  setSignalCallback(callback: (sessionId: string, signal: CallSignalData) => Promise<void>): void {
    this.signalCallback = callback;
    
    // Configurer aussi le callback pour les signaux crypto
    setCallCryptoSignalCallback(async (sessionId, cryptoSignal) => {
      if (this.signalCallback) {
        await this.signalCallback(sessionId, {
          type: 'crypto',
          callId: this.currentCall?.callId || '',
          cryptoSignal,
          timestamp: Date.now(),
        });
      }
    });
  }

  private notifyStateChange(): void {
    // IMPORTANT: Créer une copie pour forcer React à détecter le changement
    // Notifier avec l'état actuel, même si c'est null (pour signaler fin d'appel)
    const state = this.currentCall ? { ...this.currentCall } : null;
    this.stateListeners.forEach(listener => listener(state));
  }

  private notifyIncomingCall(sessionId: string, callId: string, callerName: string, callerAvatarBase64?: string): void {
    this.incomingCallListeners.forEach(listener => listener(sessionId, callId, callerName, callerAvatarBase64));
  }

  // ============================================
  // GETTERS
  // ============================================

  getState(): Call1to1Info | null {
    return this.currentCall;
  }

  isInCall(): boolean {
    return this.currentCall !== null && 
           this.currentCall.state !== 'idle' && 
           this.currentCall.state !== 'ended';
  }

  // ============================================
  // INITIER UN APPEL
  // ============================================

  async startCall(sessionId: string, contactName: string): Promise<{ success: boolean; error?: string }> {
    __DEV__ && console.log('[Call1to1] 📞 Starting call to session:', sessionId.slice(0, 12) + '...');
    
    // FIX: Attendre que le cleanup du précédent appel soit terminé
    // (y compris l'envoi du message call-ended et le reset audio).
    // Sans ça, startCall() peut trouver isInCall()=false mais l'audio
    // et le ratchet sont encore dans un état intermédiaire.
    if (this.cleanupPromise) {
      __DEV__ && console.log('[Call1to1] ⏳ Waiting for previous call cleanup...');
      try {
        await this.cleanupPromise;
      } catch (e) {
        console.warn('[Call1to1] Previous cleanup had error:', e);
      }
      __DEV__ && console.log('[Call1to1] ✅ Previous cleanup finished');
    }
    
    // Réinitialiser les compteurs de debug
    this.audioPacketCount = 0;
    this.receivedAudioCount = 0;
    this.cleanupInProgress = false;
    this.cryptoReady = false;
    
    if (this.isInCall()) {
      __DEV__ && console.log('[Call1to1] ❌ Already in a call');
      return { success: false, error: 'Déjà en appel' };
    }

    if (!SFU_URL) {
      __DEV__ && console.log('[Call1to1] ❌ SFU URL not configured');
      return { success: false, error: 'SFU non configuré' };
    }

    try {
      // Générer un ID d'appel unique
      const callId = `call1to1_${Date.now()}_${encodeBase64(getRandomBytes(8)).replace(/[+/=]/g, '')}`;
      
      // Générer roomTag et authToken
      // Le roomTag doit être 32 caractères hexadécimaux pour matcher le pattern du relay
      const randomBytes = getRandomBytes(16);
      this.roomTag = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      
      // Générer un authToken basé sur le roomTag
      const authKeyMaterial = getRandomBytes(32);
      this.authToken = await generateRoomAuthToken(authKeyMaterial, callId);
      
      // Générer mon senderToken unique pour cet appel (pour identification SFU)
      this.mySenderToken = encodeBase64(getRandomBytes(16));
      
      // v7.0: Récupérer l'avatar du contact depuis la session
      const session = sessionService.getSession(sessionId);
      const contactAvatarBase64 = session?.theirProfile?.avatarBase64;
      
      // Initialiser l'état
      this.currentCall = {
        callId,
        sessionId,
        state: 'outgoing',
        isOutgoing: true,
        remoteDisplayName: contactName,
        remoteAvatarBase64: contactAvatarBase64,  // v7.0: Avatar du contact
        startedAt: null,
        duration: 0,
        isMuted: false,
        isSpeakerOn: false,
      };
      this.notifyStateChange();

      // Initialiser le chiffrement audio avec Triple Ratchet
      // Les clés sont dérivées depuis la session existante
      const cryptoResult = await initializeCallCrypto(sessionId, callId, true);
      if (!cryptoResult.success) {
        __DEV__ && console.log('[Call1to1] ❌ Failed to initialize call crypto:', cryptoResult.error);
        await this.cleanup();
        return { success: false, error: cryptoResult.error || 'Erreur de chiffrement' };
      }
      this.cryptoReady = true;
      // v7.2 FIX #1: Connecter le callback pour les paquets flushed
      this.setupCryptoFlushCallback();
      __DEV__ && console.log('[Call1to1] ✅ Audio Triple Ratchet initialized (initiator)');

      // Initialiser l'audio
      await initializeAudio();
      __DEV__ && console.log('[Call1to1] ✅ Audio initialized');

      // Configurer les callbacks WebRTC
      this.setupWebRTCCallbacks();

      // Se connecter au SFU via double-hop
      const mySenderTokenHash = hashSenderToken(this.mySenderToken);
      __DEV__ && console.log('[Call1to1] 🔗 Connecting to SFU via double-hop...');
      
      const connected = await connectToSfu(
        SFU_URL,
        this.roomTag,
        callId, // peerId = callId pour simplicité
        mySenderTokenHash,
        this.authToken
      );

      if (!connected) {
        __DEV__ && console.log('[Call1to1] ❌ Failed to connect to SFU');
        await this.cleanup();
        return { success: false, error: 'Impossible de se connecter au serveur' };
      }

      __DEV__ && console.log('[Call1to1] ✅ Connected to SFU (double-hop)');

      // Envoyer l'offre via Triple Ratchet
      const signal: CallSignalData = {
        type: 'offer',
        callId,
        roomTag: this.roomTag,
        authToken: this.authToken,
        timestamp: Date.now(),
      };

      if (this.signalCallback) {
        await this.signalCallback(sessionId, signal);
        __DEV__ && console.log('[Call1to1] ✅ Offer sent');
      }

      // Tonalité de retour d'appel (boucle jusqu'à la réponse)
      startRingback().catch(e => __DEV__ && console.warn('[Call1to1] Ringback failed:', e));

      // NOTE: Pas besoin d'envoyer de SenderKey !
      // Les clés audio sont dérivées depuis la session Triple Ratchet partagée.
      // Les deux parties obtiennent automatiquement les mêmes clés.

      // Démarrer la capture audio avec le callback d'envoi
      await startCapture(this.handleAudioCaptured.bind(this));
      // Forcer earpiece après le start (prepareToRecordAsync peut reset le routage)
      await setAudioSpeaker(false);
      __DEV__ && console.log('[Call1to1] ✅ Audio capture started (earpiece)');

      // Timeout si pas de réponse
      this.callTimeout = setTimeout(async () => {
        if (this.currentCall?.state === 'outgoing') {
          __DEV__ && console.log('[Call1to1] ⏰ Call timeout - no answer');
          
          // Envoyer un signal hangup pour notifier le receveur que l'appel est terminé
          // Cela évite que le receveur reste bloqué sur l'écran d'appel entrant
          if (this.signalCallback) {
            try {
              await this.signalCallback(this.currentCall.sessionId, {
                type: 'hangup',
                callId: this.currentCall.callId,
                timestamp: Date.now(),
              });
              __DEV__ && console.log('[Call1to1] ⏰ Timeout hangup signal sent');
            } catch (e) {
              console.error('[Call1to1] ⏰ Failed to send timeout hangup:', e);
            }
          }
          
          this.endCall('timeout');
        }
      }, CALL_TIMEOUT_MS);

      return { success: true };

    } catch (error) {
      console.error('[Call1to1] ❌ Start call error:', error);
      await this.cleanup();
      return { success: false, error: String(error) };
    }
  }

  // ============================================
  // RECEVOIR UN APPEL (traitement du signal offer)
  // ============================================

  async handleIncomingOffer(
    sessionId: string, 
    callId: string, 
    roomTag: string,
    authToken: string,
    callerName: string,
    callerAvatarBase64?: string  // v7.0: Avatar de l'appelant
  ): Promise<void> {
    __DEV__ && console.log('[Call1to1] 📲 Incoming call from:', callerName);

    // FIX: Attendre la fin du cleanup d'un éventuel appel précédent
    // Sans ça, le cleanup peut écraser le nouveau currentCall avec null.
    if (this.cleanupPromise) {
      __DEV__ && console.log('[Call1to1] ⏳ Waiting for previous cleanup before handling offer...');
      try { await this.cleanupPromise; } catch (e) {}
    }

    if (this.isInCall()) {
      // ══════════════════════════════════════════════════════════════
      // v7.2 GLARE DETECTION : On est en appel sortant VERS la même personne ?
      // Si oui, résolution déterministe par comparaison de fingerprints.
      // ══════════════════════════════════════════════════════════════
      if (this.currentCall?.state === 'outgoing' && 
          this.currentCall?.sessionId === sessionId) {
        
        __DEV__ && console.log('[Call1to1] ⚡ GLARE detected! Both calling each other.');
        
        const session = sessionService.getSession(sessionId);
        if (session) {
          const myFp = session.myIdentityKeyFingerprint;
          const theirFp = session.theirIdentityKeyFingerprint;
          
          __DEV__ && console.log(
            `[Call1to1] ⚡ Glare resolution: my=${myFp.slice(0,8)} vs their=${theirFp.slice(0,8)}`
          );
          
          if (myFp >= theirFp) {
            // ═══ JE GAGNE : Mon fingerprint est plus élevé (ou égal = tiebreak) ═══
            // Je garde mon appel sortant. L'autre va perdre de son côté,
            // abandonner son appel sortant, et accepter mon offer.
            // Note: >= au lieu de > pour garantir un gagnant déterministe
            // même si les fingerprints sont identiques (astronomiquement improbable
            // mais provoquerait un deadlock sinon).
            __DEV__ && console.log('[Call1to1] ⚡ I WIN glare — keeping my outgoing call');
            return;
            
          } else {
            // ═══ JE PERDS : Mon fingerprint est plus bas ═══
            // J'abandonne mon appel sortant et j'accepte le leur AUTOMATIQUEMENT.
            // L'utilisateur a déjà pressé "Appeler" → on ne montre pas un écran
            // "Appel entrant" qui forcerait un second tap "Accepter".
            __DEV__ && console.log('[Call1to1] ⚡ I LOSE glare — dropping my outgoing, auto-accepting theirs');
            
            // 1. Annuler le timeout de mon appel sortant
            if (this.callTimeout) {
              clearTimeout(this.callTimeout);
              this.callTimeout = null;
            }
            if (this.durationInterval) {
              clearInterval(this.durationInterval);
              this.durationInterval = null;
            }
            
            // 2. Cleanup rapide des ressources de mon appel sortant
            try {
              await stopCapture();
              await stopPlayback();
              await cleanupAudio();
            } catch (e) {}
            disconnectFromSfu();
            clearNotifiedPeers();
            cleanupCallCrypto();
            this.cryptoReady = false;
            this.roomTag = '';
            this.authToken = '';
            this.mySenderToken = '';
            this.remoteSenderTokenHash = '';
            this.audioPacketCount = 0;
            this.receivedAudioCount = 0;
            
            // 3. Reset l'état pour accepter le nouvel appel
            this.currentCall = null;
            
            // 4. Préparer le pendingOffer pour acceptCall()
            this.pendingOffer = {
              callId,
              roomTag,
              authToken,
              callerName,
              callerAvatarBase64,
            };
            
            // 5. Créer un état minimal pour acceptCall()
            this.currentCall = {
              callId,
              sessionId,
              state: 'incoming',
              isOutgoing: false,
              remoteDisplayName: callerName,
              remoteAvatarBase64: callerAvatarBase64,
              startedAt: null,
              duration: 0,
              isMuted: false,
              isSpeakerOn: false,
            };
            
            // 6. AUTO-ACCEPT : l'utilisateur a déjà pressé "Appeler",
            // pas besoin de montrer un écran d'appel entrant.
            // On notifie d'abord l'état 'connecting' pour que l'UI
            // garde l'overlay d'appel visible (sans transition entrant→connecté)
            __DEV__ && console.log('[Call1to1] ⚡ Glare auto-accepting...');
            const autoAcceptResult = await this.acceptCall();
            
            if (!autoAcceptResult.success) {
              __DEV__ && console.log('[Call1to1] ⚡ Glare auto-accept failed:', autoAcceptResult.error);
              await this.cleanup();
            }
            
            return; // Ne PAS tomber dans le traitement normal ci-dessous
          }
        } else {
          // Session introuvable — fallback : envoyer busy
          __DEV__ && console.log('[Call1to1] ⚡ Glare but no session — sending busy');
          if (this.signalCallback) {
            await this.signalCallback(sessionId, {
              type: 'busy',
              callId,
              timestamp: Date.now(),
            });
          }
          return;
        }
        
      } else {
        // ══════════════════════════════════════════════════════════════
        // VRAI BUSY : En appel avec QUELQU'UN D'AUTRE ou état non-outgoing
        // ══════════════════════════════════════════════════════════════
        __DEV__ && console.log('[Call1to1] ❌ Already in call, sending busy signal');
        if (this.signalCallback) {
          await this.signalCallback(sessionId, {
            type: 'busy',
            callId,
            timestamp: Date.now(),
          });
        }
        return;
      }
    }

    // ══════════════════════════════════════════════════════════════
    // TRAITEMENT NORMAL DE L'OFFRE ENTRANTE
    // (atteint directement ou après résolution de glare "je perds")
    // ══════════════════════════════════════════════════════════════

    // Stocker l'offre pour acceptCall()
    this.pendingOffer = {
      callId,
      roomTag,
      authToken,
      callerName,
      callerAvatarBase64,  // v7.0: Stocker l'avatar
    };

    // Initialiser l'état
    this.currentCall = {
      callId,
      sessionId,
      state: 'incoming',
      isOutgoing: false,
      remoteDisplayName: callerName,
      remoteAvatarBase64: callerAvatarBase64,  // v7.0: Stocker l'avatar
      startedAt: null,
      duration: 0,
      isMuted: false,
      isSpeakerOn: false,
    };
    
    this.notifyStateChange();
    this.notifyIncomingCall(sessionId, callId, callerName, callerAvatarBase64);

    // Sonnerie d'appel entrant (boucle jusqu'à réponse/refus)
    startRingtone().catch(e => __DEV__ && console.warn('[Call1to1] Ringtone failed:', e));

    // Timeout si pas de réponse de l'utilisateur
    this.callTimeout = setTimeout(() => {
      if (this.currentCall?.state === 'incoming') {
        __DEV__ && console.log('[Call1to1] ⏰ Incoming call timeout');
        this.endCall('timeout');
      }
    }, CALL_TIMEOUT_MS);
  }

  // ============================================
  // ACCEPTER UN APPEL ENTRANT
  // ============================================

  async acceptCall(): Promise<{ success: boolean; error?: string }> {
    __DEV__ && console.log('[Call1to1] ✅ Accepting call...');

    // FIX: Attendre que le cleanup d'un éventuel appel précédent soit terminé
    if (this.cleanupPromise) {
      __DEV__ && console.log('[Call1to1] ⏳ Waiting for previous call cleanup before accept...');
      try { await this.cleanupPromise; } catch (e) {}
    }

    // Réinitialiser les compteurs de debug
    this.audioPacketCount = 0;
    this.receivedAudioCount = 0;
    this.cleanupInProgress = false;
    this.cryptoReady = false;

    if (!this.currentCall || this.currentCall.state !== 'incoming') {
      return { success: false, error: 'Pas d\'appel entrant' };
    }

    if (!this.pendingOffer) {
      return { success: false, error: 'Offre manquante' };
    }

    try {
      // Annuler le timeout
      if (this.callTimeout) {
        clearTimeout(this.callTimeout);
        this.callTimeout = null;
      }

      this.currentCall.state = 'connecting';
      this.notifyStateChange();

      const { callId, roomTag, authToken } = this.pendingOffer;
      this.roomTag = roomTag;
      this.authToken = authToken;
      
      // Générer mon senderToken (pour identification SFU uniquement)
      this.mySenderToken = encodeBase64(getRandomBytes(16));
      
      // Initialiser le chiffrement audio avec Triple Ratchet
      // En tant que répondeur, on dérive les mêmes clés depuis la même session
      const cryptoResult = await initializeCallCrypto(
        this.currentCall.sessionId, 
        callId, 
        false // isInitiator = false pour le répondeur
      );
      if (!cryptoResult.success) {
        __DEV__ && console.log('[Call1to1] ❌ Failed to initialize call crypto:', cryptoResult.error);
        await this.cleanup();
        return { success: false, error: cryptoResult.error || 'Erreur de chiffrement' };
      }
      this.cryptoReady = true;
      // v7.2 FIX #1: Connecter le callback pour les paquets flushed
      this.setupCryptoFlushCallback();
      __DEV__ && console.log('[Call1to1] ✅ Audio Triple Ratchet initialized (responder)');

      // Initialiser l'audio
      await initializeAudio();
      __DEV__ && console.log('[Call1to1] ✅ Audio initialized');

      // Configurer les callbacks WebRTC
      this.setupWebRTCCallbacks();

      // Se connecter au SFU
      const mySenderTokenHash = hashSenderToken(this.mySenderToken);
      __DEV__ && console.log('[Call1to1] 🔗 Connecting to SFU via double-hop...');
      
      const connected = await connectToSfu(
        SFU_URL,
        roomTag,
        `peer_${Date.now()}`, // peerId unique
        mySenderTokenHash,
        authToken
      );

      if (!connected) {
        __DEV__ && console.log('[Call1to1] ❌ Failed to connect to SFU');
        await this.cleanup();
        return { success: false, error: 'Impossible de se connecter au serveur' };
      }

      __DEV__ && console.log('[Call1to1] ✅ Connected to SFU (double-hop)');

      // Définir le timestamp de début AVANT d'envoyer le signal
      // Ce timestamp sera partagé avec l'initiator pour synchroniser les chronos
      const callStartedAt = Date.now();

      // Envoyer la réponse via Triple Ratchet avec le timestamp de début
      const signal: CallSignalData = {
        type: 'answer',
        callId,
        callStartedAt, // Timestamp partagé pour synchroniser les chronos
        timestamp: Date.now(),
      };

      if (this.signalCallback) {
        await this.signalCallback(this.currentCall.sessionId, signal);
        __DEV__ && console.log('[Call1to1] ✅ Answer sent with startedAt:', callStartedAt);
      }

      // NOTE: Pas besoin d'envoyer de SenderKey !
      // Les clés audio sont dérivées depuis la session Triple Ratchet partagée.

      // Démarrer la capture audio avec le callback d'envoi
      await startCapture(this.handleAudioCaptured.bind(this));
      __DEV__ && console.log('[Call1to1] ✅ Audio capture started');

      // Démarrer la lecture audio
      await startPlayback();
      // Forcer earpiece après capture + playback (les deux peuvent reset le routage)
      await setAudioSpeaker(false);
      __DEV__ && console.log('[Call1to1] ✅ Audio playback started (earpiece)');

      // Avec le nouveau système, on est connecté dès que le crypto est prêt
      // car les deux parties ont les mêmes clés dérivées
      if (this.cryptoReady && this.currentCall) {
        __DEV__ && console.log('[Call1to1] ✅ Crypto ready, going to connected!');
        this.currentCall.state = 'connected';
        this.currentCall.startedAt = callStartedAt; // Utiliser le même timestamp
        this.startDurationTimer();
        this.notifyStateChange();
        __DEV__ && console.log('[Call1to1] ✅ Call connected!');
      }

      this.pendingOffer = null;

      return { success: true };

    } catch (error) {
      console.error('[Call1to1] ❌ Accept call error:', error);
      await this.cleanup();
      return { success: false, error: String(error) };
    }
  }

  // ============================================
  // REFUSER UN APPEL
  // ============================================

  async declineCall(): Promise<{ success: boolean; error?: string }> {
    __DEV__ && console.log('[Call1to1] ❌ Declining call...');

    if (!this.currentCall || this.currentCall.state !== 'incoming') {
      return { success: false, error: 'Pas d\'appel entrant' };
    }

    try {
      if (this.signalCallback) {
        await this.signalCallback(this.currentCall.sessionId, {
          type: 'decline',
          callId: this.currentCall.callId,
          timestamp: Date.now(),
        });
      }

      this.endCall('declined');
      return { success: true };

    } catch (error) {
      console.error('[Call1to1] ❌ Decline error:', error);
      return { success: false, error: String(error) };
    }
  }

  // ============================================
  // RACCROCHER
  // ============================================

  async hangup(): Promise<{ success: boolean; error?: string }> {
    __DEV__ && console.log('[Call1to1] 📴 Hanging up...');

    if (!this.currentCall) {
      return { success: false, error: 'Pas d\'appel en cours' };
    }

    try {
      // FIX: Stop the duration timer IMMEDIATELY before the async signal send.
      // Without this, the 1s interval fires during the await below and sends
      // a { state: 'connected' } notification to the UI, which briefly reopens
      // the call overlay after the UI already set callInfo to null.
      if (this.durationInterval) {
        clearInterval(this.durationInterval);
        this.durationInterval = null;
      }
      if (this.callTimeout) {
        clearTimeout(this.callTimeout);
        this.callTimeout = null;
      }

      if (this.signalCallback) {
        await this.signalCallback(this.currentCall.sessionId, {
          type: 'hangup',
          callId: this.currentCall.callId,
          timestamp: Date.now(),
        });
      }

      this.endCall('local_hangup');
      return { success: true };

    } catch (error) {
      console.error('[Call1to1] ❌ Hangup error:', error);
      return { success: false, error: String(error) };
    }
  }

  // ============================================
  // TRAITEMENT DES SIGNAUX REÇUS
  // ============================================

  async handleSignal(sessionId: string, signal: CallSignalData, senderName: string, senderAvatarBase64?: string): Promise<void> {
    __DEV__ && console.log('[Call1to1] 📨 Received signal:', signal.type, 'for call:', signal.callId.slice(0, 16) + '...');

    // FIX: Rejeter les signaux retardataires pour un appel terminé/en cleanup.
    if (signal.type !== 'offer' && signal.type !== 'crypto' && this.currentCall?.state === 'ended') {
      __DEV__ && console.log('[Call1to1] ⚠️ Ignoring stale signal', signal.type, '- call already ended');
      return;
    }

    // v7.2 CRITICAL FIX: Les signaux 'crypto' DOIVENT passer même sans appel en cours !
    // L'initiateur envoie crypto_init AVANT l'offer. Côté récepteur, le signal crypto
    // arrive donc AVANT que l'offer ne crée currentCall. Si on le rejette ici,
    // callCryptoService ne stocke jamais pendingInitiatorInit, et le responder
    // dérive ses propres clés depuis un rootKey différent → déchiffrement échoue à 100%.
    // callCryptoService.handleSignal() sait déjà stocker le signal pour usage futur.
    if (signal.type !== 'offer' && signal.type !== 'crypto' && !this.currentCall) {
      __DEV__ && console.log('[Call1to1] ⚠️ Ignoring signal', signal.type, '- no active call');
      return;
    }

    // FIX: Rejeter les signaux pour un callId différent (appel précédent)
    if (signal.type !== 'offer' && signal.type !== 'crypto' && this.currentCall && this.currentCall.callId !== signal.callId) {
      __DEV__ && console.log('[Call1to1] ⚠️ Ignoring signal for old callId:', signal.callId.slice(0, 16), 'current:', this.currentCall.callId.slice(0, 16));
      return;
    }

    switch (signal.type) {
      case 'offer':
        if (signal.roomTag && signal.authToken) {
          await this.handleIncomingOffer(
            sessionId, 
            signal.callId, 
            signal.roomTag, 
            signal.authToken, 
            senderName,
            senderAvatarBase64  // v7.0: Passer l'avatar
          );
        }
        break;

      case 'answer':
        this.handleAnswer(signal.callStartedAt);
        break;

      case 'crypto':
        if (signal.cryptoSignal) {
          this.handleCryptoSignal(signal.cryptoSignal);
        }
        break;

      case 'hangup':
        this.handleRemoteHangup();
        break;

      case 'decline':
        this.handleDeclined();
        break;

      case 'busy':
        this.handleBusy();
        break;
    }
  }

  private handleAnswer(callStartedAt?: number): void {
    __DEV__ && console.log('[Call1to1] 📨 Received answer, startedAt:', callStartedAt);

    if (!this.currentCall || this.currentCall.state === 'ended') {
      __DEV__ && console.log('[Call1to1] ⚠️ No active call for answer (state:', this.currentCall?.state, ')');
      return;
    }

    // Annuler le timeout
    if (this.callTimeout) {
      clearTimeout(this.callTimeout);
      this.callTimeout = null;
    }

    // Démarrer la lecture audio
    startPlayback();
    __DEV__ && console.log('[Call1to1] ✅ Audio playback started');

    // Avec le nouveau système Triple Ratchet, les clés sont déjà dérivées
    // donc on peut passer directement à connected
    if (this.cryptoReady && this.currentCall.state !== 'connected') {
      // Arrêter le ringback/ringtone et jouer le bip de connexion
      stopTone().then(() => playConnectedBeep()).catch(() => {});
      
      this.currentCall.state = 'connected';
      // Utiliser le timestamp du responder pour synchroniser les chronos
      // Si pas disponible (ancienne version), utiliser Date.now()
      this.currentCall.startedAt = callStartedAt || Date.now();
      this.startDurationTimer();
      this.notifyStateChange();
      __DEV__ && console.log('[Call1to1] ✅ Call connected! (synced startedAt:', this.currentCall.startedAt, ')');
    }
  }

  private handleCryptoSignal(cryptoSignal: CallCryptoSignal): void {
    __DEV__ && console.log('[Call1to1] 🔐 Processing crypto signal:', cryptoSignal.type);
    
    // Ignorer les signaux crypto pour un appel terminé uniquement
    // v7.2 CRITICAL FIX: NE PAS rejeter quand currentCall est null !
    // Le crypto_init de l'initiateur arrive AVANT l'offer (qui crée currentCall).
    // callCryptoService.handleSignal() stocke le signal dans pendingInitiatorInit
    // pour qu'il soit utilisé plus tard dans initializeCallCrypto().
    if (this.currentCall?.state === 'ended') {
      __DEV__ && console.log('[Call1to1] ⚠️ Ignoring crypto signal - call ended');
      return;
    }
    
    // Déléguer au service crypto avec le callId (peut être undefined si pas encore d'appel)
    handleCallCryptoSignal(cryptoSignal, this.currentCall?.callId);
    
    // Si c'était un signal d'init et qu'on est pas encore connecté, on peut maintenant l'être
    if (cryptoSignal.type === 'call_crypto_init' && this.currentCall) {
      __DEV__ && console.log('[Call1to1] 🔐 Crypto init received from peer');
    }
  }

  private handleRemoteHangup(): void {
    __DEV__ && console.log('[Call1to1] 📴 Remote hangup');
    this.endCall('remote_hangup');
  }

  private handleDeclined(): void {
    __DEV__ && console.log('[Call1to1] ❌ Call declined');
    stopTone().then(() => playBusyTone()).catch(() => {});
    this.endCall('declined');
  }

  private handleBusy(): void {
    __DEV__ && console.log('[Call1to1] 📵 Remote is busy');
    stopTone().then(() => playBusyTone()).catch(() => {});
    this.endCall('busy');
  }

  // ============================================
  // CONTRÔLES AUDIO
  // ============================================

  toggleMute(): boolean {
    if (!this.currentCall) return false;

    this.currentCall.isMuted = !this.currentCall.isMuted;
    setAudioMuted(this.currentCall.isMuted);
    this.notifyStateChange();
    __DEV__ && console.log('[Call1to1] 🔇 Mute:', this.currentCall.isMuted);
    return this.currentCall.isMuted;
  }

  toggleSpeaker(): boolean {
    if (!this.currentCall) return false;
    
    this.currentCall.isSpeakerOn = !this.currentCall.isSpeakerOn;
    // setSpeaker is async but handles recording-safety internally
    // (queues change between recording cycles if recording is active)
    setAudioSpeaker(this.currentCall.isSpeakerOn);
    this.notifyStateChange();
    __DEV__ && console.log('[Call1to1] 🔊 Speaker:', this.currentCall.isSpeakerOn);
    return this.currentCall.isSpeakerOn;
  }

  // ============================================
  // CALLBACKS WebRTC (SFU)
  // ============================================

  private setupWebRTCCallbacks(): void {
    setWebRTCCallbacks({
      onConnectionStateChange: (state) => {
        __DEV__ && console.log('[Call1to1] 🔗 SFU connection state:', state);
        if (state === 'failed' || state === 'disconnected') {
          if (this.currentCall && this.currentCall.state !== 'ended') {
            __DEV__ && console.log('[Call1to1] ❌ SFU connection lost');
            this.endCall('error');
          }
        }
      },
      onPeerJoined: (peerId, senderTokenHash) => {
        __DEV__ && console.log('[Call1to1] 👤 Peer joined:', peerId.slice(0, 12) + '...', 'token:', senderTokenHash.slice(0, 8) + '...');
        this.remoteSenderTokenHash = senderTokenHash;
      },
      onPeerLeft: (peerId, senderTokenHash) => {
        __DEV__ && console.log('[Call1to1] 👤 Peer left:', peerId.slice(0, 12) + '...');
        // L'autre a quitté le room SFU → fin d'appel
        if (this.currentCall && this.currentCall.state !== 'ended') {
          this.endCall('remote_hangup');
        }
      },
      onAudioReceived: (senderTokenHash, encryptedAudio) => {
        this.handleIncomingAudio(senderTokenHash, encryptedAudio);
      },
      onError: (error) => {
        console.error('[Call1to1] ❌ SFU error:', error);
      },
    });
  }

  // ============================================
  // ENVOI/RÉCEPTION AUDIO
  // ============================================

  /**
   * Callback appelé quand de l'audio est capturé par le microphone
   * Chiffre avec Audio Triple Ratchet et envoie via le SFU
   */
  private audioPacketCount = 0;
  
  private handleAudioCaptured(audioData: Uint8Array): void {
    // Log périodique pour debug
    this.audioPacketCount++;
    if (this.audioPacketCount % 50 === 1) { // Log toutes les 50 packets (~1 seconde)
      __DEV__ && console.log(`[Call1to1] 🎤 Audio packet #${this.audioPacketCount}, state=${this.currentCall?.state}, cryptoReady=${this.cryptoReady}`);
    }
    
    // Vérifier les conditions
    if (!this.currentCall || this.currentCall.state === 'ended') {
      if (this.audioPacketCount % 50 === 1) {
        __DEV__ && console.log('[Call1to1] ⚠️ Audio ignored: no call or ended');
      }
      return;
    }

    // CORRECTIF v3.1: Ne pas envoyer d'audio tant que l'appel n'est pas CONNECTÉ
    // Ceci évite la désynchronisation du Call Ratchet quand l'autre partie
    // n'est pas encore prête à recevoir (son recvPacketIndex serait à 0
    // alors qu'on aurait déjà envoyé 100+ paquets)
    if (this.currentCall.state !== 'connected') {
      if (this.audioPacketCount % 50 === 1) {
        __DEV__ && console.log(`[Call1to1] ⏳ Audio buffered (waiting for connected state, current: ${this.currentCall.state})`);
      }
      return;
    }

    if (!this.cryptoReady || !isCallCryptoInitialized()) {
      if (this.audioPacketCount % 50 === 1) {
        __DEV__ && console.log('[Call1to1] ⚠️ Audio ignored: crypto not ready');
      }
      return;
    }

    // Si muté, ne pas envoyer (le bruit de confort est géré par audioService)
    if (this.currentCall.isMuted) {
      return;
    }

    try {
      // Chiffrer avec Audio Triple Ratchet
      const encrypted = encryptCallAudio(audioData);
      
      if (encrypted) {
        // Envoyer via SFU (qui route via double-hop)
        const sent = sendAudio(encrypted);
        
        if (this.audioPacketCount % 50 === 1) {
          __DEV__ && console.log(`[Call1to1] 📤 Audio sent: ${sent}, size=${encrypted.length}`);
        }
      } else {
        if (this.audioPacketCount % 50 === 1) {
          __DEV__ && console.log('[Call1to1] ⚠️ Audio encryption failed');
        }
      }
      
    } catch (error) {
      console.error('[Call1to1] ❌ Audio encrypt/send error:', error);
    }
  }

  private receivedAudioCount = 0;
  
  private handleIncomingAudio(senderTokenHash: string, encryptedAudio: Uint8Array): void {
    this.receivedAudioCount++;
    
    if (this.receivedAudioCount % 50 === 1) { // Log toutes les 50 packets
      __DEV__ && console.log(`[Call1to1] 🔊 Received audio #${this.receivedAudioCount}, size=${encryptedAudio.length}, cryptoReady=${this.cryptoReady}`);
    }
    
    if (!this.cryptoReady || !isCallCryptoInitialized()) {
      if (this.receivedAudioCount % 50 === 1) {
        __DEV__ && console.log('[Call1to1] ⚠️ Audio received but crypto not ready');
      }
      return;
    }

    try {
      // Déchiffrer avec Audio Triple Ratchet
      const decrypted = decryptCallAudio(encryptedAudio);
      
      if (decrypted) {
        // Ajouter au buffer de lecture
        addAudioToBuffer(senderTokenHash, decrypted);
        
        if (this.receivedAudioCount % 50 === 1) {
          __DEV__ && console.log(`[Call1to1] ✅ Audio decrypted and buffered, size=${decrypted.length}`);
        }
      } else {
        if (this.receivedAudioCount % 50 === 1) {
          __DEV__ && console.log('[Call1to1] ⚠️ Audio decryption returned null');
        }
      }
    } catch (error) {
      console.error('[Call1to1] ❌ Audio decrypt error:', error);
    }
  }

  // ============================================
  // FETCH RETRIES POUR MESSAGES DE FIN D'APPEL
  // ============================================

  /**
   * Programme plusieurs tentatives de fetch pour récupérer le message de fin d'appel
   * envoyé par l'autre partie. Utilisé côté receveur quand l'appelant doit envoyer le message.
   */
  private scheduleFetchRetries(sessionId: string, reason: string): void {
    __DEV__ && console.log(`[Call1to1] 📞 Scheduling fetch retries for ${reason}...`);
    
    // Premier fetch après 1.5s
    setTimeout(async () => {
      __DEV__ && console.log(`[Call1to1] 📞 Fetch retry 1/3 for ${reason}...`);
      await forceFetchAndNotify1to1(sessionId);
    }, 1500);
    
    // Deuxième fetch après 3.5s
    setTimeout(async () => {
      __DEV__ && console.log(`[Call1to1] 📞 Fetch retry 2/3 for ${reason}...`);
      await forceFetchAndNotify1to1(sessionId);
    }, 3500);
    
    // Troisième fetch après 6s (dernier recours)
    setTimeout(async () => {
      __DEV__ && console.log(`[Call1to1] 📞 Fetch retry 3/3 for ${reason}...`);
      await forceFetchAndNotify1to1(sessionId);
    }, 6000);
  }

  // ============================================
  // GESTION DE LA DURÉE
  // ============================================

  private startDurationTimer(): void {
    this.durationInterval = setInterval(() => {
      if (this.currentCall && this.currentCall.startedAt) {
        this.currentCall.duration = Math.floor((Date.now() - this.currentCall.startedAt) / 1000);
        this.notifyStateChange();
      }
    }, 1000);
  }

  // ============================================
  // CLEANUP
  // ============================================

  private endCall(reason: CallEndReason): void {
    // Protection contre les appels multiples
    if (!this.currentCall || this.currentCall.state === 'ended') {
      __DEV__ && console.log('[Call1to1] ⚠️ endCall called but already ended, ignoring');
      return;
    }
    
    __DEV__ && console.log('[Call1to1] 📴 Ending call, reason:', reason);

    // Arrêter toute tonalité en cours (ringback, ringtone, busy...)
    stopTone().catch(() => {});

    // FIX: Stopper les timers IMMÉDIATEMENT pour empêcher le durationInterval
    // d'envoyer un notifyStateChange() avec state='connected' après qu'on ait
    // notifié state='ended'. Critique pour handleRemoteHangup() où hangup()
    // n'a pas eu l'occasion de stopper les timers.
    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }
    if (this.callTimeout) {
      clearTimeout(this.callTimeout);
      this.callTimeout = null;
    }

    // Capturer les infos avant de changer l'état
    const callInfo = { ...this.currentCall };
    const endedAt = Date.now();
    
    this.currentCall.state = 'ended';
    this.notifyStateChange();

    // FIX: Créer une promesse qui séquence correctement :
    // 1. Envoyer le message call-ended (avance le ratchet)
    // 2. Puis cleanup complet (audio, crypto, SFU)
    // startCall() attend cette promesse avant de démarrer un nouvel appel,
    // ce qui empêche la race condition ratchet quand on rappelle vite.
    this.cleanupPromise = this.sequencedCleanup(callInfo, reason, endedAt);
  }

  /**
   * Exécute le cleanup séquencé : message call-ended puis libération des ressources.
   * Retourne une promesse que startCall() attend avant de démarrer.
   */
  private async sequencedCleanup(
    callInfo: Call1to1Info,
    reason: CallEndReason,
    endedAt: number
  ): Promise<void> {
    try {
      // Étape 1: Envoyer le message call-ended (avance le ratchet d'un cran)
      await this.sendCallEndedMessageAsync(callInfo, reason, endedAt);
    } catch (e) {
      console.error('[Call1to1] ❌ sendCallEndedMessageAsync failed:', e);
    }
    
    // Étape 2: Cleanup des ressources (audio, crypto, SFU)
    await this.cleanup();
    
    // Cleanup terminé, effacer la promesse
    this.cleanupPromise = null;
  }

  /**
   * Envoie le message "Appel terminé" avec la durée
   * 
   * v7.2 RÈGLE ANTI-DOUBLON RACCROCHÉ SIMULTANÉ:
   * L'INITIATEUR (isOutgoing=true) est TOUJOURS responsable d'envoyer
   * le message "Appel terminé", quel que soit qui raccroche.
   * Le CALLEE ne l'envoie jamais en premier (fallback 8s si initiateur offline).
   * 
   * AVANT: les deux parties envoyaient le message sur local_hangup
   * → doublon dans le chat + double avancement du ratchet.
   */
  private async sendCallEndedMessageAsync(
    callInfo: Call1to1Info,
    reason: CallEndReason,
    endedAt: number
  ): Promise<void> {
    try {
      // ─── CAS 1 : Je suis le CALLEE (non-initiateur) ───
      // Le callee ne prend JAMAIS la responsabilité d'envoyer le message.
      // L'initiateur l'enverra. Fallback après 8s si l'initiateur est offline.
      if (!callInfo.isOutgoing) {
        __DEV__ && console.log(
          `[Call1to1] 📞 I'm callee — deferring call-ended message to initiator (reason: ${reason})`
        );
        
        // Programmer des fetch retries pour récupérer le message de l'initiateur
        this.scheduleFetchRetries(callInfo.sessionId, `callee defer (${reason})`);
        
        // FALLBACK : Si après 8s le message n'est toujours pas arrivé
        // (initiateur offline/crash), le callee l'envoie lui-même.
        const fallbackCallId = callInfo.callId;
        const fallbackSessionId = callInfo.sessionId;
        const fallbackStartedAt = callInfo.startedAt;
        
        setTimeout(async () => {
          // Si le message de l'initiateur est déjà arrivé, ne rien faire
          if (this.callEndedMessageReceived(fallbackCallId)) {
            __DEV__ && console.log('[Call1to1] 📞 Fallback cancelled — initiator message received');
            return;
          }
          
          __DEV__ && console.log('[Call1to1] 📞 Fallback: initiator message not received after 8s, sending myself');
          
          const status = fallbackStartedAt ? 'ended' : 'cancelled';
          const duration = fallbackStartedAt 
            ? Math.floor((endedAt - fallbackStartedAt) / 1000) 
            : 0;
          
          try {
            await sendCallEndedMessage1to1(
              fallbackSessionId,
              fallbackCallId,
              status as any,
              duration,
              fallbackStartedAt || endedAt,
              endedAt
            );
            __DEV__ && console.log('[Call1to1] ✅ Fallback call ended message sent');
          } catch (e) {
            console.error('[Call1to1] ❌ Fallback call ended message failed:', e);
          }
        }, 8000);
        
        return;
      }
      
      // ─── CAS 2 : Je suis l'INITIATEUR (celui qui a appelé) ───
      // Je suis TOUJOURS responsable d'envoyer le message,
      // que j'aie raccroché moi-même ou que l'autre ait raccroché.
      
      __DEV__ && console.log(
        `[Call1to1] 📞 I'm initiator — sending call-ended message (reason: ${reason})`
      );
      
      // Mapper la raison vers un status
      let status: 'ended' | 'missed' | 'declined' | 'cancelled';
      
      switch (reason) {
        case 'local_hangup':
        case 'remote_hangup':
          status = callInfo.startedAt ? 'ended' : 'cancelled';
          break;
        case 'declined':
          status = 'declined';
          break;
        case 'timeout':
          status = 'missed';
          break;
        case 'busy':
        case 'error':
        default:
          status = 'cancelled';
          break;
      }
      
      // Calculer la durée
      const duration = callInfo.startedAt 
        ? Math.floor((endedAt - callInfo.startedAt) / 1000)
        : 0;
      const startedAt = callInfo.startedAt || endedAt;
      
      __DEV__ && console.log(`[Call1to1] 📞 Sending: status=${status}, duration=${duration}s`);
      
      // Petit délai pour laisser le signal hangup arriver en premier
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Envoyer le message
      await sendCallEndedMessage1to1(
        callInfo.sessionId,
        callInfo.callId,
        status,
        duration,
        startedAt,
        endedAt
      );
      
      __DEV__ && console.log('[Call1to1] ✅ Call ended message sent (as initiator)');
      
    } catch (error) {
      console.error('[Call1to1] ❌ Failed to send call ended message:', error);
    }
  }

  private cleanupInProgress = false;
  
  private async cleanup(): Promise<void> {
    // Protection contre les appels multiples
    if (this.cleanupInProgress) {
      __DEV__ && console.log('[Call1to1] ⚠️ Cleanup already in progress, ignoring');
      return;
    }
    this.cleanupInProgress = true;
    
    __DEV__ && console.log('[Call1to1] 🧹 Cleanup...');

    // Annuler les timers
    if (this.callTimeout) {
      clearTimeout(this.callTimeout);
      this.callTimeout = null;
    }

    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }

    // FIX: Await les fonctions audio async.
    // Sans ça, cleanupAudio() n'avait pas le temps de réinitialiser
    // Audio.setAudioModeAsync({ allowsRecordingIOS: false }),
    // et initializeAudio() du prochain appel pouvait trouver
    // state.isInitialized = true (pas encore reset).
    try {
      await stopCapture();
      await stopPlayback();
      await cleanupAudio();
    } catch (e) {
      console.warn('[Call1to1] Audio cleanup error (non-fatal):', e);
    }

    // Déconnecter du SFU
    disconnectFromSfu();
    clearNotifiedPeers();

    // Nettoyer le crypto (effacement sécurisé des clés audio)
    cleanupCallCrypto();
    this.cryptoReady = false;

    // Reset IMMÉDIAT de toutes les variables d'état
    this.roomTag = '';
    this.authToken = '';
    this.mySenderToken = '';
    this.remoteSenderTokenHash = '';
    this.pendingOffer = null;
    this.audioPacketCount = 0;
    this.receivedAudioCount = 0;

    // Réinitialiser l'état pour permettre un nouvel appel
    this.currentCall = null;
    this.cleanupInProgress = false;
    
    // IMPORTANT: Notifier IMMÉDIATEMENT l'UI que l'appel est terminé
    // Ceci permet au bouton d'appel de se réactiver instantanément
    this.notifyStateChange();
    __DEV__ && console.log('[Call1to1] ✅ Cleanup complete, state reset to idle');
  }
}

// ============================================
// SINGLETON EXPORT
// ============================================

export const call1to1Manager = new Call1to1Manager();

// ============================================
// FONCTIONS D'EXPORT SIMPLIFIÉES
// ============================================

export function startCall1to1(sessionId: string, contactName: string) {
  return call1to1Manager.startCall(sessionId, contactName);
}

export function acceptCall1to1() {
  return call1to1Manager.acceptCall();
}

export function declineCall1to1() {
  return call1to1Manager.declineCall();
}

export function hangupCall1to1() {
  return call1to1Manager.hangup();
}

export function toggleMute1to1() {
  return call1to1Manager.toggleMute();
}

export function toggleSpeaker1to1() {
  return call1to1Manager.toggleSpeaker();
}

export function getCall1to1State() {
  return call1to1Manager.getState();
}

export function isInCall1to1() {
  return call1to1Manager.isInCall();
}

export function addCall1to1StateListener(listener: CallStateListener) {
  return call1to1Manager.addStateListener(listener);
}

export function addIncomingCall1to1Listener(listener: IncomingCallListener) {
  return call1to1Manager.addIncomingCallListener(listener);
}

export function setCall1to1SignalCallback(callback: (sessionId: string, signal: CallSignalData) => Promise<void>) {
  call1to1Manager.setSignalCallback(callback);
}

export function handleCall1to1Signal(sessionId: string, signal: CallSignalData, senderName: string, senderAvatarBase64?: string) {
  return call1to1Manager.handleSignal(sessionId, signal, senderName, senderAvatarBase64);
}

// v7.2 Edge #2: Export pour que api1to1 puisse marquer les messages call-ended reçus
export function markCallEndedReceived1to1(callId: string) {
  call1to1Manager.markCallEndedReceived(callId);
}