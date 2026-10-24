// src/services/decoyTagPool.ts
// ACTION 0.2: Jeu de tags leurres PERSISTANT pour le polling.
//
// PROBLÈME RÉSOLU:
//   Les leurres de polling étaient régénérés aléatoirement à chaque requête.
//   Les vrais tags, eux, se répètent. L'intersection de deux polls consécutifs
//   du même appareil donnait donc EXACTEMENT l'ensemble des vrais tags, et le
//   serveur reconstruisait la liste complète des conversations. OHTTP n'y
//   changeait rien : c'est le contenu de la requête qui recolle les requêtes,
//   pas l'adresse IP.
//
// PRINCIPE:
//   Les leurres sont dérivés par HKDF d'une graine propre à l'appareil et du
//   numéro de JOUR (pas d'epoch de 5 min : les vrais tags directionnels
//   tournent toutes les 24 h, des leurres qui tourneraient plus vite
//   reproduiraient la fuite). L'intersection de deux polls rend désormais
//   `vrais ∪ leurres` — 50 tags indistinguables.
//
// ACTION 0.2bis — LES TAGS LEURRES REÇOIVENT DES ÉCRITURES:
//   Un tag leurre n'était jamais écrit, un vrai tag l'était. La preuve durable
//   n'est pas `rate_limits` (clé primaire (identifier, limit_type), une seule
//   ligne écrasée à chaque requête, purgée au-delà de 2 min par
//   `cleanup_old_data`) mais la table `messages` elle-même, TTL 48 h : parmi
//   les 50 tags d'un poll, ceux qui portent des lignes sont exactement les
//   vraies conversations. Une jointure SQL suffisait.
//
//   Ce module expose donc maintenant `pickWritableDecoyTag()`, qui désigne le
//   tag leurre sur lequel écrire le prochain message leurre.
//
//   DEUX CONTRAINTES NON ÉVIDENTES:
//   1. JOUR COURANT UNIQUEMENT. `getDirectionalSendTag` ne dérive que le jour
//      courant : une vraie étiquette T(J-1) est encore LUE aujourd'hui mais
//      n'est plus jamais ÉCRITE. Écrire sur un leurre « J-1 » produirait un
//      comportement qu'aucun vrai tag n'a. D'où les slots (indices pairs)
//      plutôt que les indices bruts.
//   2. RÉPARTITION NON UNIFORME. Arroser les ~22 slots au hasard leur donnerait
//      à tous le même compte journalier à un écart-type près (binomiale, σ ≈ 6
//      pour 900 écritures sur 22 slots). Les vraies conversations, elles, sont
//      à 0 pour les dormantes et à plusieurs centaines pour l'active du
//      moment : les vrais tags ressortiraient comme les valeurs aberrantes de
//      l'ensemble. On aurait remplacé un tri binaire par un tri statistique.
//      D'où le calendrier ci-dessous : poids en loi de Zipf, nombre de slots
//      actifs tiré au hasard chaque jour, et persistance du choix sur
//      plusieurs envois pour produire des rafales.

import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { deriveDecoyTagForDay, deriveDecoyScheduleBytes, getTagDayNumber } from './epochTags';
import { secureRandomIntRange } from './crypto';

// ============================================
// CONSTANTES
// ============================================

/**
 * Clé SecureStore de la graine de leurres.
 *
 * IMPORTANT: toute nouvelle clé SecureStore doit être déclarée dans
 * `ALL_SECURESTORE_KEYS` de `firstLaunchGuard.ts`, sinon la purge
 * anti-réinstallation laisse un résidu dans le Keychain iOS.
 */
const DECOY_SEED_KEY = 'ghostr_decoy_seed_v1';

/** Taille de la graine, alignée sur les autres secrets du projet. */
const SEED_BYTES = 32;

// ============================================
// ÉTAT
// ============================================

/**
 * Graine en mémoire. `null` tant que `ensureDecoyTagPool()` n'a pas tourné.
 * Jamais exportée : seuls les tags dérivés sortent de ce module.
 */
let seed: Uint8Array | null = null;

/** Verrou d'initialisation — évite deux générations concurrentes de graine. */
let initPromise: Promise<void> | null = null;

/**
 * `true` si la graine n'a pas pu être persistée et vit seulement en mémoire.
 * Dans ce cas les leurres restent stables pour la durée du processus (ce qui
 * suffit à casser l'attaque par intersection de deux polls successifs) mais
 * changent au redémarrage de l'app.
 */
let seedIsEphemeral = false;

// ============================================
// INITIALISATION
// ============================================

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function loadOrCreateSeed(): Promise<void> {
  // 1. Tenter la lecture.
  try {
    const stored = await SecureStore.getItemAsync(DECOY_SEED_KEY);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) {
      seed = hexToBytes(stored);
      seedIsEphemeral = false;
      return;
    }
    if (stored) {
      // Valeur présente mais illisible (corruption, migration ratée) : on la
      // remplace plutôt que de polluer les leurres avec une graine douteuse.
      __DEV__ && console.warn('[DecoyTagPool] Stored seed malformed, regenerating');
    }
  } catch (error) {
    __DEV__ && console.warn('[DecoyTagPool] SecureStore read failed:', error);
  }

  // 2. Générer une graine neuve.
  const fresh = Crypto.getRandomBytes(SEED_BYTES);
  seed = fresh;

  // 3. Tenter la persistance. Un échec n'est pas fatal : la graine reste en
  //    mémoire pour ce processus.
  try {
    await SecureStore.setItemAsync(DECOY_SEED_KEY, bytesToHex(fresh));
    seedIsEphemeral = false;
  } catch (error) {
    seedIsEphemeral = true;
    __DEV__ && console.warn('[DecoyTagPool] SecureStore write failed, seed is in-memory only:', error);
  }
}

/**
 * Charge la graine de leurres, ou en crée une au premier lancement.
 *
 * À appeler (et à `await`) avant le premier `getPollingDecoyTags()`. Les deux
 * boucles de poll sont asynchrones, elles peuvent donc l'attendre directement.
 * Idempotent, et sûr en cas d'appels concurrents.
 *
 * La graine n'est volontairement PAS exportée dans le dump de sauvegarde
 * (`migrationService.collectExportData()` est une liste blanche explicite) :
 * une restauration régénère un jeu de leurres neuf. C'est un secret de moins
 * à transporter, et le changement de jeu de leurres après restauration est
 * indistinguable d'une conversation qui se termine.
 */
export async function ensureDecoyTagPool(): Promise<void> {
  if (seed) return;
  if (!initPromise) {
    initPromise = loadOrCreateSeed().finally(() => {
      initPromise = null;
    });
  }
  return initPromise;
}

/** `true` si la graine est chargée et les leurres persistants disponibles. */
export function isDecoyTagPoolReady(): boolean {
  return seed !== null;
}

/** Diagnostic de développement uniquement — ne révèle pas la graine. */
export function getDecoyTagPoolStatus(): { ready: boolean; ephemeral: boolean } {
  return { ready: seed !== null, ephemeral: seedIsEphemeral };
}

// ============================================
// TIRAGE DES LEURRES
// ============================================

/**
 * Retourne `count` tags leurres STABLES sur la journée, pris à partir de
 * l'index `offset` du jeu de l'appareil.
 *
 * Déterministe : deux appels avec les mêmes (count, offset) dans la même
 * journée renvoient exactement le même ensemble. C'est toute la propriété de
 * sécurité — un tirage aléatoire dans un pool persistant rouvrirait
 * partiellement l'attaque par intersection (les leurres qui disparaissent d'un
 * poll au suivant se désignent eux-mêmes comme leurres).
 *
 * `offset` sert à donner des plages DISJOINTES à deux lots d'un même cycle de
 * poll : deux requêtes émises coup sur coup qui partageraient des leurres
 * s'annonceraient au serveur comme venant du même appareil.
 *
 * Les leurres vont par PAIRES (jour courant, jour précédent) sur un même slot,
 * comme les vrais tags : `getDirectionalReceiveTags` poll T(J) et T(J-1) pour
 * chaque conversation, donc à minuit T(J) survit en devenant le tag « jour
 * précédent ». Un leurre doit se comporter pareil, sinon la bascule de minuit
 * trie les deux familles : les tags qui survivent seraient les vrais.
 * D'où `slot = floor(index / 2)` et non `index` dans la dérivation — le slot s
 * porte D(J, s) et D(J-1, s), et D(J, s) réapparaît le lendemain.
 *
 * @param count - Nombre de leurres voulus. 0 ou négatif → tableau vide.
 * @param offset - Index de départ dans le jeu du jour.
 * @throws Si la graine n'est pas chargée. Appeler `ensureDecoyTagPool()` avant.
 */
export function getPollingDecoyTags(
  count: number,
  offset: number = 0,
  timestampMs: number = Date.now()
): string[] {
  if (count <= 0) return [];
  if (!seed) {
    throw new Error('Decoy tag pool not initialized — call ensureDecoyTagPool() first');
  }

  const currentDay = getTagDayNumber(timestampMs);
  const decoys: string[] = [];

  for (let i = offset; i < offset + count; i++) {
    const slot = Math.floor(i / 2);
    const day = i % 2 === 0 ? currentDay : currentDay - 1;
    decoys.push(deriveDecoyTagForDay(seed, day, slot));
  }

  // Une collision entre deux index est cryptographiquement improbable, mais un
  // doublon ferait taire silencieusement un slot de leurre et le poll ne
  // porterait plus le compte attendu. On vérifie plutôt que de supposer.
  const unique = [...new Set(decoys)];
  if (unique.length !== count) {
    __DEV__ && console.warn(`[DecoyTagPool] Duplicate decoys (${unique.length}/${count})`);
  }
  return unique;
}

// ============================================
// ACTION 0.2bis — CALENDRIER D'ACTIVITÉ DES TAGS LEURRES
// ============================================

/**
 * Nombre maximal de slots leurres adressables en écriture.
 *
 * Un poll porte POLLING_TAG_COUNT = 50 tags (`api1to1.ts`) et les leurres vont
 * par paires (jour courant, jour précédent) : au plus 25 slots, donc 25 tags
 * « jour courant » susceptibles de recevoir une écriture.
 */
const MAX_DECOY_SLOTS = 25;

/** Bornes du nombre de slots ACTIFS sur une journée. */
const MIN_ACTIVE_SLOTS = 3;
const MAX_ACTIVE_SLOTS = 20;

/**
 * Exposant de la loi de Zipf qui répartit les écritures entre slots actifs.
 * Le slot de rang k (0-based) reçoit un poids `1 / (k+1)^ZIPF_EXPONENT`.
 * À 1,1, le slot le plus bavard capte ~30 % du trafic et le dixième ~4 % :
 * l'allure d'un appareil qui a une conversation active, quelques tièdes et
 * une majorité de dormantes.
 */
const ZIPF_EXPONENT = 1.1;

/** Nombre d'envois consécutifs sur un même slot, tiré dans [1, MAX_STICKY]. */
const MAX_STICKY_SENDS = 20;

/**
 * Plafond local d'écritures par slot et par minute glissante.
 *
 * `send_sealed_message` rate-limite à 15 écritures/min PAR TAG, aux deux
 * étages (`schema.sql:385` et `RATE_LIMIT_RULES.send_msg` du gateway).
 * Le cas qui mord n'est pas le régime de croisière — un slot toutes les 30 s —
 * mais le drain d'un transfert média : `scheduleNextSlot()` descend alors à
 * 200 ms–2 s entre slots et l'interleaving tire un leurre avec p ∈ [0,15 ; 0,40],
 * soit ~15 leurres/min qui, avec la persistance de rafale, tomberaient tous sur
 * le même slot. Le plafond serait franchi exactement pendant le transfert qu'on
 * cherche à masquer : le leurre refusé (429) laisserait un trou dans le débit
 * constant, et la série de 429 serait elle-même un signal.
 *
 * 10 laisse une marge d'un tiers sous le plafond serveur, ce qui absorbe une
 * rafale aléatoire de 8 arrivant sur un slot déjà sollicité.
 */
const MAX_WRITES_PER_SLOT_PER_MIN = 10;

/** Fenêtre du plafond ci-dessus. */
const WRITE_WINDOW_MS = 60_000;

interface DecoySchedule {
  day: number;
  /** Slots actifs du jour, ordonnés du plus bavard au plus discret. */
  rankedSlots: number[];
}

let schedule: DecoySchedule | null = null;

/**
 * Nombre de slots « jour courant » réellement présents dans le poll.
 * Publié par `buildPollPlan()`. `0` tant qu'aucun poll n'a été construit.
 */
let polledSlotCount = 0;

/** Slot en cours et nombre d'envois restants avant d'en retirer un autre. */
let stickySlot: number | null = null;
let stickyRemaining = 0;

/** Horodatage des écritures récentes, par slot. Purge à la lecture. */
const recentWrites = new Map<number, number[]>();

/** Nombre d'écritures sur `slot` dans la dernière minute, après purge. */
function writesInWindow(slot: number, now: number): number {
  const stamps = recentWrites.get(slot);
  if (!stamps) return 0;
  const kept = stamps.filter(t => now - t < WRITE_WINDOW_MS);
  if (kept.length === 0) recentWrites.delete(slot);
  else recentWrites.set(slot, kept);
  return kept.length;
}

/** Enregistre une écriture sur `slot`. */
function noteWrite(slot: number, now: number): void {
  const stamps = recentWrites.get(slot) || [];
  stamps.push(now);
  recentWrites.set(slot, stamps);
}

/** Tire un flottant CSPRNG dans [0, 1). */
function randomUnitFloat(): number {
  const b = Crypto.getRandomBytes(4);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false);
  return v / 0x100000000;
}

/**
 * Construit le calendrier du jour : quels slots sont actifs, et dans quel
 * ordre de bavardage.
 *
 * Le nombre de slots actifs est lui-même tiré au hasard chaque jour. Sans ça,
 * le nombre de tags portant du trafic dans un poll vaudrait
 * `constante + nombre de vraies conversations actives`, et une soustraction
 * suffirait à retrouver le second terme.
 */
function buildSchedule(day: number, decoySeed: Uint8Array): DecoySchedule {
  // 1 octet pour le nombre d'actifs, 4 par étape de mélange.
  const bytes = deriveDecoyScheduleBytes(decoySeed, day, 1 + MAX_DECOY_SLOTS * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const activeCount =
    MIN_ACTIVE_SLOTS + (bytes[0] % (MAX_ACTIVE_SLOTS - MIN_ACTIVE_SLOTS + 1));

  // Fisher-Yates déterministe sur [0, MAX_DECOY_SLOTS).
  // Le biais de modulo sur un mot de 32 bits pour n <= 25 est de l'ordre de
  // 1e-8 : sans effet observable sur une répartition d'écritures.
  const slots: number[] = [];
  for (let i = 0; i < MAX_DECOY_SLOTS; i++) slots.push(i);
  for (let i = MAX_DECOY_SLOTS - 1; i > 0; i--) {
    const word = view.getUint32(1 + (MAX_DECOY_SLOTS - 1 - i) * 4, false);
    const j = word % (i + 1);
    const tmp = slots[i];
    slots[i] = slots[j];
    slots[j] = tmp;
  }

  return { day, rankedSlots: slots.slice(0, activeCount) };
}

/**
 * ACTION 0.2bis: déclare combien d'indices leurres le poll du jour porte
 * réellement. Appelé par `buildPollPlan()` à chaque construction de plan.
 *
 * Le nombre d'indices varie avec le nombre de conversations (un poll est
 * complété à 50 tags). Le calendrier, lui, est dérivé une fois sur
 * MAX_DECOY_SLOTS et filtré au tirage : ajouter ou retirer une conversation
 * ne rebat donc pas les poids du jour, ça ne fait qu'élargir ou rétrécir la
 * plage adressable.
 *
 * @param totalDecoyIndices - Nombre d'indices leurres consommés par le plan
 *                            (toutes plages de lots confondues).
 */
export function publishPolledDecoyRange(totalDecoyIndices: number): void {
  if (!Number.isFinite(totalDecoyIndices) || totalDecoyIndices <= 0) {
    polledSlotCount = 0;
    return;
  }
  // Les indices pairs portent le jour courant : slot = index / 2.
  polledSlotCount = Math.min(Math.ceil(totalDecoyIndices / 2), MAX_DECOY_SLOTS);
}

/**
 * ACTION 0.2bis: retourne le tag leurre sur lequel écrire le prochain message
 * leurre, ou `null` si aucun n'est adressable.
 *
 * Le tag retourné est TOUJOURS un tag « jour courant » présent dans le poll de
 * l'appareil : la ligne écrite sera donc relue par nous quelques secondes plus
 * tard, exactement comme une ligne déposée par un pair sur une vraie
 * conversation.
 *
 * `null` signifie « pas encore de plan de poll publié » (aucun poll depuis le
 * démarrage) ou « graine non chargée ». L'appelant doit alors retomber sur un
 * tag aléatoire plutôt que d'annuler l'envoi : un slot de trafic sauté troue le
 * débit constant, ce qui est une fuite plus grave que la ligne orpheline que
 * produit le repli.
 */
export function pickWritableDecoyTag(): string | null {
  if (!seed) return null;
  if (polledSlotCount <= 0) return null;

  const day = getTagDayNumber();
  if (!schedule || schedule.day !== day) {
    schedule = buildSchedule(day, seed);
    // Le calendrier a changé : la rafale en cours appartenait à la veille.
    stickySlot = null;
    stickyRemaining = 0;
  }

  const now = Date.now();

  // Rafale en cours, si son slot est toujours adressable et pas saturé.
  if (
    stickyRemaining > 0 &&
    stickySlot !== null &&
    stickySlot < polledSlotCount &&
    writesInWindow(stickySlot, now) < MAX_WRITES_PER_SLOT_PER_MIN
  ) {
    stickyRemaining--;
    noteWrite(stickySlot, now);
    return deriveDecoyTagForDay(seed, day, stickySlot);
  }

  // Slots actifs encore adressables et sous le plafond, rangs préservés.
  const candidates: { slot: number; weight: number }[] = [];
  let totalWeight = 0;
  for (let rank = 0; rank < schedule.rankedSlots.length; rank++) {
    const slot = schedule.rankedSlots[rank];
    if (slot >= polledSlotCount) continue;
    if (writesInWindow(slot, now) >= MAX_WRITES_PER_SLOT_PER_MIN) continue;
    const weight = 1 / Math.pow(rank + 1, ZIPF_EXPONENT);
    totalWeight += weight;
    candidates.push({ slot, weight });
  }

  // Aucun candidat : soit le calendrier ne désigne que des slots hors plage
  // (poll étroit, beaucoup de conversations), soit tous sont saturés (drain
  // média prolongé). Chercher le slot adressable le moins sollicité plutôt que
  // de forcer une écriture qui reviendrait en 429.
  if (candidates.length === 0) {
    let fallbackSlot = -1;
    let fallbackWrites = MAX_WRITES_PER_SLOT_PER_MIN;
    for (let slot = 0; slot < polledSlotCount; slot++) {
      const writes = writesInWindow(slot, now);
      if (writes < fallbackWrites) {
        fallbackWrites = writes;
        fallbackSlot = slot;
      }
    }
    // Tous les slots pollés sont au plafond. Rendre `null` : l'appelant part
    // sur un tag aléatoire, ce qui produit une ligne orpheline mais préserve le
    // débit constant. Le cas demande ~220 leurres en une minute, il n'arrive
    // pas en régime normal.
    if (fallbackSlot < 0) {
      stickySlot = null;
      stickyRemaining = 0;
      return null;
    }
    stickySlot = fallbackSlot;
    stickyRemaining = secureRandomIntRange(1, MAX_STICKY_SENDS) - 1;
    noteWrite(fallbackSlot, now);
    return deriveDecoyTagForDay(seed, day, fallbackSlot);
  }

  let threshold = randomUnitFloat() * totalWeight;
  let chosen = candidates[candidates.length - 1].slot;
  for (const candidate of candidates) {
    threshold -= candidate.weight;
    if (threshold <= 0) {
      chosen = candidate.slot;
      break;
    }
  }

  stickySlot = chosen;
  stickyRemaining = secureRandomIntRange(1, MAX_STICKY_SENDS) - 1;
  noteWrite(chosen, now);
  return deriveDecoyTagForDay(seed, day, chosen);
}

/** Diagnostic de développement — ne révèle ni la graine ni les tags. */
export function getDecoyWriteStatus(): {
  polledSlotCount: number;
  activeSlotCount: number;
} {
  return {
    polledSlotCount,
    activeSlotCount: schedule ? schedule.rankedSlots.length : 0,
  };
}
