// src/services/proofOfWork.ts
// PROOF-OF-WORK — Hashcash-style anti-spam for certificate issuance
// Version 1.0 — Audit Fix CRITIQUE-03
//
// Le gateway exige une preuve de travail avant de délivrer un certificat
// sealed sender. Cela empêche le spam massif de certificats (DoS).
//
// Algorithme:
//   1. Client génère un challenge = SHA-256(timestamp || random)
//   2. Client cherche un nonce tel que SHA-256(challenge || nonce) commence
//      par N zéros (difficulté). ~200ms sur mobile pour N=16.
//   3. Le serveur vérifie en O(1) : hash et vérifie les zéros.
//
// Anti-replay:
//   - Le challenge inclut un timestamp. Le serveur rejette si |now - timestamp| > 5 min.
//   - Le serveur maintient un Set des challenges récents pour empêcher la réutilisation.

import { sha256 } from '@noble/hashes/sha256';

// ============================================
// CONSTANTS
// ============================================

/** 
 * ACTION 8 (Audit Fix): Difficulté augmentée de 16 à 18 bits.
 * 16 bits = ~65K itérations (~200ms mobile) — trivial pour un GPU.
 * 18 bits = ~262K itérations (~1-2s mobile) — 4× plus coûteux pour l'attaquant,
 * UX fluide (splash screen ~1-2s). Surge mode monte à 24 bits côté serveur.
 */
export const POW_DIFFICULTY_BITS = 18;

/** Fenêtre de validité du timestamp (±5 minutes) */
export const POW_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

// ============================================
// CLIENT SIDE — Compute PoW
// ============================================

export interface ProofOfWork {
  /** Timestamp (ms) inclus dans le challenge */
  timestamp: number;
  /** Random 16 bytes hex, inclus dans le challenge */
  salt: string;
  /** Nonce trouvé (nombre) */
  nonce: number;
  /** Difficulté utilisée (bits de zéro) */
  difficulty: number;
}

/**
 * Calcule une preuve de travail de manière ASYNCHRONE.
 *
 * Yield au thread UI toutes les BATCH_SIZE itérations pour ne pas
 * bloquer les animations (~30ms par batch sur mobile).
 *
 * @param difficulty - Nombre de bits de zéro en tête (default: POW_DIFFICULTY_BITS)
 * @returns ProofOfWork prête à envoyer au serveur
 */
export async function computeProofOfWork(
  difficulty: number = POW_DIFFICULTY_BITS
): Promise<ProofOfWork> {
  const timestamp = Date.now();

  // Salt aléatoire 16 bytes → hex
  const saltBytes = new Uint8Array(16);
  // P9 fix: Require CSPRNG, no insecure fallback
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(saltBytes);
  } else {
    throw new Error('PoW: crypto.getRandomValues unavailable — cannot generate secure salt');
  }
  const salt = Array.from(saltBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Build challenge prefix: "timestamp:salt:"
  const prefix = `${timestamp}:${salt}:`;
  const prefixBytes = new TextEncoder().encode(prefix);

  // Traiter par batch pour ne pas bloquer le thread UI.
  // 10K hashes ≈ 20-40ms sur mobile — assez court pour garder 30fps.
  const BATCH_SIZE = 10_000;
  let nonce = 0;

  while (true) {
    const batchEnd = nonce + BATCH_SIZE;
    while (nonce < batchEnd) {
      const nonceStr = nonce.toString();
      const nonceBytes = new TextEncoder().encode(nonceStr);
      const input = new Uint8Array(prefixBytes.length + nonceBytes.length);
      input.set(prefixBytes, 0);
      input.set(nonceBytes, prefixBytes.length);

      const hash = sha256(input);

      if (hasLeadingZeroBits(hash, difficulty)) {
        return { timestamp, salt, nonce, difficulty };
      }

      nonce++;
    }

    // Yield au thread UI — les animations peuvent avancer
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

/**
 * Vérifie une preuve de travail (utilisable côté client pour tests).
 */
export function verifyProofOfWork(
  pow: ProofOfWork,
  maxTimestampDriftMs: number = POW_TIMESTAMP_WINDOW_MS
): boolean {
  // Check timestamp window
  const now = Date.now();
  if (Math.abs(now - pow.timestamp) > maxTimestampDriftMs) {
    return false;
  }

  // Recompute hash
  const input = new TextEncoder().encode(
    `${pow.timestamp}:${pow.salt}:${pow.nonce}`
  );
  const hash = sha256(input);

  return hasLeadingZeroBits(hash, pow.difficulty);
}

// ============================================
// HELPERS
// ============================================

/**
 * Vérifie que les N premiers bits d'un hash sont à zéro.
 */
function hasLeadingZeroBits(hash: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;

  // Check full zero bytes
  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }

  // Check remaining bits in the next byte
  if (remainingBits > 0) {
    const mask = 0xFF << (8 - remainingBits); // e.g. bits=3 → mask=0xE0
    if ((hash[fullBytes] & mask) !== 0) return false;
  }

  return true;
}
