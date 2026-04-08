// src/services/callCryptoService.ts
// Service de chiffrement pour les appels avec Triple Ratchet
// Version 1.0 - Post-Quantum + Forward Secrecy
//
// Ce service remplace l'ancien système de SenderKeys statiques
// par le Call Triple Ratchet qui offre:
// - Forward secrecy (les clés tournent à chaque paquet)
// - Protection post-quantique (via dérivation depuis le Triple Ratchet session)
// - Protection anti-replay
// - Rotation DH périodique optionnelle

import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

import {
  CallRatchetState,
  SerializedCallRatchetInit,
  DHRotationMessage,
  initializeCallRatchet,
  initializeCallRatchetFromSecret,
  initializeCallRatchetFromInit,
  encryptAudioPacket,
  decryptAudioPacket,
  shouldRotateDH,
  prepareDHRotation,
  processDHRotation,
  cleanupCallRatchetState,
  getCallRatchetStats,
  createCallRatchetInit,
  processCallRatchetInit,
  serializeCallRatchetState,
  deserializeCallRatchetState,
} from './tripleRatchet/callTripleRatchet';

import { sessionService } from './tripleRatchet/sessionService';

// ============================================
// TYPES
// ============================================

export interface CallCryptoInfo {
  callId: string;
  sessionId: string;
  isInitiator: boolean;
  packetsSent: number;
  packetsReceived: number;
  dhRotations: number;
  callDurationMs: number;
  // v1.1: Statistiques du buffer audio précoce
  audioBufferStats?: {
    pendingPackets: number;
    totalBuffered: number;
    totalDropped: number;
  };
}

export interface CallCryptoInitData {
  type: 'call_crypto_init';
  init: SerializedCallRatchetInit;
}

export interface CallCryptoDHRotation {
  type: 'call_crypto_dh_rotation';
  rotation: DHRotationMessage;
}

export type CallCryptoSignal = CallCryptoInitData | CallCryptoDHRotation;

// Callback pour envoyer les signaux crypto via le canal Triple Ratchet
type SignalCallback = (sessionId: string, signal: CallCryptoSignal) => Promise<void>;

// ============================================
// SERVICE
// ============================================

class CallCryptoService {
  private currentState: CallRatchetState | null = null;
  private currentSessionId: string | null = null;
  private signalCallback: SignalCallback | null = null;
  
  // Signal crypto de l'initiateur en attente (reçu avant acceptCall).
  // Le répondant peut recevoir le crypto_init AVANT d'appeler acceptCall().
  // On stocke le signal complet (clés dérivées de l'initiateur) pour l'appliquer
  // dès que initialize() est appelé côté répondant.
  private pendingInitiatorInit: SerializedCallRatchetInit | null = null;
  private pendingCallId: string | null = null;
  
  // Statistiques
  private encryptCount = 0;
  private decryptCount = 0;
  private decryptFailCount = 0;
  
  // ============================================
  // BUFFER AUDIO PRÉCOCE (v1.1)
  // ============================================
  // Buffer les paquets audio reçus avant que l'état crypto soit initialisé.
  // Évite la perte des premiers paquets si WebRTC connecte avant le signal crypto.
  // À 25 paquets/sec (40ms), 50 paquets = 2 secondes de buffer.
  
  private pendingAudioPackets: Uint8Array[] = [];
  private readonly MAX_PENDING_AUDIO_PACKETS = 50;
  private pendingAudioBufferedCount = 0; // Stats: total bufferisé
  private pendingAudioDroppedCount = 0;  // Stats: total dropped (buffer plein)
  
  // v1.2 FIX #1: Callback pour livrer les paquets audio déchiffrés lors du flush.
  // Sans ce callback, flushPendingAudioPackets() déchiffrait les paquets
  // mais jetait le résultat — les 1-2 premières secondes d'appel étaient muettes.
  private onDecryptedAudio: ((audioData: Uint8Array) => void) | null = null;
  
  // ============================================
  // CONFIGURATION
  // ============================================
  
  /**
   * Configure le callback pour envoyer les signaux crypto
   */
  setSignalCallback(callback: SignalCallback): void {
    this.signalCallback = callback;
  }
  
  /**
   * v1.2 FIX #1: Configure le callback pour livrer les paquets audio déchiffrés
   * lors du flush du buffer précoce. Appelé par call1to1Service.
   */
  setOnDecryptedAudio(callback: (audioData: Uint8Array) => void): void {
    this.onDecryptedAudio = callback;
  }
  
  // ============================================
  // INITIALISATION
  // ============================================
  
  /**
   * Initialise le chiffrement pour un nouvel appel
   * 
   * @param sessionId - ID de la session Triple Ratchet existante
   * @param callId - ID unique de l'appel
   * @param isInitiator - true si on est l'appelant
   */
  async initialize(
    sessionId: string,
    callId: string,
    isInitiator: boolean
  ): Promise<{ success: boolean; error?: string }> {
    __DEV__ && console.log('[CallCrypto] 🔐 Initializing for call:', callId.slice(0, 16) + '...');
    
    try {
      // CAS RÉPONDANT: si on a reçu le signal de l'initiateur en attente,
      // l'utiliser directement pour garantir des clés identiques.
      // Le répondant peut avoir un rootKey Triple Ratchet différent de celui
      // de l'initiateur (la session avance à chaque message), donc on ne peut
      // pas dériver indépendamment — on utilise les clés de l'initiateur inversées.
      if (!isInitiator && this.pendingInitiatorInit && this.pendingCallId === callId) {
        __DEV__ && console.log('[CallCrypto] 🔄 Using initiator keys (received before accept)');
        
        this.currentState = initializeCallRatchetFromInit(this.pendingInitiatorInit, callId);
        this.currentSessionId = sessionId;
        this.pendingInitiatorInit = null;
        this.pendingCallId = null;
        
        this.encryptCount = 0;
        this.decryptCount = 0;
        this.decryptFailCount = 0;
        
        __DEV__ && console.log('[CallCrypto] ✅ Initialized as responder (using initiator keys)');
        this.sendCryptoInit();
        this.flushPendingAudioPackets();
        return { success: true };
      }
      
      // CAS INITIATEUR (ou répondant sans signal en attente):
      // Dériver les clés depuis l'état session courant.
      const secretResult = await this.getSharedSecretFromSession(sessionId);
      if (!secretResult) {
        __DEV__ && console.error('[CallCrypto] ❌ Could not get shared secret');
        return { success: false, error: 'Could not derive call keys' };
      }
      
      this.currentState = await initializeCallRatchetFromSecret(
        secretResult.sharedSecret,
        callId,
        isInitiator,
        secretResult.pqSecret ?? undefined
      );
      this.currentSessionId = sessionId;
      
      this.encryptCount = 0;
      this.decryptCount = 0;
      this.decryptFailCount = 0;
      
      __DEV__ && console.log('[CallCrypto] ✅ Initialized as', isInitiator ? 'initiator' : 'responder');
      
      // Envoyer nos clés (+ DH public key) à l'autre partie
      this.sendCryptoInit();
      this.flushPendingAudioPackets();
      return { success: true };
      
    } catch (error) {
      __DEV__ && console.error('[CallCrypto] ❌ Initialize error:', error);
      return { success: false, error: String(error) };
    }
  }
  
  /**
   * Récupère le secret partagé depuis la session pour dérivation
   * Utilise la rootKey de la session comme base
   */
  private async getSharedSecretFromSession(sessionId: string): Promise<{
    sharedSecret: Uint8Array;
    pqSecret: Uint8Array | null;
  } | null> {
    try {
      const session = sessionService.getSession(sessionId);
      if (!session || !session.tripleRatchetState) {
        return null;
      }
      
      // La rootKey est dans l'état sérialisé
      const serializedState = session.tripleRatchetState;
      if (!serializedState.rootKey) {
        return null;
      }
      
      const sharedSecret = decodeBase64(serializedState.rootKey);
      
      // P2 FIX: Extraire le pqSecret SPQR pour protection post-quantique.
      // Sans ça, initializeCallRatchetFromSecret dérive les clés d'appel
      // uniquement à partir du rootKey classique (X25519), ce qui est
      // vulnérable à un adversaire avec un ordinateur quantique.
      // Avec pqSecret, le matériel ML-KEM est mixé dans la dérivation.
      let pqSecret: Uint8Array | null = null;
      if (serializedState.spqr?.pqSecret) {
        pqSecret = decodeBase64(serializedState.spqr.pqSecret);
        __DEV__ && console.log('[CallCrypto] 🔐 PQ secret available from SPQR state');
      } else {
        __DEV__ && console.log('[CallCrypto] ⚠️ No PQ secret in SPQR — call will use classical keys only');
      }
      
      return { sharedSecret, pqSecret };
    } catch (error) {
      __DEV__ && console.error('[CallCrypto] Error getting shared secret:', error);
      return null;
    }
  }
  
  /**
   * Envoie les données d'initialisation crypto à l'autre partie.
   * FIRE-AND-FORGET: Don't await the network round-trip.
   * The crypto init just shares our DH key — we already have the shared secret
   * and can encrypt/decrypt audio immediately.
   */
  private sendCryptoInit(): void {
    if (!this.currentState || !this.currentSessionId || !this.signalCallback) {
      return;
    }
    
    const initData = createCallRatchetInit(this.currentState);
    
    // Fire-and-forget — don't block on OHTTP round-trip
    this.signalCallback(this.currentSessionId, {
      type: 'call_crypto_init',
      init: initData,
    }).then(() => {
      __DEV__ && console.log('[CallCrypto] ✅ Crypto init sent');
    }).catch(err => {
      __DEV__ && console.warn('[CallCrypto] ⚠️ Crypto init send failed (non-blocking):', err);
    });
  }
  
  // ============================================
  // CHIFFREMENT/DÉCHIFFREMENT AUDIO
  // ============================================
  
  /**
   * Chiffre un paquet audio
   */
  encryptAudio(audioData: Uint8Array): Uint8Array | null {
    if (!this.currentState) {
      __DEV__ && console.warn('[CallCrypto] No state for encryption');
      return null;
    }
    
    try {
      const { packet, newState } = encryptAudioPacket(this.currentState, audioData);
      this.currentState = newState;
      
      this.encryptCount++;
      
      // Log périodique
      if (this.encryptCount % 100 === 1) {
        __DEV__ && console.log(`[CallCrypto] 🔒 Encrypted packet #${this.encryptCount}, index=${this.currentState.sendPacketIndex - 1}`);
      }
      
      // Vérifier si rotation DH nécessaire
      this.checkDHRotation();
      
      return packet;
      
    } catch (error) {
      __DEV__ && console.error('[CallCrypto] ❌ Encrypt error:', error);
      return null;
    }
  }
  
  /**
   * Déchiffre un paquet audio
   * 
   * v1.1: Si l'état n'est pas encore initialisé, les paquets sont bufferisés
   * et seront traités automatiquement après l'initialisation.
   */
  decryptAudio(packet: Uint8Array): Uint8Array | null {
    // v1.1: Buffer les paquets si pas encore initialisé
    if (!this.currentState) {
      if (this.pendingAudioPackets.length < this.MAX_PENDING_AUDIO_PACKETS) {
        // Copier le paquet pour éviter les problèmes de référence
        this.pendingAudioPackets.push(new Uint8Array(packet));
        this.pendingAudioBufferedCount++;
        
        // Log périodique (pas à chaque paquet pour éviter spam)
        if (this.pendingAudioPackets.length === 1 || this.pendingAudioPackets.length % 10 === 0) {
          __DEV__ && console.log(`[CallCrypto] ⏳ Buffering audio packet ${this.pendingAudioPackets.length}/${this.MAX_PENDING_AUDIO_PACKETS} (waiting for crypto init)`);
        }
      } else {
        // Buffer plein, on doit dropper
        this.pendingAudioDroppedCount++;
        if (this.pendingAudioDroppedCount === 1 || this.pendingAudioDroppedCount % 10 === 0) {
          __DEV__ && console.warn(`[CallCrypto] ⚠️ Audio buffer full, dropped ${this.pendingAudioDroppedCount} packets`);
        }
      }
      return null;
    }
    
    // Traitement normal
    return this.decryptAudioInternal(packet);
  }
  
  /**
   * Implémentation interne du déchiffrement audio
   * @private
   */
  private decryptAudioInternal(packet: Uint8Array): Uint8Array | null {
    if (!this.currentState) {
      return null;
    }
    
    try {
      const { audioData, newState } = decryptAudioPacket(this.currentState, packet);
      this.currentState = newState;
      
      if (audioData) {
        this.decryptCount++;
        
        // Log périodique
        if (this.decryptCount % 100 === 1) {
          __DEV__ && console.log(`[CallCrypto] 🔓 Decrypted packet #${this.decryptCount}, index=${this.currentState.recvPacketIndex - 1}`);
        }
      } else {
        this.decryptFailCount++;
        
        // Log des échecs
        if (this.decryptFailCount % 10 === 1) {
          __DEV__ && console.warn(`[CallCrypto] ⚠️ Decrypt failures: ${this.decryptFailCount}`);
        }
      }
      
      return audioData;
      
    } catch (error) {
      __DEV__ && console.error('[CallCrypto] ❌ Decrypt error:', error);
      this.decryptFailCount++;
      return null;
    }
  }
  
  /**
   * Traite les paquets audio bufferisés après initialisation
   * 
   * v1.1: Appelé automatiquement après initialize() pour traiter
   * les paquets reçus pendant l'attente du signal crypto.
   * @private
   */
  private flushPendingAudioPackets(): void {
    if (this.pendingAudioPackets.length === 0) {
      return;
    }
    
    if (!this.currentState) {
      __DEV__ && console.warn('[CallCrypto] ⚠️ Cannot flush: no state');
      return;
    }
    
    const count = this.pendingAudioPackets.length;
    __DEV__ && console.log(`[CallCrypto] 🔄 Flushing ${count} buffered audio packets`);
    
    let successCount = 0;
    let failCount = 0;
    
    for (const packet of this.pendingAudioPackets) {
      const result = this.decryptAudioInternal(packet);
      if (result) {
        successCount++;
        // v1.2 FIX #1: Livrer l'audio déchiffré au playback via le callback.
        // AVANT ce fix, le résultat était compté mais jamais envoyé — l'audio
        // des premières secondes d'appel était silencieusement perdu.
        if (this.onDecryptedAudio) {
          try {
            this.onDecryptedAudio(result);
          } catch (e) {
            __DEV__ && console.error('[CallCrypto] ❌ onDecryptedAudio callback error:', e);
          }
        }
      } else {
        failCount++;
      }
    }
    
    // Vider le buffer
    this.pendingAudioPackets = [];
    
    __DEV__ && console.log(`[CallCrypto] ✅ Flushed ${count} packets: ${successCount} OK, ${failCount} failed`);
    
    // Log des stats totales si des paquets ont été droppés
    if (this.pendingAudioDroppedCount > 0) {
      __DEV__ && console.log(`[CallCrypto] 📊 Buffer stats: ${this.pendingAudioBufferedCount} buffered, ${this.pendingAudioDroppedCount} dropped`);
    }
  }
  
  // ============================================
  // ROTATION DH
  // ============================================
  
  /**
   * Vérifie et effectue une rotation DH si nécessaire
   * 
   * Audit Fix L-02: La rotation DH est OBLIGATOIRE (pas optionnelle).
   * Si l'envoi du signal échoue, on retente au prochain paquet.
   * L'appel ne continue pas indéfiniment sans rotation.
   */
  private async checkDHRotation(): Promise<void> {
    if (!this.currentState || !this.currentSessionId || !this.signalCallback) {
      return;
    }
    
    if (shouldRotateDH(this.currentState)) {
      __DEV__ && console.log('[CallCrypto] 🔄 DH+PQ rotation needed (initiator ping-pong v5.0)');
      
      // SECURITY FIX P3: Sauvegarder l'état PRÉ-rotation avant de l'appliquer.
      // Si l'envoi du signal échoue, on ROLLBACK vers l'état sauvegardé.
      // Sans ça : état local avancé (rotationPendingResponse=true) mais le pair
      // n'a jamais reçu la rotation → désynchronisation permanente des clés,
      // forward secrecy dégradée jusqu'au prochain restart.
      const stateBeforeRotation = this.currentState;
      
      const { message, newState } = prepareDHRotation(this.currentState);
      this.currentState = newState; // Application optimiste
      
      try {
        await this.signalCallback(this.currentSessionId, {
          type: 'call_crypto_dh_rotation',
          rotation: message,
        });
        __DEV__ && console.log('[CallCrypto] ✅ DH+PQ rotation REQUEST sent, keyId:', message.keyId);
        // Envoi OK — on garde le nouvel état
      } catch (error) {
        // ROLLBACK : annuler la rotation locale pour rester synchronisé avec le pair
        __DEV__ && console.warn('[CallCrypto] ⚠️ DH rotation REQUEST failed — rolling back local state:', error);
        this.currentState = stateBeforeRotation;
        // La prochaine invocation de shouldRotateDH re-déclenchera la rotation
      }
    }
  }
  
  // ============================================
  // TRAITEMENT DES SIGNAUX REÇUS
  // ============================================
  
  /**
   * Traite un signal crypto reçu
   */
  async handleSignal(signal: CallCryptoSignal, callId?: string): Promise<void> {
    switch (signal.type) {
      case 'call_crypto_init':
        __DEV__ && console.log('[CallCrypto] 📨 Received crypto init from', signal.init.isInitiator ? 'initiator' : 'responder');
        
        if (signal.init.isInitiator) {
          const effectiveCallId = callId || signal.init.callId;
          
          if (!this.currentState) {
            // Répondant pas encore initialisé — stocker pour initialize()
            __DEV__ && console.log('[CallCrypto] 📦 Storing initiator init for later (no state yet)');
            this.pendingInitiatorInit = signal.init;
            this.pendingCallId = effectiveCallId;
            return;
          }
          
          // v30.1 FIX: If state exists but belongs to a DIFFERENT call (old call
          // still being cleaned up), store as pending instead of replacing.
          // The old call's cleanup will clear currentState but preserve
          // pendingInitiatorInit (via FIX #7). Then initialize() for the
          // new call will pick up the correct initiator keys.
          //
          // BEFORE: This path tried to replace the old call's state with the
          // new call's init data. But initializeCallRatchetFromInit() validates
          // that the callId matches → CallId mismatch error. Even if it succeeded,
          // cleanup would immediately destroy the replaced state.
          if (effectiveCallId && this.currentState.callId !== effectiveCallId) {
            __DEV__ && console.log('[CallCrypto] 📦 Storing initiator init for later (state belongs to different call:', this.currentState.callId.slice(0, 16), '→', effectiveCallId.slice(0, 16), ')');
            this.pendingInitiatorInit = signal.init;
            this.pendingCallId = effectiveCallId;
            return;
          }
          
          // État déjà initialisé mais init de l'initiateur reçu après
          // (rare — peut arriver si le signal arrive après acceptCall)
          if (!effectiveCallId) {
            __DEV__ && console.error('[CallCrypto] ❌ No callId for init processing');
            return;
          }
          
          try {
            __DEV__ && console.log('[CallCrypto] 🔄 Replacing state with initiator keys (late arrival)');
            cleanupCallRatchetState(this.currentState);
            this.currentState = initializeCallRatchetFromInit(signal.init, effectiveCallId);
            __DEV__ && console.log('[CallCrypto] ✅ State synchronized with initiator keys');
            this.flushPendingAudioPackets();
          } catch (error) {
            __DEV__ && console.error('[CallCrypto] ❌ Failed to process initiator init:', error);
          }
        } else {
          // Signal du répondant → on est l'initiateur, mettre à jour la clé DH
          if (this.currentState) {
            this.currentState = processCallRatchetInit(this.currentState, signal.init);
            __DEV__ && console.log('[CallCrypto] ✅ Updated with responder DH key');
          } else {
            __DEV__ && console.warn('[CallCrypto] ⚠️ Received responder init but no state');
          }
        }
        break;
        
      case 'call_crypto_dh_rotation':
        if (!this.currentState) {
          __DEV__ && console.warn('[CallCrypto] No state for DH rotation');
          return;
        }
        __DEV__ && console.log('[CallCrypto] 📨 Received DH rotation, keyId:', signal.rotation.keyId,
          'isResponse:', signal.rotation.isResponse);
        
        // v5.0: processDHRotation retourne le nouveau state + un message de réponse optionnel.
        // Si c'était une request (responder reçoit), on renvoie la response automatiquement.
        const { newState: rotatedState, responseMessage } = processDHRotation(this.currentState, signal.rotation);
        this.currentState = rotatedState;
        
        // v5.0: Si une response doit être envoyée (responder → initiator), l'envoyer
        if (responseMessage && this.signalCallback && this.currentSessionId) {
          try {
            await this.signalCallback(this.currentSessionId, {
              type: 'call_crypto_dh_rotation',
              rotation: responseMessage,
            });
            __DEV__ && console.log('[CallCrypto] ✅ DH+PQ rotation RESPONSE sent, keyId:', responseMessage.keyId);
          } catch (error) {
            __DEV__ && console.warn('[CallCrypto] ⚠️ DH rotation response send failed:', error);
          }
        }
        break;
    }
  }
  
  // ============================================
  // ÉTAT ET CLEANUP
  // ============================================
  
  /**
   * Vérifie si le service est initialisé
   */
  isInitialized(): boolean {
    return this.currentState !== null;
  }
  
  /**
   * Récupère les informations sur l'état actuel
   */
  getInfo(): CallCryptoInfo | null {
    if (!this.currentState || !this.currentSessionId) {
      return null;
    }
    
    const stats = getCallRatchetStats(this.currentState);
    
    return {
      callId: this.currentState.callId,
      sessionId: this.currentSessionId,
      isInitiator: stats.isInitiator,
      packetsSent: stats.packetsSent,
      packetsReceived: stats.packetsReceived,
      dhRotations: stats.dhRotations,
      callDurationMs: stats.callDurationMs,
      // v1.1: Stats du buffer audio précoce
      audioBufferStats: {
        pendingPackets: this.pendingAudioPackets.length,
        totalBuffered: this.pendingAudioBufferedCount,
        totalDropped: this.pendingAudioDroppedCount,
      },
    };
  }
  
  /**
   * Nettoie l'état de manière sécurisée
   */
  cleanup(): void {
    __DEV__ && console.log('[CallCrypto] 🧹 Cleanup');
    
    // v1.2 FIX #7: Sauvegarder le callId en cours de cleanup pour ne pas
    // effacer un pendingInitiatorInit qui appartiendrait à un NOUVEL appel
    // (arrivé pendant le sequencedCleanup async de l'ancien appel).
    const cleaningCallId = this.currentState?.callId;
    
    if (this.currentState) {
      cleanupCallRatchetState(this.currentState);
      this.currentState = null;
    }
    
    this.currentSessionId = null;
    
    // v1.2 FIX #7: Ne reset pendingInitiatorInit QUE si elle appartient
    // à l'appel qu'on nettoie. Si pendingCallId ≠ cleaningCallId,
    // c'est un signal pour un NOUVEL appel → on garde.
    if (!this.pendingCallId || this.pendingCallId === cleaningCallId) {
      this.pendingInitiatorInit = null;
      this.pendingCallId = null;
    } else {
      __DEV__ && console.log('[CallCrypto] 🔄 Preserving pendingInitiatorInit for new call:', this.pendingCallId?.slice(0, 16));
    }
    
    this.encryptCount = 0;
    this.decryptCount = 0;
    this.decryptFailCount = 0;
    
    // v1.1: Nettoyer le buffer audio
    if (this.pendingAudioPackets.length > 0) {
      __DEV__ && console.log(`[CallCrypto] 🗑️ Discarding ${this.pendingAudioPackets.length} buffered audio packets`);
    }
    this.pendingAudioPackets = [];
    this.pendingAudioBufferedCount = 0;
    this.pendingAudioDroppedCount = 0;
    
    // v1.2 FIX #1: Nettoyer le callback audio
    this.onDecryptedAudio = null;
    
    __DEV__ && console.log('[CallCrypto] ✅ Cleanup complete');
  }
  
  // ============================================
  // SÉRIALISATION (pour persistance temporaire)
  // ============================================
  
  /**
   * Sérialise l'état actuel
   */
  serializeState(): string | null {
    if (!this.currentState) {
      return null;
    }
    return serializeCallRatchetState(this.currentState);
  }
  
  /**
   * Restaure un état sérialisé
   */
  restoreState(serialized: string, sessionId: string): boolean {
    try {
      this.currentState = deserializeCallRatchetState(serialized);
      this.currentSessionId = sessionId;
      return true;
    } catch (error) {
      __DEV__ && console.error('[CallCrypto] Failed to restore state:', error);
      return false;
    }
  }
}

// ============================================
// SINGLETON EXPORT
// ============================================

export const callCryptoService = new CallCryptoService();

// ============================================
// FONCTIONS D'EXPORT SIMPLIFIÉES
// ============================================

export function initializeCallCrypto(
  sessionId: string,
  callId: string,
  isInitiator: boolean
) {
  return callCryptoService.initialize(sessionId, callId, isInitiator);
}

export function encryptCallAudio(audioData: Uint8Array): Uint8Array | null {
  return callCryptoService.encryptAudio(audioData);
}

export function decryptCallAudio(packet: Uint8Array): Uint8Array | null {
  return callCryptoService.decryptAudio(packet);
}

export function handleCallCryptoSignal(signal: CallCryptoSignal, callId?: string): void {
  // v5.0: handleSignal is now async (sends DH rotation responses).
  // Fire-and-forget is safe: errors are caught inside handleSignal.
  callCryptoService.handleSignal(signal, callId).catch(err => {
    __DEV__ && console.warn('[CallCrypto] handleSignal error:', err);
  });
}

export function setCallCryptoSignalCallback(callback: SignalCallback): void {
  callCryptoService.setSignalCallback(callback);
}

// v1.2 FIX #1: Export pour connecter le callback de flush audio
export function setCallCryptoOnDecryptedAudio(callback: (audioData: Uint8Array) => void): void {
  callCryptoService.setOnDecryptedAudio(callback);
}

export function cleanupCallCrypto(): void {
  callCryptoService.cleanup();
}

export function isCallCryptoInitialized(): boolean {
  return callCryptoService.isInitialized();
}

export function getCallCryptoInfo(): CallCryptoInfo | null {
  return callCryptoService.getInfo();
}