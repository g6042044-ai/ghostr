// src/services/constantTraffic.ts
// PHASE 2: Constant-Rate Traffic Manager
//
// PROBLÈME RÉSOLU:
//   Avant: burst de 3 decoys après chaque vrai message → pattern détectable
//   Après: flux à débit constant (1 slot / 45s) — le vrai message remplace un decoy
//
// PRINCIPE:
//   - Un slot de transmission se déclenche toutes les SLOT_INTERVAL_MS millisecondes
//   - Si l'utilisateur a un message en attente → envoyer le vrai message
//   - Sinon → envoyer un decoy indistinguable
//   - Le serveur voit un flux constant → impossible de distinguer activité/inactivité
//   - Polling aussi à intervalle constant (POLL_INTERVAL_MS)
//
// SÉCURITÉ:
//   - Pas de bypass, pas de burst. Les messages urgents (appels VoIP)
//     sont en tête de queue et le slot est accéléré (200ms-2s).
//   - Le volume de trafic est identique qu'il s'agisse d'un decoy ou d'un vrai message.
//   - Le timing de drain (200ms-2s) est indistinguable des random bursts (5% des slots).

import { AppState, AppStateStatus } from 'react-native';
import * as Crypto from 'expo-crypto';
import { secureRandomInt } from './crypto';

// ============================================
// CONFIGURATION
// ============================================

/** Intervalle entre chaque slot de transmission (ms) — INCHANGÉ */
const SLOT_INTERVAL_MS = 30_000; // 30 secondes

/** Intervalle entre chaque poll (ms) — agressif pour réception appels */
const POLL_INTERVAL_MS = 5_000; // 5 secondes

/** Jitter d'ENVOI: ±30s — protège l'anonymat d'envoi.
 * Audit Fix M-04: ±10s est insuffisant contre un adversaire réseau qui peut corréler
 * les patterns temporels sur ~24h d'observation. */
const SLOT_JITTER_MS = 30_000; // ±30 secondes

/** Jitter de RÉCEPTION: ±3s — proportionnel au poll réduit.
 * N'impacte PAS l'anonymat : le poll est une lecture uniforme, tous les clients
 * pollent au même rythme constant via OHTTP avec 50 tags shufflés (vrais + decoys). */
const POLL_JITTER_MS = 3_000; // ±3 secondes

/** Audit Fix M-04: Probabilité d'un burst de dummy traffic par slot (5%) */
const BURST_PROBABILITY = 0.05;
const BURST_MIN_COUNT = 2;
const BURST_MAX_COUNT = 8; // v25.1: élargi de 5→8 pour couvrir les sous-rafales de drain

/**
 * v25.0: DECOY INTERLEAVING — Masquage des transferts média chunkés.
 *
 * PROBLÈME:
 *   Un média de 200KB produit ~50 chunks envoyés consécutivement via le drain
 *   accéléré (200ms-2s). L'observateur voit un burst de 50 messages consécutifs
 *   sans aucun decoy → pattern statistiquement anormal (les bursts normaux font 2-5).
 *
 * SOLUTION:
 *   Quand la queue contient > DECOY_INTERLEAVE_THRESHOLD messages, chaque slot
 *   a DECOY_INTERLEAVE_PROBABILITY de chances d'envoyer un decoy AU LIEU du
 *   prochain message réel. Le message réel reste en queue pour le slot suivant.
 *
 * RÉSULTAT:
 *   Pour 50 chunks: ~17 decoys injectés → 67 messages totaux (~67s)
 *   Pour 125 chunks: ~42 decoys injectés → 167 messages totaux (~2.8 min)
 *   L'observateur ne peut plus distinguer chunks/decoys dans le burst.
 *
 * IMPACT LATENCE:
 *   +33% environ (1s → 1.33s par chunk en moyenne). Pour 200KB: ~67s au lieu de ~50s.
 */
const DECOY_INTERLEAVE_THRESHOLD = 3;
// GH-15: Variable probability per burst (15%-40%) instead of fixed 25%
const DECOY_INTERLEAVE_PROBABILITY_MIN = 0.15;
const DECOY_INTERLEAVE_PROBABILITY_MAX = 0.40;

// ============================================
// TYPES
// ============================================

type SendDecoyFn = () => Promise<void>;
type SendDecoyMediumTierFn = () => Promise<void>;
type PollFn = () => Promise<void>;
type SendMessageFn = () => Promise<void>;

interface QueuedMessage {
  sessionId: string;
  sendFn: SendMessageFn;
  priority: 'normal' | 'urgent' | 'deferred';
  enqueuedAt: number;
  rejectFn?: (reason: Error) => void;
}

// ============================================
// STATE
// ============================================

let sendDecoyFn: SendDecoyFn | null = null;
let sendDecoyMediumTierFn: SendDecoyMediumTierFn | null = null;
let pollFn: PollFn | null = null;

let slotTimerId: ReturnType<typeof setTimeout> | null = null;
let pollTimerId: ReturnType<typeof setTimeout> | null = null;

let messageQueue: QueuedMessage[] = [];
let isRunning = false;

// Génération: incrémentée à chaque start. Les résultats de polls d'anciennes
// générations sont ignorés pour éviter le double-traitement lors du remount React.
let currentGeneration = 0;

// Stats
let stats = {
  slotsFired: 0,
  realMessagesSent: 0,
  decoysSent: 0,
  interleaveDecoysSent: 0, // v25.0: Decoys injectés pendant drain media
  urgentBypassCount: 0,
  startedAt: 0,
};

// v25.1: Sub-burst drain — fragmente les drains longs en sous-rafales
// de taille aléatoire (3-8 messages) avec pauses inter-burst
// pour que les longues séquences de chunks soient indistinguables
// du trafic normal (bursts aléatoires de 2-5 + decoys)
let consecutiveDrainCount = 0;
let currentSubBurstSize = 0;

// AppState listener
let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

// ============================================
// JITTER HELPER (Audit Fix M-04)
// ============================================

/**
 * Génère un intervalle jitté avec distribution exponentielle et CSPRNG.
 * 
 * Audit Fix M-04:
 *   - Remplace Math.random() par Crypto.getRandomBytes() (CSPRNG)
 *   - Distribution exponentielle au lieu d'uniforme
 *     (rend la corrélation statistique beaucoup plus difficile)
 *   - Jitter paramétrable: SLOT_JITTER_MS pour l'envoi, POLL_JITTER_MS pour la réception
 */
function jitteredMs(baseMs: number, jitterMs: number = SLOT_JITTER_MS): number {
  // Générer un float aléatoire CSPRNG dans [0, 1)
  const randomBytes = Crypto.getRandomBytes(4);
  const randomUint = new DataView(
    randomBytes.buffer,
    randomBytes.byteOffset,
    randomBytes.byteLength
  ).getUint32(0, false);
  const u = randomUint / 0x100000000; // [0, 1)
  
  // Distribution exponentielle: -ln(1 - u) * lambda
  // Centrée sur 0 avec scale = jitterMs
  // Signe aléatoire pour +/- jitter
  const signBytes = Crypto.getRandomBytes(1);
  const sign = (signBytes[0] & 1) === 0 ? 1 : -1;
  
  // Exponentielle tronquée à [0, jitterMs]
  const exponentialJitter = Math.min(
    -Math.log(1 - u * 0.999) * (jitterMs / 3), // lambda = jitter/3
    jitterMs
  );
  
  const jitter = sign * exponentialJitter;
  return Math.max(1000, baseMs + jitter); // minimum 1s
}

// ============================================
// SLOT TICK (transmission)
// ============================================

async function slotTick(): Promise<void> {
  if (!isRunning) return;
  
  stats.slotsFired++;
  
  // Vérifier s'il y a un vrai message en attente (premier en queue, FIFO)
  const nextMessage = messageQueue.length > 0 ? messageQueue[0] : null;
  
  if (nextMessage && sendDecoyFn) {
    // =========================================================
    // v25.0: DECOY INTERLEAVING
    // Quand la queue est profonde (media chunking), on injecte
    // probabilistiquement des decoys entre les vrais messages
    // pour casser le pattern de burst consécutif.
    //
    // Sans ça: 50 chunks → 50 messages consécutifs → détectable
    // Avec ça: 50 chunks + ~17 decoys → indistinguable
    //
    // v25.2: Les decoys interleaved utilisent des tags ALÉATOIRES (pas session-targeted).
    // Les session-targeted decoys causaient des erreurs de déchiffrement côté
    // destinataire (le ratchet tentait de décrypter du random → échec + logs ERROR).
    // Les decoys à tags aléatoires sont "fire and forget" — personne ne les fetch.
    // Le serveur voit des messages vers des tags variés → ne peut pas distinguer
    // lesquels sont des chunks réels (l'analyse par tag reste possible mais
    // nécessite une corrélation temporelle fine, pas juste le tag).
    // =========================================================
    // NEVER delay urgent messages (call signals) with decoy interleaving.
    // Urgent messages must be sent within 50-200ms for real-time signaling.
    if (nextMessage.priority !== 'urgent' && messageQueue.length > DECOY_INTERLEAVE_THRESHOLD) {
      // GH-15: Variable probability per burst — harder to detect statistically
      const range = DECOY_INTERLEAVE_PROBABILITY_MAX - DECOY_INTERLEAVE_PROBABILITY_MIN;
      const burstProbability = DECOY_INTERLEAVE_PROBABILITY_MIN + (secureRandomInt(1000) / 1000) * range;
      const interleaveRandom = Crypto.getRandomBytes(1)[0] / 256;
      if (interleaveRandom < burstProbability) {
        try {
          // Decoy medium-tier à tag aléatoire — même taille que les chunks,
          // mais envoyé vers un tag que personne ne poll → pas d'erreur côté destinataire
          const interleaveDecoyFn = sendDecoyMediumTierFn || sendDecoyFn;
          await interleaveDecoyFn!();
          stats.decoysSent++;
          stats.interleaveDecoysSent++;
          __DEV__ && console.log(`[ConstantTraffic] 👻🔀 Slot #${stats.slotsFired}: INTERLEAVED medium-tier decoy (queue: ${messageQueue.length})`);
        } catch {
          // Decoy failures are silent
        }
        scheduleNextSlot();
        return; // Ne pas continuer vers le burst aléatoire
      }
    }
    
    // Envoyer le vrai message (remplace le decoy de ce slot)
    messageQueue.shift();
    try {
      await nextMessage.sendFn();
      stats.realMessagesSent++;
      __DEV__ && console.log(`[ConstantTraffic] 📤 Slot #${stats.slotsFired}: REAL message sent (queue: ${messageQueue.length})`);
    } catch (error) {
      __DEV__ && console.error('[ConstantTraffic] Real message send error:', error);
    }
  } else if (sendDecoyFn) {
    // Pas de vrai message → envoyer un decoy
    try {
      await sendDecoyFn();
      stats.decoysSent++;
      __DEV__ && console.log(`[ConstantTraffic] 👻 Slot #${stats.slotsFired}: decoy sent (total: ${stats.decoysSent})`);
    } catch {
      // Decoy failures are silent
    }
  }
  
  // Audit Fix M-04: Burst aléatoire de dummy traffic pour briser les patterns
  // Avec probabilité BURST_PROBABILITY, envoyer quelques decoys supplémentaires
  //
  // v30.1: SKIP burst when urgent messages are pending in queue.
  // Random bursts fire 2-8 concurrent OHTTP requests. When call signals
  // (offer, crypto, answer) are queued as urgent, these burst decoys compete
  // for OHTTP relay bandwidth and delay the next urgent slot by 1-3s.
  // Bursts will resume naturally once all urgent messages are drained.
  const hasUrgentPending = messageQueue.length > 0 && messageQueue[0].priority === 'urgent';
  if (sendDecoyFn && !hasUrgentPending) {
    const burstRandom = Crypto.getRandomBytes(4);
    const burstValue = new DataView(
      burstRandom.buffer,
      burstRandom.byteOffset,
      burstRandom.byteLength
    ).getUint32(0, false) / 0x100000000;
    
    if (burstValue < BURST_PROBABILITY) {
      const burstCount = BURST_MIN_COUNT + secureRandomInt(BURST_MAX_COUNT - BURST_MIN_COUNT + 1);
      
      for (let i = 0; i < burstCount; i++) {
        sendDecoyFn().catch(() => {});
      }
      
      __DEV__ && console.log(`[ConstantTraffic] 💥 Random burst: ${burstCount} dummy messages`);
    }
  }
  
  // Programmer le prochain slot
  scheduleNextSlot();
}

function scheduleNextSlot(): void {
  if (!isRunning) return;
  
  if (messageQueue.length > 0) {
    // FIX Bug 2+3: If the NEXT message in queue is urgent, ALWAYS use fast drain.
    // This also fixes Bug 3 (timer overwrite): scheduleNextSlot is the single
    // source of truth for the next timer — no need to worry about enqueueMessage's
    // timer being overwritten, because we always check priority here.
    if (messageQueue[0].priority === 'urgent') {
      const fastDelay = 50 + secureRandomInt(150); // 50-200ms — same as enqueueMessage urgent
      slotTimerId = setTimeout(slotTick, fastDelay);
      return;
    }
    
    consecutiveDrainCount++;
    
    // v25.2: SUB-BURST DRAIN ADAPTATIF
    // Fragmente le drain en sous-rafales pour casser le pattern de burst,
    // mais adapte la taille et la pause au volume en queue:
    //
    // Queue profonde (>20, media transfer):
    //   Sub-bursts larges (5-12), pauses courtes (3-8s)
    //   → 135 chunks ≈ 14 bursts × 5.5s ≈ 3 min total
    //
    // Queue moyenne (4-20, multiple messages):
    //   Sub-bursts normaux (3-8), pauses moyennes (5-15s)
    //
    // Queue courte (1-3):
    //   Pas de sub-burst, drain direct (200ms-2s)
    //   → Identique au comportement pré-sub-burst
    
    const queueDepth = messageQueue.length;
    
    if (queueDepth <= DECOY_INTERLEAVE_THRESHOLD) {
      // Queue courte → drain direct, pas de sub-burst
      const drainDelay = 200 + secureRandomInt(1800);
      slotTimerId = setTimeout(slotTick, drainDelay);
      return;
    }
    
    if (currentSubBurstSize === 0) {
      // Initialiser la taille de la sous-rafale selon la profondeur
      if (queueDepth > 20) {
        currentSubBurstSize = 5 + secureRandomInt(8); // 5-12
      } else {
        currentSubBurstSize = 3 + secureRandomInt(6); // 3-8
      }
    }
    
    if (consecutiveDrainCount >= currentSubBurstSize) {
      // Fin de sous-rafale → pause adaptative
      consecutiveDrainCount = 0;
      
      let pauseDelay: number;
      if (queueDepth > 20) {
        // Media transfer: pauses courtes (3-8s)
        // Assez long pour briser le pattern, assez court pour être utilisable
        pauseDelay = 3000 + secureRandomInt(5000);
        currentSubBurstSize = 5 + secureRandomInt(8); // 5-12
      } else {
        // Multiple messages: pauses moyennes (5-15s)
        pauseDelay = 5000 + secureRandomInt(10000);
        currentSubBurstSize = 3 + secureRandomInt(6); // 3-8
      }
      
      slotTimerId = setTimeout(slotTick, pauseDelay);
    } else {
      // Au sein d'une sous-rafale → délai court (200ms-2s)
      const drainDelay = 200 + secureRandomInt(1800);
      slotTimerId = setTimeout(slotTick, drainDelay);
    }
  } else {
    // Queue vide → reset des compteurs sub-burst
    consecutiveDrainCount = 0;
    currentSubBurstSize = 0;
    slotTimerId = setTimeout(slotTick, jitteredMs(SLOT_INTERVAL_MS));
  }
}

// ============================================
// POLL TICK
// ============================================

async function pollTick(): Promise<void> {
  if (!isRunning || !pollFn) return;
  
  __DEV__ && console.log('[ConstantTraffic] 🔍 Poll tick');
  
  try {
    await pollFn();
  } catch (error) {
    __DEV__ && console.error('[ConstantTraffic] Poll error:', error);
  }
  
  scheduleNextPoll();
}

function scheduleNextPoll(): void {
  if (!isRunning) return;
  pollTimerId = setTimeout(pollTick, jitteredMs(POLL_INTERVAL_MS, POLL_JITTER_MS));
}

// ============================================
// APPSTATE LISTENER
// ============================================

function handleAppStateChange(nextState: AppStateStatus): void {
  if (nextState === 'active' && isRunning) {
    // L'app revient au foreground → reprendre immédiatement
    __DEV__ && console.log('[ConstantTraffic] App resumed, firing immediate slot + poll');
    
    // Annuler les timers en cours et relancer
    if (slotTimerId) clearTimeout(slotTimerId);
    if (pollTimerId) clearTimeout(pollTimerId);
    
    slotTick();
    pollTick();
  }
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Démarre le traffic constant.
 * 
 * @param decoyFn - Fonction qui envoie un decoy (indistinguable d'un vrai message)
 * @param pollCallback - Fonction qui poll les messages en attente
 */
export function startConstantTraffic(
  decoyFn: SendDecoyFn,
  pollCallback: PollFn,
  mediumTierDecoyFn?: SendDecoyMediumTierFn,
): void {
  if (isRunning) return;

  sendDecoyFn = decoyFn;
  sendDecoyMediumTierFn = mediumTierDecoyFn || null;
  pollFn = pollCallback;
  isRunning = true;
  currentGeneration++;
  
  stats = {
    slotsFired: 0,
    realMessagesSent: 0,
    decoysSent: 0,
    interleaveDecoysSent: 0,
    urgentBypassCount: 0,
    startedAt: Date.now(),
  };
  
  // Démarrer les boucles
  scheduleNextSlot();
  scheduleNextPoll();
  
  // Écouter les changements d'état de l'app
  appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
  
  __DEV__ && console.log('[ConstantTraffic] Started (slot every ~30s ±30s, poll every ~5s ±5s)');
}

/**
 * Arrête le traffic constant.
 */
export function stopConstantTraffic(): void {
  isRunning = false;
  
  if (slotTimerId) {
    clearTimeout(slotTimerId);
    slotTimerId = null;
  }
  
  if (pollTimerId) {
    clearTimeout(pollTimerId);
    pollTimerId = null;
  }
  
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
  
  // P0 FIX: Flush urgent messages immédiatement au lieu de les détruire.
  // Sans ça, les signaux d'appel (offer, answer, hangup) enqueued avec
  // priority='urgent' sont perdus quand l'AppState cycle background→foreground,
  // ce qui rendait les appels impossibles.
  const urgentMessages = messageQueue.filter(m => m.priority === 'urgent');
  const nonUrgentMessages = messageQueue.filter(m => m.priority !== 'urgent');
  
  // Envoyer les messages urgents en fire-and-forget
  for (const msg of urgentMessages) {
    msg.sendFn().catch(e => {
      __DEV__ && console.warn('[ConstantTraffic] Flush urgent on stop error:', e);
    });
  }
  
  if (urgentMessages.length > 0) {
    __DEV__ && console.log(`[ConstantTraffic] 🚨 Flushed ${urgentMessages.length} urgent messages on stop`);
  }
  
  // Rejeter les promises des messages non-urgents pour éviter les hanging promises
  for (const msg of nonUrgentMessages) {
    if (msg.rejectFn) {
      msg.rejectFn(new Error('ConstantTraffic stopped — message dropped'));
    }
  }
  
  messageQueue = [];
  sendDecoyFn = null;
  sendDecoyMediumTierFn = null;
  pollFn = null;
  
  __DEV__ && console.log('[ConstantTraffic] Stopped');
}

/**
 * Enqueue un message pour envoi au prochain slot.
 * 
 * SÉCURITÉ: Pas de bypass, pas de burst. Le message remplace le decoy prévu.
 * Le volume de trafic reste constant quel que soit le type de message.
 * Un observateur réseau ne voit aucune différence entre un slot decoy et un slot réel.
 * 
 * - normal: ajouté en fin de queue
 * - urgent: ajouté en TÊTE de queue (priorité FIFO, pas de burst)
 * 
 * Dans les deux cas, le prochain slot est accéléré (~100-600ms de micro-jitter).
 */
/**
 * Enqueue un message pour envoi au prochain slot.
 * 
 * SÉCURITÉ: Le volume de trafic reste constant quel que soit le type de message.
 * 
 * Priorités:
 * - urgent: ajouté en TÊTE de queue + slot accéléré (~100-600ms)
 * - normal: ajouté en fin de queue + slot accéléré (~200-2000ms)
 * - deferred: ajouté en fin de queue + PAS d'accélération de slot
 *
 * ANTI-SDA (Statistical Disclosure Attack):
 *   Les delivery/read receipts DOIVENT utiliser 'deferred' pour ne pas créer
 *   de corrélation temporelle entre la réception d'un message et l'envoi
 *   du receipt. Le receipt attend le prochain slot naturel (~30s ±30s),
 *   rendant la corrélation statistique impossible.
 *   Ref: Martiny et al., NDSS 2021 — "Improving Signal's Sealed Sender"
 */
export function enqueueMessage<T>(
  sessionId: string,
  sendFn: () => Promise<T>,
  priority: 'normal' | 'urgent' | 'deferred' = 'normal'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const wrappedSendFn = async () => {
      try {
        const result = await sendFn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    
    const entry: QueuedMessage = {
      sessionId,
      sendFn: wrappedSendFn,
      priority,
      enqueuedAt: Date.now(),
      // P0 FIX: Stocker reject pour pouvoir résoudre la promise si la queue
      // est vidée (stopConstantTraffic). Sans ça, la promise hang indéfiniment
      // et sendCallSignal1to1 ne retourne jamais.
      rejectFn: reject,
    };
    
    if (priority === 'urgent') {
      // Insérer en tête → sera envoyé au prochain slot (pas de burst détectable)
      messageQueue.unshift(entry);
    } else {
      messageQueue.push(entry);
    }
    
    // ANTI-SDA: 'deferred' ne déclenche PAS d'accélération de slot.
    // Le message attend le prochain slot naturellement schedulé.
    // Cela empêche un adversaire de corréler un receipt avec le message
    // qui l'a déclenché via le timing d'envoi.
    if (priority === 'deferred') {
      // Ne rien faire — le message sera envoyé au prochain slot naturel
      return;
    }
    
    // Accélérer le prochain slot : annuler le timer en cours et déclencher
    // après un délai aléatoire. Le timing est indistinguable des
    // random bursts existants (5% des slots déclenchent 2-5 messages rapides).
    if (slotTimerId) {
      clearTimeout(slotTimerId);
      slotTimerId = null;
    }
    
    // P1 FIX: Urgent = 50-200ms (signaux d'appel, critiques pour la latence)
    // Normal = 200-2000ms (texte, médias, pas de contrainte temps réel)
    const microJitter = priority === 'urgent'
      ? 50 + secureRandomInt(150)    // 50-200ms pour appels
      : 200 + secureRandomInt(1800); // 200-2000ms pour messages normaux
    slotTimerId = setTimeout(slotTick, microJitter);
  });
}

/**
 * Force un poll immédiat (par exemple quand l'UI fait un pull-to-refresh).
 */
export function forceImmediatePoll(): void {
  if (!isRunning || !pollFn) return;
  pollFn().catch(() => {});
}

/**
 * Retourne la génération courante du traffic manager.
 * Utilisé par pollAllSessions pour ignorer les résultats périmés.
 */
export function getPollGeneration(): number {
  return currentGeneration;
}

/**
 * Retourne les statistiques de traffic.
 */
export function getTrafficStats() {
  const uptimeMs = isRunning ? Date.now() - stats.startedAt : 0;
  const totalSent = stats.realMessagesSent + stats.decoysSent;
  
  return {
    ...stats,
    uptimeMs,
    totalSent,
    ratio: totalSent > 0 
      ? `${stats.realMessagesSent}/${totalSent} real (${Math.round(stats.realMessagesSent / totalSent * 100)}%)`
      : 'N/A',
    queueLength: messageQueue.length,
    isRunning,
  };
}