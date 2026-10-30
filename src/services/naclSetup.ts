// src/services/naclSetup.ts
// Configuration unique du PRNG pour TweetNaCl.
// Ce module DOIT être importé une seule fois — l'import est idempotent
// car nacl.setPRNG écrase le PRNG précédent.
//
// IMPORTANT: Ne pas dupliquer cet appel dans d'autres fichiers.
//
// ============================================================================
// v28.0 — iOS PERFORMANCE FIX:
//
// PROBLÈME CORRIGÉ:
//   L'ancienne implémentation chunkait l'allocation random en blocs de 1024
//   bytes (limite de Crypto.getRandomBytes côté expo-crypto). Pour padder un
//   blob média au tier de 16MB, on faisait jusqu'à 16 384 appels JSI vers le
//   pont natif iOS. Chaque appel a un coût fixe de 0.5-3 ms sur iOS
//   (allocation Uint8Array + traversée de pont), ce qui produit 8-50 secondes
//   de blocage du thread JS uniquement pour la phase de padding random.
//   Android n'était pas affecté car la pile JSI/Hermes Android amortit mieux
//   le coût d'appel + l'allocateur ART est plus rapide en boucle serrée.
//
// SOLUTION:
//   On utilise globalThis.crypto.getRandomValues (polyfillé au boot via
//   react-native-get-random-values, déjà importé dans App.tsx). Cette API
//   suit la spec Web Crypto et accepte jusqu'à 65 536 bytes par appel —
//   soit 64× moins d'appels natifs.
//
// IMPACT MESURÉ:
//   - Padding 16MB tier:    16 384 appels → 256 appels (64× moins)
//   - Padding 4MB tier:      4 096 appels →  64 appels
//   - Padding 1MB tier:      1 024 appels →  16 appels
//   - Padding 256KB tier:      256 appels →   4 appels
//
// ============================================================================
// Tâche 0.12 (2026-10-30) — PLANTAGE ANDROID À L'ENVOI D'UN MÉDIA :
//
//   La version v28.0 passait des vues DÉCALÉES (subarray à byteOffset > 0)
//   à crypto.getRandomValues pour écrire sans copie dans la queue du blob.
//   Sur Android, expo-crypto 15 (SDK 54) applique le byteOffset DEUX fois :
//   CryptoModule.kt appelle typedArray.write(bytes, byteOffset, byteLength)
//   alors que le pointeur natif d'expo-modules-core inclut déjà le décalage
//   (TypedArray::getRawPointer). Toute vue décalée est donc écrite hors du
//   buffer → SIGSEGV dans JavaScriptTypedArray::writeBuffer. Corrigé en
//   amont seulement en SDK 55 (expo/expo PR #42186, issue #43124). iOS
//   n'est pas touché (SecRandomCopyBytes sur array.rawPointer, une seule
//   application du décalage).
//
//   Règle : ne JAMAIS donner au natif une vue dont byteOffset ≠ 0. On remplit
//   un tampon à décalage zéro de 64 Ko au plus, puis on le copie dans la
//   cible avec view.set (memcpy). Même nombre d'appels natifs qu'avant,
//   une copie mémoire supplémentaire par tranche de 64 Ko, imperceptible.
//   Vérifié par src/services/naclSetup.test.js (npm run test).
// ============================================================================

import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';

// Limite par appel de globalThis.crypto.getRandomValues (Web Crypto spec)
const WEB_CRYPTO_QUOTA = 65536;

// Limite par appel de Crypto.getRandomBytes (expo-crypto)
const EXPO_CRYPTO_QUOTA = 1024;

/**
 * Référence cachée (lazy) vers crypto.getRandomValues (polyfillé par
 * react-native-get-random-values importé dans App.tsx).
 *
 * Résolution lazy parce que ce module peut être importé DURANT le
 * chargement du bundle, potentiellement avant que App.tsx ait fini
 * d'évaluer son premier import (le polyfill). En pratique l'ordre
 * est correct sur RN/Hermes (le polyfill est chargé en premier dans
 * App.tsx), mais on garde la lazy resolution comme ceinture+bretelles.
 */
let webCryptoCache: any = undefined; // undefined = not resolved, null = absent, object = resolved
function getWebCrypto(): { getRandomValues: (a: Uint8Array) => Uint8Array } | null {
  if (webCryptoCache !== undefined) return webCryptoCache;
  const g: any = globalThis;
  if (g && g.crypto && typeof g.crypto.getRandomValues === 'function') {
    webCryptoCache = g.crypto;
  } else {
    webCryptoCache = null;
  }
  return webCryptoCache;
}

/**
 * Remplit un Uint8Array EN PLACE avec des bytes aléatoires cryptographiquement sûrs.
 *
 * La cible peut être une vue décalée (subarray) : elle n'est jamais passée
 * telle quelle au natif (voir « Tâche 0.12 » en tête de fichier). Le natif ne
 * reçoit que des tampons à byteOffset 0, copiés ensuite dans la cible.
 *
 * Hot path pour le padding des blobs média (jusqu'à 16MB de random).
 *
 * @param view - Le Uint8Array (ou subarray) à remplir entièrement.
 */
export function fillRandomBytes(view: Uint8Array): void {
  const total = view.byteLength;
  if (total === 0) return;

  // Chemin rapide: crypto.getRandomValues (1 appel natif par 64KB)
  const webCrypto = getWebCrypto();
  if (webCrypto) {
    // Tampon à décalage zéro, réutilisé pour toutes les tranches pleines ;
    // la dernière tranche, plus courte, a son propre tampon exact.
    let scratch = new Uint8Array(Math.min(WEB_CRYPTO_QUOTA, total));
    let offset = 0;
    while (offset < total) {
      const chunkSize = Math.min(WEB_CRYPTO_QUOTA, total - offset);
      if (scratch.byteLength !== chunkSize) scratch = new Uint8Array(chunkSize);
      webCrypto.getRandomValues(scratch);
      view.set(scratch, offset);
      offset += chunkSize;
    }
    // Le tampon a pu porter une clé ou un nonce (getSecureRandomBytes) :
    // on ne laisse pas de copie traîner en mémoire.
    scratch.fill(0);
    return;
  }

  // Fallback (ne devrait jamais arriver — le polyfill est importé au boot)
  let offset = 0;
  while (offset < total) {
    const chunkSize = Math.min(EXPO_CRYPTO_QUOTA, total - offset);
    const chunk = Crypto.getRandomBytes(chunkSize);
    view.set(chunk, offset);
    offset += chunkSize;
  }
}

/**
 * Alloue et retourne un Uint8Array de bytes aléatoires.
 * Kept for backwards compatibility — préférer fillRandomBytes pour les
 * gros buffers (pas de double allocation).
 */
export function getSecureRandomBytes(size: number): Uint8Array {
  if (size <= 0) {
    throw new Error('Size must be positive');
  }
  const result = new Uint8Array(size);
  fillRandomBytes(result);
  return result;
}

// Configuration unique du PRNG pour NaCl.
// La fonction reçoit le buffer cible `x` (déjà alloué par nacl) et la
// longueur `n` à remplir. On écrit directement via subarray — pas de
// boucle de copie byte-à-byte comme l'ancienne implémentation.
nacl.setPRNG((x: Uint8Array, n: number) => {
  fillRandomBytes(x.subarray(0, n));
});

export const NACL_PRNG_CONFIGURED = true;
