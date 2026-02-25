// src/services/naclSetup.ts
// Configuration unique du PRNG pour TweetNaCl.
// Ce module DOIT être importé une seule fois — l'import est idempotent
// car nacl.setPRNG écrase le PRNG précédent.
//
// IMPORTANT: Ne pas dupliquer cet appel dans d'autres fichiers.

import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';

/**
 * Obtient des bytes aléatoires cryptographiquement sûrs de n'importe quelle taille.
 * expo-crypto limite à 1024 bytes max, donc on chunke si nécessaire.
 */
export function getSecureRandomBytes(size: number): Uint8Array {
  if (size <= 0) {
    throw new Error('Size must be positive');
  }
  if (size <= 1024) {
    return Crypto.getRandomBytes(size);
  }

  const result = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const chunkSize = Math.min(1024, size - offset);
    const chunk = Crypto.getRandomBytes(chunkSize);
    result.set(chunk, offset);
    offset += chunkSize;
  }
  return result;
}

// Configuration unique du PRNG pour NaCl
nacl.setPRNG((x: Uint8Array, n: number) => {
  const randomBytes = getSecureRandomBytes(n);
  for (let i = 0; i < n; i++) {
    x[i] = randomBytes[i];
  }
});

export const NACL_PRNG_CONFIGURED = true;
