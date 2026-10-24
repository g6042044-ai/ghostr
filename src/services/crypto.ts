// src/services/crypto.ts
// Service de chiffrement - Version Signal-level
// HKDF RFC 5869, pas de PIN, code complet Base32
// v5.3 - CORRECTIONS SÉCURITÉ:
//   1. PRNG fix pour tailles > 1024 bytes
//   2. KDF PIN renforcé (100k itérations + sel étendu)
//   3. Ajout getConversationSenderToken() pour tokens non-corrélables

import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { hmac as nobleHmac } from '@noble/hashes/hmac';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf';
import i18n from '../i18n';

// ============================================
// CONFIGURATION PRNG - Module unique (P10 fix)
// ============================================
// L'import side-effect configure nacl.setPRNG une seule fois.
import { getSecureRandomBytes, NACL_PRNG_CONFIGURED } from './naclSetup';
void NACL_PRNG_CONFIGURED; // ensure import is not tree-shaken

// ============================================
// TYPES
// ============================================

export interface DerivedKeys {
  conversationId: string;
  e2eKey: Uint8Array;
}

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

// ============================================
// CONSTANTES
// ============================================

// Alphabet sans ambiguïtés (32 chars = 5 bits par char)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Tailles de padding (paliers pour masquer la longueur réelle)
const PADDING_SIZES = [256, 1024, 4096, 16384, 65536];

// La palette d'avatars a été DÉPLACÉE dans le design system
// (`components/ui/theme.ts` → `avatarColors` / `getAvatarColor`).
//
// Elle n'avait rien à faire ici : ce module est un service cryptographique,
// il n'a pas à connaître la charte graphique. Surtout, cette copie divergeait
// des deux autres palettes du projet, si bien qu'un même contact changeait
// de couleur entre sa fiche et la liste des conversations.
//
// `generateColorIndex` reste ci-dessous : c'est un hash pur, sans couleur.

// ============================================
// UTILITAIRES (déclarés en premier car utilisés par HMAC)
// ============================================

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
}

// ============================================
// CONSTANT-TIME COMPARISON (Security Critical!)
// ============================================

// ============================================
// HKDF RFC 5869 / HMAC RFC 2104 — @noble/hashes
// ============================================
// Toutes les fonctions cryptographiques utilisent désormais @noble/hashes
// (bibliothèque auditée, constant-time, opère sur bytes bruts).
// P1 fix : remplace l'ancienne implémentation hex-string non-conforme RFC.

/**
 * HMAC-SHA256 RFC 2104 conforme — @noble/hashes (audité, constant-time)
 * Retourne une Promise pour compatibilité avec les callers existants.
 */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return nobleHmac(nobleSha256, key, data);
}

/**
 * HKDF RFC 5869 conforme — @noble/hashes
 * Retourne une Promise pour compatibilité avec les callers existants.
 */
export async function hkdf(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number
): Promise<Uint8Array> {
  return nobleHkdf(nobleSha256, inputKeyMaterial, salt, info, length);
}

// ============================================
// GÉNÉRATION DE CLÉ MASTER
// ============================================

export async function generateMasterKey(): Promise<Uint8Array> {
  const randomBytes = await Crypto.getRandomBytesAsync(32);
  return new Uint8Array(randomBytes);
}

// ============================================
// DÉRIVATION DE CLÉS (avec HKDF standard)
// ============================================

export async function deriveAllKeys(masterKey: Uint8Array): Promise<DerivedKeys> {
  // P2-A5: Salt contextuel dérivé du masterKey au lieu d'un salt vide.
  // Utilise HMAC-SHA256(fixedKey, masterKey) pour créer un salt unique par conversation
  // tout en gardant la dérivation déterministe (même masterKey = mêmes clés).
  const saltInput = new TextEncoder().encode('ghostr-derive-salt-v3');
  const salt = nobleHmac(nobleSha256, saltInput, masterKey);
  
  const idBytes = await hkdf(masterKey, salt, 'whisper-id-v3', 16);
  const conversationId = bytesToHex(idBytes);
  
  const e2eKey = await hkdf(masterKey, salt, 'whisper-e2e-v3', 32);
  
  return {
    conversationId,
    e2eKey,
  };
}

// ============================================
// PAIRES DE CLÉS CURVE25519
// ============================================

export function generateKeyPair(): KeyPair {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
  };
}

export function generateSigningKeyPair(): KeyPair {
  const keyPair = nacl.sign.keyPair();
  return {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
  };
}

// ============================================
// DIFFIE-HELLMAN X25519
// ============================================

export function calculateDH(
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Uint8Array {
  return nacl.scalarMult(privateKey, publicKey);
}

// ============================================
// SIGNATURES Ed25519
// ============================================

export function sign(
  message: Uint8Array,
  secretKey: Uint8Array
): Uint8Array {
  return nacl.sign.detached(message, secretKey);
}

export function verifySignature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return nacl.sign.detached.verify(message, signature, publicKey);
}

// ============================================
// CHIFFREMENT E2E (NaCl secretbox)
// ============================================

export function encryptE2E(
  message: string,
  e2eKey: Uint8Array
): { encrypted: string; nonce: string } {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageBytes = decodeUTF8(message);
  
  const paddedMessage = addPadding(messageBytes);
  
  const encrypted = nacl.secretbox(paddedMessage, nonce, e2eKey);
  
  if (!encrypted) {
    throw new Error('E2E encryption failed');
  }
  
  return {
    encrypted: encodeBase64(encrypted),
    nonce: encodeBase64(nonce),
  };
}

export function decryptE2E(
  encryptedBase64: string,
  nonceBase64: string,
  e2eKey: Uint8Array
): string {
  const encrypted = decodeBase64(encryptedBase64);
  const nonce = decodeBase64(nonceBase64);
  
  const decrypted = nacl.secretbox.open(encrypted, nonce, e2eKey);
  
  if (!decrypted) {
    throw new Error('E2E decryption failed - invalid key or corrupted message');
  }
  
  const unpadded = removePadding(decrypted);
  
  return encodeUTF8(unpadded);
}

// ============================================
// CHIFFREMENT ASYMÉTRIQUE (pour Sealed Sender)
// ============================================

export function encryptBox(
  message: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array
): { encrypted: Uint8Array; nonce: Uint8Array } {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(message, nonce, recipientPublicKey, senderSecretKey);
  
  if (!encrypted) {
    throw new Error('Box encryption failed');
  }
  
  return { encrypted, nonce };
}

export function decryptBox(
  encrypted: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array
): Uint8Array | null {
  return nacl.box.open(encrypted, nonce, senderPublicKey, recipientSecretKey);
}

export function sealedBoxEncrypt(
  message: Uint8Array,
  recipientPublicKey: Uint8Array
): Uint8Array {
  const ephemeralKeyPair = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  
  const encrypted = nacl.box(
    message,
    nonce,
    recipientPublicKey,
    ephemeralKeyPair.secretKey
  );
  
  if (!encrypted) {
    throw new Error('Sealed box encryption failed');
  }
  
  const result = new Uint8Array(32 + 24 + encrypted.length);
  result.set(ephemeralKeyPair.publicKey, 0);
  result.set(nonce, 32);
  result.set(encrypted, 56);
  
  return result;
}

export function sealedBoxDecrypt(
  sealedBox: Uint8Array,
  recipientSecretKey: Uint8Array
): Uint8Array | null {
  if (sealedBox.length < 57) {
    return null;
  }
  
  const ephemeralPublicKey = sealedBox.slice(0, 32);
  const nonce = sealedBox.slice(32, 56);
  const ciphertext = sealedBox.slice(56);
  
  return nacl.box.open(
    ciphertext,
    nonce,
    ephemeralPublicKey,
    recipientSecretKey
  );
}

// ============================================
// PADDING (anti-analyse de trafic)
// ============================================

function addPadding(data: Uint8Array): Uint8Array {
  let targetSize = PADDING_SIZES[0];
  for (const size of PADDING_SIZES) {
    if (data.length + 4 <= size) {
      targetSize = size;
      break;
    }
  }
  
  if (data.length + 4 > targetSize) {
    targetSize = data.length + 4;
  }
  
  const padded = new Uint8Array(targetSize);
  const view = new DataView(padded.buffer);
  view.setUint32(0, data.length, true);
  padded.set(data, 4);
  const randomBytes = nacl.randomBytes(targetSize - 4 - data.length);
  padded.set(randomBytes, 4 + data.length);
  
  return padded;
}

function removePadding(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) {
    throw new Error('Invalid padded data: too short');
  }
  
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const originalLength = view.getUint32(0, true);
  
  if (originalLength > padded.length - 4) {
    throw new Error('Invalid padded data: length mismatch');
  }
  
  return padded.slice(4, 4 + originalLength);
}

// ============================================
// CONVERSION CODE ↔ CLÉ
// ============================================

export function masterKeyToCode(masterKey: Uint8Array): string {
  if (masterKey.length !== 32) {
    throw new Error('Master key must be 32 bytes');
  }
  
  const hashHex = bytesToHex(masterKey);
  
  // P7 fix: Use HMAC-SHA256 truncated to 2 bytes (16 bits) instead of DJB2.
  // This provides proper error detection via a cryptographic function.
  const checksumFull = nobleHmac(nobleSha256, masterKey, new TextEncoder().encode('ghostr-checksum-v1'));
  const checksumHex = bytesToHex(checksumFull).slice(0, 4); // 2 bytes = 4 hex chars
  
  const fullHex = hashHex + checksumHex;
  const fullBytes = hexToBytes(fullHex);
  
  let bits = '';
  for (const byte of fullBytes) {
    bits += byte.toString(2).padStart(8, '0');
  }
  
  let code = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5);
    if (chunk.length === 5) {
      const index = parseInt(chunk, 2);
      code += CODE_ALPHABET[index];
    }
  }
  
  return code.match(/.{1,4}/g)?.join('-') || code;
}

export function codeToMasterKey(code: string): Uint8Array {
  const cleaned = code.replace(/[-\s]/g, '').toUpperCase();
  
  for (const char of cleaned) {
    if (!CODE_ALPHABET.includes(char)) {
      throw new Error(`Invalid character in code: ${char}`);
    }
  }
  
  let bits = '';
  for (const char of cleaned) {
    const index = CODE_ALPHABET.indexOf(char);
    bits += index.toString(2).padStart(5, '0');
  }
  
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  
  if (bytes.length < 32) {
    throw new Error('Code too short');
  }
  
  const masterKey = new Uint8Array(bytes.slice(0, 32));
  
  if (bytes.length >= 34) {
    const providedChecksum = bytes.slice(32, 34);
    // P7 fix: Verify using HMAC-SHA256 truncated (same as masterKeyToCode)
    const checksumFull = nobleHmac(nobleSha256, masterKey, new TextEncoder().encode('ghostr-checksum-v1'));
    const expectedHex = bytesToHex(checksumFull).slice(0, 4);
    const expectedChecksum = hexToBytes(expectedHex);
    
    if (providedChecksum[0] !== expectedChecksum[0] || providedChecksum[1] !== expectedChecksum[1]) {
      // CORRECTION MAJEURE (Audit Février 2026 — Phase 0 §2):
      // L'ancien code faisait console.warn() et acceptait la clé invalide.
      // Conséquence : l'utilisateur avec une masterKey corrompue dérivait un tag
      // opaque incorrect, ne recevait JAMAIS de messages, et l'erreur était
      // silencieuse (aucun feedback utilisateur).
      //
      // Maintenant on refuse explicitement le code invalide pour forcer
      // l'utilisateur à re-saisir correctement.
      throw new Error(
        i18n.t('errors.invalidCode') +
        i18n.t('errors.qrCodeError')
      );
    }
  }
  
  return masterKey;
}

export function formatCode(code: string): string {
  const cleaned = code.replace(/[-\s]/g, '').toUpperCase();
  return cleaned.match(/.{1,4}/g)?.join('-') || cleaned;
}

export function validateCode(code: string): boolean {
  const cleaned = code.replace(/[-\s]/g, '').toUpperCase();
  
  if (cleaned.length < 51 || cleaned.length > 56) {
    return false;
  }
  
  for (const char of cleaned) {
    if (!CODE_ALPHABET.includes(char)) {
      return false;
    }
  }
  
  return true;
}

// ============================================
// SAFETY NUMBERS (vérification d'identité)
// ============================================

export async function generateSafetyNumber(
  identityKey1: Uint8Array,
  identityKey2: Uint8Array
): Promise<string> {
  const [first, second] = compareBytes(identityKey1, identityKey2) < 0
    ? [identityKey1, identityKey2]
    : [identityKey2, identityKey1];
  
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);
  
  // Use @noble/hashes sha256 on raw bytes (not hex-string)
  const hashBytes = nobleSha256(combined);
  let number = '';
  
  for (let i = 0; i < 30; i++) {
    const value = ((hashBytes[i % 32] << 8) | hashBytes[(i + 1) % 32]) % 100;
    number += value.toString().padStart(2, '0');
  }
  
  return number.match(/.{1,5}/g)?.join(' ') || number;
}

// ============================================
// UTILITAIRES EXPORTÉS
// ============================================

export async function generateSenderToken(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(16);
  return encodeBase64(new Uint8Array(bytes));
}

export function getRandomBytes(length: number): Uint8Array {
  return getSecureRandomBytes(length);
}

/**
 * ACTION 10 (Audit Fix): Génère un entier aléatoire dans [0, max) sans biais modulo.
 * Utilise le rejection sampling : si la valeur tirée tombe dans la zone biaisée
 * (les derniers `2^32 % max` valeurs), on re-tire.
 * 
 * @param max - Borne supérieure exclusive (max > 0)
 * @returns Un entier dans [0, max) uniformément distribué
 */
export function secureRandomInt(max: number): number {
  if (max <= 0 || max > 0x100000000) throw new Error('secureRandomInt: max must be in (0, 2^32]');
  if (max === 1) return 0;
  const limit = Math.floor(0x100000000 / max) * max; // Plus grand multiple de max ≤ 2^32
  let value: number;
  do {
    const bytes = getSecureRandomBytes(4);
    value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  } while (value >= limit);
  return value % max;
}

/**
 * Génère un entier aléatoire dans [min, max] (inclusif) sans biais modulo.
 */
export function secureRandomIntRange(min: number, max: number): number {
  return min + secureRandomInt(max - min + 1);
}

export const readableCodeToKey = codeToMasterKey;
export const keyToReadableCode = masterKeyToCode;

// ============================================
// PIN & LIENS SÉCURISÉS - v5.3 KDF RENFORCÉ
// ============================================

// GH-11: PBKDF2_ITERATIONS constant removed (legacy v2 KDF removed)

export function generatePIN(length: number = 8): string {
  let pin = '';
  for (let i = 0; i < length; i++) {
    pin += CODE_ALPHABET[secureRandomInt(CODE_ALPHABET.length)]; // ACTION 10: no modulo bias
  }
  return pin;
}

export function formatPIN(pin: string): string {
  return pin.match(/.{1,4}/g)?.join('-') || pin;
}

export function cleanPIN(pin: string): string {
  return pin.replace(/[-\s]/g, '').toUpperCase();
}

/**
 * Dérive une clé à partir d'un PIN - VERSION 3 (vrai PBKDF2-HMAC-SHA256)
 * 
 * Utilise @noble/hashes/pbkdf2 (audité, constant-time) au lieu d'une
 * boucle SHA-256 maison. 600k itérations (recommandation OWASP 2023).
 */
async function derivePINKeyV3(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const context = 'whisper-pin-v3';
  const pinBytes = decodeUTF8(pin + context);
  
  // Vrai PBKDF2-HMAC-SHA256 : réintroduit le mot de passe à chaque itération
  // 600k itérations sur bytes bruts (pas sur des strings hex)
  // pbkdf2Async yield au event loop régulièrement → ne freeze pas l'UI mobile
  const derived = await pbkdf2Async(nobleSha256, pinBytes, salt, {
    c: 600000,
    dkLen: 32,
  });
  
  return derived;
}

// GH-11: Legacy derivePINKey v2 REMOVED (non-standard PBKDF2, not production-grade)

// GH-11: Legacy derivePINKeyLegacy v1 REMOVED (10k iterations SHA-256, non-standard)

export async function encryptMasterKeyWithPIN(
  masterKey: Uint8Array,
  pin: string
): Promise<{ encryptedKey: string; salt: string; nonce: string; version: number }> {
  const cleanedPIN = cleanPIN(pin);
  
  if (cleanedPIN.length < 8) {
    throw new Error('PIN must be at least 8 characters');
  }
  
  // v6.0: Sel étendu à 32 bytes, PBKDF2 v3
  const salt = nacl.randomBytes(32);
  const pinKey = await derivePINKeyV3(cleanedPIN, salt);
  
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const encrypted = nacl.secretbox(masterKey, nonce, pinKey);
  
  if (!encrypted) {
    throw new Error('PIN encryption failed');
  }
  
  return {
    encryptedKey: encodeBase64(encrypted),
    salt: encodeBase64(salt),
    nonce: encodeBase64(nonce),
    version: 3, // v6.0 utilise PBKDF2-HMAC-SHA256 standard
  };
}

export async function decryptMasterKeyWithPIN(
  encryptedKey: string,
  salt: string,
  nonce: string,
  pin: string,
  version?: number
): Promise<Uint8Array> {
  const cleanedPIN = cleanPIN(pin);
  
  const saltBytes = decodeBase64(salt);
  const nonceBytes = decodeBase64(nonce);
  const encryptedBytes = decodeBase64(encryptedKey);
  
  // GH-11: Only v3 (true PBKDF2-HMAC-SHA256) — legacy v1/v2 removed
  const pinKey = await derivePINKeyV3(cleanedPIN, saltBytes);
  
  const decrypted = nacl.secretbox.open(encryptedBytes, nonceBytes, pinKey);
  
  if (!decrypted) {
    throw new Error('Invalid PIN or corrupted data');
  }
  
  return decrypted;
}

export async function generateShareLink(
  masterKey: Uint8Array,
  pin: string
): Promise<string> {
  const { encryptedKey, salt, nonce, version } = await encryptMasterKeyWithPIN(masterKey, pin);
  
  const params = new URLSearchParams({
    k: encryptedKey,
    s: salt,
    n: nonce,
    v: version.toString(), // Inclure la version
  });
  
  return `whisper://join?${params.toString()}`;
}

export interface ParsedShareLink {
  encryptedKey: string;
  salt: string;
  nonce: string;
  version?: number;
}

export function parseShareLink(url: string): ParsedShareLink | null {
  try {
    let queryString: string;
    
    if (url.includes('?')) {
      queryString = url.split('?')[1];
    } else {
      return null;
    }
    
    const params = new URLSearchParams(queryString);
    
    const encryptedKey = params.get('k');
    const salt = params.get('s');
    const nonce = params.get('n');
    const versionStr = params.get('v');
    
    if (!encryptedKey || !salt || !nonce) {
      return null;
    }
    
    return { 
      encryptedKey, 
      salt, 
      nonce,
      version: versionStr ? parseInt(versionStr, 10) : undefined,
    };
  } catch {
    return null;
  }
}

export { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 };

// ============================================
// IDENTITY COMMITMENT (v5.2 - Pseudonymes cryptographiques)
// ============================================

/**
 * Génère l'identity commitment pour une conversation
 * 
 * Propriétés cryptographiques:
 * - Déterministe : même (userSecret, masterKey) = même commitment
 * - Non-corrélable : commitments différents entre conversations
 * - Non-forgeable : sans userSecret, impossible de prédire le commitment
 * 
 * @param masterKey - La clé master de la conversation
 * @param userSecret - Le secret utilisateur (généré une fois, stocké dans SecureStore)
 * @returns Commitment de 16 bytes en hexadécimal (32 chars)
 */
export async function generateIdentityCommitment(
  masterKey: Uint8Array,
  userSecret: Uint8Array
): Promise<string> {
  const combined = new Uint8Array(masterKey.length + userSecret.length);
  combined.set(masterKey);
  combined.set(userSecret, masterKey.length);
  
  // P2-A5: Salt contextuel dérivé du masterKey
  const saltInput = new TextEncoder().encode('ghostr-identity-salt-v2');
  const salt = nobleHmac(nobleSha256, saltInput, masterKey);
  
  const commitment = await hkdf(
    combined,
    salt,
    'whisper-identity-v2',
    16
  );
  
  return bytesToHex(commitment);
}

// ============================================
// SENDER TOKEN PAR CONVERSATION - v5.3 NOUVEAU
// ============================================

/**
 * Génère un SenderToken UNIQUE par conversation
 * 
 * CORRECTION SÉCURITÉ v5.3:
 * - Avant: même senderToken global pour toutes les conversations
 * - Maintenant: token dérivé = HKDF(userSecret || masterKey, "sender-token")
 * 
 * Propriétés:
 * - Non-corrélable entre conversations (tokens différents)
 * - Déterministe (même utilisateur = même token dans une conversation)
 * - Impossible à prédire sans connaître userSecret
 * 
 * @param masterKey - La clé master de la conversation
 * @param userSecret - Le secret utilisateur (32 bytes)
 * @returns Token en base64 (22 chars)
 */
export async function deriveConversationSenderToken(
  masterKey: Uint8Array,
  userSecret: Uint8Array
): Promise<string> {
  const combined = new Uint8Array(userSecret.length + masterKey.length);
  combined.set(userSecret);
  combined.set(masterKey, userSecret.length);
  
  // GH-02 fix: Contextual salt instead of empty Uint8Array(32)
  const saltInput = new TextEncoder().encode('ghostr-sender-token-salt-v2');
  const salt = nobleHmac(nobleSha256, saltInput, combined);
  
  const tokenBytes = await hkdf(
    combined,
    salt,
    'whisper-sender-token-v2',
    16
  );
  
  return encodeBase64(tokenBytes);
}

/**
 * Génère un token d'authentification pour le SFU (appels)
 * 
 * Ce token prouve que l'utilisateur connaît la masterKey
 * sans révéler la masterKey elle-même.
 * 
 * @param masterKey - La clé master de la conversation
 * @param callId - L'ID unique de l'appel
 * @returns Token d'auth en base64
 */
export async function generateRoomAuthToken(
  masterKey: Uint8Array,
  callId: string
): Promise<string> {
  const info = `whisper-room-auth-v2:${callId}`;
  // GH-02 fix: Contextual salt instead of empty Uint8Array(32)
  const saltInput = new TextEncoder().encode('ghostr-room-auth-salt-v2');
  const salt = nobleHmac(nobleSha256, saltInput, masterKey);
  const tokenBytes = await hkdf(masterKey, salt, info, 32);
  return encodeBase64(tokenBytes);
}

// `generateColorIndex` a été supprimée avec la palette : elle n'avait plus
// aucun appelant une fois `generateColorFromToken` retirée. Le hash équivalent
// vit désormais dans `getAvatarColor` (components/ui/theme.ts), au plus près
// de la palette qu'il indexe.

// `generateColorFromToken` a été retirée : voir `getAvatarColor` dans
// `components/ui/theme.ts`, qui applique le MÊME hash sur la palette unique
// du design system.

/**
 * Génère les initiales pour un avatar
 * @param displayName - Le pseudo (optionnel)
 * @param senderToken - Le token de l'expéditeur (fallback)
 * @returns Une ou deux lettres pour l'avatar
 */
export function generateAvatarInitials(displayName?: string, senderToken?: string): string {
  if (displayName && displayName.trim()) {
    const parts = displayName.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return displayName.trim().substring(0, 2).toUpperCase();
  }
  
  if (senderToken) {
    let hash = 0;
    for (let i = 0; i < senderToken.length; i++) {
      hash = ((hash << 5) - hash) + senderToken.charCodeAt(i);
    }
    const letter1 = String.fromCharCode(65 + (Math.abs(hash) % 26));
    const letter2 = String.fromCharCode(65 + (Math.abs(hash >> 8) % 26));
    return letter1 + letter2;
  }
  
  return '??';
}