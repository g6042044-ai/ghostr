// src/services/callSignaling.ts
// Service de signaling pour les appels vocaux
// Version 5.1 - CORRECTIONS:
//   - v5.1: FIX CRITIQUE - Utiliser getTagToConversationMap() au lieu de getAllConversationTags()
//          getAllConversationTags retournait string[], pas Map, ce qui cassait la réception des signaux
//   - v3.0: Tracking des signaux traités pour éviter désync ratchet
//   - v4.0: Persistence des signaux traités dans AsyncStorage
//   - v4.0: Meilleure gestion du TTL pour les IDs persistés
//   - v4.0: Récupération automatique après crash/restart

// supabase import supprimé — les RPC passent par secureRpc (relay OHTTP + fallback)
import {
  getConversationKeys,
  getConversationTag,
  getConversationSenderToken,
  getTagToConversationMap,  // v5.1: FIX - Retourne Map<tag, conversationId>
  getMyIdentity,  // v5.0: Pour récupérer le displayName
} from './storage';
import {
  encodeBase64,
  getRandomBytes,
  secureRandomInt,
} from './crypto';
import {
  encryptWithMessageKey,
  decryptWithMessageKey,
} from './ratchet';
import {
  prepareMessageKey,
  getMessageKeyForDecrypt,
} from './ratchetStorage';
import { CallSignal } from './voiceCall';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deriveTagSeed, getSendTag, getPollingTags, generateDecoyTagsForEpoch, getEpochNumber, csprngShuffle } from './epochTags';
import { sha256 } from '@noble/hashes/sha256';
import { secureRpc } from './relayTransport';
import { enqueueMessage } from './constantTraffic';

// ============================================
// TYPES
// ============================================

interface RawCallSignal {
  id: string;
  tag: string;
  device_id: string;
  // FIX 0.1: signal_type et call_id supprimés — chiffrés dans sealed_payload
  sealed_payload: string;
  created_at: string;
}

interface CallSignalPayload {
  type: 'call-signal';
  signal: CallSignal;
  senderToken: string;
  conversationId: string;
  timestamp: number;
  // AJOUT: ID unique pour éviter les duplicatas
  signalId: string;
  // v5.0: Pseudo de l'expéditeur
  displayName?: string;
  // v15.0: Avatar de l'expéditeur (chiffré E2E)
  avatarBase64?: string;
}

interface DecryptedCallSignal {
  signal: CallSignal;
  senderToken: string;
  displayName?: string;  // v5.0: Pseudo de l'expéditeur
  avatarBase64?: string; // v15.0: Avatar de l'expéditeur
}

// ============================================
// CONFIGURATION v4.0
// ============================================

const MAX_PROCESSED_IDS = 1000;           // Limite pour éviter les fuites mémoire
const PROCESSED_IDS_TTL_MS = 3600000;     // 1 heure de rétention
const PERSISTENCE_KEY_SIGNAL_IDS = 'whisper_processed_signal_ids';
const PERSISTENCE_KEY_DB_IDS = 'whisper_processed_db_ids';
const PERSISTENCE_DEBOUNCE_MS = 1000;     // Debounce pour les sauvegardes

// ============================================
// TRACKING DES SIGNAUX TRAITÉS
// v4.0: Avec persistence dans AsyncStorage
// ============================================

interface ProcessedIdEntry {
  id: string;
  timestamp: number;
}

// Cache mémoire (synchronisé avec AsyncStorage)
let processedSignalIds: Map<string, number> = new Map();  // id -> timestamp
let processedDbIds: Map<string, number> = new Map();      // id -> timestamp

// Flags de chargement
let isLoaded = false;
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * v4.0: Charge les IDs persistés depuis AsyncStorage
 */
async function loadProcessedIds(): Promise<void> {
  if (isLoaded) return;
  
  try {
    const [signalIdsJson, dbIdsJson] = await Promise.all([
      AsyncStorage.getItem(PERSISTENCE_KEY_SIGNAL_IDS),
      AsyncStorage.getItem(PERSISTENCE_KEY_DB_IDS),
    ]);
    
    const now = Date.now();
    
    if (signalIdsJson) {
      const entries: ProcessedIdEntry[] = JSON.parse(signalIdsJson);
      processedSignalIds = new Map(
        entries
          .filter(e => now - e.timestamp < PROCESSED_IDS_TTL_MS)
          .map(e => [e.id, e.timestamp])
      );
    }
    
    if (dbIdsJson) {
      const entries: ProcessedIdEntry[] = JSON.parse(dbIdsJson);
      processedDbIds = new Map(
        entries
          .filter(e => now - e.timestamp < PROCESSED_IDS_TTL_MS)
          .map(e => [e.id, e.timestamp])
      );
    }
    
    isLoaded = true;
    console.log(`📞 Loaded processed IDs: ${processedSignalIds.size} signal IDs, ${processedDbIds.size} DB IDs`);
    
  } catch (error) {
    console.error('📞 Failed to load processed IDs:', error);
    isLoaded = true;  // Continuer malgré l'erreur
  }
}

/**
 * v4.0: Sauvegarde les IDs dans AsyncStorage (avec debounce)
 */
function scheduleSaveProcessedIds(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  
  saveTimeout = setTimeout(async () => {
    try {
      const now = Date.now();
      
      // Filtrer les IDs expirés avant de sauvegarder
      const signalEntries: ProcessedIdEntry[] = [];
      for (const [id, timestamp] of processedSignalIds) {
        if (now - timestamp < PROCESSED_IDS_TTL_MS) {
          signalEntries.push({ id, timestamp });
        }
      }
      
      const dbEntries: ProcessedIdEntry[] = [];
      for (const [id, timestamp] of processedDbIds) {
        if (now - timestamp < PROCESSED_IDS_TTL_MS) {
          dbEntries.push({ id, timestamp });
        }
      }
      
      await Promise.all([
        AsyncStorage.setItem(PERSISTENCE_KEY_SIGNAL_IDS, JSON.stringify(signalEntries)),
        AsyncStorage.setItem(PERSISTENCE_KEY_DB_IDS, JSON.stringify(dbEntries)),
      ]);
      
      console.log(`📞 Saved processed IDs: ${signalEntries.length} signal IDs, ${dbEntries.length} DB IDs`);
      
    } catch (error) {
      console.error('📞 Failed to save processed IDs:', error);
    }
  }, PERSISTENCE_DEBOUNCE_MS);
}

/**
 * Marque un signal comme traité (par signalId)
 */
function markSignalAsProcessed(signalId: string): void {
  processedSignalIds.set(signalId, Date.now());
  
  // Nettoyer si trop d'IDs
  if (processedSignalIds.size > MAX_PROCESSED_IDS) {
    cleanupOldIds(processedSignalIds);
  }
  
  // v4.0: Sauvegarder
  scheduleSaveProcessedIds();
}

/**
 * Vérifie si un signal a déjà été traité
 */
function isSignalAlreadyProcessed(signalId: string): boolean {
  const timestamp = processedSignalIds.get(signalId);
  if (!timestamp) return false;
  
  // Vérifier le TTL
  if (Date.now() - timestamp > PROCESSED_IDS_TTL_MS) {
    processedSignalIds.delete(signalId);
    return false;
  }
  
  return true;
}

/**
 * Marque un ID de base de données comme traité
 */
function markDbIdAsProcessed(dbId: string): void {
  processedDbIds.set(dbId, Date.now());
  
  if (processedDbIds.size > MAX_PROCESSED_IDS) {
    cleanupOldIds(processedDbIds);
  }
  
  // v4.0: Sauvegarder
  scheduleSaveProcessedIds();
}

/**
 * Vérifie si un ID de base de données a déjà été traité
 */
function isDbIdAlreadyProcessed(dbId: string): boolean {
  const timestamp = processedDbIds.get(dbId);
  if (!timestamp) return false;
  
  // Vérifier le TTL
  if (Date.now() - timestamp > PROCESSED_IDS_TTL_MS) {
    processedDbIds.delete(dbId);
    return false;
  }
  
  return true;
}

/**
 * v4.0: Nettoie les IDs les plus anciens
 */
function cleanupOldIds(map: Map<string, number>): void {
  const entries = Array.from(map.entries());
  // Trier par timestamp (les plus anciens d'abord)
  entries.sort((a, b) => a[1] - b[1]);
  // Supprimer les 500 plus anciens
  const toRemove = entries.slice(0, 500);
  for (const [id] of toRemove) {
    map.delete(id);
  }
}

// ============================================
// ENVOI DE SIGNAL D'APPEL
// v5.0: Inclut le displayName de l'expéditeur
// ============================================

export async function sendCallSignal(
  conversationId: string,
  signal: CallSignal
): Promise<{ success: boolean; error?: string }> {
  try {
    // v4.0: S'assurer que les IDs sont chargés
    await loadProcessedIds();
    
    const keys = await getConversationKeys(conversationId);
    if (!keys) {
      return { success: false, error: 'Conversation keys not found' };
    }

    const tag = await getConversationTag(conversationId);
    if (!tag) {
      return { success: false, error: 'Conversation tag not found' };
    }

    // v3.1 - Token par conversation
    const senderToken = await getConversationSenderToken(conversationId);
    const timestamp = Date.now();
    
    // v5.0 - Récupérer le displayName de l'utilisateur
    // v15.0 - Récupérer aussi l'avatar
    const myIdentity = await getMyIdentity(conversationId);
    const displayName = myIdentity?.displayName;
    const avatarBase64 = myIdentity?.avatarBase64;
    
    // Générer un ID unique pour ce signal
    const signalId = encodeBase64(getRandomBytes(16));

    const { messageKey, ratchetIndex, updateFn } = await prepareMessageKey(conversationId);

    const payload: CallSignalPayload = {
      type: 'call-signal',
      signal,
      senderToken,
      conversationId,
      timestamp,
      signalId,
      displayName,  // v5.0: Inclure le pseudo
      avatarBase64, // v15.0: Inclure l'avatar (chiffré E2E)
    };

    const payloadString = JSON.stringify(payload);
    const { encrypted, nonce } = encryptWithMessageKey(payloadString, messageKey);

    const sealedPayload = JSON.stringify({
      type: 'sealed_call_v1',
      encrypted,
      nonce,
      ratchetIndex,
      senderToken,
    });

    const anonymousDeviceId = encodeBase64(getRandomBytes(16));

    // FIX 0.1: signal_type et call_id sont maintenant DANS sealedPayload (chiffrés E2E)
    // Le serveur ne voit plus que des blobs opaques — pas de registre d'appels possible
    // URGENT: Les appels VoIP sont envoyés immédiatement + decoys masquants
    const { error } = await enqueueMessage(conversationId, () =>
      secureRpc('send_call_signal', {
        p_tag: tag,
        p_device_id: anonymousDeviceId,
        p_sealed_payload: sealedPayload,
      }),
      'urgent'
    );

    if (error) {
      console.error('Send call signal error:', error);
      return { success: false, error: error.message };
    }

    // Mettre à jour l'état du ratchet APRÈS l'envoi réussi
    await updateFn();
    
    // Marquer comme traité (pour ne pas le retraiter si on le reçoit)
    markSignalAsProcessed(signalId);

    console.log(`📞 Call signal sent: ${signal.type} for call ${signal.callId.slice(0, 8)}... (ratchet: ${ratchetIndex})${displayName ? ` as "${displayName}"` : ''}`);
    return { success: true };

  } catch (error) {
    console.error('Send call signal exception:', error);
    return { success: false, error: String(error) };
  }
}

// ============================================
// RÉCEPTION DES SIGNAUX D'APPEL
// ============================================

export async function fetchCallSignals(
  since?: Date
): Promise<Map<string, DecryptedCallSignal[]>> {
  try {
    // v4.0: S'assurer que les IDs sont chargés
    await loadProcessedIds();
    
    // v5.1 FIX: Utiliser getTagToConversationMap qui retourne Map<tag, conversationId>
    const tagMap = await getTagToConversationMap();
    if (tagMap.size === 0) {
      return new Map();
    }

    const realTags = Array.from(tagMap.keys());
    
    // PHASE 1: Use epoch-based decoy tags (HKDF-persistent) instead of random decoys
    const decoyHashSeed = sha256(new TextEncoder().encode('call-decoy:' + realTags.join(',')));
    const callDecoys = generateDecoyTagsForEpoch(decoyHashSeed, getEpochNumber(), 4);
    const allTags = [...realTags, ...callDecoys];
    // Audit Fix M-03: Shuffle avec CSPRNG
    const shuffledTags = csprngShuffle(allTags);

    const { data, error } = await secureRpc('get_call_signals_by_tags', {
      p_tags: shuffledTags,
      p_since: since?.toISOString() || null,
      p_limit: 50,
    });

    if (error) {
      console.error('Fetch call signals error:', error);
      return new Map();
    }

    if (!data || data.length === 0) {
      return new Map();
    }

    const signalsByConversation = new Map<string, DecryptedCallSignal[]>();
    // v3.1 - Cache des tokens par conversation pour éviter les appels répétés
    const tokenCache = new Map<string, string>();

    for (const raw of data as RawCallSignal[]) {
      // v4.0: Vérifier si on a déjà traité ce signal (par ID de DB) avec TTL
      if (isDbIdAlreadyProcessed(raw.id)) {
        console.log(`📞 Skipping already processed signal (db): ${raw.id.slice(0, 8)}...`);
        continue;
      }
      
      const conversationId = tagMap.get(raw.tag);
      if (!conversationId) continue;

      // v3.1 - Obtenir le token pour cette conversation (avec cache)
      let mySenderToken = tokenCache.get(conversationId);
      if (!mySenderToken) {
        mySenderToken = await getConversationSenderToken(conversationId);
        tokenCache.set(conversationId, mySenderToken);
      }

      try {
        const result = await decryptCallSignal(raw, conversationId, mySenderToken);
        if (result) {
          // Marquer comme traité
          markDbIdAsProcessed(raw.id);
          
          const signals = signalsByConversation.get(conversationId) || [];
          signals.push(result);
          signalsByConversation.set(conversationId, signals);
        }
      } catch (e) {
        // Log mais ne pas bloquer les autres signaux
        console.warn('Failed to decrypt call signal:', e);
      }
    }

    return signalsByConversation;

  } catch (error) {
    console.error('Fetch call signals exception:', error);
    return new Map();
  }
}

/**
 * Déchiffre un signal d'appel
 * CORRECTIONS:
 * - Vérifie si le signal a déjà été traité (par signalId)
 * - updateFn() appelé seulement si signal valide et non-dupliqué
 */
async function decryptCallSignal(
  raw: RawCallSignal,
  conversationId: string,
  mySenderToken: string
): Promise<DecryptedCallSignal | null> {
  try {
    const keys = await getConversationKeys(conversationId);
    if (!keys) return null;

    const sealedPayload = JSON.parse(raw.sealed_payload);

    if (sealedPayload.type !== 'sealed_call_v1') {
      console.warn('Unknown call signal payload type:', sealedPayload.type);
      return null;
    }

    const { encrypted, nonce, ratchetIndex, senderToken: msgSenderToken } = sealedPayload;

    // Ignorer mes propres signaux
    if (msgSenderToken === mySenderToken) {
      return null;
    }

    // Récupérer la clé de déchiffrement
    let messageKey: Uint8Array;
    let updateFn: () => Promise<void>;
    
    try {
      const keyResult = await getMessageKeyForDecrypt(
        conversationId,
        msgSenderToken,
        ratchetIndex
      );
      
      // v2.2 - Si null, le signal a déjà été traité, le skipper
      if (!keyResult) {
        console.log(`📞 Skipping old signal (ratchet): already processed`);
        return null;
      }
      
      messageKey = keyResult.messageKey;
      updateFn = keyResult.updateFn;
    } catch (e) {
      // Erreur de ratchet (duplicata ou désync)
      console.warn(`📞 Ratchet error for signal from ${msgSenderToken.slice(0, 8)}...: ${e}`);
      return null;
    }

    // Déchiffrer
    let decrypted: string;
    try {
      decrypted = decryptWithMessageKey(encrypted, nonce, messageKey);
    } catch (e) {
      console.warn('Decryption failed:', e);
      return null;
    }
    
    const payload: CallSignalPayload = JSON.parse(decrypted);

    // v4.0: Vérifier si on a déjà traité ce signalId avec TTL
    if (payload.signalId && isSignalAlreadyProcessed(payload.signalId)) {
      console.log(`📞 Skipping already processed signal: ${payload.signal.type}`);
      return null; // NE PAS appeler updateFn()
    }

    // Vérifier la cohérence
    if (payload.conversationId !== conversationId) {
      console.warn('Call signal conversation mismatch');
      return null;
    }

    if (payload.senderToken !== msgSenderToken) {
      console.warn('Call signal senderToken mismatch');
      return null;
    }

    // TOUT EST VALIDE - Maintenant on peut update le ratchet
    await updateFn();
    
    // Marquer comme traité
    if (payload.signalId) {
      markSignalAsProcessed(payload.signalId);
    }

    // v5.0: Log avec le displayName si présent
    const displayInfo = payload.displayName ? ` ("${payload.displayName}")` : '';
    console.log(`📞 Received signal: ${payload.signal.type} from ${msgSenderToken.slice(0, 8)}...${displayInfo} (ratchet: ${ratchetIndex})`);

    return {
      signal: payload.signal,
      senderToken: msgSenderToken,
      displayName: payload.displayName,  // v5.0: Inclure le pseudo
      avatarBase64: payload.avatarBase64, // v15.0: Inclure l'avatar
    };

  } catch (error) {
    console.error('Decrypt call signal error:', error);
    return null;
  }
}

// ============================================
// POLLING DES SIGNAUX D'APPEL
// v5.0: Ajout du displayName dans le callback
// v15.0: Ajout de avatarBase64 dans le callback
// ============================================

interface CallSignalPollingState {
  isRunning: boolean;
  lastPollTime: Date | null;
  intervalId: ReturnType<typeof setTimeout> | null;
  onSignalReceived: ((conversationId: string, signal: CallSignal, senderToken: string, displayName?: string, avatarBase64?: string) => void) | null;
}

const pollingState: CallSignalPollingState = {
  isRunning: false,
  lastPollTime: null,
  intervalId: null,
  onSignalReceived: null,
};

// v6.0 OPTIMIZATION: Réduction drastique des intervalles de polling
// pour une signalisation quasi temps-réel (état de l'art: < 500ms)
// Ancien: 3000-5000ms -> Nouveau: 400-700ms
const CALL_POLL_INTERVAL_MIN_MS = 400;
const CALL_POLL_INTERVAL_MAX_MS = 700;

export async function startCallSignalPolling(
  onSignalReceived: (conversationId: string, signal: CallSignal, senderToken: string, displayName?: string, avatarBase64?: string) => void
): Promise<void> {
  if (pollingState.isRunning) return;

  // v4.0: Charger les IDs persistés au démarrage du polling
  await loadProcessedIds();

  pollingState.isRunning = true;
  pollingState.lastPollTime = new Date();
  pollingState.onSignalReceived = onSignalReceived;

  performCallSignalPoll();
  scheduleNextCallPoll();

  console.log('📞 Call signal polling started');
}

function scheduleNextCallPoll(): void {
  if (!pollingState.isRunning) return;

  const range = CALL_POLL_INTERVAL_MAX_MS - CALL_POLL_INTERVAL_MIN_MS;
  const delay = CALL_POLL_INTERVAL_MIN_MS + secureRandomInt(range);

  pollingState.intervalId = setTimeout(() => {
    performCallSignalPoll();
    scheduleNextCallPoll();
  }, delay);
}

async function performCallSignalPoll(): Promise<void> {
  try {
    const since = pollingState.lastPollTime;
    pollingState.lastPollTime = new Date();

    const signalsByConversation = await fetchCallSignals(since || undefined);

    for (const [conversationId, results] of signalsByConversation) {
      for (const result of results) {
        pollingState.onSignalReceived?.(
          conversationId, 
          result.signal, 
          result.senderToken,
          result.displayName,  // v5.0: Passer le displayName
          result.avatarBase64  // v15.0: Passer l'avatar
        );
      }
    }

  } catch (error) {
    console.error('Call signal poll error:', error);
  }
}

export function stopCallSignalPolling(): void {
  pollingState.isRunning = false;

  if (pollingState.intervalId) {
    clearTimeout(pollingState.intervalId);
    pollingState.intervalId = null;
  }

  pollingState.onSignalReceived = null;

  console.log('📞 Call signal polling stopped');
}

export async function forceCallSignalPoll(): Promise<void> {
  await performCallSignalPoll();
}

export function isCallSignalPollingActive(): boolean {
  return pollingState.isRunning;
}

// ============================================
// NETTOYAGE (pour reset entre les appels)
// v4.0: Nettoyage aussi dans AsyncStorage
// ============================================

export async function clearProcessedSignals(): Promise<void> {
  processedSignalIds.clear();
  processedDbIds.clear();
  
  // v4.0: Nettoyer aussi AsyncStorage
  try {
    await Promise.all([
      AsyncStorage.removeItem(PERSISTENCE_KEY_SIGNAL_IDS),
      AsyncStorage.removeItem(PERSISTENCE_KEY_DB_IDS),
    ]);
  } catch (error) {
    console.error('📞 Failed to clear persisted signal IDs:', error);
  }
  
  console.log('📞 Cleared processed signals cache');
}

// ============================================
// v4.0: INITIALISATION
// À appeler au démarrage de l'app
// ============================================

export async function initializeCallSignaling(): Promise<void> {
  await loadProcessedIds();
  console.log('📞 Call signaling initialized');
}