// src/services/kdf.ts
// Key Derivation Function — Version 7.0 — 16 KB Page Size Safe
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  STRATÉGIE DE SÉCURITÉ ÉTAT DE L'ART 2026                                ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║  Toutes plateformes  : Argon2id (@noble/hashes, JS pur, RFC 9106)        ║
// ║                        m=19 MiB, t=2, p=1  → ~2-5s sur mobile            ║
// ║                        Paramètres OWASP 2025 minimum                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// CONTEXTE DE LA MIGRATION (v6 → v7):
// La v6 utilisait `react-native-argon2` (natif). Cette lib n'est pas compatible
// avec les tailles de page mémoire 16 KB exigées par Google Play depuis nov.
// 2025 (lib non maintenue, NDK trop ancien). On la remplace par @noble/hashes
// qui est :
//   - 100% JS pur (aucun binaire natif → aucun problème d'alignement 16 KB)
//   - audité, maintenu activement, conforme RFC 9106
//   - identique en sortie au natif pour des paramètres identiques
//
// Les anciennes clés v6 (m=64 MiB, t=3) restent décryptables via
// deriveKeyWithParams qui lit les paramètres stockés. La performance sera
// dégradée (~10-15s la première fois), mais needsMigration() déclenchera
// une re-encryption automatique avec les nouveaux paramètres v7.
//
// PBKDF2 reste disponible uniquement comme fallback historique en Expo Go.

import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';
import { argon2idAsync } from '@noble/hashes/argon2';

// ============================================
// TYPES
// ============================================

export interface KDFParams {
  algorithm: 'argon2id' | 'pbkdf2';
  salt: string;              // Base64 encoded
  // Argon2id params
  memory?: number;           // en KiB
  timeCost?: number;         // iterations
  parallelism?: number;
  // PBKDF2 params
  iterations?: number;
  // Meta
  version: number;
  native?: boolean;          // toujours false en v7 (JS pur)
}

export interface KDFResult {
  key: Uint8Array;
  params: string;            // JSON stringified KDFParams
  algorithmInfo: AlgorithmInfo;
}

export interface AlgorithmInfo {
  name: string;
  strength: 'high' | 'standard' | 'low';
  iterations?: number;
  memoryMB?: number;
  estimatedTimeMs: number;
  native: boolean;
  warning?: string;
}

// ============================================
// CONFIGURATION
// ============================================

// Argon2id — Paramètres OWASP 2025 minimum (m=19 MiB, t=2, p=1)
// Choisi pour équilibrer sécurité et performance en JS pur sur mobile.
// Référence : https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
const ARGON2_MEMORY_KIB = 19456;    // 19 MiB
const ARGON2_TIME_COST = 2;         // 2 iterations
const ARGON2_PARALLELISM = 1;       // 1 thread (JS = pas de vrai parallélisme de toute façon)
const ARGON2_HASH_LENGTH = 32;      // 256 bits

// Limite mémoire interne d'@noble/hashes (DoS protection).
// 19 MiB ≪ 1 GiB, donc on garde le défaut. Documenté explicitement pour clarté.
const ARGON2_MAXMEM_BYTES = 2 ** 30; // 1 GiB

// PBKDF2 — Fallback historique pour Expo Go uniquement
const PBKDF2_ITERATIONS_JS = 50000;

// Tailles
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;             // 32 bytes — compatible avec ancien format v6

// Version actuelle du format
const CURRENT_VERSION = 7;

// ============================================
// ERREURS TYPÉES
// ============================================

/**
 * Conservée pour compatibilité avec le code appelant (appLock.ts,
 * AppNoticeOverlay.tsx, secureBackup.ts) qui catch encore cette erreur.
 *
 * En v7, Argon2id est TOUJOURS disponible (JS pur), donc cette erreur ne
 * devrait JAMAIS être lancée par kdf.ts en production. Elle reste utile
 * en tant que type d'erreur pour les cas exceptionnels (paramètres
 * corrompus, salt invalide, etc.).
 */
export class ArgonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgonUnavailableError';
    Object.setPrototypeOf(this, ArgonUnavailableError.prototype);
  }
}

// ============================================
// DÉTECTION ENVIRONNEMENT
// ============================================

let isExpoGo = false;
let envChecked = false;

function detectExpoGo(): boolean {
  try {
    // @ts-ignore
    const Constants = require('expo-constants').default;
    return Constants?.executionEnvironment === 'storeClient';
  } catch {
    return false;
  }
}

function ensureEnvChecked() {
  if (!envChecked) {
    isExpoGo = detectExpoGo();
    envChecked = true;
    if (__DEV__) {
      console.log(
        isExpoGo
          ? '📱 Expo Go détecté'
          : '🏗️ Build natif détecté (EAS / dev-client)'
      );
    }
  }
}

/**
 * Compat API : retourne toujours true en v7 (Argon2id JS pur disponible
 * partout). Conservée pour ne pas casser les appelants.
 */
export async function isArgon2Available(): Promise<boolean> {
  ensureEnvChecked();
  return true;
}

export function isRunningInExpoGo(): boolean {
  ensureEnvChecked();
  return isExpoGo;
}

// ============================================
// UTILITAIRES
// ============================================

function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

// ============================================
// ARGON2ID (JS PUR via @noble/hashes)
// ============================================

/**
 * Dérive une clé avec Argon2id (RFC 9106) en JS pur, version asynchrone.
 *
 * IMPORTANT — Performance & responsivité :
 * Argon2 en JS pur est intrinsèquement plus lent que le natif (pas de
 * Uint64Array rapide en JS). On utilise `argon2idAsync` de @noble/hashes
 * v1.8+ qui cède au runtime toutes les `asyncTick` ms — l'UI reste donc
 * fluide pendant la dérivation, et `onProgress` rapporte un vrai % de
 * progression (pas une simple estimation).
 *
 * Performance attendue (mobile ARM, JS via Hermes) :
 *   - v7 (m=19 MiB, t=2)  : ~2-5 s
 *   - v6 (m=64 MiB, t=3) legacy : ~10-20 s (one-time, déclenche migration)
 */
async function deriveWithArgon2(
  password: string,
  salt: Uint8Array,
  memory: number = ARGON2_MEMORY_KIB,
  timeCost: number = ARGON2_TIME_COST,
  parallelism: number = ARGON2_PARALLELISM,
  onProgress?: (progress: number) => void
): Promise<Uint8Array> {
  const startTime = Date.now();

  // Yield AVANT pour laisser React Native rendre l'UI de loading.
  onProgress?.(0);
  await new Promise(resolve => setTimeout(resolve, 16));

  // @noble/hashes argon2idAsync (v1.8+) :
  //   - password / salt : KDFInput (string ou Uint8Array)
  //   - opts.t       : iterations
  //   - opts.m       : memory in KiB
  //   - opts.p       : parallelism (≥1, ignoré en pratique en JS)
  //   - opts.dkLen   : output length in bytes
  //   - opts.maxmem  : memory limit guard (DoS) — défaut 1 GiB, suffisant
  //   - opts.asyncTick : cooperative yield interval in ms (défaut 10)
  //   - opts.onProgress : (progress: number 0..1) => void
  // Salt min : 8 bytes (RFC 9106) — on a 32 bytes, OK.
  const key = await argon2idAsync(password, salt, {
    t: timeCost,
    m: memory,
    p: parallelism,
    dkLen: ARGON2_HASH_LENGTH,
    maxmem: ARGON2_MAXMEM_BYTES,
    asyncTick: 10,
    onProgress: (progress: number) => {
      // Mappe la progression réelle d'argon2 sur [0.05 .. 1.0] pour laisser
      // un peu de marge au début (init UI) et à la fin (post-traitement).
      onProgress?.(0.05 + 0.95 * progress);
    },
  });

  if (__DEV__) {
    const elapsed = Date.now() - startTime;
    console.log(
      `⏱️ Argon2id JS async: m=${memory} KiB, t=${timeCost}, p=${parallelism} → ${elapsed}ms`
    );
  }

  return key;
}

// ============================================
// PBKDF2 (FALLBACK JS PUR — Expo Go uniquement)
// ============================================

/**
 * HMAC-SHA256 avec pré-calcul des pads (optimisé)
 */
class HmacSha256 {
  private innerPad: Uint8Array;
  private outerPad: Uint8Array;

  constructor(key: Uint8Array) {
    const blockSize = 64;
    const paddedKey = new Uint8Array(blockSize);

    if (key.length <= blockSize) {
      paddedKey.set(key);
    } else {
      paddedKey.set(sha256(key));
    }

    this.innerPad = new Uint8Array(blockSize);
    this.outerPad = new Uint8Array(blockSize);

    for (let i = 0; i < blockSize; i++) {
      this.innerPad[i] = paddedKey[i] ^ 0x36;
      this.outerPad[i] = paddedKey[i] ^ 0x5c;
    }
  }

  async compute(data: Uint8Array): Promise<Uint8Array> {
    const innerData = new Uint8Array(64 + data.length);
    innerData.set(this.innerPad);
    innerData.set(data, 64);

    const innerHash = await Crypto.digest(
      Crypto.CryptoDigestAlgorithm.SHA256,
      innerData
    );

    const outerData = new Uint8Array(64 + 32);
    outerData.set(this.outerPad);
    outerData.set(new Uint8Array(innerHash), 64);

    const result = await Crypto.digest(
      Crypto.CryptoDigestAlgorithm.SHA256,
      outerData
    );

    return new Uint8Array(result);
  }
}

/**
 * PBKDF2-SHA256 en JS pur — utilisé UNIQUEMENT en Expo Go.
 * Tous les builds natifs (EAS dev/preview/production) utilisent Argon2id.
 */
async function deriveWithPBKDF2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  onProgress?: (progress: number) => void
): Promise<Uint8Array> {
  const startTime = Date.now();
  const passwordBytes = utf8Encode(password);

  const hmac = new HmacSha256(passwordBytes);

  const u = new Uint8Array(salt.length + 4);
  u.set(salt);
  u.set([0, 0, 0, 1], salt.length);

  let block = await hmac.compute(u);
  const result = new Uint8Array(block);

  let lastYield = Date.now();
  let lastProgress = 0;
  const yieldInterval = 200;

  for (let i = 1; i < iterations; i++) {
    block = await hmac.compute(block);

    for (let j = 0; j < KEY_LENGTH; j++) {
      result[j] ^= block[j];
    }

    const now = Date.now();
    if (now - lastYield > yieldInterval) {
      await new Promise(resolve => setTimeout(resolve, 0));

      const progress = i / iterations;
      if (progress - lastProgress > 0.02) {
        onProgress?.(progress);
        lastProgress = progress;
      }
      lastYield = now;
    }
  }

  if (__DEV__) {
    const elapsed = Date.now() - startTime;
    console.log(`⏱️ PBKDF2 JS: ${iterations} iterations en ${elapsed}ms`);
  }

  onProgress?.(1);
  return result;
}

// ============================================
// API PRINCIPALE
// ============================================

/**
 * Génère un sel cryptographiquement sûr
 */
export function generateSalt(length: number = SALT_LENGTH): Uint8Array {
  return nacl.randomBytes(length);
}

/**
 * Dérive une clé à partir d'un mot de passe.
 *
 * - En build natif (EAS) : Argon2id (m=19 MiB, t=2, p=1) — sécurité OWASP
 * - En Expo Go            : PBKDF2 (50k iters) — fallback développement
 *
 * Avant v7, Argon2 nécessitait un module natif. La v7 utilise @noble/hashes
 * qui fonctionne partout. On garde le fallback PBKDF2 en Expo Go uniquement
 * pour réduire la latence en dev (Expo Go = dev only de toute façon).
 */
export async function deriveKey(
  password: string,
  existingSalt?: Uint8Array,
  onProgress?: (progress: number) => void
): Promise<KDFResult> {
  ensureEnvChecked();
  const salt = existingSalt || generateSalt();

  let key: Uint8Array;
  let params: KDFParams;
  let algorithmInfo: AlgorithmInfo;

  if (isExpoGo) {
    // ─── Expo Go : PBKDF2 (rapide, pour dev uniquement) ───
    key = await deriveWithPBKDF2(
      password,
      salt,
      PBKDF2_ITERATIONS_JS,
      onProgress
    );

    params = {
      algorithm: 'pbkdf2',
      salt: encodeBase64(salt),
      iterations: PBKDF2_ITERATIONS_JS,
      version: CURRENT_VERSION,
      native: false,
    };

    algorithmInfo = {
      name: 'PBKDF2-SHA256',
      strength: 'standard',
      iterations: PBKDF2_ITERATIONS_JS,
      estimatedTimeMs: 1500,
      native: false,
      warning: 'Mode développement (Expo Go) — PBKDF2 fallback',
    };

    if (__DEV__) console.log('⚠️ Clé dérivée avec PBKDF2 (Expo Go uniquement)');
  } else {
    // ─── Build natif : Argon2id JS pur (sécurité maximale, 16 KB safe) ───
    key = await deriveWithArgon2(
      password,
      salt,
      ARGON2_MEMORY_KIB,
      ARGON2_TIME_COST,
      ARGON2_PARALLELISM,
      onProgress
    );

    params = {
      algorithm: 'argon2id',
      salt: encodeBase64(salt),
      memory: ARGON2_MEMORY_KIB,
      timeCost: ARGON2_TIME_COST,
      parallelism: ARGON2_PARALLELISM,
      version: CURRENT_VERSION,
      native: false, // v7 = JS pur, jamais natif
    };

    algorithmInfo = {
      name: `Argon2id (${ARGON2_MEMORY_KIB / 1024} MiB)`,
      strength: 'high',
      memoryMB: ARGON2_MEMORY_KIB / 1024,
      iterations: ARGON2_TIME_COST,
      estimatedTimeMs: 3000,
      native: false,
    };

    if (__DEV__) console.log('🔐 Clé dérivée avec Argon2id (JS pur, RFC 9106)');
  }

  return { key, params: JSON.stringify(params), algorithmInfo };
}

/**
 * Dérive une clé avec des paramètres existants (déchiffrement, vérif).
 *
 * Lit l'algorithme et les paramètres depuis le JSON stocké, applique la même
 * dérivation. Compatible avec les anciens formats v6 (m=64 MiB, t=3) pour
 * les utilisateurs internes qui auraient déjà des données chiffrées.
 */
export async function deriveKeyWithParams(
  password: string,
  paramsJson: string,
  onProgress?: (progress: number) => void
): Promise<Uint8Array> {
  ensureEnvChecked();
  const params: KDFParams = JSON.parse(paramsJson);
  const salt = decodeBase64(params.salt);

  if (params.algorithm === 'argon2id') {
    // Tous les builds (Expo Go inclus) peuvent désormais dériver de l'Argon2id.
    return deriveWithArgon2(
      password,
      salt,
      params.memory || ARGON2_MEMORY_KIB,
      params.timeCost || ARGON2_TIME_COST,
      params.parallelism || ARGON2_PARALLELISM,
      onProgress
    );
  } else {
    // PBKDF2 legacy : autorisé en Expo Go (dev), mais aussi accepté en build
    // natif si les données ont été créées en dev — sinon les utilisateurs
    // d'Expo Go ne pourraient plus accéder à leurs données après un EAS build.
    const iterations = params.iterations || PBKDF2_ITERATIONS_JS;
    return deriveWithPBKDF2(password, salt, iterations, onProgress);
  }
}

/**
 * Dérive des sous-clés à partir d'une clé maître (HKDF-Expand simplifié)
 */
export async function deriveSubKey(
  masterKey: Uint8Array,
  info: string,
  keyLength: number = 32
): Promise<Uint8Array> {
  const infoBytes = utf8Encode(info);

  const hmac = new HmacSha256(masterKey);
  const input = new Uint8Array(infoBytes.length + 1);
  input.set(infoBytes);
  input[input.length - 1] = 1;

  const key = await hmac.compute(input);
  return key.slice(0, keyLength);
}

// ============================================
// UTILITAIRES D'INFO
// ============================================

/**
 * Vérifie si une migration est nécessaire.
 *
 * Migration v6 → v7 :
 *   - Les utilisateurs internes en v6 (m=64 MiB, t=3) ont des unlocks lents
 *     (~10-15s en JS). On déclenche une re-dérivation en v7 (m=19 MiB, t=2)
 *     dès qu'on en a l'occasion pour accélérer les unlocks futurs (~2-5s).
 */
export function needsMigration(paramsJson: string): boolean {
  try {
    const params: KDFParams = JSON.parse(paramsJson);

    if (params.version < CURRENT_VERSION) {
      return true;
    }

    // Données chiffrées en PBKDF2 alors qu'on tourne en build natif :
    // proposer un upgrade Argon2id.
    if (params.algorithm === 'pbkdf2' && !isExpoGo) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Obtient les infos sur l'algorithme utilisé
 */
export function getAlgorithmInfo(paramsJson: string): AlgorithmInfo {
  try {
    const params: KDFParams = JSON.parse(paramsJson);

    if (params.algorithm === 'argon2id') {
      const memoryMB = (params.memory || ARGON2_MEMORY_KIB) / 1024;
      // Estimation grossière : ~150ms par MiB en JS pur
      const estimatedTimeMs = Math.round(memoryMB * 150 * (params.timeCost || ARGON2_TIME_COST));
      return {
        name: `Argon2id (${memoryMB} MiB)`,
        strength: 'high',
        memoryMB,
        iterations: params.timeCost || ARGON2_TIME_COST,
        estimatedTimeMs,
        native: false,
      };
    } else {
      const iterations = params.iterations || PBKDF2_ITERATIONS_JS;
      const strength: 'high' | 'standard' | 'low' =
        iterations >= 50000 ? 'standard' : 'low';

      return {
        name: 'PBKDF2-SHA256',
        strength,
        iterations,
        estimatedTimeMs: Math.round(iterations / 30),
        native: false,
        warning: 'Argon2id recommandé pour une sécurité optimale',
      };
    }
  } catch {
    return {
      name: 'Inconnu',
      strength: 'low',
      estimatedTimeMs: 0,
      native: false,
    };
  }
}

/**
 * Estime le temps de dérivation (en ms)
 */
export async function estimateDerivationTime(paramsJson: string): Promise<number> {
  try {
    const info = getAlgorithmInfo(paramsJson);
    return info.estimatedTimeMs;
  } catch {
    return -1;
  }
}

// ============================================
// VÉRIFICATION DE COMPATIBILITÉ
// ============================================

/**
 * Vérifie si les paramètres peuvent être utilisés dans l'environnement actuel.
 *
 * En v7, Argon2id et PBKDF2 fonctionnent partout (JS pur).
 * Cette fonction retourne donc toujours true pour les paramètres valides.
 */
export async function canDecryptWithParams(paramsJson: string): Promise<{
  canDecrypt: boolean;
  reason?: string;
}> {
  try {
    const params: KDFParams = JSON.parse(paramsJson);
    if (params.algorithm !== 'argon2id' && params.algorithm !== 'pbkdf2') {
      return {
        canDecrypt: false,
        reason: `Algorithme non supporté : ${params.algorithm}`,
      };
    }
    return { canDecrypt: true };
  } catch {
    return {
      canDecrypt: false,
      reason: 'Paramètres de chiffrement invalides',
    };
  }
}

// ============================================
// LEGACY SUPPORT
// ============================================

/**
 * @deprecated Utiliser deriveKey à la place
 */
export async function deriveKeyLegacyV2(
  password: string,
  salt: Uint8Array
): Promise<Uint8Array> {
  if (__DEV__) console.warn('⚠️ deriveKeyLegacyV2 est déprécié');
  return deriveWithPBKDF2(password, salt, 20000);
}

/**
 * @deprecated Utiliser deriveKey à la place
 */
export async function deriveKeyLegacy(
  password: string,
  salt: Uint8Array,
  iterations: number = 10000
): Promise<Uint8Array> {
  if (__DEV__) console.warn('⚠️ deriveKeyLegacy est déprécié');
  return deriveWithPBKDF2(password, salt, iterations);
}

// ============================================
// EXPORTS POUR DEBUG / TESTS
// ============================================

export const _internal = {
  ARGON2_MEMORY_KIB,
  ARGON2_TIME_COST,
  ARGON2_PARALLELISM,
  PBKDF2_ITERATIONS_JS,
  CURRENT_VERSION,
  detectExpoGo,
  isExpoGo: () => isExpoGo,
};