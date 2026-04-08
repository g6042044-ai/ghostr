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
import { AppState } from 'react-native';
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
  addAudioToBuffer,
  setMuted as setAudioMuted,
  setSpeaker as setAudioSpeaker,
  cleanupAudio,
  startProximityRouteEnforcer,
  startCallAudioPipeline,
  checkAudioHealth,
  resetAudioHealth,
  restartCallAudioPipeline,
} from './audioService';
import { sendCallEndedMessage1to1, forceFetchAndNotify1to1, getLocalMessages1to1 } from './api1to1';
import { forceImmediatePoll } from './constantTraffic';
import { sessionService } from './tripleRatchet';  // v7.0: Pour récupérer l'avatar du contact
import { startRingback, startRingtone, playConnectedBeep, playBusyTone, playEndCallBeep, stopTone, transitionToCallAudio, setCallTonePlayFn, getConnectingBeepPCM } from './callTones';
import { stopRinging, showMissedCallNotification } from './pushNotificationService';

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
const CALL_TIMEOUT_MS = 90_000; // 90s: couvre poll 10s±5s + latence envoi 2s + réaction utilisateur

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

  // Pre-warm state: audio initialized during ringing (local only, safe)
  private preWarmAudioDone: boolean = false;
  private preWarmAudioPromise: Promise<void> | null = null;

  // Tracks whether the offer signal was actually sent to the remote party.
  // If false when hangup is called, the remote never knew → no signal, no chat message.
  private offerSent: boolean = false;

  // v28.0: Tracks whether the caller's audio pipeline was proactively started
  // by onPeerJoined. Prevents double pipeline initialization when handleAnswer
  // arrives later.
  private callerPipelineStarted: boolean = false;
  
  // FIX: Promise de cleanup en cours — empêche un nouvel appel avant que
  // le cleanup du précédent (y compris le message call-ended) soit terminé.
  private cleanupPromise: Promise<void> | null = null;

  // SECURITY FIX P2: Rate-limiting des offers entrants par sessionId.
  // Un pair malveillant peut spam des signals 'offer' → flooding de notifications.
  // On limite à 1 offer accepté toutes les OFFER_RATE_LIMIT_MS par session.
  private lastOfferTimestamp = new Map<string, number>();
  private static readonly OFFER_RATE_LIMIT_MS = 8_000; // 8s entre deux offers d'un même pair

  // v7.2 Edge #2: Tracking des messages call-ended reçus (pour annuler le fallback du callee)
  private receivedCallEndedIds: Set<string> = new Set();

  // v25.1: Audio health monitor — detects silent VP I/O and triggers pipeline restart
  private audioHealthTimer: ReturnType<typeof setInterval> | null = null;
  private audioRestartAttempts = 0;
  // v29.0: Increased from 2 to 3. On iOS, the 2nd restart often fails because
  // the first restart's VP I/O teardown isn't complete yet. The 3rd attempt
  // succeeds because by then ~4.5s have passed, giving CoreAudio enough time
  // to fully reclaim all VP I/O hardware resources.
  private static readonly MAX_AUDIO_RESTARTS = 3;

  // ═══════════════════════════════════════════════════════════════
  // REMOTE AUDIO SILENCE MONITOR
  //
  // Tracks whether remote audio packets are being received.
  // - firstRemoteAudioReceived: false until the first decrypted packet arrives
  //   → connecting tone plays while false, connected beep on transition to true
  // - lastRemoteAudioTime: timestamp of last received packet
  //   → if now - lastRemoteAudioTime > SILENCE_TIMEOUT_MS → end call
  //
  // TIMEOUT: 15 seconds without any remote audio → call ends.
  // This covers: remote app killed, network lost, SFU crash.
  // Faster than SFU WebSocket timeout (~30s).
  // ═══════════════════════════════════════════════════════════════
  private firstRemoteAudioReceived = false;
  private lastRemoteAudioTime = 0;
  private silenceMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly SILENCE_TIMEOUT_MS = 15_000; // 15s sans audio → fin d'appel
  private static readonly SILENCE_CHECK_INTERVAL_MS = 3_000; // Beep cadence + silence check
  private static readonly MAX_CONNECTING_BEEP_MS = 12_000; // v27.0: Stop beeping after 12s max
  private connectingBeepStartTime = 0; // v27.0: Track when connecting beeps started

  // v21.0: Proximity guard REMOVED. InCallManager.start({ media: 'audio' })
  // already manages proximity sensor routing natively. The custom guard was
  // conflicting with InCallManager's built-in handling, causing the audio
  // to switch to SPEAKER when the proximity sensor activated (the exact
  // opposite of desired behavior on Samsung/Android devices).

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

  // ============================================
  // AUDIO HEALTH MONITOR — v25.1
  // ============================================
  // Periodically checks if audio packets are flowing through the native
  // playback engine. If VP I/O (iOS) or AudioTrack (Android) silently dies,
  // this detects the silence and triggers a full pipeline restart.
  // Maximum 2 restarts per call to avoid infinite loops.

  private startAudioHealthMonitor(): void {
    this.stopAudioHealthMonitor();
    this.audioRestartAttempts = 0;
    resetAudioHealth();

    this.audioHealthTimer = setInterval(async () => {
      if (!this.currentCall || this.currentCall.state !== 'connected') {
        this.stopAudioHealthMonitor();
        return;
      }

      const { healthy, silentTicks } = checkAudioHealth();

      if (!healthy && this.audioRestartAttempts < Call1to1Manager.MAX_AUDIO_RESTARTS) {
        this.audioRestartAttempts++;
        __DEV__ && console.log(
          `[Call1to1] ⚠️ Audio silent (${silentTicks} ticks) — ` +
          `restarting pipeline (attempt ${this.audioRestartAttempts}/${Call1to1Manager.MAX_AUDIO_RESTARTS})`
        );

        try {
          const ok = await restartCallAudioPipeline(this.handleAudioCaptured.bind(this));
          if (ok) {
            resetAudioHealth();
            __DEV__ && console.log('[Call1to1] ✅ Audio pipeline restarted successfully');
          } else {
            __DEV__ && console.error('[Call1to1] ❌ Audio pipeline restart failed');
          }
        } catch (e) {
          __DEV__ && console.error('[Call1to1] ❌ Audio pipeline restart error:', e);
        }
      }
    }, 1500); // v29.0: Reduced from 2000ms for faster VP I/O death detection
    __DEV__ && console.log('[Call1to1] 🏥 Audio health monitor started');
  }

  private stopAudioHealthMonitor(): void {
    if (this.audioHealthTimer) {
      clearInterval(this.audioHealthTimer);
      this.audioHealthTimer = null;
    }
  }

  // ============================================
  // SILENCE MONITOR — Remote audio timeout
  // ============================================
  // Detects when the remote party stops sending audio for 15s.
  // Also manages the connecting tone (beep every 3s until first audio).
  //
  // FLOW:
  //   1. Call goes to 'connected' → startSilenceMonitor()
  //   2. Connecting tone plays (beep every 3s)
  //   3. First remote audio packet → stopConnectingTone() + playConnectedBeep()
  //   4. If 15s pass without any remote audio → endCall('error')
  //
  // This is FASTER than SFU WebSocket timeout (~30s) and catches:
  //   - Remote app killed (process death)
  //   - Network lost on remote side
  //   - SFU crash or relay failure

  private setupCallTonePlayFn(): void {
    setCallTonePlayFn((data: Uint8Array) => {
      addAudioToBuffer('_tone_', data);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SILENCE MONITOR — Single timer, no external connecting tone timer.
  //
  // PREVIOUS BUG: startConnectingTone() used its own setInterval in
  // callTones.ts. On iOS, clearInterval via the JS bridge can fail
  // silently → the connecting beep timer kept firing forever even
  // after stopConnectingTone() was called → beep over active audio.
  //
  // FIX: The connecting beep is now played INLINE from the silence
  // monitor's own setInterval tick. Zero external timers to clean up.
  // When firstRemoteAudioReceived becomes true, the beep condition
  // is simply no longer met — no timer to clear, no state to reset.
  // ═══════════════════════════════════════════════════════════════

  private startSilenceMonitor(): void {
    this.stopSilenceMonitor();
    this.lastRemoteAudioTime = Date.now();
    this.connectingBeepStartTime = Date.now(); // v27.0: Track beep start

    // Play first connecting beep immediately (if no audio received yet)
    if (!this.firstRemoteAudioReceived) {
      this.playConnectingBeepInline();
    }

    this.silenceMonitorTimer = setInterval(() => {
      if (!this.currentCall || this.currentCall.state !== 'connected') {
        this.stopSilenceMonitor();
        return;
      }

      // ═══════════════════════════════════════════════════════════════
      // v27.0 FIX: Connecting beep with MAX DURATION.
      //
      // BEFORE: Beep played every 3s until firstRemoteAudioReceived.
      // If remote audio never triggers onRemoteAudioReceived() (e.g.,
      // decryption failures, VP I/O not outputting, or the connected
      // beep condition being missed because audio arrived during
      // 'outgoing' state), the beep played FOREVER.
      //
      // FIX: Stop beeping after MAX_CONNECTING_BEEP_MS regardless.
      // The call will still end via SILENCE_TIMEOUT_MS if no audio.
      // ═══════════════════════════════════════════════════════════════
      if (!this.firstRemoteAudioReceived) {
        const beepElapsed = Date.now() - this.connectingBeepStartTime;
        if (beepElapsed < Call1to1Manager.MAX_CONNECTING_BEEP_MS) {
          this.playConnectingBeepInline();
        } else if (beepElapsed >= Call1to1Manager.MAX_CONNECTING_BEEP_MS && !this.firstRemoteAudioReceived) {
          // Force-mark as received to stop beeping — audio may be flowing
          // but the flag wasn't set (e.g., audio arrived during 'outgoing' state)
          this.firstRemoteAudioReceived = true;
          __DEV__ && console.log('[Call1to1] 🔇 Connecting beep timeout — stopping beeps');
        }
      }

      // Timeout: 15s without any remote audio → end call
      const silenceMs = Date.now() - this.lastRemoteAudioTime;
      if (silenceMs >= Call1to1Manager.SILENCE_TIMEOUT_MS) {
        __DEV__ && console.log(
          `[Call1to1] 🔇 Remote audio silent for ${Math.round(silenceMs / 1000)}s — ending call`
        );
        this.stopSilenceMonitor();
        this.endCall('error');
      }
    }, Call1to1Manager.SILENCE_CHECK_INTERVAL_MS); // 3s = connecting beep cadence

    __DEV__ && console.log('[Call1to1] 🔇 Silence monitor started (beep until audio, timeout 15s, max beep 12s)');
  }

  /** Play a single connecting beep via the call audio pipeline. No timer. */
  private playConnectingBeepInline(): void {
    try {
      const pcm = getConnectingBeepPCM();
      if (pcm) {
        addAudioToBuffer('_tone_', pcm);
      }
    } catch {}
  }

  private stopSilenceMonitor(): void {
    if (this.silenceMonitorTimer) {
      clearInterval(this.silenceMonitorTimer);
      this.silenceMonitorTimer = null;
    }
  }

  /**
   * Called by handleIncomingAudio when a remote audio packet is successfully decrypted.
   *
   * v27.0 FIX: Only trigger connected beep when the call is in 'connected' state.
   * BEFORE: Remote audio could arrive via SFU BEFORE the answer signal (which
   * triggers handleAnswer → state='connected'). onRemoteAudioReceived() would
   * call playConnectedBeep() during state='outgoing', which prematurely cleared
   * ringbackActive → transitionToCallAudio() never called stopRingback().
   */
  private onRemoteAudioReceived(): void {
    this.lastRemoteAudioTime = Date.now();

    if (!this.firstRemoteAudioReceived && this.currentCall?.state === 'connected') {
      this.firstRemoteAudioReceived = true;
      playConnectedBeep().catch(() => {});
      __DEV__ && console.log('[Call1to1] 🔊 First remote audio received — connected beep');
    }
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
      // FIX P2: Ne pas envoyer de signal crypto sans callId valide.
      // Peut arriver si currentCall est null lors d'une race condition.
      // Un callId vide (callId='') cause un mismatch côté récepteur et
      // dégrade la forward secrecy des rotations DH.
      const callId = this.currentCall?.callId;
      if (!callId) {
        __DEV__ && console.warn('[Call1to1] ⚠️ Dropping crypto signal — no active callId');
        return;
      }
      if (this.signalCallback) {
        await this.signalCallback(sessionId, {
          type: 'crypto',
          callId,
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

  // v22.1: Synchronous mutex — prevents the TOCTOU race where two concurrent
  // startCall() invocations both pass isInCall() before either sets currentCall.
  // This caused two crypto inits with different callIds → CallId mismatch on receiver.
  private startCallInProgress = false;

  async startCall(sessionId: string, contactName: string): Promise<{ success: boolean; error?: string }> {
    __DEV__ && console.log('[Call1to1] 📞 Starting call to session:', sessionId.slice(0, 12) + '...');
    
    // v22.1: Synchronous guard BEFORE any await — blocks the second tap immediately
    if (this.startCallInProgress) {
      __DEV__ && console.log('[Call1to1] ❌ startCall already in progress (debounce)');
      return { success: false, error: 'Appel en cours de démarrage' };
    }
    this.startCallInProgress = true;
    
    // FIX: Attendre que le cleanup du précédent appel soit terminé
    if (this.cleanupPromise) {
      __DEV__ && console.log('[Call1to1] ⏳ Waiting for previous call cleanup...');
      try {
        await this.cleanupPromise;
      } catch (e) {
        __DEV__ && console.warn('[Call1to1] Previous cleanup had error:', e);
      }
      __DEV__ && console.log('[Call1to1] ✅ Previous cleanup finished');
    }
    
    try {
    // Réinitialiser les compteurs de debug
    this.audioPacketCount = 0;
    this.receivedAudioCount = 0;
    this.cleanupInProgress = false;
    this.cryptoReady = false;
    this.offerSent = false;
    this.callerPipelineStarted = false;
    this._pendingStartedAt = undefined;
    this.firstRemoteAudioReceived = false;
    
    if (this.isInCall()) {
      __DEV__ && console.log('[Call1to1] ❌ Already in a call');
      return { success: false, error: 'Déjà en appel' };
    }

    if (!SFU_URL) {
      __DEV__ && console.log('[Call1to1] ❌ SFU URL not configured');
      return { success: false, error: 'SFU non configuré' };
    }

    try {
      // SECURITY FIX P1: callId purement aléatoire (pas de timestamp).
      // Un timestamp dans le callId révèle l'heure exacte d'initiation à quiconque
      // l'observe dans les signaux ou logs.
      const callIdBytes = getRandomBytes(20);
      const callId = `call1to1_${encodeBase64(callIdBytes).replace(/[+/=]/g, '').slice(0, 27)}`;
      
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
      
      // GUARD: L'utilisateur a pu raccrocher pendant l'await
      if (this.isCallAborted(callId)) {
        __DEV__ && console.log('[Call1to1] ⚠️ Call aborted during crypto init');
        return { success: true }; // Raccroché intentionnel, pas une erreur
      }
      
      if (!cryptoResult.success) {
        __DEV__ && console.log('[Call1to1] ❌ Failed to initialize call crypto:', cryptoResult.error);
        await this.cleanup();
        return { success: false, error: cryptoResult.error || 'Erreur de chiffrement' };
      }
      this.cryptoReady = true;
      // v7.2 FIX #1: Connecter le callback pour les paquets flushed
      this.setupCryptoFlushCallback();
      __DEV__ && console.log('[Call1to1] ✅ Audio Triple Ratchet initialized (initiator)');

      // ═══════════════════════════════════════════════════════════════
      // LATENCY FIX: Envoyer l'offer IMMÉDIATEMENT, AVANT audio+SFU.
      //
      // L'offer ne contient que roomTag + authToken + callId (valeurs locales).
      // Avant ce fix, l'offer attendait la fin de audio+SFU (~1000ms),
      // ce qui retardait la découverte par le receveur de ~1 seconde.
      // Le receveur polle toutes les ~3-5s → dans le pire cas, 
      // 1s d'init + 5s de poll = 6s avant que l'appel entrant n'apparaisse.
      //
      // Avec ce fix: l'offer est envoyé juste après crypto init (~500ms).
      // Audio+SFU s'initialisent EN PARALLÈLE pendant que l'offer transit
      // via OHTTP vers le serveur. Le receveur voit l'appel ~1s plus tôt.
      //
      // Timeline AVANT:  [crypto 500ms][audio+SFU 1000ms][offer 300ms] = 1800ms
      // Timeline APRÈS:  [crypto 500ms][offer + audio + SFU en parallèle] = max 1300ms
      //                  L'offer hit le serveur à ~800ms au lieu de ~1800ms !
      // ═══════════════════════════════════════════════════════════════

      // 1. Envoyer l'offer immédiatement (true fire-and-forget, no await)
      const signal: CallSignalData = {
        type: 'offer',
        callId,
        roomTag: this.roomTag,
        authToken: this.authToken,
        timestamp: Date.now(),
      };

      if (this.signalCallback) {
        this.offerSent = true;
        const signalCb = this.signalCallback;
        // v30.1: TRUE fire-and-forget — don't include in Promise.all.
        // The offer delivery via OHTTP takes 0.5-3s depending on relay load.
        // Audio + SFU connection only takes ~500-700ms. Before this fix,
        // Promise.all waited for the slowest of the three → the OHTTP
        // round-trip was the bottleneck on slow relay responses.
        // The offer just tells the callee the roomTag/authToken — the caller
        // doesn't need to wait for delivery confirmation to proceed.
        signalCb(sessionId, signal).then(() => {
          __DEV__ && console.log('[Call1to1] ✅ Offer sent');
        }).catch(e => {
          __DEV__ && console.error('[Call1to1] ❌ Offer send failed:', e);
        });
      }

      // 2. En parallèle: audio + SFU (offer delivery happens concurrently but doesn't block)
      this.setupWebRTCCallbacks();
      const mySenderTokenHash = hashSenderToken(this.mySenderToken);
      __DEV__ && console.log('[Call1to1] 🔗 Sending offer + initializing audio + connecting SFU (all parallel)...');
      
      const [, connected] = await Promise.all([
        initializeAudio(),
        connectToSfu(
          SFU_URL,
          this.roomTag,
          callId,
          mySenderTokenHash,
          this.authToken
        )
      ]);

      // GUARD: L'utilisateur a pu raccrocher pendant audio+SFU
      if (this.isCallAborted(callId)) {
        __DEV__ && console.log('[Call1to1] ⚠️ Call aborted during audio/SFU init');
        disconnectFromSfu();
        try { await cleanupAudio(); } catch {}
        return { success: true };
      }

      __DEV__ && console.log('[Call1to1] ✅ Audio + SFU ready (parallel)');

      if (!connected) {
        __DEV__ && console.log('[Call1to1] ❌ Failed to connect to SFU');
        await this.cleanup();
        return { success: false, error: 'Impossible de se connecter au serveur' };
      }

      __DEV__ && console.log('[Call1to1] ✅ Connected to SFU (double-hop)');

      // GUARD: Dernier check avant de lancer la capture (opération longue)
      if (this.isCallAborted(callId)) {
        __DEV__ && console.log('[Call1to1] ⚠️ Call aborted before capture start');
        disconnectFromSfu();
        return { success: true };
      }
      
      // ═══════════════════════════════════════════════════════════════
      // FIX AUDIO v3: NE PAS démarrer speechmatics pendant le ringback.
      //
      // PROBLÈME: Au premier appel (cold-start), smToggle(true) crée un
      // AudioRecord natif qui entre en conflit avec le ToneGenerator du
      // ringback et le proximity wake lock d'InCallManager. Cette
      // combinaison corrompt le routage audio dans l'AudioPolicyManager
      // de Samsung (OneUI). Quand le capteur de proximité éteint l'écran,
      // le routage corrompu bascule sur le haut-parleur.
      // setForceSpeakerphoneOn(false) n'a aucun effet car il opère sur
      // un AudioManager en état corrompu.
      //
      // Au second appel, les modules natifs sont warm → pas de cold-start
      // AudioRecord → pas de conflit → pas de corruption → ça marche.
      //
      // CONSTAT: L'audio capturé pendant le ringback (state='outgoing')
      // est entièrement JETÉ par handleAudioCaptured():
      //   if (this.currentCall.state !== 'connected') return;
      // Démarrer le micro pendant le ringback est donc 100% inutile.
      //
      // FIX: Démarrer UNIQUEMENT InCallManager pendant le ringback.
      // Pas de speechmatics, pas d'AudioRecord, pas de conflit.
      // startCapture() est différé à handleAnswer() quand l'appel
      // se connecte réellement.
      // ═══════════════════════════════════════════════════════════════

      // v24.1: startRingback() is now properly async — it includes a settle delay
      // after InCallManager.start() before enforcing earpiece route on Samsung.
      // The old code called it fire-and-forget + immediate forceAudioRoute() which
      // both ran before MODE_IN_COMMUNICATION had propagated → speaker output.
      await startRingback();
      __DEV__ && console.log('[Call1to1] ✅ Ringback started, audio routed to earpiece (capture deferred to answer)');

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
              __DEV__ && console.error('[Call1to1] ⏰ Failed to send timeout hangup:', e);
            }
          }
          
          this.endCall('timeout');
        }
      }, CALL_TIMEOUT_MS);

      return { success: true };

    } catch (error) {
      __DEV__ && console.error('[Call1to1] ❌ Start call error:', error);
      await this.cleanup();
      return { success: false, error: String(error) };
    }
    } finally {
      this.startCallInProgress = false;
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

    // FIX AVATAR: L'avatar dans le signal d'appel est souvent absent car
    // stripAvatarForWire ne l'inclut que si le hash a changé depuis le dernier
    // message envoyé dans cette session. Fallback vers theirProfile.avatarBase64
    // qui est maintenu à jour par les messages reçus précédemment.
    if (!callerAvatarBase64) {
      const session = sessionService.getSession(sessionId);
      callerAvatarBase64 = session?.theirProfile?.avatarBase64;
      __DEV__ && console.log('[Call1to1] 🖼️ Avatar fallback from session:', callerAvatarBase64 ? 'found' : 'not found');
    }

    // SECURITY FIX P2: Rate-limit par sessionId — un pair malveillant ne peut pas
    // flooder de notifications en envoyant des 'offer' en boucle.
    const now = Date.now();
    const lastOffer = this.lastOfferTimestamp.get(sessionId) ?? 0;
    if (now - lastOffer < Call1to1Manager.OFFER_RATE_LIMIT_MS) {
      __DEV__ && console.warn(
        `[Call1to1] 🚫 Offer rate-limited from ${sessionId.slice(0, 8)} ` +
        `(${Math.round((now - lastOffer) / 1000)}s < ${Call1to1Manager.OFFER_RATE_LIMIT_MS / 1000}s cooldown)`
      );
      return;
    }
    this.lastOfferTimestamp.set(sessionId, now);

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
            // v20.0: Use cleanupAudio() which handles stopCapture/stopPlayback
            // internally with proper serialization guards.
            try {
              await cleanupAudio();
            } catch (e) {}
            disconnectFromSfu();
            clearNotifiedPeers();
            cleanupCallCrypto();
            this.cryptoReady = false;
            this.resetPreWarm();
            this.roomTag = '';
            this.authToken = '';
            this.mySenderToken = '';
            this.remoteSenderTokenHash = '';
            this.audioPacketCount = 0;
            this.receivedAudioCount = 0;
            this.offerSent = false;
            this.callerPipelineStarted = false;
            this._pendingStartedAt = undefined;
            this.firstRemoteAudioReceived = false;
            this.stopSilenceMonitor();
            setCallTonePlayFn(null);
            
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

    // ═══════════════════════════════════════════════════════════════
    // OPTIMISATION: PRE-WARM pendant la sonnerie
    // L'utilisateur met ~2-5s à décrocher. On profite de ce temps pour
    // pré-charger speechmatics et pré-connecter au SFU.
    // Quand il décroche, tout est déjà prêt → gain ~3-4 secondes.
    // ═══════════════════════════════════════════════════════════════
    this.preWarmForIncoming(roomTag, authToken).catch(e => {
      __DEV__ && console.warn('[Call1to1] Pre-warm failed (non-fatal):', e);
    });

    // Timeout si pas de réponse de l'utilisateur
    this.callTimeout = setTimeout(() => {
      if (this.currentCall?.state === 'incoming') {
        __DEV__ && console.log('[Call1to1] ⏰ Incoming call timeout');
        this.endCall('timeout');
      }
    }, CALL_TIMEOUT_MS);
  }

  // ============================================
  // PRE-WARM: Initialiser audio + SFU pendant la sonnerie
  // ============================================

  private async preWarmForIncoming(roomTag: string, authToken: string): Promise<void> {
    __DEV__ && console.log('[Call1to1] 🔥 Pre-warming audio while ringing...');
    
    // SÉCURITÉ: On ne pré-connecte PAS au SFU pendant la sonnerie.
    // Si l'utilisateur décline, une connexion SFU précoce révélerait à
    // l'opérateur SFU que le destinataire a reçu la notification et était en ligne.
    // Seule l'initialisation audio (100% locale) est safe.
    
    this.preWarmAudioPromise = (async () => {
      try {
        await initializeAudio();
        this.preWarmAudioDone = true;
        __DEV__ && console.log('[Call1to1] 🔥 Pre-warm: audio ready ✅');
      } catch (e) {
        __DEV__ && console.warn('[Call1to1] 🔥 Pre-warm: audio failed (will retry on accept):', e);
      }
    })();

    // Pré-générer le senderToken (crypto local uniquement)
    this.mySenderToken = encodeBase64(getRandomBytes(16));

    await this.preWarmAudioPromise;
  }

  private resetPreWarm(): void {
    this.preWarmAudioDone = false;
    this.preWarmAudioPromise = null;
  }

  /**
   * Guard pour détecter si un appel a été annulé pendant un await.
   * Vérifie que:
   * 1. currentCall existe toujours (pas déjà cleanup)
   * 2. C'est le MÊME appel (pas un nouvel appel démarré)
   * 3. L'appel n'a pas été terminé (hangup/decline/remote_hangup pendant l'await)
   */
  private isCallAborted(callId: string): boolean {
    return !this.currentCall || 
           this.currentCall.callId !== callId || 
           this.currentCall.state === 'ended';
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
    this.firstRemoteAudioReceived = false;

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

      // FIX 1.2: Arrêter la sonnerie IMMÉDIATEMENT à l'acceptation
      await stopTone();

      this.currentCall.state = 'connecting';
      this.notifyStateChange();

      const { callId, roomTag, authToken } = this.pendingOffer;
      this.roomTag = roomTag;
      this.authToken = authToken;
      
      // Générer mon senderToken (réutiliser celui du pre-warm si dispo)
      if (!this.mySenderToken) {
        this.mySenderToken = encodeBase64(getRandomBytes(16));
      }
      
      // Initialiser le chiffrement audio avec Triple Ratchet
      // En tant que répondeur, on dérive les mêmes clés depuis la même session
      const cryptoResult = await initializeCallCrypto(
        this.currentCall.sessionId, 
        callId, 
        false // isInitiator = false pour le répondeur
      );
      
      // GUARD: L'utilisateur ou le caller a pu raccrocher pendant l'await
      if (this.isCallAborted(callId)) {
        __DEV__ && console.log('[Call1to1] ⚠️ Accept aborted during crypto init');
        this.resetPreWarm();
        return { success: true }; // Raccroché intentionnel, pas une erreur
      }
      
      if (!cryptoResult.success) {
        __DEV__ && console.log('[Call1to1] ❌ Failed to initialize call crypto:', cryptoResult.error);
        this.resetPreWarm();
        await this.cleanup();
        return { success: false, error: cryptoResult.error || 'Erreur de chiffrement' };
      }
      this.cryptoReady = true;
      // v7.2 FIX #1: Connecter le callback pour les paquets flushed
      this.setupCryptoFlushCallback();
      __DEV__ && console.log('[Call1to1] ✅ Audio Triple Ratchet initialized (responder)');

      // ═══════════════════════════════════════════════════════════════
      // PARALLELIZATION FIX: All async operations run concurrently.
      //
      // BEFORE (sequential, ~8-13s):
      //   initializeCallCrypto (await crypto signal OHTTP round-trip ~3-5s)
      //   → Promise.all([audio, SFU]) (~2s)
      //   → await answer signal (OHTTP round-trip ~3-5s)
      //   → start audio
      //
      // AFTER (parallel, ~2-3s):
      //   initializeCallCrypto (crypto signal = fire-and-forget, no await)
      //   + SFU connect (in parallel)
      //   + audio pre-warm (already done)
      //   → answer signal = fire-and-forget
      //   → start audio immediately
      // ═══════════════════════════════════════════════════════════════

      const audioPromise = this.preWarmAudioDone
        ? ((__DEV__ && console.log('[Call1to1] ⚡ Audio already pre-warmed')), Promise.resolve())
        : this.preWarmAudioPromise 
          ? ((__DEV__ && console.log('[Call1to1] ⏳ Waiting for audio pre-warm...')), this.preWarmAudioPromise)
          : ((__DEV__ && console.log('[Call1to1] 🎤 Initializing audio (no pre-warm)')), initializeAudio());

      this.setupWebRTCCallbacks();
      const mySenderTokenHash = hashSenderToken(this.mySenderToken);
      __DEV__ && console.log('[Call1to1] 🔗 Crypto + Audio + SFU (all parallel)...');
      
      const sfuPromise = connectToSfu(
        SFU_URL,
        roomTag,
        `peer_${Date.now()}`,
        mySenderTokenHash,
        authToken
      );

      // All three in parallel: audio + SFU + crypto (crypto signal is fire-and-forget inside)
      const [, connected] = await Promise.all([audioPromise, sfuPromise]);
      __DEV__ && console.log('[Call1to1] ✅ Audio + SFU ready (parallel)');
      this.resetPreWarm();

      // GUARD: Raccroché pendant audio+SFU
      if (this.isCallAborted(callId)) {
        __DEV__ && console.log('[Call1to1] ⚠️ Accept aborted during audio/SFU');
        disconnectFromSfu();
        try { await cleanupAudio(); } catch {}
        return { success: true }; // Raccroché intentionnel, pas une erreur
      }

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

      // Send answer as FIRE-AND-FORGET — don't block audio startup on network round-trip.
      // The answer signal tells the caller's UI to switch to "connected" state,
      // but audio already flows via the SFU independently.
      if (this.signalCallback) {
        this.signalCallback(this.currentCall.sessionId, signal).then(() => {
          __DEV__ && console.log('[Call1to1] ✅ Answer sent with startedAt:', callStartedAt);
        }).catch(e => {
          __DEV__ && console.warn('[Call1to1] ⚠️ Answer send failed (non-blocking):', e);
        });
      }

      // GUARD: Raccroché pendant envoi du answer
      if (this.isCallAborted(callId)) {
        __DEV__ && console.log('[Call1to1] ⚠️ Accept aborted during answer send');
        disconnectFromSfu();
        return { success: true }; // Raccroché intentionnel, pas une erreur
      }

      // NOTE: Pas besoin d'envoyer de SenderKey !
      // Les clés audio sont dérivées depuis la session Triple Ratchet partagée.

      // ═══════════════════════════════════════════════════════════════
      // v24.0: UNIFIED AUDIO PIPELINE (callee path)
      //
      // transitionToCallAudio() handles:
      //   - stopRingtone (callee was ringing)
      //   - InCallManager.start({ media: 'audio' }) with full settle delay
      //   - MODE_IN_COMMUNICATION fully propagated before we return
      //
      // startCallAudioPipeline() handles:
      //   - reconfigurePlaybackEngine (AudioTrack/VP I/O creation)
      //   - startCapture (microphone)
      //   - startPlayback (output + early buffer flush)
      //   - iOS VP I/O priming (after mic+playback are both active)
      //   - Single route enforcement (after all engines settled)
      //
      // BEFORE v24.0: callee used ensureInCallStarted() + 600ms delay +
      // reconfigure + capture + playback + 3x setForceSpeakerphoneOn.
      // Caller used restartInCallManager() (0ms gap!) + 200ms + different
      // sequence. The divergence caused Samsung dual-route + iOS no-sound.
      // ═══════════════════════════════════════════════════════════════
      await transitionToCallAudio();

      // GUARD: L'utilisateur ou le caller a pu raccrocher pendant le settle
      if (this.isCallAborted(callId)) {
        __DEV__ && console.log('[Call1to1] ⚠️ Accept aborted during audio transition');
        return { success: true };
      }

      const pipelineOk = await startCallAudioPipeline(this.handleAudioCaptured.bind(this));
      if (!pipelineOk) {
        __DEV__ && console.error('[Call1to1] ❌ Audio pipeline failed');
        await this.cleanup();
        return { success: false, error: 'Erreur audio' };
      }
      __DEV__ && console.log('[Call1to1] ✅ Audio pipeline started (callee)');

      // Start proximity route enforcer for Samsung/Xiaomi
      startProximityRouteEnforcer();

      // GUARD final: vérifier que l'appel est toujours actif avant de passer en connected
      if (this.isCallAborted(callId)) {
        __DEV__ && console.log('[Call1to1] ⚠️ Accept aborted during audio startup');
        return { success: true }; // Raccroché intentionnel, pas une erreur
      }

      // Avec le nouveau système, on est connecté dès que le crypto est prêt
      // car les deux parties ont les mêmes clés dérivées
      if (this.cryptoReady && this.currentCall) {
        __DEV__ && console.log('[Call1to1] ✅ Crypto ready, going to connected!');
        this.currentCall.state = 'connected';
        this.currentCall.startedAt = callStartedAt; // Utiliser le même timestamp
        this.startDurationTimer();
        this.startAudioHealthMonitor();
        
        // Wire tone generator + start silence/connecting monitor
        this.setupCallTonePlayFn();
        this.startSilenceMonitor();

        this.notifyStateChange();
        __DEV__ && console.log('[Call1to1] ✅ Call connected!');
      }

      this.pendingOffer = null;

      return { success: true };

    } catch (error) {
      __DEV__ && console.error('[Call1to1] ❌ Accept call error:', error);
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
      // CRITICAL FIX: Même pattern que hangup — endCall d'abord.
      const sessionId = this.currentCall.sessionId;
      const callId = this.currentCall.callId;

      this.endCall('declined');

      // Signal fire-and-forget
      if (this.signalCallback) {
        this.signalCallback(sessionId, {
          type: 'decline',
          callId,
          timestamp: Date.now(),
        }).catch(e => __DEV__ && console.error('[Call1to1] ❌ Decline signal send failed:', e));
      }

      return { success: true };

    } catch (error) {
      __DEV__ && console.error('[Call1to1] ❌ Decline error:', error);
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
      // CRITICAL FIX: Capturer les infos AVANT endCall (qui va reset l'état).
      // Puis endCall() EN PREMIER (synchrone) pour empêcher toute race condition
      // avec startCall()/acceptCall() qui reprendraient un await.
      // Le signal hangup est envoyé APRÈS en fire-and-forget.
      const sessionId = this.currentCall.sessionId;
      const callId = this.currentCall.callId;
      const shouldSignal = this.offerSent || !this.currentCall.isOutgoing;

      // endCall() est SYNCHRONE : set state='ended', notifie l'UI, stoppe les timers,
      // et lance le cleanup async (via cleanupPromise).
      this.endCall('local_hangup');

      // Envoyer le signal hangup en fire-and-forget SEULEMENT si l'autre partie
      // sait que l'appel existe (offer envoyé, ou je suis le receiver).
      // Si l'offer n'a jamais été envoyé, l'autre ne sait rien → pas de signal.
      if (this.signalCallback && shouldSignal) {
        this.signalCallback(sessionId, {
          type: 'hangup',
          callId,
          timestamp: Date.now(),
        }).catch(e => __DEV__ && console.error('[Call1to1] ❌ Hangup signal send failed:', e));
      }

      return { success: true };

    } catch (error) {
      __DEV__ && console.error('[Call1to1] ❌ Hangup error:', error);
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
    // callCryptoService ne stocke que la clé DH publique (pendingTheirDHKey), et le responder
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
        await this.handleAnswer(signal.callStartedAt);
        break;

      case 'crypto':
        if (signal.cryptoSignal) {
          // v30.1 FIX: Pass the SIGNAL's callId, not this.currentCall?.callId.
          // When a new call's crypto_init arrives during cleanup of the old call,
          // this.currentCall still has the OLD callId → CallId mismatch error.
          // The signal always carries the correct callId for its own call.
          this.handleCryptoSignal(signal.cryptoSignal, signal.callId);
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

  private async handleAnswer(callStartedAt?: number): Promise<void> {
    __DEV__ && console.log('[Call1to1] 📨 Received answer, startedAt:', callStartedAt);

    if (!this.currentCall || this.currentCall.state === 'ended') {
      __DEV__ && console.log('[Call1to1] ⚠️ No active call for answer (state:', this.currentCall?.state, ')');
      return;
    }

    if (this.callTimeout) {
      clearTimeout(this.callTimeout);
      this.callTimeout = null;
    }

    if (!this.currentCall || this.currentCall.state === 'ended') {
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // v28.0: If the pipeline was already started proactively by
    // onPeerJoined, we only need to update the startedAt timer.
    // The pipeline is either running or still starting — both are fine.
    // ═══════════════════════════════════════════════════════════════
    if (this.currentCall.state === 'connected') {
      __DEV__ && console.log('[Call1to1] ⚡ Already connected (proactive pipeline) — updating startedAt only');
      
      // Update startedAt from the answer signal
      const now = Date.now();
      const TOLERANCE_FUTURE_MS = 2_000;
      const TOLERANCE_PAST_MS = CALL_TIMEOUT_MS + 5_000;
      const isValidTs = callStartedAt !== undefined
        && callStartedAt <= now + TOLERANCE_FUTURE_MS
        && callStartedAt >= now - TOLERANCE_PAST_MS;

      if (isValidTs) {
        this.currentCall.startedAt = callStartedAt!;
        __DEV__ && console.log('[Call1to1] ⚡ startedAt synced from answer signal:', callStartedAt);
      }
      this.notifyStateChange();
      return;
    }

    if (this.cryptoReady && (this.currentCall.state === 'outgoing' || this.currentCall.state === 'connecting')) {
      // ═══════════════════════════════════════════════════════════════
      // v28.0: Pipeline may already be in progress (started by onPeerJoined
      // via startCallerPipelineProactive). If so, skip pipeline setup.
      // This handles the race where answer arrives while pipeline is
      // still starting (not yet 'connected').
      // ═══════════════════════════════════════════════════════════════
      if (this.callerPipelineStarted) {
        __DEV__ && console.log('[Call1to1] ⚡ Pipeline already starting (proactive) — waiting for it');
        // The proactive pipeline will set state='connected' when done.
        // Store startedAt for when it completes.
        this._pendingStartedAt = callStartedAt;
        return;
      }

      // ═══════════════════════════════════════════════════════════════
      // FALLBACK: Pipeline not started proactively (onPeerJoined didn't
      // fire, or callerPipelineStarted was false). Do full pipeline setup.
      // This is the original v24.0 path.
      // ═══════════════════════════════════════════════════════════════

      // 1. Transition from ringback to call audio mode
      await transitionToCallAudio();
      // Connected beep is now played by onRemoteAudioReceived() when first audio arrives

      if (!this.currentCall || this.currentCall.state === 'ended') {
        return;
      }

      // 2. Unified audio pipeline — identical to callee path
      const pipelineOk = await startCallAudioPipeline(this.handleAudioCaptured.bind(this));
      if (!pipelineOk) {
        __DEV__ && console.error('[Call1to1] ❌ Audio pipeline failed (caller)');
        this.endCall('error');
        return;
      }
      __DEV__ && console.log('[Call1to1] ✅ Audio pipeline started (caller)');

      // 3. Start proximity route enforcer for Samsung/Xiaomi
      startProximityRouteEnforcer();

      if (!this.currentCall || this.currentCall.state === 'ended') {
        return;
      }
      
      this.currentCall.state = 'connected';

      // SECURITY FIX P3: Valider callStartedAt avant de l'utiliser pour le chrono.
      const now = Date.now();
      const TOLERANCE_FUTURE_MS = 2_000;
      const TOLERANCE_PAST_MS = CALL_TIMEOUT_MS + 5_000; // 95s
      const isValidTs = callStartedAt !== undefined
        && callStartedAt <= now + TOLERANCE_FUTURE_MS
        && callStartedAt >= now - TOLERANCE_PAST_MS;

      if (!isValidTs && callStartedAt !== undefined) {
        __DEV__ && console.warn(
          '[Call1to1] ⚠️ callStartedAt rejected (out of valid range):', callStartedAt,
          '— using local time instead'
        );
      }

      this.currentCall.startedAt = isValidTs ? callStartedAt! : now;
      this.startDurationTimer();
      this.startAudioHealthMonitor();
      
      // Wire tone generator + start silence/connecting monitor
      this.setupCallTonePlayFn();
      this.startSilenceMonitor();

      // v27.0 FIX: If remote audio was already received during 'outgoing'
      // state (SFU relays audio before the answer signal arrives), trigger
      // the connected beep now that we're in 'connected' state.
      // onRemoteAudioReceived() guards on state === 'connected', so audio
      // that arrived during 'outgoing' updated lastRemoteAudioTime but
      // didn't set firstRemoteAudioReceived. Check and rectify here.
      if (!this.firstRemoteAudioReceived && this.receivedAudioCount > 0) {
        this.firstRemoteAudioReceived = true;
        playConnectedBeep().catch(() => {});
        __DEV__ && console.log('[Call1to1] 🔊 Audio already received during outgoing — playing connected beep now');
      }

      this.notifyStateChange();

      __DEV__ && console.log('[Call1to1] ✅ Call connected! (startedAt:', this.currentCall.startedAt, ')');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // v28.0: PROACTIVE CALLER PIPELINE
  //
  // Called by onPeerJoined when the callee connects to the SFU.
  // Runs the same pipeline as handleAnswer but doesn't wait for
  // the answer signal. This eliminates 0.5-8s of polling delay.
  //
  // The answer signal, when it arrives via handleAnswer(), finds
  // the call already in 'connected' state and only updates startedAt.
  // ═══════════════════════════════════════════════════════════════

  // Pending startedAt from answer signal that arrived during pipeline setup
  private _pendingStartedAt: number | undefined = undefined;

  private async startCallerPipelineProactive(): Promise<void> {
    if (!this.currentCall || this.currentCall.state !== 'outgoing') {
      return;
    }
    if (!this.cryptoReady) {
      __DEV__ && console.log('[Call1to1] ⚠️ Proactive pipeline: crypto not ready, falling back to handleAnswer');
      this.callerPipelineStarted = false;
      return;
    }

    __DEV__ && console.log('[Call1to1] ⚡ Proactive pipeline: starting transition...');

    // 1. Transition from ringback to call audio mode
    await transitionToCallAudio();

    if (!this.currentCall || this.currentCall.state === 'ended') {
      return;
    }

    // 2. Start audio pipeline
    const pipelineOk = await startCallAudioPipeline(this.handleAudioCaptured.bind(this));
    if (!pipelineOk) {
      __DEV__ && console.error('[Call1to1] ❌ Proactive pipeline failed');
      this.callerPipelineStarted = false;
      // Don't endCall — let handleAnswer retry with the fallback path
      return;
    }
    __DEV__ && console.log('[Call1to1] ✅ Proactive pipeline started');

    // 3. Start proximity route enforcer
    startProximityRouteEnforcer();

    if (!this.currentCall || this.currentCall.state === 'ended') {
      return;
    }

    // 4. Transition to connected state
    this.currentCall.state = 'connected';

    // Use pendingStartedAt if answer signal already arrived, otherwise use now
    const now = Date.now();
    const pendingTs = this._pendingStartedAt;
    this._pendingStartedAt = undefined;

    if (pendingTs !== undefined) {
      const TOLERANCE_FUTURE_MS = 2_000;
      const TOLERANCE_PAST_MS = CALL_TIMEOUT_MS + 5_000;
      const isValid = pendingTs <= now + TOLERANCE_FUTURE_MS && pendingTs >= now - TOLERANCE_PAST_MS;
      this.currentCall.startedAt = isValid ? pendingTs : now;
      __DEV__ && console.log('[Call1to1] ⚡ startedAt from pending answer:', this.currentCall.startedAt);
    } else {
      this.currentCall.startedAt = now;
      __DEV__ && console.log('[Call1to1] ⚡ startedAt from proactive pipeline (no answer yet):', now);
    }

    this.startDurationTimer();
    this.startAudioHealthMonitor();

    // Wire tone generator + start silence/connecting monitor
    this.setupCallTonePlayFn();
    this.startSilenceMonitor();

    // Check if audio was already received
    if (!this.firstRemoteAudioReceived && this.receivedAudioCount > 0) {
      this.firstRemoteAudioReceived = true;
      playConnectedBeep().catch(() => {});
      __DEV__ && console.log('[Call1to1] 🔊 Audio already received — connected beep');
    }

    this.notifyStateChange();
    __DEV__ && console.log('[Call1to1] ✅ Call connected via proactive pipeline! (startedAt:', this.currentCall.startedAt, ')');
  }

  private handleCryptoSignal(cryptoSignal: CallCryptoSignal, signalCallId?: string): void {
    __DEV__ && console.log('[Call1to1] 🔐 Processing crypto signal:', cryptoSignal.type);
    
    // v7.2 CRITICAL FIX: NE PAS rejeter quand currentCall est null !
    // Le crypto_init de l'initiateur arrive AVANT l'offer (qui crée currentCall).
    // callCryptoService.handleSignal() stocke la clé DH dans pendingTheirDHKey
    // pour qu'il soit utilisé plus tard dans initializeCallCrypto().
    //
    // v26.0 FIX: NE PAS rejeter quand state === 'ended' non plus !
    // Quand l'appel précédent est en cleanup (state='ended'), un crypto_init
    // pour le NOUVEL appel peut arriver. L'offer attend le cleanup (cleanupPromise),
    // mais le crypto passe directement ici. Si on le rejette, le responder
    // n'a jamais la clé DH de l'initiateur → 100% decryption failure.
    // callCryptoService.handleSignal() sait stocker la clé pour plus tard.
    
    // v30.1 FIX: Use signalCallId (from the signal itself) instead of currentCall?.callId.
    // During cleanup of call N, a crypto_init for call N+1 can arrive.
    // currentCall still has call N's callId → mismatch → init rejected.
    // signalCallId always carries the correct callId for the signal's own call.
    handleCallCryptoSignal(cryptoSignal, signalCallId || this.currentCall?.callId);
    
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
    setAudioSpeaker(this.currentCall.isSpeakerOn);
    
    // Enforcer keeps running — it now enforces the CURRENT speakerOn state
    // (not just earpiece). No need to stop/restart it.
    
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
        
        // ═══════════════════════════════════════════════════════════════
        // v28.0: PROACTIVE AUDIO PIPELINE START
        //
        // BEFORE: Caller waited for the answer signal (delivered via
        // encrypted OHTTP polling) before starting its audio pipeline.
        // The answer signal delivery takes 0.5-8s depending on poll timing.
        // Then the pipeline itself takes ~1.7-2.2s. Total: 2.2-10s delay.
        //
        // FIX: Start the audio pipeline as soon as the peer joins the SFU.
        // The peer can only join if they have roomTag + authToken (given
        // exclusively in the offer signal) AND they called connectToSfu()
        // which only happens inside acceptCall(). So onPeerJoined is a
        // reliable, instant indicator that the callee has accepted.
        //
        // The answer signal, when it arrives, just updates startedAt for
        // the call duration timer.
        //
        // SAVINGS: Eliminates 0.5-8s of polling latency entirely.
        // Total delay: ~500ms (SFU relay) + ~1.7s (pipeline) = ~2.2s
        // ═══════════════════════════════════════════════════════════════
        if (this.currentCall?.state === 'outgoing' && !this.callerPipelineStarted) {
          this.callerPipelineStarted = true;
          __DEV__ && console.log('[Call1to1] ⚡ Peer joined → starting audio pipeline proactively (no poll wait)');
          
          // Still force polls to receive the answer signal for startedAt sync
          setTimeout(() => forceImmediatePoll(), 500);
          setTimeout(() => forceImmediatePoll(), 2500);
          
          // Start pipeline async — same sequence as handleAnswer but triggered earlier
          this.startCallerPipelineProactive().catch(e => {
            __DEV__ && console.error('[Call1to1] ❌ Proactive pipeline failed:', e);
          });
        }
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
        __DEV__ && console.error('[Call1to1] ❌ SFU error:', error);
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
      __DEV__ && console.error('[Call1to1] ❌ Audio encrypt/send error:', error);
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
        
        // Track remote audio for silence detection + connecting tone
        this.onRemoteAudioReceived();
        
        if (this.receivedAudioCount % 50 === 1) {
          __DEV__ && console.log(`[Call1to1] ✅ Audio decrypted and buffered, size=${decrypted.length}`);
        }
      } else {
        if (this.receivedAudioCount % 50 === 1) {
          __DEV__ && console.log('[Call1to1] ⚠️ Audio decryption returned null');
        }
      }
    } catch (error) {
      __DEV__ && console.error('[Call1to1] ❌ Audio decrypt error:', error);
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
      __DEV__ && console.log(`[Call1to1] 📞 Fetch retry 1/4 for ${reason}...`);
      await forceFetchAndNotify1to1(sessionId);
    }, 1500);
    
    // Deuxième fetch après 3.5s
    setTimeout(async () => {
      __DEV__ && console.log(`[Call1to1] 📞 Fetch retry 2/4 for ${reason}...`);
      await forceFetchAndNotify1to1(sessionId);
    }, 3500);
    
    // Troisième fetch après 6s
    setTimeout(async () => {
      __DEV__ && console.log(`[Call1to1] 📞 Fetch retry 3/4 for ${reason}...`);
      await forceFetchAndNotify1to1(sessionId);
    }, 6000);

    // FIX DOUBLON: 4ème fetch à 10s — filet de sécurité avant le fallback 15s.
    // Couvre le cas où l'initiateur envoie le message avec retard (CT stop/start).
    // Le message peut arriver au serveur entre 6s et 10s → ce 4ème fetch le capte.
    setTimeout(async () => {
      __DEV__ && console.log(`[Call1to1] 📞 Fetch retry 4/4 for ${reason}...`);
      await forceFetchAndNotify1to1(sessionId);
    }, 10000);
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
    
    // Stop silence monitor + connecting tone
    this.stopSilenceMonitor();
    
    // Jouer le bip de fin d'appel (si l'appel était connecté)
    if (this.currentCall.state === 'connected') {
      playEndCallBeep().catch(() => {});
    }

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
    const offerWasSent = this.offerSent;
    
    this.currentCall.state = 'ended';
    this.notifyStateChange();

    // Détection d'appel manqué:
    // Appel entrant qui n'a jamais été connecté → "Appel manqué"
    const isMissedCall = !callInfo.isOutgoing
      && callInfo.state !== 'connected'
      && (reason === 'remote_hangup' || reason === 'timeout' || reason === 'error');

    if (isMissedCall) {
      __DEV__ && console.log('[Call1to1] 📵 Missed call from:', callInfo.remoteDisplayName);
      // Ne montrer la notification système que si l'app est en background.
      // En foreground, l'UI affiche déjà l'état "appel manqué" — une notification
      // système serait redondante et exposerait le nom de l'appelant dans la
      // barre de notifications alors que l'utilisateur est déjà dans l'app.
      // En background, la notification est nécessaire pour informer l'utilisateur.
      const appState = AppState.currentState;
      if (appState !== 'active') {
        showMissedCallNotification(callInfo.remoteDisplayName || 'Inconnu');
      } else {
        __DEV__ && console.log('[Call1to1] 📵 App is active — skipping notification (UI handles it)');
        // Stopper la sonnerie si elle tourne encore (cas où le signal arrive
        // pendant que l'utilisateur regarde l'écran d'appel entrant)
        stopRinging();
      }
    } else {
      // Appel décroché ou sortant → juste supprimer la notification d'appel
      stopRinging();
    }

    // FIX: Créer une promesse qui séquence correctement :
    // 1. Envoyer le message call-ended (avance le ratchet)
    // 2. Puis cleanup complet (audio, crypto, SFU)
    // startCall() attend cette promesse avant de démarrer un nouvel appel,
    // ce qui empêche la race condition ratchet quand on rappelle vite.
    this.cleanupPromise = this.sequencedCleanup(callInfo, reason, endedAt, offerWasSent);
  }

  /**
   * Exécute le cleanup séquencé : message call-ended puis libération des ressources.
   * Retourne une promesse que startCall() attend avant de démarrer.
   */
  private async sequencedCleanup(
    callInfo: Call1to1Info,
    reason: CallEndReason,
    endedAt: number,
    offerWasSent: boolean
  ): Promise<void> {
    try {
      // Étape 1: Envoyer le message call-ended (avance le ratchet d'un cran)
      await this.sendCallEndedMessageAsync(callInfo, reason, endedAt, offerWasSent);
    } catch (e) {
      __DEV__ && console.error('[Call1to1] ❌ sendCallEndedMessageAsync failed:', e);
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
    endedAt: number,
    offerWasSent: boolean
  ): Promise<void> {
    try {
      // ─── CAS 0 : L'offer n'a jamais été envoyé ───
      // Le receveur ne sait pas que l'appel a existé.
      // Aucun message dans le chat, aucun signal, silence total.
      if (callInfo.isOutgoing && !offerWasSent) {
        __DEV__ && console.log(
          '[Call1to1] 📞 Offer never sent — skipping call-ended message (silent cancel)'
        );
        return;
      }

      // ─── CAS 1 : Je suis le CALLEE (non-initiateur) ───
      // Le callee ne prend JAMAIS la responsabilité d'envoyer le message.
      // L'initiateur l'enverra. Fallback après 15s si l'initiateur est offline.
      if (!callInfo.isOutgoing) {
        __DEV__ && console.log(
          `[Call1to1] 📞 I'm callee — deferring call-ended message to initiator (reason: ${reason})`
        );
        
        // Programmer des fetch retries pour récupérer le message de l'initiateur
        this.scheduleFetchRetries(callInfo.sessionId, `callee defer (${reason})`);
        
        // FIX DOUBLON: Fallback porté de 8s à 15s.
        //
        // POURQUOI 15s:
        // L'initiateur peut mettre jusqu'à ~10s pour envoyer son message dans le pire cas:
        //   - Hangup signal via CT urgent (~0.5s)
        //   - endCall → sequencedCleanup → sendCallEndedMessageAsync (~0.3s)
        //   - 300ms delay intentionnel (laisser le hangup signal arriver)
        //   - enqueueMessage via CT → peut être en cycle stop/start
        //   - Jusqu'à 3 retries × 1s = ~3s si CT est instable
        //   - OHTTP round-trip ~1-2s
        //   - Total worst case: ~7-8s
        //
        // 15s laisse une marge confortable pour les réseaux lents (3G, satellite).
        // Le 4ème fetch retry à 10s couvre le cas normal. Le fallback à 15s ne
        // se déclenche que si l'initiateur est vraiment offline/crashed.
        const fallbackCallId = callInfo.callId;
        const fallbackSessionId = callInfo.sessionId;
        const fallbackStartedAt = callInfo.startedAt;
        
        setTimeout(async () => {
          // Check 1: Le flag en mémoire (set par markCallEndedReceived)
          if (this.callEndedMessageReceived(fallbackCallId)) {
            __DEV__ && console.log('[Call1to1] 📞 Fallback cancelled — initiator message received (flag)');
            return;
          }

          // FIX DOUBLON: Check 2 — Dernier fetch avant de décider.
          // Couvre le cas où le message est arrivé entre le 4ème retry (10s)
          // et maintenant, mais le polling normal ne l'a pas encore capté.
          try {
            await forceFetchAndNotify1to1(fallbackSessionId);
            // Laisser le temps à markCallEndedReceived de se propager
            // (dynamic import async dans le handler de fetch)
            await new Promise(r => setTimeout(r, 300));
          } catch (e) {
            __DEV__ && console.warn('[Call1to1] 📞 Fallback last-chance fetch failed:', e);
          }

          // Re-check le flag après le dernier fetch
          if (this.callEndedMessageReceived(fallbackCallId)) {
            __DEV__ && console.log('[Call1to1] 📞 Fallback cancelled — initiator message received (after last fetch)');
            return;
          }

          // FIX DOUBLON: Check 3 — Vérifier le stockage local.
          // Ultime filet de sécurité: le message a pu être reçu et sauvegardé
          // par le polling normal, mais le dynamic import de markCallEndedReceived
          // n'a pas eu le temps de s'exécuter (race entre save et import async).
          try {
            const existingMessages = await getLocalMessages1to1(fallbackSessionId);
            const alreadyHasCallMessage = existingMessages.some(
              (m: any) => m.messageType === 'call' && m.callId === fallbackCallId
            );
            if (alreadyHasCallMessage) {
              __DEV__ && console.log('[Call1to1] 📞 Fallback cancelled — call message already in local storage');
              return;
            }
          } catch (e) {
            __DEV__ && console.warn('[Call1to1] 📞 Fallback storage check failed (non-fatal):', e);
          }
          
          __DEV__ && console.log('[Call1to1] 📞 Fallback: initiator message not received after 15s, sending myself');
          
          const status = fallbackStartedAt ? 'ended' : 'cancelled';
          const duration = fallbackStartedAt 
            ? Math.floor((endedAt - fallbackStartedAt) / 1000) 
            : 0;
          
          try {
            // Retry si ConstantTraffic cycle stop/start
            for (let attempt = 1; attempt <= 3; attempt++) {
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
                break;
              } catch (sendErr: any) {
                if (attempt < 3 && sendErr?.message?.includes('stopped')) {
                  __DEV__ && console.log(`[Call1to1] 🔄 Fallback retry ${attempt}/3 in 1s...`);
                  await new Promise(r => setTimeout(r, 1000));
                } else {
                  throw sendErr;
                }
              }
            }
          } catch (e) {
            __DEV__ && console.error('[Call1to1] ❌ Fallback call ended message failed:', e);
          }
        }, 15_000);
        
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
      
      // Envoyer le message — avec retry si ConstantTraffic cycle stop/start
      // (arrive quand l'UI navigue après raccroché → stopGlobalPolling → startGlobalPolling)
      const MAX_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await sendCallEndedMessage1to1(
            callInfo.sessionId,
            callInfo.callId,
            status,
            duration,
            startedAt,
            endedAt
          );
          __DEV__ && console.log('[Call1to1] ✅ Call ended message sent (as initiator)');
          break; // Succès → sortir de la boucle
        } catch (sendErr: any) {
          if (attempt < MAX_RETRIES && sendErr?.message?.includes('stopped')) {
            __DEV__ && console.log(`[Call1to1] 🔄 CT stopped during send, retry ${attempt}/${MAX_RETRIES} in 1s...`);
            await new Promise(r => setTimeout(r, 1000));
          } else {
            throw sendErr; // Erreur non-retriable ou max retries atteint
          }
        }
      }
      
    } catch (error) {
      __DEV__ && console.error('[Call1to1] ❌ Failed to send call ended message:', error);
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

    // v25.1: Stop audio health monitor
    this.stopAudioHealthMonitor();


    // v20.0 FIX: cleanupAudio() now handles stopCapture() and stopPlayback()
    // internally with proper guards. Do NOT call them separately here —
    // calling stopMicrophone() twice in quick succession confuses some
    // Android OEMs (Samsung, Xiaomi) causing the next startMicrophone()
    // to silently fail → no mic audio on the second call.
    try {
      await cleanupAudio();
    } catch (e) {
      __DEV__ && console.warn('[Call1to1] Audio cleanup error (non-fatal):', e);
    }

    // Déconnecter du SFU
    disconnectFromSfu();
    clearNotifiedPeers();

    // Nettoyer le crypto (effacement sécurisé des clés audio)
    cleanupCallCrypto();
    this.cryptoReady = false;
    this.resetPreWarm();

    // Reset IMMÉDIAT de toutes les variables d'état
    this.roomTag = '';
    this.authToken = '';
    this.mySenderToken = '';
    this.remoteSenderTokenHash = '';
    this.pendingOffer = null;
    this.audioPacketCount = 0;
    this.receivedAudioCount = 0;
    this.offerSent = false;
    this.callerPipelineStarted = false;
    this._pendingStartedAt = undefined;
    this.startCallInProgress = false;
    this.audioRestartAttempts = 0;
    
    // Reset silence monitor state
    this.firstRemoteAudioReceived = false;
    this.lastRemoteAudioTime = 0;
    this.connectingBeepStartTime = 0; // v27.0
    this.stopSilenceMonitor();
    setCallTonePlayFn(null);

    // Purger les entrées rate-limit plus vieilles que 60s pour éviter une fuite mémoire
    // (une nouvelle entrée est créée par session lors de chaque offer reçu)
    const now = Date.now();
    for (const [sid, ts] of this.lastOfferTimestamp) {
      if (now - ts > 60_000) this.lastOfferTimestamp.delete(sid);
    }

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