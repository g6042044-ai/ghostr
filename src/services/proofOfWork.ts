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
 * PoW difficulty: 16 bits = ~65K iterations = <1 second on mobile (pure JS SHA-256).
 * Combined with CF Worker IP rate limiting + cert quota (100 msgs/cert), this is
 * sufficient anti-spam. 22 bits was ~4M iterations = 80s on Hermes (unusable).
 */
export const POW_DIFFICULTY_BITS = 16;

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

  const saltBytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(saltBytes);
  } else {
    throw new Error('PoW: crypto.getRandomValues unavailable — cannot generate secure salt');
  }
  const salt = Array.from(saltBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // PERF FIX: Pre-allocate a single mutable buffer instead of creating
  // 3 objects per iteration (toString + TextEncoder + new Uint8Array).
  // This eliminates GC pressure and is ~10x faster on Hermes/mobile.
  const prefix = `${timestamp}:${salt}:`;
  const prefixBytes = new TextEncoder().encode(prefix);
  const prefixLen = prefixBytes.length;
  const maxNonceDigits = 10; // supports nonce up to 9,999,999,999
  const buffer = new Uint8Array(prefixLen + maxNonceDigits);
  buffer.set(prefixBytes, 0);

  // Pre-compute difficulty check values (avoid function call per iteration)
  const fullZeroBytes = Math.floor(difficulty / 8);
  const remainingBits = difficulty % 8;
  const remainingMask = remainingBits > 0 ? (0xFF << (8 - remainingBits)) : 0;

  // Larger batches = fewer setTimeout yields = faster total time
  const BATCH_SIZE = 50_000;
  let nonce = 0;

  while (true) {
    const batchEnd = nonce + BATCH_SIZE;
    while (nonce < batchEnd) {
      // Write nonce digits directly into the pre-allocated buffer (ZERO allocation)
      let n = nonce;
      let digitCount: number;
      if (n === 0) {
        buffer[prefixLen] = 48; // ASCII '0'
        digitCount = 1;
      } else {
        let temp = n;
        digitCount = 0;
        while (temp > 0) { digitCount++; temp = (temp / 10) | 0; }
        let pos = prefixLen + digitCount - 1;
        temp = n;
        while (temp > 0) {
          buffer[pos--] = 48 + (temp % 10);
          temp = (temp / 10) | 0;
        }
      }

      // Hash the exact slice — subarray creates a view, not a copy
      const hash = sha256(buffer.subarray(0, prefixLen + digitCount));

      // Inline difficulty check (avoid function call overhead)
      let valid = true;
      for (let i = 0; i < fullZeroBytes; i++) {
        if (hash[i] !== 0) { valid = false; break; }
      }
      if (valid && remainingBits > 0 && (hash[fullZeroBytes] & remainingMask) !== 0) {
        valid = false;
      }
      if (valid) {
        return { timestamp, salt, nonce, difficulty };
      }

      nonce++;
    }

    // Yield to event loop
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
