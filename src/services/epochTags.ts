// src/services/epochTags.ts
// PHASE 1: Tags rotatifs toutes les 5 minutes avec dérivation HKDF
//
// Audit Fixes:
//   M-03: Fisher-Yates shuffle utilise CSPRNG (Crypto.getRandomBytes) au lieu de Math.random()
//   N-01: Tags de 32 bytes (256 bits) au lieu de 16 bytes (128 bits) — collision à ~2^128
//   L-03: Decoy tags mixtes: 50% HKDF-persistants + 50% aléatoires par requête

import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import * as Crypto from 'expo-crypto';
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

/** Préfixe pour la dérivation HKDF des decoy tags */
const DECOY_INFO_PREFIX = 'ghostr-epoch-decoy-v2';

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
// POLLING TAGS
// ============================================



// ============================================
// DECOY TAGS — MIXED (Audit Fix L-03)
// ============================================

/**
 * Génère des decoy tags HKDF-persistants pour un epoch donné.
 * Ces tags sont les mêmes à chaque requête dans le même epoch.
 */
export function generateDecoyTagsForEpoch(
  decoySeed: Uint8Array,
  epochNumber: number,
  count: number = 5
): string[] {
  const decoys: string[] = [];
  
  for (let i = 0; i < count; i++) {
    const salt = new Uint8Array(12);
    const view = new DataView(salt.buffer);
    view.setUint32(0, Math.floor(epochNumber / 0x100000000), false);
    view.setUint32(4, epochNumber >>> 0, false);
    view.setUint32(8, i, false);
    
    // Audit Fix N-01: 32 bytes
    const tagBytes = hkdf(sha256, decoySeed, salt, DECOY_INFO_PREFIX, 32);
    
    decoys.push(
      Array.from(tagBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
    );
  }
  
  return decoys;
}

/**
 * Génère des decoy tags entièrement aléatoires (changent à chaque requête).
 * 
 * Audit Fix L-03: Ces tags ne peuvent pas être corrélés dans le temps.
 * Le serveur ne peut pas déduire que certains tags sont toujours "vides"
 * sur une longue période → améliore la k-anonymity.
 */
function generateRandomDecoyTags(count: number): string[] {
  const decoys: string[] = [];
  for (let i = 0; i < count; i++) {
    // Audit Fix N-01: 32 bytes comme les vrais tags
    const randomBytes = Crypto.getRandomBytes(32);
    decoys.push(
      Array.from(randomBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
    );
  }
  return decoys;
}

// ============================================
// COMBINED: POLLING WITH DECOYS
// ============================================

/**
 * Retourne les tags de polling mélangés avec des decoys.
 * 
 * Audit Fixes:
 *   M-03: Shuffle CSPRNG (pas Math.random())
 *   L-03: Decoys mixtes — 50% HKDF-persistants + 50% aléatoires
 *         Les HKDF-persistants couvrent le cas "tag sans résultats = indistinguable"
 *         Les aléatoires empêchent la corrélation inter-epochs par le serveur
 */
export function getPollingTagsWithDecoys(
  realSeed: Uint8Array,
  decoySeed: Uint8Array,
  decoyCount: number = 6,
  timestampMs: number = Date.now()
): string[] {
  const epochNumber = getEpochNumber(timestampMs);
  const currentTag = deriveEpochTag(realSeed, epochNumber);
  const previousTag = deriveEpochTag(realSeed, epochNumber - 1);
  const realTags = [...new Set([currentTag, previousTag])];
  
  // Audit Fix L-03: 50% HKDF-persistants + 50% aléatoires
  const hkdfCount = Math.ceil(decoyCount / 2);
  const randomCount = decoyCount - hkdfCount;
  
  const hkdfDecoys = generateDecoyTagsForEpoch(decoySeed, epochNumber, hkdfCount);
  const randomDecoys = generateRandomDecoyTags(randomCount);
  
  const allTags = [...realTags, ...hkdfDecoys, ...randomDecoys];
  
  // Audit Fix M-03: Shuffle avec CSPRNG
  return csprngShuffle(allTags);
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
