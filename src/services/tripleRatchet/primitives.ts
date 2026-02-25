// src/services/tripleRatchet/primitives.ts
// Primitives cryptographiques pour le Triple Ratchet
// Version 3.1 - État de l'art avec corrections de sécurité critiques
//
// SÉCURITÉ:
// - Utilise TweetNaCl (audité, constant-time)
// - Utilise @noble/hashes (audité, constant-time) pour HMAC/HKDF
// - HKDF RFC 5869 avec domain separation
// - Zeroization: libsodium.memzero() garanti + fallback JS 4-pass (v3.1)
// - Conversion sécurisée Ed25519 <-> X25519
// - NONCES DÉTERMINISTES: Élimine risque de collision (v3.0)
//
// ALGORITHMES:
// - X25519: Échange de clés Diffie-Hellman
// - Ed25519: Signatures numériques
// - XSalsa20-Poly1305: Chiffrement authentifié
// - HMAC-SHA256: Dérivation de clés (@noble/hashes - audité)
// - Nonces déterministes via HMAC-SHA256 (v3.0)

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import * as Crypto from 'expo-crypto';
// @noble/hashes - bibliothèque auditée, constant-time
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf';
import {
  X25519PublicKey,
  X25519PrivateKey,
  X25519KeyPair,
  Ed25519PublicKey,
  Ed25519PrivateKey,
  Ed25519KeyPair,
  Ed25519Signature,
  SymmetricKey,
  ChainKey,
  MessageKey,
  RootKey,
  HeaderKey,
  IdentityKeyPair,
  SignedPreKey,
  OneTimePreKey,
  CRYPTO_CONSTANTS,
} from './types';

// ============================================
// CONFIGURATION PRNG SÉCURISÉ — Module unique (P10 fix)
// ============================================
// L'import side-effect configure nacl.setPRNG une seule fois via naclSetup.
import { getSecureRandomBytes, NACL_PRNG_CONFIGURED } from '../naclSetup';
void NACL_PRNG_CONFIGURED;
export { getSecureRandomBytes };

// ============================================
// SODIUM ZEROIZE — Effacement mémoire garanti (v3.1)
// ============================================
// Si libsodium est initialisé, utilise sodium.memzero() (garantie C-level).
// Sinon, fallback 4-pass JS avec volatile sink (best-effort).
import { sodiumMemzero } from '../sodiumZeroize';

// ============================================
// UTILITAIRES HEXADÉCIMAUX
// ============================================

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ============================================
// SÉCURITÉ MÉMOIRE
// ============================================

/**
 * Variable volatile pour empêcher l'optimisation JIT de supprimer la zeroization
 * Le compilateur ne peut pas savoir que cette variable n'est jamais lue
 */
let zeroizeSink = 0;

/**
 * Efface un buffer de la mémoire (zeroization)
 * CRITIQUE: Appeler après usage de toute donnée sensible
 * 
 * v3.1: STRATÉGIE HYBRIDE
 *   Priorité 1 — libsodium.memzero() si disponible:
 *     Appel C-level sodium_memzero() compilé en asm.js, marqué volatile.
 *     Le runtime JS ne peut PAS éliminer cet appel (code opaque).
 *     → Garantie formelle d'effacement.
 *
 *   Priorité 2 — Fallback JS 4-pass (si libsodium indisponible):
 *     Pass 1: XOR 0xAA (pattern complémentaire)
 *     Pass 2: XOR 0x55 (pattern complémentaire)
 *     Pass 3: Random bytes (CSPRNG) — empêche cold boot attacks
 *     Pass 4: Mise à zéro finale avec accumulation volatile
 *     → Best-effort (le JIT POURRAIT optimiser, mais le volatile sink rend
 *       l'élimination très improbable en pratique).
 *
 *   Dans TOUS les cas: vérification post-zeroize que le buffer est à zéro.
 *   Si la vérification échoue (ne devrait jamais arriver), on relance le
 *   fallback JS — ceinture et bretelles.
 */
export function zeroize(data: Uint8Array): void {
  if (!data || data.length === 0) {
    return;
  }

  const len = data.length;

  // ── Priorité 1: libsodium.memzero() ──────────────────────────
  // sodiumMemzero() retourne true si sodium a traité le buffer,
  // false si indisponible ou erreur.
  const usedSodium = sodiumMemzero(data);

  if (usedSodium) {
    // Vérification post-sodium: s'assurer que tout est bien à zéro.
    // sodium.memzero() ne devrait jamais échouer, mais on vérifie
    // par principe de defense-in-depth.
    let nonZero = 0;
    for (let i = 0; i < len; i++) {
      nonZero |= data[i];
    }
    // Empêcher l'élimination de la boucle de vérification
    zeroizeSink ^= nonZero;

    if (nonZero === 0) {
      // Sodium a correctement effacé — terminé
      return;
    }
    // Sinon, fallthrough vers le fallback JS (ne devrait jamais arriver)
  }

  // ── Priorité 2: Fallback JS 4-pass ──────────────────────────

  // Pass 1: XOR avec pattern 0xAA (10101010)
  for (let i = 0; i < len; i++) {
    data[i] ^= 0xAA;
  }
  
  // Pass 2: XOR avec pattern complémentaire 0x55 (01010101)
  for (let i = 0; i < len; i++) {
    data[i] ^= 0x55;
  }
  
  // Pass 3: Écraser avec des random bytes (CSPRNG)
  // Plus efficace que les patterns fixes contre les cold boot attacks
  try {
    const randomOverwrite = Crypto.getRandomBytes(len);
    for (let i = 0; i < len; i++) {
      data[i] = randomOverwrite[i];
    }
  } catch {
    // Fallback si Crypto n'est pas disponible (tests)
    for (let i = 0; i < len; i++) {
      data[i] ^= 0xFF;
    }
  }
  
  // Pass 4: Mise à zéro finale avec accumulation volatile anti-JIT
  let accumulator = 0;
  for (let i = 0; i < len; i++) {
    accumulator ^= data[i];
    data[i] = 0;
  }
  
  // Store dans variable volatile (empêche l'élimination du code mort)
  zeroizeSink ^= accumulator;
  
  // Vérification que tout est à zéro (force la lecture, empêche optimisation)
  for (let i = 0; i < len; i++) {
    zeroizeSink ^= data[i];
  }
}

/**
 * Efface plusieurs buffers de manière sécurisée
 */
export function zeroizeAll(...buffers: (Uint8Array | null | undefined)[]): void {
  for (const buffer of buffers) {
    if (buffer) {
      zeroize(buffer);
    }
  }
}

/**
 * Version explicite de zeroize pour TypedArrays de différents types
 * Utile pour Uint32Array, Int32Array, etc.
 */
export function zeroizeTypedArray(data: ArrayBufferView): void {
  if (!data || !data.buffer) {
    return;
  }
  
  // Accéder au buffer sous-jacent en tant que Uint8Array
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  zeroize(bytes);
}

/**
 * Comparaison en temps constant de deux buffers
 * Résiste aux timing attacks
 */
/**
 * Comparaison en temps constant
 * CRITIQUE: Évite les timing attacks lors de comparaison de secrets
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    // Faire une comparaison dummy pour éviter le timing leak
    let result = a.length ^ b.length;
    const minLen = Math.min(a.length, b.length);
    for (let i = 0; i < minLen; i++) {
      result |= a[i] ^ b[i];
    }
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  
  return result === 0;
}

/**
 * Clone un Uint8Array de manière sécurisée
 */
export function secureClone(data: Uint8Array): Uint8Array {
  const clone = new Uint8Array(data.length);
  clone.set(data);
  return clone;
}

// ============================================
// HMAC-SHA256 (@noble/hashes - audité, constant-time)
// ============================================

/**
 * HMAC-SHA256 utilisant @noble/hashes
 * Bibliothèque auditée avec implémentation constant-time
 * Utilisé pour HKDF et dérivation de clés
 */
export function hmacSha256(
  key: Uint8Array,
  data: Uint8Array
): Uint8Array {
  return hmac(sha256, key, data);
}

/**
 * Version async pour compatibilité API (mais synchrone sous le capot)
 */
export async function hmacSha256Async(
  key: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  return hmac(sha256, key, data);
}

// ============================================
// HKDF RFC 5869 (@noble/hashes - audité)
// ============================================

/**
 * HKDF-Extract: Extrait une clé pseudo-aléatoire
 * Utilise @noble/hashes pour une implémentation auditée
 */
export function hkdfExtract(
  salt: Uint8Array,
  inputKeyMaterial: Uint8Array
): Uint8Array {
  // Si pas de sel, utiliser un bloc de zéros
  const actualSalt = salt.length > 0 ? salt : new Uint8Array(32);
  return hmacSha256(actualSalt, inputKeyMaterial);
}

/**
 * HKDF-Expand: Expand une PRK en sortie de longueur arbitraire
 * Utilise @noble/hashes directement
 */
export function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number
): Uint8Array {
  const hashLen = 32; // SHA-256
  const n = Math.ceil(length / hashLen);
  
  if (n > 255) {
    throw new Error('HKDF: output length too large');
  }
  
  const okm = new Uint8Array(n * hashLen);
  let t = new Uint8Array(0);
  
  for (let i = 1; i <= n; i++) {
    const input = new Uint8Array(t.length + info.length + 1);
    input.set(t);
    input.set(info, t.length);
    input[t.length + info.length] = i;
    
    const result = hmacSha256(prk, input);
    t = new Uint8Array(result);
    okm.set(t, (i - 1) * hashLen);
    
    // Cleanup intermédiaire
    zeroize(input);
  }
  
  return okm.slice(0, length);
}

/**
 * HKDF complet avec domain separation
 * Utilise @noble/hashes native implementation
 * 
 * @param ikm - Input Key Material
 * @param salt - Sel (peut être vide)
 * @param info - Information contextuelle (domain separation)
 * @param length - Longueur de sortie désirée
 */
export function hkdfSync(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number
): Uint8Array {
  const infoBytes = new TextEncoder().encode(info);
  // Utiliser @noble/hashes HKDF directement
  return nobleHkdf(sha256, ikm, salt, infoBytes, length);
}

/**
 * HKDF async wrapper pour compatibilité API existante
 */
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number
): Promise<Uint8Array> {
  return hkdfSync(ikm, salt, info, length);
}

/**
 * HKDF avec domain separation stricte pour le protocole
 * Préfixe automatique "ghostr_triple_ratchet_v1:"
 */
export async function protocolHkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  domain: string,
  length: number
): Promise<Uint8Array> {
  const fullInfo = `ghostr_triple_ratchet_v1:${domain}`;
  return hkdfSync(ikm, salt, fullInfo, length);
}

/**
 * Version synchrone de protocolHkdf pour les chemins critiques
 */
export function protocolHkdfSync(
  ikm: Uint8Array,
  salt: Uint8Array,
  domain: string,
  length: number
): Uint8Array {
  const fullInfo = `ghostr_triple_ratchet_v1:${domain}`;
  return hkdfSync(ikm, salt, fullInfo, length);
}

// ============================================
// GÉNÉRATION DE CLÉS X25519 (Curve25519)
// ============================================

/**
 * Génère une paire de clés X25519 pour l'échange DH
 */
export function generateX25519KeyPair(): X25519KeyPair {
  const keyPair = nacl.box.keyPair();
  
  return {
    publicKey: {
      _brand: 'X25519PublicKey' as const,
      bytes: keyPair.publicKey,
    },
    privateKey: {
      _brand: 'X25519PrivateKey' as const,
      bytes: keyPair.secretKey,
    },
  };
}

/**
 * Crée une clé publique X25519 à partir de bytes
 */
export function createX25519PublicKey(bytes: Uint8Array): X25519PublicKey {
  if (bytes.length !== CRYPTO_CONSTANTS.X25519_PUBLIC_KEY_SIZE) {
    throw new Error(`Invalid X25519 public key size: ${bytes.length}`);
  }
  return {
    _brand: 'X25519PublicKey' as const,
    bytes: secureClone(bytes),
  };
}

/**
 * Crée une clé privée X25519 à partir de bytes
 */
export function createX25519PrivateKey(bytes: Uint8Array): X25519PrivateKey {
  if (bytes.length !== CRYPTO_CONSTANTS.X25519_PRIVATE_KEY_SIZE) {
    throw new Error(`Invalid X25519 private key size: ${bytes.length}`);
  }
  return {
    _brand: 'X25519PrivateKey' as const,
    bytes: secureClone(bytes),
  };
}

// ============================================
// GÉNÉRATION DE CLÉS Ed25519
// ============================================

/**
 * Génère une paire de clés Ed25519 pour les signatures
 */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const keyPair = nacl.sign.keyPair();
  
  return {
    publicKey: {
      _brand: 'Ed25519PublicKey' as const,
      bytes: keyPair.publicKey,
    },
    privateKey: {
      _brand: 'Ed25519PrivateKey' as const,
      bytes: keyPair.secretKey,
    },
  };
}

/**
 * Crée une clé publique Ed25519 à partir de bytes
 */
export function createEd25519PublicKey(bytes: Uint8Array): Ed25519PublicKey {
  if (bytes.length !== CRYPTO_CONSTANTS.ED25519_PUBLIC_KEY_SIZE) {
    throw new Error(`Invalid Ed25519 public key size: ${bytes.length}`);
  }
  return {
    _brand: 'Ed25519PublicKey' as const,
    bytes: secureClone(bytes),
  };
}

// ============================================
// CONVERSION Ed25519 <-> X25519
// ============================================

/**
 * Convertit une clé privée Ed25519 en X25519
 * La clé privée Ed25519 contient la seed dans les 32 premiers bytes
 * 
 * Méthode: Hash SHA-512 de la seed, puis clamping X25519
 */
export function ed25519PrivateKeyToX25519(
  edPrivateKey: Ed25519PrivateKey
): X25519PrivateKey {
  // Les 32 premiers bytes de la clé privée Ed25519 sont la seed
  const seed = edPrivateKey.bytes.slice(0, 32);
  
  // Hash SHA-512 de la seed (même processus que NaCl utilise internement)
  const h = nacl.hash(seed);
  
  // Clamping comme défini par X25519 (RFC 7748)
  h[0] &= 248;   // Clear bottom 3 bits
  h[31] &= 127;  // Clear top bit
  h[31] |= 64;   // Set second-to-top bit
  
  const x25519Private = h.slice(0, 32);
  
  // Cleanup le hash complet
  zeroize(h);
  
  return {
    _brand: 'X25519PrivateKey' as const,
    bytes: x25519Private,
  };
}

/**
 * Convertit une clé publique Ed25519 en X25519
 * 
 * APPROCHE SIMPLIFIÉE ET SÛRE:
 * Au lieu d'implémenter l'arithmétique modulaire complexe,
 * on dérive la clé publique X25519 à partir de la clé privée X25519
 * en utilisant le point de base de Curve25519.
 * 
 * Cette fonction nécessite la clé privée correspondante.
 * Pour une conversion sans clé privée, utiliser ed25519PublicKeyToX25519Standalone
 */
export function ed25519KeyPairToX25519(
  edKeyPair: Ed25519KeyPair
): X25519KeyPair {
  // Convertir la clé privée
  const x25519Private = ed25519PrivateKeyToX25519(edKeyPair.privateKey);
  
  // Calculer la clé publique correspondante via scalar multiplication
  // avec le point de base de Curve25519
  const x25519PublicBytes = nacl.scalarMult.base(x25519Private.bytes);
  
  return {
    publicKey: {
      _brand: 'X25519PublicKey' as const,
      bytes: x25519PublicBytes,
    },
    privateKey: x25519Private,
  };
}

/**
 * Convertit une clé publique Ed25519 en X25519 (standalone)
 * 
 * Utilise la formule mathématique: u = (1 + y) / (1 - y) mod p
 * où y est la coordonnée y du point Ed25519
 * 
 * NOTE: Cette implémentation utilise l'arithmétique de corps fini
 * sur GF(2^255 - 19)
 */
export function ed25519PublicKeyToX25519(
  edPublicKey: Ed25519PublicKey
): X25519PublicKey {
  const ed = edPublicKey.bytes;
  
  // Extraire la coordonnée y (les 255 bits inférieurs de la clé publique Ed25519)
  // Le bit de poids fort encode le signe de x
  const y = new Uint8Array(32);
  y.set(ed);
  y[31] &= 0x7f; // Effacer le bit de signe
  
  // Convertir y en coordonnée u de Montgomery: u = (1 + y) / (1 - y) mod p
  const u = edwardsYToMontgomeryU(y);
  
  return {
    _brand: 'X25519PublicKey' as const,
    bytes: u,
  };
}

/**
 * Conversion de la coordonnée y Edwards vers u Montgomery
 * Formule: u = (1 + y) / (1 - y) mod p, où p = 2^255 - 19
 */
function edwardsYToMontgomeryU(y: Uint8Array): Uint8Array {
  // Travailler avec des BigInt pour l'arithmétique modulaire précise
  const p = (1n << 255n) - 19n;
  
  // Convertir y en BigInt (little-endian)
  let yBig = 0n;
  for (let i = 31; i >= 0; i--) {
    yBig = (yBig << 8n) | BigInt(y[i]);
  }
  
  // Calculer (1 + y) mod p
  const onePlusY = (1n + yBig) % p;
  
  // Calculer (1 - y) mod p
  let oneMinusY = (1n - yBig) % p;
  if (oneMinusY < 0n) {
    oneMinusY += p;
  }
  
  // Calculer l'inverse modulaire de (1 - y) via Fermat: a^(-1) = a^(p-2) mod p
  const oneMinusYInv = modPow(oneMinusY, p - 2n, p);
  
  // u = (1 + y) * (1 - y)^(-1) mod p
  const u = (onePlusY * oneMinusYInv) % p;
  
  // Convertir le résultat en Uint8Array (little-endian)
  const result = new Uint8Array(32);
  let temp = u;
  for (let i = 0; i < 32; i++) {
    result[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  
  return result;
}

/**
 * Exponentiation modulaire: base^exp mod mod
 * Utilise la méthode square-and-multiply
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  
  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % mod;
    }
    exp = exp >> 1n;
    base = (base * base) % mod;
  }
  
  return result;
}

// ============================================
// DIFFIE-HELLMAN X25519
// ============================================

/**
 * Calcule le secret partagé via X25519 DH
 * 
 * @param myPrivateKey - Ma clé privée
 * @param theirPublicKey - Leur clé publique
 * @returns Secret partagé de 32 bytes
 */
export function x25519(
  myPrivateKey: X25519PrivateKey,
  theirPublicKey: X25519PublicKey
): Uint8Array {
  const sharedSecret = nacl.scalarMult(
    myPrivateKey.bytes,
    theirPublicKey.bytes
  );
  
  // Vérifier que le résultat n'est pas le point à l'infini (attaque)
  const isZero = sharedSecret.every(b => b === 0);
  if (isZero) {
    throw new Error('Invalid DH result: point at infinity');
  }
  
  return sharedSecret;
}

/**
 * Calcule DH et dérive une clé via HKDF
 */
export async function x25519WithKdf(
  myPrivateKey: X25519PrivateKey,
  theirPublicKey: X25519PublicKey,
  info: string
): Promise<SymmetricKey> {
  const rawShared = x25519(myPrivateKey, theirPublicKey);
  
  const derived = await protocolHkdf(
    rawShared,
    new Uint8Array(32), // Pas de sel pour X3DH standard
    info,
    32
  );
  
  // Cleanup
  zeroize(rawShared);
  
  return {
    _brand: 'SymmetricKey' as const,
    bytes: derived,
  };
}

// ============================================
// SIGNATURES Ed25519
// ============================================

/**
 * Signe un message avec une clé privée Ed25519
 */
export function sign(
  message: Uint8Array,
  privateKey: Ed25519PrivateKey
): Ed25519Signature {
  const signature = nacl.sign.detached(message, privateKey.bytes);
  
  return {
    _brand: 'Ed25519Signature' as const,
    bytes: signature,
  };
}

/**
 * Vérifie une signature Ed25519
 */
export function verify(
  message: Uint8Array,
  signature: Ed25519Signature,
  publicKey: Ed25519PublicKey
): boolean {
  return nacl.sign.detached.verify(
    message,
    signature.bytes,
    publicKey.bytes
  );
}

// ============================================
// GÉNÉRATION IDENTITY KEY PAIR
// ============================================

/**
 * Génère une paire de clés d'identité complète
 * Inclut les versions Ed25519 (signature) et X25519 (DH)
 */
export function generateIdentityKeyPair(): IdentityKeyPair {
  const edKeyPair = generateEd25519KeyPair();
  
  // Convertir en X25519 pour DH en utilisant la méthode cohérente
  const x25519KeyPair = ed25519KeyPairToX25519(edKeyPair);
  
  return {
    publicKey: edKeyPair.publicKey,
    privateKey: edKeyPair.privateKey,
    dhPublicKey: x25519KeyPair.publicKey,
    dhPrivateKey: x25519KeyPair.privateKey,
  };
}

// ============================================
// CRÉATION DE CLÉS TYPÉES
// ============================================

/**
 * Crée une SymmetricKey à partir de bytes
 */
export function createSymmetricKey(bytes: Uint8Array): SymmetricKey {
  if (bytes.length !== CRYPTO_CONSTANTS.SYMMETRIC_KEY_SIZE) {
    throw new Error(`Invalid symmetric key size: ${bytes.length}`);
  }
  return {
    _brand: 'SymmetricKey' as const,
    bytes: secureClone(bytes),
  };
}

/**
 * Crée une ChainKey à partir de bytes
 */
export function createChainKey(bytes: Uint8Array): ChainKey {
  if (bytes.length !== CRYPTO_CONSTANTS.SYMMETRIC_KEY_SIZE) {
    throw new Error(`Invalid chain key size: ${bytes.length}`);
  }
  return {
    _brand: 'ChainKey' as const,
    bytes: secureClone(bytes),
  };
}

/**
 * Crée une MessageKey à partir de bytes
 */
export function createMessageKey(bytes: Uint8Array): MessageKey {
  if (bytes.length !== CRYPTO_CONSTANTS.SYMMETRIC_KEY_SIZE) {
    throw new Error(`Invalid message key size: ${bytes.length}`);
  }
  return {
    _brand: 'MessageKey' as const,
    bytes: secureClone(bytes),
  };
}

/**
 * Crée une RootKey à partir de bytes
 */
export function createRootKey(bytes: Uint8Array): RootKey {
  if (bytes.length !== CRYPTO_CONSTANTS.SYMMETRIC_KEY_SIZE) {
    throw new Error(`Invalid root key size: ${bytes.length}`);
  }
  return {
    _brand: 'RootKey' as const,
    bytes: secureClone(bytes),
  };
}

/**
 * Crée une HeaderKey à partir de bytes
 * Utilisée pour le chiffrement des en-têtes (Header Encryption)
 */
export function createHeaderKey(bytes: Uint8Array): HeaderKey {
  if (bytes.length !== CRYPTO_CONSTANTS.HEADER_KEY_SIZE) {
    throw new Error(`Invalid header key size: ${bytes.length}`);
  }
  return {
    _brand: 'HeaderKey' as const,
    bytes: secureClone(bytes),
  };
}

/**
 * Crée une signature Ed25519 à partir de bytes
 */
export function createEd25519Signature(bytes: Uint8Array): Ed25519Signature {
  if (bytes.length !== CRYPTO_CONSTANTS.ED25519_SIGNATURE_SIZE) {
    throw new Error(`Invalid signature size: ${bytes.length}`);
  }
  return {
    _brand: 'Ed25519Signature' as const,
    bytes: secureClone(bytes),
  };
}

// ============================================
// CHIFFREMENT SYMÉTRIQUE
// ============================================

/**
 * Chiffre des données avec une clé symétrique (XSalsa20-Poly1305)
 */
export function encrypt(
  plaintext: Uint8Array,
  key: SymmetricKey | MessageKey | HeaderKey
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = getSecureRandomBytes(CRYPTO_CONSTANTS.NONCE_SIZE);
  const ciphertext = nacl.secretbox(plaintext, nonce, key.bytes);
  
  if (!ciphertext) {
    throw new Error('Encryption failed');
  }
  
  return { ciphertext, nonce };
}

/**
 * Déchiffre des données avec une clé symétrique
 */
export function decrypt(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: SymmetricKey | MessageKey | HeaderKey
): Uint8Array | null {
  return nacl.secretbox.open(ciphertext, nonce, key.bytes);
}

// ============================================
// CHIFFREMENT AEAD AVEC DONNÉES ASSOCIÉES
// ============================================

/**
 * Dérive les clés de chiffrement et MAC à partir d'une clé maître
 * 
 * SÉCURITÉ: Utilise des clés distinctes pour éviter la réutilisation de clé
 * dans différents contextes cryptographiques (encryption vs MAC).
 * 
 * @param masterKey - Clé maître de 32 bytes
 * @returns Tuple [encKey, macKey] de 32 bytes chacune
 */
function deriveAEADKeys(masterKey: Uint8Array): [Uint8Array, Uint8Array] {
  // Utiliser un salt vide (la clé maître est déjà de haute entropie)
  const salt = new Uint8Array(32);
  
  // Dériver 64 bytes: 32 pour encryption, 32 pour MAC
  const derived = hkdfSync(
    masterKey,
    salt,
    'ghostr_aead_key_derivation_v1',
    64
  );
  
  const encKey = derived.slice(0, 32);
  const macKey = derived.slice(32, 64);
  
  // Zeroize le buffer temporaire
  zeroize(derived);
  
  return [encKey, macKey];
}

/**
 * Dérive un nonce déterministe à partir de la clé et du compteur de message
 * 
 * SÉCURITÉ CRITIQUE:
 * Les nonces aléatoires ont un risque théorique de collision (birthday paradox).
 * Un nonce réutilisé avec XSalsa20 révèle le XOR des plaintexts.
 * 
 * Cette fonction génère un nonce UNIQUE et DÉTERMINISTE:
 * nonce = HMAC-SHA256(key, messageNumber || direction)[0:24]
 * 
 * @param key - Clé de message (unique par message)
 * @param messageNumber - Numéro de message dans la chaîne
 * @param direction - 'send' (0x01) ou 'receive' (0x02)
 */
export function deriveDeterministicNonce(
  key: Uint8Array,
  messageNumber: number,
  direction: 'send' | 'receive'
): Uint8Array {
  // Construire l'entrée: messageNumber (4 bytes big-endian) + direction (1 byte)
  const input = new Uint8Array(5);
  new DataView(input.buffer).setUint32(0, messageNumber, false); // big-endian
  input[4] = direction === 'send' ? 0x01 : 0x02;
  
  // Dériver le nonce via HMAC-SHA256
  const derived = hmacSha256(key, input);
  
  // Prendre les 24 premiers bytes (192 bits pour XSalsa20)
  const nonce = derived.slice(0, CRYPTO_CONSTANTS.NONCE_SIZE);
  
  // Cleanup
  zeroize(input);
  zeroize(derived);
  
  return nonce;
}

/**
 * Chiffrement AEAD (Authenticated Encryption with Associated Data)
 * 
 * Construction sécurisée Encrypt-then-MAC avec clés dérivées distinctes:
 * 1. Dériver encKey et macKey de la clé maître via HKDF
 * 2. Générer un nonce DÉTERMINISTE (v3.0) ou aléatoire (fallback)
 * 3. Chiffrer avec XSalsa20-Poly1305 (encKey)
 * 4. Calculer HMAC-SHA256 sur (nonce || AAD_length || AAD || ciphertext) avec macKey
 * 5. Retourner: authTag || ciphertext
 * 
 * SÉCURITÉ v3.0:
 * - NONCES DÉTERMINISTES: Élimine le risque de collision par birthday paradox
 * - Clés distinctes pour chiffrement et MAC (prévient les attaques par réutilisation)
 * - Nonce inclus dans le calcul du MAC (binding cryptographique)
 * - Longueur AAD encodée (prévient les attaques par extension)
 * - Double authentification: Poly1305 + HMAC-SHA256 (défense en profondeur)
 * 
 * @param key - Clé maître de 32 bytes
 * @param plaintext - Données à chiffrer
 * @param associatedData - Données authentifiées mais non chiffrées (AAD)
 * @param messageNumber - Numéro de message pour nonce déterministe (optionnel)
 * @param direction - Direction du message pour nonce déterministe (optionnel)
 * @returns Ciphertext avec tag d'authentification et nonce
 */
export async function encryptAEAD(
  key: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
  messageNumber?: number,
  direction?: 'send' | 'receive'
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  // 1. Dériver les clés distinctes pour encryption et MAC
  const [encKey, macKey] = deriveAEADKeys(key);
  
  try {
    // 2. Générer le nonce
    let nonce: Uint8Array;
    
    if (messageNumber !== undefined && direction !== undefined) {
      // v3.0: Nonce déterministe (RECOMMANDÉ)
      // Élimine complètement le risque de collision
      nonce = deriveDeterministicNonce(key, messageNumber, direction);
    } else {
      // Fallback: Nonce aléatoire (compatibilité arrière)
      // AVERTISSEMENT: Risque théorique de collision
      nonce = getSecureRandomBytes(CRYPTO_CONSTANTS.NONCE_SIZE);
    }
    
    // 3. Chiffrer le plaintext avec XSalsa20-Poly1305
    const encrypted = nacl.secretbox(plaintext, nonce, encKey);
    
    if (!encrypted) {
      throw new Error('AEAD encryption failed');
    }
    
    // 4. Calculer le tag d'authentification incluant les AAD
    // Format: HMAC(macKey, nonce || AAD_length || AAD || ciphertext)
    const aadLengthBytes = new Uint8Array(4);
    new DataView(aadLengthBytes.buffer).setUint32(0, associatedData.length, false);
    
    const dataToAuth = new Uint8Array(
      nonce.length + aadLengthBytes.length + associatedData.length + encrypted.length
    );
    let offset = 0;
    dataToAuth.set(nonce, offset); offset += nonce.length;
    dataToAuth.set(aadLengthBytes, offset); offset += aadLengthBytes.length;
    dataToAuth.set(associatedData, offset); offset += associatedData.length;
    dataToAuth.set(encrypted, offset);
    
    // 5. HMAC avec la clé MAC dédiée (pas la clé de chiffrement!)
    const authTag = await hmacSha256(macKey, dataToAuth);
    
    // 6. Construire le ciphertext final: authTag || encrypted
    const ciphertext = new Uint8Array(authTag.length + encrypted.length);
    ciphertext.set(authTag);
    ciphertext.set(encrypted, authTag.length);
    
    // 7. Cleanup
    zeroize(dataToAuth);
    
    return { ciphertext, nonce };
  } finally {
    // SÉCURITÉ: Toujours nettoyer les clés dérivées
    zeroize(encKey);
    zeroize(macKey);
  }
}


/**
 * Déchiffrement AEAD
 * 
 * @param key - Clé maître de 32 bytes
 * @param nonce - Nonce utilisé pour le chiffrement
 * @param ciphertext - Données chiffrées avec tag
 * @param associatedData - AAD qui doit correspondre
 * @returns Plaintext si authentification réussie
 */
export async function decryptAEAD(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array
): Promise<Uint8Array> {
  // 1. Dériver les clés distinctes
  const [encKey, macKey] = deriveAEADKeys(key);
  
  try {
    // 2. Extraire le tag et le ciphertext chiffré
    if (ciphertext.length < 32) {
      throw new Error('AEAD: Ciphertext too short');
    }
    
    const receivedTag = ciphertext.slice(0, 32);
    const encrypted = ciphertext.slice(32);
    
    // 3. Recalculer le tag d'authentification
    const aadLengthBytes = new Uint8Array(4);
    new DataView(aadLengthBytes.buffer).setUint32(0, associatedData.length, false);
    
    const dataToAuth = new Uint8Array(
      nonce.length + aadLengthBytes.length + associatedData.length + encrypted.length
    );
    let offset = 0;
    dataToAuth.set(nonce, offset); offset += nonce.length;
    dataToAuth.set(aadLengthBytes, offset); offset += aadLengthBytes.length;
    dataToAuth.set(associatedData, offset); offset += associatedData.length;
    dataToAuth.set(encrypted, offset);
    
    // 4. HMAC avec la clé MAC dédiée
    const expectedTag = await hmacSha256(macKey, dataToAuth);
    
    // 5. Vérifier le tag en temps constant
    if (!constantTimeEqual(receivedTag, expectedTag)) {
      zeroize(dataToAuth);
      zeroize(expectedTag);
      throw new Error('AEAD: Authentication failed');
    }
    
    // 6. Déchiffrer avec la clé de chiffrement
    const plaintext = nacl.secretbox.open(encrypted, nonce, encKey);
    
    // 7. Cleanup
    zeroize(dataToAuth);
    zeroize(expectedTag);
    
    if (!plaintext) {
      throw new Error('AEAD: Decryption failed');
    }
    
    return plaintext;
  } finally {
    // SÉCURITÉ: Toujours nettoyer les clés dérivées
    zeroize(encKey);
    zeroize(macKey);
  }
}

// ============================================
// SÉRIALISATION / DÉSÉRIALISATION
// ============================================

export function serializePublicKey(key: X25519PublicKey | Ed25519PublicKey): string {
  return encodeBase64(key.bytes);
}

export function deserializeX25519PublicKey(base64: string): X25519PublicKey {
  return createX25519PublicKey(decodeBase64(base64));
}

export function deserializeEd25519PublicKey(base64: string): Ed25519PublicKey {
  return createEd25519PublicKey(decodeBase64(base64));
}

export function serializeSignature(sig: Ed25519Signature): string {
  return encodeBase64(sig.bytes);
}

export function deserializeSignature(base64: string): Ed25519Signature {
  return createEd25519Signature(decodeBase64(base64));
}

// ============================================
// SIGNED PRE-KEY & ONE-TIME PRE-KEY GENERATION
// ============================================

const SIGNED_PREKEY_SIGNATURE_PREFIX = 'SignedPreKey:';

/**
 * Génère une Signed PreKey signée par l'Identity Key
 */
export function generateSignedPreKey(
  identityKeyPair: IdentityKeyPair,
  id: number
): SignedPreKey {
  const keyPair = generateX25519KeyPair();
  
  // Créer le message à signer
  const prefix = new TextEncoder().encode(SIGNED_PREKEY_SIGNATURE_PREFIX);
  const message = new Uint8Array(prefix.length + keyPair.publicKey.bytes.length);
  message.set(prefix);
  message.set(keyPair.publicKey.bytes, prefix.length);
  
  // Signer avec l'Identity Key
  const signature = sign(message, identityKeyPair.privateKey);
  
  return {
    id,
    keyPair,
    signature,
    timestamp: Date.now(),
  };
}

/**
 * Génère une One-Time PreKey
 */
export function generateOneTimePreKey(id: number): OneTimePreKey {
  return {
    id,
    keyPair: generateX25519KeyPair(),
  };
}

/**
 * Génère un lot de One-Time PreKeys de manière asynchrone.
 * Yield toutes les 10 clés pour ne pas bloquer le thread UI.
 */
export async function generateOneTimePreKeys(startId: number, count: number = 100): Promise<OneTimePreKey[]> {
  const keys: OneTimePreKey[] = [];
  const BATCH = 10;
  for (let i = 0; i < count; i++) {
    keys.push(generateOneTimePreKey(startId + i));
    if ((i + 1) % BATCH === 0 && i + 1 < count) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  return keys;
}

// ============================================
// EXPORTS UTILITAIRES
// ============================================

export { encodeBase64, decodeBase64 };