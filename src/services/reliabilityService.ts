// ════════════════════════════════════════════════════════════════════════════
// reliabilityService.ts — Couche de fiabilité de livraison (Phase 1 + 2)
// ════════════════════════════════════════════════════════════════════════════
//
// OBJECTIF
//   Garantir « aucune perte de données » même si le destinataire est hors-ligne,
//   sans rien sacrifier au chiffrement post-quantique ni à l'anonymat serveur.
//
// MODÈLE (inspiré de l'algorithme Sesame de Signal)
//   • L'ÉMETTEUR conserve le plaintext localement (déjà fait par api1to1 dans
//     MESSAGES_1TO1_PREFIX — c'est l'équivalent du « MessageRecord » de Sesame).
//   • Ce module tient un OUTBOX : la liste des messages déposés mais PAS encore
//     acquittés (delivered_receipt). Tant qu'un message n'est pas ACK, il est
//     re-déposé périodiquement (backoff), ce qui « recharge » la boîte aux
//     lettres serveur avant son expiration (rétention 48h = cleanup_old_data).
//   • L'ACK (delivered_receipt) LIBÈRE l'entrée d'outbox (sémantique Sesame :
//     « a delivery receipt notifies the sender that the MessageRecord may be
//     deleted »).
//
// POURQUOI C'EST SANS BOUCLE INFINIE
//   La retransmission est pilotée par l'ABSENCE d'ACK, pas par un échec de
//   déchiffrement. Une fois l'ACK reçu, l'entrée disparaît. Aucune rétroaction
//   capable de s'auto-entretenir.
//
// ANONYMAT PRÉSERVÉ
//   Ce module ne fait AUCUN appel réseau lui-même. Il délègue le renvoi à un
//   handler injecté par api1to1 (`setResendHandler`) qui réutilise EXACTEMENT
//   le même pipeline d'envoi (padding uniforme → Triple Ratchet → Sealed
//   Sender → slot à débit constant). Le serveur ne voit donc rien de différent
//   d'un message normal.
//
// PAS D'IMPORT CIRCULAIRE
//   Ce module n'importe PAS api1to1. C'est api1to1 qui importe ce module et qui
//   injecte ses callbacks (resend / give-up). On ne dépend ici que de
//   localCrypto (chiffrement transparent du stockage) et d'AsyncStorage.
//
// ════════════════════════════════════════════════════════════════════════════

import AsyncStorage from '@react-native-async-storage/async-storage';
import { encryptIfEnabled, decryptIfNeeded, hasAnyEncryptionKey } from './localCrypto';

declare const __DEV__: boolean;

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────

/**
 * Classe de fiabilité d'un message.
 *
 * • 'best_effort' : contenu normal (texte, média). Une perte est récupérable
 *   et non bloquante. Retransmission jusqu'à MAXLATENCY puis abandon (le
 *   message repasse 'failed' → renvoi manuel possible, comme aujourd'hui).
 *
 * • 'guaranteed' : matériel de clé (Phase 3 — distribution/rotation de Sender
 *   Key de groupe). Une perte est PERMANENTE (déchiffrement de toute la suite
 *   impossible). ACK obligatoire, jamais d'abandon avant un plafond très long,
 *   alerte si on l'atteint.
 *
 * En Phase 1 (1:1), tout est 'best_effort'.
 */
export type ReliabilityClass = 'best_effort' | 'guaranteed';

export interface OutboxRecord {
  /** = Message1to1.id (identifiant interne stable, conservé entre retransmissions) */
  msgId: string;
  /** Session 1:1 (ou sous-session vers un membre de groupe en Phase 3) */
  sessionId: string;
  /** 1 enregistrement PAR destinataire → Selective-Repeat (un seul en 1:1) */
  recipientFingerprint: string;
  cls: ReliabilityClass;
  /** Premier dépôt réussi (sert au calcul du plafond MAXLATENCY / give-up) */
  firstSentAt: number;
  /** Dernière tentative de (re)dépôt */
  lastAttemptAt: number;
  /** Nombre de tentatives de retransmission (0 = jamais retransmis) */
  attempts: number;
  /** Horodatage de la prochaine retransmission éligible (backoff) */
  nextRetryAt: number;
}

/**
 * Résultat d'une tentative de renvoi, retourné par le handler injecté.
 *
 * • 'dispatched' : le renvoi a été ré-enqueué avec succès → on garde l'entrée
 *   et on avance le backoff (on continue d'attendre l'ACK).
 * • 'gone' : le message n'existe plus localement (supprimé par l'utilisateur)
 *   ou n'est pas renvoyable → on supprime l'entrée définitivement.
 * • 'error' : échec transitoire (réseau, sealed sender pas prêt) → on garde
 *   l'entrée et on réessaiera au prochain backoff.
 */
export type ResendOutcome = 'dispatched' | 'gone' | 'error';

export type ResendHandler = (
  sessionId: string,
  recipientFingerprint: string,
  msgId: string,
  cls: ReliabilityClass
) => Promise<ResendOutcome>;

/**
 * Appelé quand on ABANDONNE un message (best_effort au-delà de MAXLATENCY, ou
 * guaranteed au-delà du plafond). Permet à api1to1 de repasser le message en
 * 'failed' (best_effort) pour proposer un renvoi manuel, ou d'alerter
 * (guaranteed).
 */
export type GiveUpHandler = (
  sessionId: string,
  msgId: string,
  cls: ReliabilityClass
) => void;

// ────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = '@ghostr_outbox_v1';

/**
 * Rétention serveur : cleanup_old_data() supprime tout message > 2 jours
 * (pg_cron toutes les 15 min). C'est le MAXLATENCY de Sesame : au-delà, un
 * dépôt non récupéré est définitivement perdu côté serveur. On retransmet donc
 * AVANT cette échéance, et on abandonne un best_effort une fois dépassée.
 */
const MAXLATENCY_MS = 48 * 60 * 60 * 1000; // 48h

/** Plafond d'abandon pour le matériel de clé (Phase 3). Aligné sur la durée de
 *  vie d'une invitation. On n'abandonne quasi jamais, mais on borne pour ne pas
 *  retransmettre indéfiniment un destinataire définitivement parti. */
const GUARANTEED_GIVEUP_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

/**
 * Paliers de backoff (ms) entre deux retransmissions. Après le dernier palier,
 * on continue à cet intervalle jusqu'au plafond de la classe.
 *
 * best_effort : on retransmet ~5 fois sur 48h. Un destinataire qui revient
 * dans la fenêtre récupère une copie fraîche au prochain palier.
 */
const BACKOFF_BEST_EFFORT_MS = [
  60_000,        // +1 min
  5 * 60_000,    // +5 min
  30 * 60_000,   // +30 min
  2 * 60 * 60_000,  // +2 h
  6 * 60 * 60_000,  // +6 h
];

/** guaranteed : plus agressif au début (le matériel de clé est urgent), puis
 *  on espace. Se répète au dernier palier jusqu'au plafond. */
const BACKOFF_GUARANTEED_MS = [
  30_000,        // +30 s
  2 * 60_000,    // +2 min
  10 * 60_000,   // +10 min
  30 * 60_000,   // +30 min
  2 * 60 * 60_000,  // +2 h
];

/** Cap dur sur la taille de l'outbox (anti-emballement mémoire/stockage). On
 *  supprime les plus anciennes entrées au-delà. */
const MAX_OUTBOX_ENTRIES = 2000;

/** Délai de persistance debounced après une mutation. */
const PERSIST_DEBOUNCE_MS = 1500;

// ────────────────────────────────────────────────────────────────────────────
// ÉTAT (module-scope)
// ────────────────────────────────────────────────────────────────────────────

/** Clé composite recipientFingerprint + ':' + msgId → OutboxRecord. Un même
 *  msgId peut viser plusieurs destinataires (fan-out de groupe en Phase 3). */
const outbox = new Map<string, OutboxRecord>();

let _loaded = false;
let _ticking = false;
let _resendHandler: ResendHandler | null = null;
let _giveUpHandler: GiveUpHandler | null = null;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function keyOf(recipientFingerprint: string, msgId: string): string {
  return recipientFingerprint + ':' + msgId;
}

// ────────────────────────────────────────────────────────────────────────────
// INJECTION DES HANDLERS (appelée une fois par api1to1)
// ────────────────────────────────────────────────────────────────────────────

export function setResendHandler(fn: ResendHandler): void {
  _resendHandler = fn;
}

export function setGiveUpHandler(fn: GiveUpHandler): void {
  _giveUpHandler = fn;
}

// ────────────────────────────────────────────────────────────────────────────
// PERSISTANCE
// ────────────────────────────────────────────────────────────────────────────

function schedulePersist(): void {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNow(): Promise<void> {
  try {
    const arr = Array.from(outbox.values());
    const json = JSON.stringify(arr);
    // Chiffrement transparent (même politique que secureSet d'api1to1) :
    // si le chiffrement échoue, on lève — mieux vaut perdre l'outbox que de
    // stocker des métadonnées en clair sur un device potentiellement saisi.
    const encrypted = encryptIfEnabled(json);
    await AsyncStorage.setItem(STORAGE_KEY, encrypted);
  } catch (e) {
    __DEV__ && console.warn('[reliability] persist failed (non-fatal):', e);
  }
}

/**
 * Charge l'outbox persistée. À appeler au boot AVANT la première tick (sinon la
 * tick voit une map vide → no-op inoffensif, et les nouveaux envois peuplent la
 * map de toute façon).
 */
export async function loadOutbox(): Promise<void> {
  if (_loaded) return;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      // Si la donnée est chiffrée mais la clé pas encore dispo (avant unlock),
      // on n'écrase pas : on retentera plus tard.
      if (raw.startsWith('enc1:') && !hasAnyEncryptionKey()) {
        __DEV__ && console.log('[reliability] outbox encrypted, key not ready — deferring load');
        return;
      }
      const json = decryptIfNeeded(raw);
      const arr: OutboxRecord[] = JSON.parse(json);
      outbox.clear();
      for (const rec of arr) {
        if (rec && rec.msgId && rec.recipientFingerprint && rec.sessionId) {
          outbox.set(keyOf(rec.recipientFingerprint, rec.msgId), rec);
        }
      }
      __DEV__ && console.log(`[reliability] loaded ${outbox.size} outbox entrie(s)`);
    }
    _loaded = true;
  } catch (e) {
    // Donnée corrompue ou clé invalide : repartir d'une map vide plutôt que de
    // bloquer. Les messages restent visibles côté UI (state 'sent'), seule la
    // retransmission automatique est perdue pour les entrées illisibles.
    __DEV__ && console.warn('[reliability] loadOutbox failed (starting empty):', e);
    _loaded = true;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// API PUBLIQUE — SUIVI / ACQUITTEMENT
// ────────────────────────────────────────────────────────────────────────────

/**
 * Enregistre un message déposé en attente d'ACK. IDEMPOTENT : si l'entrée
 * existe déjà (ex. retransmission, double appel), on ne réinitialise pas le
 * backoff ni firstSentAt.
 */
export function trackOutbound(params: {
  msgId: string;
  sessionId: string;
  recipientFingerprint: string;
  cls?: ReliabilityClass;
}): void {
  try {
    const { msgId, sessionId, recipientFingerprint } = params;
    if (!msgId || !sessionId || !recipientFingerprint) return;
    const k = keyOf(recipientFingerprint, msgId);
    if (outbox.has(k)) return; // idempotent

    const now = Date.now();
    const cls: ReliabilityClass = params.cls || 'best_effort';
    const schedule = cls === 'guaranteed' ? BACKOFF_GUARANTEED_MS : BACKOFF_BEST_EFFORT_MS;

    outbox.set(k, {
      msgId,
      sessionId,
      recipientFingerprint,
      cls,
      firstSentAt: now,
      lastAttemptAt: now,
      attempts: 0,
      nextRetryAt: now + schedule[0], // première retransmission au 1er palier
    });

    // Cap mémoire : si on dépasse, supprimer les plus anciennes (par firstSentAt).
    if (outbox.size > MAX_OUTBOX_ENTRIES) {
      const sorted = Array.from(outbox.entries()).sort(
        (a, b) => a[1].firstSentAt - b[1].firstSentAt
      );
      const toRemove = outbox.size - MAX_OUTBOX_ENTRIES;
      for (let i = 0; i < toRemove; i++) outbox.delete(sorted[i][0]);
    }

    schedulePersist();
  } catch (e) {
    __DEV__ && console.warn('[reliability] trackOutbound error:', e);
  }
}

/**
 * Acquitte des messages pour un destinataire donné (appelé à réception d'un
 * delivered_receipt). Libère les entrées correspondantes — c'est la sémantique
 * Sesame : l'ACK autorise la suppression du MessageRecord côté émetteur.
 */
export function markAcked(recipientFingerprint: string, msgIds: string[]): void {
  try {
    if (!recipientFingerprint || !msgIds || msgIds.length === 0) return;
    let changed = false;
    for (const msgId of msgIds) {
      const k = keyOf(recipientFingerprint, msgId);
      if (outbox.delete(k)) changed = true;
    }
    if (changed) schedulePersist();
  } catch (e) {
    __DEV__ && console.warn('[reliability] markAcked error:', e);
  }
}

/**
 * Supprime toutes les entrées d'outbox pour un msgId (tous destinataires).
 * Appelé quand un message est supprimé par l'utilisateur ou repasse 'failed'.
 */
export function dropOutbox(msgId: string): void {
  try {
    if (!msgId) return;
    let changed = false;
    for (const [k, rec] of outbox) {
      if (rec.msgId === msgId) {
        outbox.delete(k);
        changed = true;
      }
    }
    if (changed) schedulePersist();
  } catch (e) {
    __DEV__ && console.warn('[reliability] dropOutbox error:', e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// BOUCLE DE RETRANSMISSION
// ────────────────────────────────────────────────────────────────────────────

function nextBackoff(rec: OutboxRecord): number {
  const schedule = rec.cls === 'guaranteed' ? BACKOFF_GUARANTEED_MS : BACKOFF_BEST_EFFORT_MS;
  // attempts vient d'être incrémenté ; on borne au dernier palier.
  const idx = Math.min(rec.attempts, schedule.length - 1);
  return schedule[idx];
}

/**
 * Parcourt les entrées d'outbox éligibles (nextRetryAt ≤ now) et tente une
 * retransmission via le handler injecté. Gère les plafonds d'abandon.
 *
 * IDEMPOTENCE CÔTÉ DESTINATAIRE : une retransmission re-chiffre le plaintext
 * (le ratchet avance) → c'est un nouveau message du ratchet que le destinataire
 * peut déchiffrer via skipped-message-keys, qu'il ait vu l'original ou non. La
 * déduplication finale se fait par msgId à la sauvegarde (saveLocalMessage1to1),
 * donc aucun doublon n'apparaît dans l'UI.
 *
 * Protégé contre le ré-entrant (une seule tick à la fois).
 */
export async function reliabilityTick(): Promise<void> {
  if (_ticking) return;
  if (!_resendHandler) return; // handler pas encore injecté
  _ticking = true;
  try {
    const now = Date.now();
    // Snapshot des entrées dues (on mute la map pendant l'itération).
    const due: OutboxRecord[] = [];
    for (const rec of outbox.values()) {
      if (rec.nextRetryAt <= now) due.push(rec);
    }
    if (due.length === 0) return;

    __DEV__ && console.log(`[reliability] tick: ${due.length} due / ${outbox.size} total`);

    for (const rec of due) {
      const k = keyOf(rec.recipientFingerprint, rec.msgId);
      if (!outbox.has(k)) continue; // acquitté entre-temps

      const age = now - rec.firstSentAt;

      // — Plafonds d'abandon —
      if (rec.cls === 'best_effort' && age > MAXLATENCY_MS) {
        outbox.delete(k);
        try { _giveUpHandler?.(rec.sessionId, rec.msgId, rec.cls); } catch {}
        __DEV__ && console.log(`[reliability] give up (best_effort > 48h): ${rec.msgId.slice(0, 8)}…`);
        continue;
      }
      if (rec.cls === 'guaranteed' && age > GUARANTEED_GIVEUP_MS) {
        outbox.delete(k);
        try { _giveUpHandler?.(rec.sessionId, rec.msgId, rec.cls); } catch {}
        __DEV__ && console.warn(`[reliability] give up (guaranteed > 30d): ${rec.msgId.slice(0, 8)}…`);
        continue;
      }

      // — Tentative de renvoi —
      let outcome: ResendOutcome = 'error';
      try {
        outcome = await _resendHandler(rec.sessionId, rec.recipientFingerprint, rec.msgId, rec.cls);
      } catch (e) {
        __DEV__ && console.warn('[reliability] resend handler threw:', e);
        outcome = 'error';
      }

      if (!outbox.has(k)) continue; // acquitté pendant le renvoi (ACK arrivé)

      if (outcome === 'gone') {
        outbox.delete(k);
        __DEV__ && console.log(`[reliability] entry gone: ${rec.msgId.slice(0, 8)}…`);
        continue;
      }

      // 'dispatched' ou 'error' : on avance le backoff et on garde l'entrée.
      rec.attempts += 1;
      rec.lastAttemptAt = now;
      rec.nextRetryAt = now + nextBackoff(rec);
      outbox.set(k, rec);
    }

    schedulePersist();
  } catch (e) {
    __DEV__ && console.warn('[reliability] tick error:', e);
  } finally {
    _ticking = false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MIGRATION (export/import du backup)
// ────────────────────────────────────────────────────────────────────────────

/** Sérialise l'outbox pour le dump de migration (JSON brut, non chiffré ici —
 *  le dump entier est chiffré par migrationService). */
export function serializeOutbox(): string {
  try {
    return JSON.stringify(Array.from(outbox.values()));
  } catch {
    return '[]';
  }
}

/** Remplace l'outbox courante par celle d'un backup importé (migration). */
export async function replaceOutboxFromImport(json: string | null | undefined): Promise<void> {
  try {
    if (!json) return;
    const arr: OutboxRecord[] = JSON.parse(json);
    outbox.clear();
    for (const rec of arr) {
      if (rec && rec.msgId && rec.recipientFingerprint && rec.sessionId) {
        outbox.set(keyOf(rec.recipientFingerprint, rec.msgId), rec);
      }
    }
    _loaded = true;
    await persistNow();
    __DEV__ && console.log(`[reliability] imported ${outbox.size} outbox entrie(s) from backup`);
  } catch (e) {
    __DEV__ && console.warn('[reliability] replaceOutboxFromImport failed:', e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DEBUG / NETTOYAGE
// ────────────────────────────────────────────────────────────────────────────

export function getOutboxStats(): { total: number; byClass: Record<string, number> } {
  const byClass: Record<string, number> = { best_effort: 0, guaranteed: 0 };
  for (const rec of outbox.values()) byClass[rec.cls] = (byClass[rec.cls] || 0) + 1;
  return { total: outbox.size, byClass };
}

/** Vide entièrement l'outbox (utilisé par clearAll1to1Data). */
export async function clearOutbox(): Promise<void> {
  outbox.clear();
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/** Supprime toutes les entrées d'une session (utilisé à la suppression d'une
 *  conversation). */
export function dropOutboxForSession(sessionId: string): void {
  let changed = false;
  for (const [k, rec] of outbox) {
    if (rec.sessionId === sessionId) {
      outbox.delete(k);
      changed = true;
    }
  }
  if (changed) schedulePersist();
}
