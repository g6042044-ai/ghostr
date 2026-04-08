// src/services/sodiumEd25519.ts
// R-11: Conversion Ed25519 → X25519 constant-time via libsodium
//
// POURQUOI CE MODULE:
// La conversion de clé publique Ed25519 → X25519 utilisait modPow() en BigInt JS.
// BigInt JavaScript n'est PAS garanti constant-time (timing side-channel théorique).
//
// libsodium.crypto_sign_ed25519_pk_to_curve25519() est:
//   - Constant-time (implémentation C compilée en asm.js/WASM)
//   - Auditée (NaCl/libsodium sont parmi les bibliothèques crypto les plus vérifiées)
//   - Correcte mathématiquement (même formule, u = (1+y)/(1-y) mod p)
//
// Ce module expose uniquement cette fonction avec un fallback BigInt si
// libsodium n'est pas disponible.

declare const __DEV__: boolean;

interface SodiumWithEd25519 {
  crypto_sign_ed25519_pk_to_curve25519: (edPublicKey: Uint8Array) => Uint8Array;
  ready: Promise<void>;
}

let _sodium: SodiumWithEd25519 | null = null;
let _ready = false;
let _initPromise: Promise<void> | null = null;

/**
 * Initialise le module. Idempotent.
 * Appelé automatiquement lors du premier appel à ed25519PkToCurve25519.
 */
async function ensureInit(): Promise<void> {
  if (_ready) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const originalWarn = console.warn;
    try {
      console.warn = (...args: any[]) => {
        const msg = typeof args[0] === 'string' ? args[0] : '';
        if (msg.includes('WebAssembly') || msg.includes('Aborted')) return;
        originalWarn.apply(console, args);
      };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sodium = require('libsodium-wrappers/dist/modules/libsodium-wrappers.js');
      await sodium.ready;
      console.warn = originalWarn;

      if (typeof sodium.crypto_sign_ed25519_pk_to_curve25519 === 'function') {
        _sodium = sodium;
        _ready = true;
        __DEV__ && console.log('[SodiumEd25519] ✅ constant-time Ed25519→X25519 ready');
      }
    } catch {
      console.warn = originalWarn;
      __DEV__ && console.log('[SodiumEd25519] ℹ️ libsodium not available — using BigInt fallback');
    }
  })();

  return _initPromise;
}

// Pré-initialise en background (non-bloquant)
ensureInit().catch(() => {});

/**
 * Convertit une clé publique Ed25519 en X25519 de manière constant-time.
 *
 * Utilise libsodium.crypto_sign_ed25519_pk_to_curve25519() si disponible,
 * sinon tombe sur l'implémentation BigInt (timing side-channel théorique
 * sur clés publiques uniquement — risque limité).
 *
 * @param edPublicKeyBytes - 32 bytes clé publique Ed25519
 * @returns 32 bytes clé publique X25519 (Curve25519 Montgomery)
 */
export async function ed25519PkToCurve25519(edPublicKeyBytes: Uint8Array): Promise<Uint8Array> {
  await ensureInit();

  if (_ready && _sodium) {
    try {
      return _sodium.crypto_sign_ed25519_pk_to_curve25519(edPublicKeyBytes);
    } catch {
      // Fallback si la clé est invalide ou si sodium échoue
    }
  }

  // Fallback BigInt (original implementation, non-constant-time)
  return ed25519PkToCurve25519Fallback(edPublicKeyBytes);
}

/**
 * Version synchrone — retourne null si libsodium pas encore chargé.
 * Utiliser ed25519PkToCurve25519() (async) de préférence.
 */
export function ed25519PkToCurve25519Sync(edPublicKeyBytes: Uint8Array): Uint8Array | null {
  if (_ready && _sodium) {
    try {
      return _sodium.crypto_sign_ed25519_pk_to_curve25519(edPublicKeyBytes);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fallback BigInt: formule u = (1 + y) / (1 - y) mod p
 * Utilisé uniquement si libsodium n'est pas disponible.
 */
function ed25519PkToCurve25519Fallback(edPublicKeyBytes: Uint8Array): Uint8Array {
  const p = (1n << 255n) - 19n;

  // Extraire y (255 bits) — effacer le bit de signe
  const y = new Uint8Array(32);
  y.set(edPublicKeyBytes);
  y[31] &= 0x7f;

  // Convertir en BigInt little-endian
  let yBig = 0n;
  for (let i = 31; i >= 0; i--) {
    yBig = (yBig << 8n) | BigInt(y[i]);
  }

  // u = (1 + y) * inverse(1 - y) mod p
  const onePlusY = (1n + yBig) % p;
  let oneMinusY = (1n - yBig) % p;
  if (oneMinusY < 0n) oneMinusY += p;

  // Fermat: a^(-1) = a^(p-2) mod p
  const inv = modPow(oneMinusY, p - 2n, p);
  const u = (onePlusY * inv) % p;

  const result = new Uint8Array(32);
  let temp = u;
  for (let i = 0; i < 32; i++) {
    result[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return result;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}