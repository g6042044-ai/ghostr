// src/services/epochTags.ts
// PHASE 1: Tags rotatifs toutes les 5 minutes avec dérivation HKDF
//
// Audit Fixes:
//   M-03: Fisher-Yates shuffle utilise CSPRNG (Crypto.getRandomBytes) au lieu de Math.random()
//   N-01: Tags de 32 bytes (256 bits) au lieu de 16 bytes (128 bits) — collision à ~2^128
//   0.2:  Decoy tags de polling 100% HKDF-persistants, dérivés du numéro de JOUR.
//         (L'ancienne stratégie 50/50 HKDF + aléatoire est supprimée : la moitié
//          aléatoire suffisait à rendre l'intersection de deux polls égale à
//          l'ensemble exact des vrais tags. Voir decoyTagPool.ts.)

import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { secureRandomInt } from './crypto';

// ============================================
// CONSTANTES
// ============================================

/** Durée d'un epoch en millisecondes (5 minutes) — legacy, pour backward compat */
const EPOCH_DURATION_MS = 5 * 60 * 1000;

/** 
 * ACTION 3 (Audit Fix): Durée d'un "jour tag" en millisecondes (24 heures).
 * Les tags directionnels tournent toutes les 24h avec overlap de 48h.
 */
const TAG_DAY_DURATION_MS = 24 * 60 * 60 * 1000;

/** Préfixe pour la dérivation HKDF des tags */
const TAG_INFO_PREFIX = 'ghostr-epoch-tag-v2'; // v2: 256-bit tags

/**
 * Préfixe pour la dérivation HKDF des decoy tags.
 * v3: le salt porte un numéro de JOUR (24 h) et non plus un numéro d'epoch
 * (5 min). Aucun enjeu d'interopérabilité : les tags leurres sont purement
 * locaux, ils ne sont jamais partagés avec un pair.
 */
const DECOY_INFO_PREFIX = 'ghostr-epoch-decoy-v3';

/**
 * Préfixe pour la dérivation HKDF du CALENDRIER d'activité des tags leurres
 * (ACTION 0.2bis).
 *
 * DOIT être distinct de DECOY_INFO_PREFIX. Le tag leurre est envoyé au serveur :
 * si le poids d'un tag était dérivé du tag lui-même, le serveur pourrait
 * recalculer ce poids et vérifier qu'il correspond au nombre de lignes
 * observées — ce qui redonnerait un test d'appartenance à la famille des
 * leurres. Avec un info distinct, le calendrier reste inaccessible sans la
 * graine.
 */
const DECOY_SCHEDULE_INFO_PREFIX = 'ghostr-decoy-schedule-v1';

/** 
 * ACTION 3: Préfixe pour les tags directionnels.
 * Le tag est HKDF(seed, salt=dayBytes, info="ghostr-dir-tag-v1|direction").
 * direction = "low-to-high" ou "high-to-low" (basé sur l'ordre des fingerprints).
 */
const DIRECTIONAL_TAG_PREFIX = 'ghostr-dir-tag-v1';

// ============================================
// CSPRNG SHUFFLE (Audit Fix M-03)
// ============================================

/**
 * Fisher-Yates shuffle avec CSPRNG.
 * 
 * Audit Fix M-03: Math.random() est un PRNG non-cryptographique.
 * Un serveur adversaire pourrait détecter un biais positionnel
 * pour distinguer vrais tags et decoys. Crypto.getRandomBytes() élimine ce risque.
 */
function csprngShuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    // ACTION 10 (Audit Fix): rejection sampling — no modulo bias
    const j = secureRandomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ============================================
// EPOCH HELPERS
// ============================================

/** Retourne le numéro d'epoch courant */
export function getEpochNumber(timestampMs: number = Date.now()): number {
  return Math.floor(timestampMs / EPOCH_DURATION_MS);
}

/** Retourne le timestamp de début d'un epoch */
export function getEpochStart(epochNumber: number): number {
  return epochNumber * EPOCH_DURATION_MS;
}

/** Retourne le nombre de millisecondes jusqu'au prochain epoch */
export function msUntilNextEpoch(timestampMs: number = Date.now()): number {
  const currentEpochStart = getEpochStart(getEpochNumber(timestampMs));
  return currentEpochStart + EPOCH_DURATION_MS - timestampMs;
}

// ============================================
// TAG SEED DERIVATION
// ============================================

/**
 * Dérive un seed partagé entre deux participants à partir de leurs fingerprints.
 */
export function deriveTagSeed(
  myFingerprint: string,
  theirFingerprint: string
): Uint8Array {
  const parts = [myFingerprint, theirFingerprint].sort();
  const combined = parts.join(':');
  const inputBytes = new TextEncoder().encode(combined);
  return hkdf(sha256, inputBytes, new Uint8Array(32), 'ghostr-tag-seed-v1', 32);
}

/**
 * Dérive un seed à partir d'une masterKey (pour les conversations basées sur code).
 */
export function deriveTagSeedFromMasterKey(masterKeyBytes: Uint8Array): Uint8Array {
  return hkdf(sha256, masterKeyBytes, new Uint8Array(32), 'ghostr-tag-seed-v1', 32);
}

// ============================================
// ACTION 3: DIRECTIONAL TAGS WITH 24h ROTATION
// ============================================

/** Retourne le numéro de "jour tag" (epoch 24h) */
export function getTagDayNumber(timestampMs: number = Date.now()): number {
  return Math.floor(timestampMs / TAG_DAY_DURATION_MS);
}

/**
 * Détermine la direction de tag basée sur l'ordre lexicographique des fingerprints.
 * 
 * Si myFingerprint < theirFingerprint: je suis "low", ils sont "high"
 *   → mon envoi = "low-to-high", ma réception = "high-to-low"
 * Si myFingerprint > theirFingerprint: je suis "high", ils sont "low"
 *   → mon envoi = "high-to-low", ma réception = "low-to-high"
 * 
 * @returns { sendDirection, receiveDirection } — les info HKDF pour chaque sens
 */
function getDirections(myFingerprint: string, theirFingerprint: string): {
  sendDirection: string;
  receiveDirection: string;
} {
  if (myFingerprint < theirFingerprint) {
    return {
      sendDirection: `${DIRECTIONAL_TAG_PREFIX}|low-to-high`,
      receiveDirection: `${DIRECTIONAL_TAG_PREFIX}|high-to-low`,
    };
  } else {
    return {
      sendDirection: `${DIRECTIONAL_TAG_PREFIX}|high-to-low`,
      receiveDirection: `${DIRECTIONAL_TAG_PREFIX}|low-to-high`,
    };
  }
}

/**
 * Dérive un tag directionnel pour un jour donné.
 * 
 * tag = HKDF(seed, salt=dayBytes, info="ghostr-dir-tag-v1|direction")
 */
function deriveDirectionalTag(seed: Uint8Array, directionInfo: string, dayNumber: number): string {
  const dayBytes = new Uint8Array(8);
  const view = new DataView(dayBytes.buffer);
  view.setUint32(0, Math.floor(dayNumber / 0x100000000), false);
  view.setUint32(4, dayNumber >>> 0, false);
  
  const tagBytes = hkdf(sha256, seed, dayBytes, directionInfo, 32);
  return Array.from(tagBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * ACTION 3: Retourne le tag directionnel à utiliser pour l'ENVOI.
 * 
 * Ce tag est spécifique à la direction (Alice→Bob ≠ Bob→Alice) et tourne
 * toutes les 24h. Le correspondant poll ce même tag côté réception.
 * 
 * @param seed - Seed partagé de la conversation (deriveTagSeed)
 * @param myFingerprint - Mon fingerprint d'identité
 * @param theirFingerprint - Leur fingerprint d'identité
 * @returns Tag hex 64 chars pour l'envoi
 */
export function getDirectionalSendTag(
  seed: Uint8Array,
  myFingerprint: string,
  theirFingerprint: string
): string {
  const { sendDirection } = getDirections(myFingerprint, theirFingerprint);
  const dayNumber = getTagDayNumber();
  return deriveDirectionalTag(seed, sendDirection, dayNumber);
}

/**
 * ACTION 3: Retourne les tags à poller pour la RÉCEPTION.
 * 
 * Inclut:
 * 1. Tag directionnel de réception (jour courant) — messages envoyés aujourd'hui
 * 2. Tag directionnel de réception (jour précédent) — overlap pour messages en transit
 * 
 * P0-A3: Le tag permanent legacy a été SUPPRIMÉ. Ce tag fixe permettait au serveur
 * de corréler une conversation indéfiniment, annulant la protection des tags rotatifs.
 * 
 * L'overlap de 48h garantit qu'aucun message n'est perdu lors de la rotation.
 * 
 * @param seed - Seed partagé de la conversation
 * @param myFingerprint - Mon fingerprint d'identité
 * @param theirFingerprint - Leur fingerprint d'identité
 * @returns Array de tags à poller
 */
export function getDirectionalReceiveTags(
  seed: Uint8Array,
  myFingerprint: string,
  theirFingerprint: string
): string[] {
  const { receiveDirection } = getDirections(myFingerprint, theirFingerprint);
  const currentDay = getTagDayNumber();
  const previousDay = currentDay - 1;
  
  // Tags directionnels (jour courant + précédent pour overlap)
  const currentDayTag = deriveDirectionalTag(seed, receiveDirection, currentDay);
  const previousDayTag = deriveDirectionalTag(seed, receiveDirection, previousDay);
  
  // P0-A3: Plus de tag permanent legacy — uniquement des tags rotatifs
  return [...new Set([currentDayTag, previousDayTag])];
}

// ============================================
// EPOCH TAG DERIVATION
// ============================================

/**
 * Dérive le tag pour un epoch spécifique.
 * 
 * Audit Fix N-01: Tags de 32 bytes (256 bits) au lieu de 16 bytes.
 * Collision birthday paradox à ~2^128 (au lieu de ~2^64 avec 128 bits).
 * Coût: +16 bytes par tag (négligeable).
 */
export function deriveEpochTag(seed: Uint8Array, epochNumber: number): string {
  const epochBytes = new Uint8Array(8);
  const view = new DataView(epochBytes.buffer);
  view.setUint32(0, Math.floor(epochNumber / 0x100000000), false);
  view.setUint32(4, epochNumber >>> 0, false);
  
  // Audit Fix N-01: 32 bytes au lieu de 16
  const tagBytes = hkdf(sha256, seed, epochBytes, TAG_INFO_PREFIX, 32);
  
  return Array.from(tagBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Retourne le tag pour l'epoch courant */
export function getCurrentEpochTag(seed: Uint8Array): string {
  return deriveEpochTag(seed, getEpochNumber());
}

// ============================================
// DECOY TAGS — HKDF-PERSISTANTS PAR JOUR (ACTION 0.2)
// ============================================

/**
 * Dérive UN decoy tag HKDF-persistant, pour un jour et un index donnés.
 *
 * ACTION 0.2: le paramètre est un numéro de jour (`getTagDayNumber`), pas un
 * numéro d'epoch de 5 minutes. C'est critique : les vrais tags directionnels
 * tournent toutes les 24 h. Des leurres qui tourneraient toutes les 5 minutes
 * pendant que les vrais restent stables rendraient l'attaque par intersection
 * immédiatement praticable à nouveau.
 *
 * Déterministe : même graine + même jour + même index → même tag. L'index est
 * adressable, pour que deux lots d'un même cycle de poll puissent tirer des
 * plages disjointes et ne partagent aucun leurre.
 * L'appelant est `decoyTagPool.ts`, qui détient la graine.
 */
export function deriveDecoyTagForDay(
  decoySeed: Uint8Array,
  dayNumber: number,
  index: number
): string {
  const salt = new Uint8Array(12);
  const view = new DataView(salt.buffer);
  view.setUint32(0, Math.floor(dayNumber / 0x100000000), false);
  view.setUint32(4, dayNumber >>> 0, false);
  view.setUint32(8, index, false);
  
  // Audit Fix N-01: 32 bytes, comme les vrais tags
  const tagBytes = hkdf(sha256, decoySeed, salt, DECOY_INFO_PREFIX, 32);
  
  return Array.from(tagBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * ACTION 0.2bis: dérive des octets pseudo-aléatoires pour le CALENDRIER
 * d'activité des tags leurres d'une journée.
 *
 * Déterministe par (graine, jour) : le calendrier survit au redémarrage de
 * l'app. C'est indispensable — si les poids étaient retirés à chaque
 * lancement, les écritures se répartiraient uniformément sur la journée et
 * les tags leurres reformeraient le peloton serré qu'on cherche justement à
 * éviter.
 *
 * @param decoySeed - Graine de leurres de l'appareil
 * @param dayNumber - Numéro de jour (getTagDayNumber)
 * @param length - Nombre d'octets voulus
 */
export function deriveDecoyScheduleBytes(
  decoySeed: Uint8Array,
  dayNumber: number,
  length: number
): Uint8Array {
  const salt = new Uint8Array(8);
  const view = new DataView(salt.buffer);
  view.setUint32(0, Math.floor(dayNumber / 0x100000000), false);
  view.setUint32(4, dayNumber >>> 0, false);

  return hkdf(sha256, decoySeed, salt, DECOY_SCHEDULE_INFO_PREFIX, length);
}

// ============================================
// EXPORT CSPRNG SHUFFLE (pour réutilisation)
// ============================================

/**
 * Fisher-Yates shuffle CSPRNG — utilisable par d'autres modules.
 * Audit Fix M-03.
 */
export { csprngShuffle };

// ============================================
// MIGRATION HELPER
// ============================================

export function getLegacyTag(myFingerprint: string, theirFingerprint: string): string {
  const parts = [myFingerprint, theirFingerprint].sort();
  const combined = parts.join(':');
  const bytes = new TextEncoder().encode(combined);
  const hash = sha256(bytes);
  return Array.from(hash.slice(0, 16))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
