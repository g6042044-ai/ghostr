// src/services/keyTransparency.ts
// KEY TRANSPARENCY — Safety Numbers + Key Pinning
// Version 1.0 — Audit Fix C-02
//
// PROBLÈME:
//   Aucun mécanisme pour vérifier que les clés publiques distribuées
//   par le serveur sont authentiques. Un attaquant contrôlant Supabase
//   peut substituer les PreKeys et faire un MITM transparent.
//
// SOLUTION:
//   1. SAFETY NUMBERS (comme Signal):
//      Hash des identity keys des deux participants → nombre de 60 chiffres
//      vérifiable par QR code ou lecture vocale.
//   2. KEY PINNING LOCAL:
//      Chaque identity key reçue est stockée localement au premier contact.
//      Si la clé change, l'utilisateur est alerté (key change notification).
//   3. KEY VERIFICATION STATUS:
//      Track si l'utilisateur a vérifié manuellement les safety numbers.

import { sha256 } from '@noble/hashes/sha256';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ============================================
// TYPES
// ============================================

export interface KeyRecord {
  /** Fingerprint de l'identity key (hex SHA-256) */
  fingerprint: string;
  /** Clé publique Ed25519 en Base64 */
  identityKeyB64: string;
  /** Première fois que cette clé a été vue */
  firstSeen: number;
  /** Dernière fois que cette clé a été vue */
  lastSeen: number;
  /** L'utilisateur a-t-il vérifié manuellement cette clé ? */
  verified: boolean;
  /** Historique des changements de clé */
  previousKeys: Array<{
    fingerprint: string;
    identityKeyB64: string;
    firstSeen: number;
    lastSeen: number;
    verified: boolean;
  }>;
}

export type KeyChangeAction = 'new' | 'unchanged' | 'changed';

export interface KeyVerificationResult {
  action: KeyChangeAction;
  /** true si la clé était vérifiée avant le changement (alerte critique) */
  wasVerified: boolean;
  /** Le nouveau fingerprint */
  fingerprint: string;
}

// ============================================
// CONSTANTS
// ============================================

const STORAGE_PREFIX = 'ghostr_key_pin_';
const SAFETY_NUMBER_VERSION = 1;
// Nombre de chiffres dans le safety number (12 groupes de 5 = 60 chiffres)
const SAFETY_NUMBER_ITERATIONS = 5200;

// ============================================
// SAFETY NUMBERS
// ============================================

/**
 * Calcule le safety number entre deux participants.
 *
 * Algorithme (compatible Signal) :
 *   Pour chaque participant : SHA-256^5200(version || pubKey || identifier)
 *   Puis : concat des deux résultats → tronqué à 30 bytes → encodé en décimal.
 *
 * Le résultat est un nombre de 60 chiffres, affiché en 12 groupes de 5.
 *
 * @param myIdentityKeyBytes - Ma clé publique Ed25519 (32 bytes)
 * @param myIdentifier - Mon identifiant stable (fingerprint hex)
 * @param theirIdentityKeyBytes - Leur clé publique Ed25519 (32 bytes)
 * @param theirIdentifier - Leur identifiant stable (fingerprint hex)
 * @returns Safety number (60 chiffres, 12 groupes de 5 séparés par des espaces)
 */
export function computeSafetyNumber(
  myIdentityKeyBytes: Uint8Array,
  myIdentifier: string,
  theirIdentityKeyBytes: Uint8Array,
  theirIdentifier: string
): string {
  const myDigest = iteratedHash(myIdentityKeyBytes, myIdentifier);
  const theirDigest = iteratedHash(theirIdentityKeyBytes, theirIdentifier);

  // Le safety number est stable indépendamment de l'ordre des participants :
  // on trie les digests par ordre lexicographique.
  let first: Uint8Array;
  let second: Uint8Array;
  if (compareBytes(myDigest, theirDigest) < 0) {
    first = myDigest;
    second = theirDigest;
  } else {
    first = theirDigest;
    second = myDigest;
  }

  // 6 groupes de 5 chiffres par digest (5 bytes/groupe × 6 = 30 bytes),
  // total: 12 groupes = 60 chiffres
  const firstGroups = bytesToSafetyNumber(first, 6);
  const secondGroups = bytesToSafetyNumber(second, 6);
  return firstGroups + ' ' + secondGroups;
}

/**
 * Hash itéré SHA-256 pour le safety number.
 * hash = SHA-256^N(version || pubKey || identifier)
 */
function iteratedHash(
  identityKey: Uint8Array,
  identifier: string
): Uint8Array {
  const identifierBytes = new TextEncoder().encode(identifier);
  const versionByte = new Uint8Array([SAFETY_NUMBER_VERSION]);

  // Entrée initiale : version || pubKey || identifier
  let data = concatBytes(versionByte, identityKey, identifierBytes);

  for (let i = 0; i < SAFETY_NUMBER_ITERATIONS; i++) {
    // Hash(pubKey || data) pour inclure la clé à chaque itération
    const input = concatBytes(identityKey, data);
    data = sha256(input);
  }

  return data; // 32 bytes
}

/**
 * Convertit des bytes en chiffres décimaux groupés par 5.
 * 
 * Algorithme Signal-compatible:
 *   Chaque bloc de 5 bytes → nombre big-endian (0 à ~1.1 trillion)
 *   mod 100000 → 5 chiffres uniformément distribués
 *   32 bytes → 6 groupes de 5 chiffres (utilise 30 bytes sur 32)
 * 
 * @param bytes - Hash digest (32 bytes)
 * @param maxGroups - Nombre de groupes à générer (default: 6)
 * @returns Groupes de 5 chiffres séparés par des espaces
 */
function bytesToSafetyNumber(bytes: Uint8Array, maxGroups: number = 6): string {
  const groups: string[] = [];

  for (let i = 0; i + 4 < bytes.length && groups.length < maxGroups; i += 5) {
    // Lire 5 bytes en big-endian → nombre sur 40 bits
    // Max: 2^40 - 1 = 1,099,511,627,775
    // Modulo 100000 → distribution quasi-uniforme (biais < 0.001%)
    const high = bytes[i];
    const mid = (bytes[i + 1] << 24) | (bytes[i + 2] << 16) | (bytes[i + 3] << 8) | bytes[i + 4];
    // Calcul: high * 2^32 + mid (unsigned)
    const value = high * 0x100000000 + (mid >>> 0);
    groups.push((value % 100000).toString().padStart(5, '0'));
  }

  return groups.join(' ');
}

/**
 * Formate le safety number pour affichage QR code (sans espaces).
 */
export function safetyNumberToQRData(safetyNumber: string): string {
  return safetyNumber.replace(/ /g, '');
}

/**
 * Compare deux safety numbers.
 */
export function verifySafetyNumber(
  computed: string,
  scanned: string
): boolean {
  const a = computed.replace(/ /g, '');
  const b = scanned.replace(/ /g, '');
  return a === b;
}

// ============================================
// KEY PINNING (LOCAL STORE)
// ============================================

/**
 * Vérifie et met à jour la clé d'un contact.
 *
 * - Première fois : stocke la clé comme "pinned" → action 'new'
 * - Clé identique : met à jour lastSeen → action 'unchanged'
 * - Clé différente : alerte + archive l'ancienne → action 'changed'
 *
 * @param contactId - Identifiant du contact (fingerprint ou sessionId)
 * @param identityKeyB64 - Clé publique Ed25519 actuelle en Base64
 * @returns Le résultat de la vérification
 */
export async function verifyAndPinKey(
  contactId: string,
  identityKeyB64: string
): Promise<KeyVerificationResult> {
  const fingerprint = computeKeyFingerprint(identityKeyB64);
  const existing = await getKeyRecord(contactId);

  // Première fois : stocker la clé
  if (!existing) {
    const record: KeyRecord = {
      fingerprint,
      identityKeyB64,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      verified: false,
      previousKeys: [],
    };
    await saveKeyRecord(contactId, record);
    return { action: 'new', wasVerified: false, fingerprint };
  }

  // Clé identique : mettre à jour lastSeen
  if (existing.fingerprint === fingerprint) {
    existing.lastSeen = Date.now();
    await saveKeyRecord(contactId, existing);
    return {
      action: 'unchanged',
      wasVerified: existing.verified,
      fingerprint,
    };
  }

  // CLÉ DIFFÉRENTE — archiver l'ancienne et alerter
  const wasVerified = existing.verified;
  existing.previousKeys.push({
    fingerprint: existing.fingerprint,
    identityKeyB64: existing.identityKeyB64,
    firstSeen: existing.firstSeen,
    lastSeen: existing.lastSeen,
    verified: existing.verified,
  });

  // Limiter l'historique à 10 entrées
  if (existing.previousKeys.length > 10) {
    existing.previousKeys = existing.previousKeys.slice(-10);
  }

  existing.fingerprint = fingerprint;
  existing.identityKeyB64 = identityKeyB64;
  existing.firstSeen = Date.now();
  existing.lastSeen = Date.now();
  existing.verified = false; // Reset : la nouvelle clé doit être re-vérifiée

  await saveKeyRecord(contactId, existing);

  return { action: 'changed', wasVerified, fingerprint };
}

/**
 * Marque la clé d'un contact comme vérifiée manuellement.
 */
export async function markKeyAsVerified(contactId: string): Promise<void> {
  const record = await getKeyRecord(contactId);
  if (record) {
    record.verified = true;
    await saveKeyRecord(contactId, record);
  }
}

/**
 * Récupère le statut de vérification d'un contact.
 */
export async function getKeyVerificationStatus(
  contactId: string
): Promise<{ pinned: boolean; verified: boolean; fingerprint: string | null }> {
  const record = await getKeyRecord(contactId);
  if (!record) {
    return { pinned: false, verified: false, fingerprint: null };
  }
  return {
    pinned: true,
    verified: record.verified,
    fingerprint: record.fingerprint,
  };
}

/**
 * Récupère l'historique des clés d'un contact.
 */
export async function getKeyHistory(
  contactId: string
): Promise<KeyRecord | null> {
  return getKeyRecord(contactId);
}

// ============================================
// STORAGE HELPERS
// ============================================

async function getKeyRecord(contactId: string): Promise<KeyRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_PREFIX + contactId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveKeyRecord(
  contactId: string,
  record: KeyRecord
): Promise<void> {
  await AsyncStorage.setItem(
    STORAGE_PREFIX + contactId,
    JSON.stringify(record)
  );
}

// ============================================
// UTILITAIRES
// ============================================

function computeKeyFingerprint(identityKeyB64: string): string {
  // Décoder la clé Base64 en bytes bruts avant de hasher
  // (ne PAS hasher la string Base64 — fragile si variante d'encodage)
  const raw = Uint8Array.from(atob(identityKeyB64), c => c.charCodeAt(0));
  const hash = sha256(raw);
  return Array.from(hash)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}
