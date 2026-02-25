// src/services/kdf.ts
// Key Derivation Function - Version 6.0 Production-Ready
// 
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  STRATÉGIE DE SÉCURITÉ ÉTAT DE L'ART 2025                                ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║  EAS Build (prod)  : Argon2id natif    → 64 MiB, 3 iter  → ~200-400ms   ║
// ║  Expo Go (dev)     : PBKDF2 JS pur     → 50K iter        → ~1-2 sec     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Argon2id est recommandé par OWASP 2025 comme l'algorithme de référence
// pour la dérivation de clés à partir de mots de passe.
// 
// En Expo Go, PBKDF2 JS est utilisé comme fallback (acceptable pour le dev).
// En production (EAS Build), Argon2id natif offre une sécurité maximale.
//
// INSTALLATION PRODUCTION:
// npx expo install react-native-argon2
// npx expo prebuild
// eas build --profile production

import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';

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
  native?: boolean;
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

// Argon2id - Paramètres OWASP 2025
const ARGON2_MEMORY_KIB = 65536;    // 64 MiB
const ARGON2_TIME_COST = 3;         // 3 iterations
const ARGON2_PARALLELISM = 1;       // 1 thread (mobile)
const ARGON2_HASH_LENGTH = 32;      // 256 bits

// PBKDF2 - Fallback pour Expo Go
const PBKDF2_ITERATIONS_JS = 50000; // ~1-2 sec en JS pur

// Tailles
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;

// Version actuelle du format
const CURRENT_VERSION = 6;

// ============================================
// DÉTECTION ARGON2 NATIF
// ============================================

let argon2Module: any = null;
let argon2Checked = false;
let isExpoGo = false;

/**
 * Détecte si on est dans Expo Go
 */
function detectExpoGo(): boolean {
  try {
    // @ts-ignore
    const Constants = require('expo-constants').default;
    return Constants?.executionEnvironment === 'storeClient';
  } catch {
    return false;
  }
}

/**
 * Vérifie si react-native-argon2 est disponible
 */
async function checkArgon2Available(): Promise<boolean> {
  if (argon2Checked) {
    return argon2Module !== null;
  }
  
  argon2Checked = true;
  isExpoGo = detectExpoGo();
  
  if (isExpoGo) {
    __DEV__ && console.log('📱 Expo Go détecté - Argon2 natif non disponible');
    __DEV__ && console.log('⚠️ Fallback PBKDF2 activé. Normal en développement.');
    __DEV__ && console.log('💡 En production (EAS Build), Argon2id sera utilisé automatiquement.');
    return false;
  }
  
  try {
    // Import dynamique pour éviter l'erreur si non installé
    const module = await import('react-native-argon2').catch(() => null);
    
    if (module && module.default) {
      // Test rapide pour vérifier que ça fonctionne
      const testSalt = 'testsalt12345678901234567890123456';
      const testResult = await module.default('test', testSalt, {
        mode: 'argon2id',
        memory: 1024,
        iterations: 1,
        parallelism: 1,
        hashLength: 32,
      });
      
      if (testResult && testResult.rawHash) {
        argon2Module = module.default;
        __DEV__ && console.log('✅ react-native-argon2 disponible (sécurité maximale)');
        return true;
      }
    }
  } catch (e) {
    __DEV__ && console.log('⚠️ react-native-argon2 non disponible:', e);
  }
  
  __DEV__ && console.log('⚠️ Fallback PBKDF2 activé');
  return false;
}

/**
 * Vérifie si Argon2 natif est disponible (pour l'UI)
 */
export async function isArgon2Available(): Promise<boolean> {
  return checkArgon2Available();
}

/**
 * Vérifie si on est en mode Expo Go
 */
export function isRunningInExpoGo(): boolean {
  if (!argon2Checked) {
    isExpoGo = detectExpoGo();
  }
  return isExpoGo;
}

// ============================================
// UTILITAIRES
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

// ============================================
// ARGON2ID (NATIF)
// ============================================

/**
 * Dérive une clé avec Argon2id natif
 */
async function deriveWithArgon2(
  password: string,
  salt: Uint8Array,
  memory: number = ARGON2_MEMORY_KIB,
  timeCost: number = ARGON2_TIME_COST,
  parallelism: number = ARGON2_PARALLELISM,
  onProgress?: (progress: number) => void
): Promise<Uint8Array> {
  if (!argon2Module) {
    throw new Error('Argon2 module not available');
  }
  
  onProgress?.(0.1);
  
  // react-native-argon2 attend le salt en string (hex ou utf8)
  const saltHex = bytesToHex(salt);
  
  const result = await argon2Module(password, saltHex, {
    mode: 'argon2id',
    memory,
    iterations: timeCost,
    parallelism,
    hashLength: ARGON2_HASH_LENGTH,
    saltEncoding: 'hex',
  });
  
  onProgress?.(1);
  
  if (!result || !result.rawHash) {
    throw new Error('Argon2 derivation failed');
  }
  
  // Le rawHash est en hex
  return hexToBytes(result.rawHash);
}

// ============================================
// PBKDF2 (FALLBACK JS PUR)
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
      // RFC 2104: Si la clé dépasse la taille de bloc, la hasher d'abord
      // sha256 retourne 32 bytes, qui est < blockSize (64), donc on set directement
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
 * PBKDF2-SHA256 en JS pur
 */
async function deriveWithPBKDF2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  onProgress?: (progress: number) => void
): Promise<Uint8Array> {
  const startTime = Date.now();
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  
  const hmac = new HmacSha256(passwordBytes);
  
  // Premier bloc: U1 = PRF(Password, Salt || INT(1))
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
  
  const elapsed = Date.now() - startTime;
  __DEV__ && console.log(`⏱️ PBKDF2 JS: ${iterations} iterations en ${elapsed}ms`);
  
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
 * Dérive une clé à partir d'un mot de passe
 * Utilise Argon2id si disponible, sinon PBKDF2
 */
export async function deriveKey(
  password: string,
  existingSalt?: Uint8Array,
  onProgress?: (progress: number) => void
): Promise<KDFResult> {
  const salt = existingSalt || generateSalt();
  const hasArgon2 = await checkArgon2Available();
  
  let key: Uint8Array;
  let params: KDFParams;
  let algorithmInfo: AlgorithmInfo;
  
  if (hasArgon2 && argon2Module) {
    // 🔒 Mode production : Argon2id natif
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
      native: true,
    };
    
    algorithmInfo = {
      name: 'Argon2id (64 MiB)',
      strength: 'high',
      memoryMB: ARGON2_MEMORY_KIB / 1024,
      iterations: ARGON2_TIME_COST,
      estimatedTimeMs: 300,
      native: true,
    };
    
    __DEV__ && console.log('🔐 Clé dérivée avec Argon2id (sécurité maximale)');
  } else {
    // ⚠️ Fallback : PBKDF2 JS
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
      warning: isExpoGo 
        ? 'Mode développement (Expo Go) - sécurité réduite'
        : 'Installez react-native-argon2 pour une sécurité optimale',
    };
    
    __DEV__ && console.log('⚠️ Clé dérivée avec PBKDF2 (fallback)');
  }
  
  return { key, params: JSON.stringify(params), algorithmInfo };
}

/**
 * Dérive une clé avec des paramètres existants
 */
export async function deriveKeyWithParams(
  password: string,
  paramsJson: string,
  onProgress?: (progress: number) => void
): Promise<Uint8Array> {
  const params: KDFParams = JSON.parse(paramsJson);
  const salt = decodeBase64(params.salt);
  
  if (params.algorithm === 'argon2id') {
    const hasArgon2 = await checkArgon2Available();
    
    if (hasArgon2 && argon2Module) {
      return deriveWithArgon2(
        password,
        salt,
        params.memory || ARGON2_MEMORY_KIB,
        params.timeCost || ARGON2_TIME_COST,
        params.parallelism || ARGON2_PARALLELISM,
        onProgress
      );
    } else {
      // Argon2 requis mais non disponible
      console.error('🔴 ERREUR: Les données ont été chiffrées avec Argon2id');
      console.error('🔴 Argon2 natif non disponible dans cet environnement');
      console.error('🔴 Utilisez un EAS Build pour déchiffrer');
      throw new Error(
        'Ces données nécessitent Argon2id qui n\'est pas disponible. ' +
        'Utilisez un build de production (EAS Build) pour y accéder.'
      );
    }
  } else {
    // PBKDF2
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
  const encoder = new TextEncoder();
  const infoBytes = encoder.encode(info);
  
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
 * Vérifie si une migration est nécessaire
 */
export function needsMigration(paramsJson: string): boolean {
  try {
    const params: KDFParams = JSON.parse(paramsJson);
    
    // Migration nécessaire si :
    // - Version ancienne
    // - PBKDF2 utilisé alors qu'Argon2 est disponible (vérifié plus tard)
    if (params.version < CURRENT_VERSION) {
      return true;
    }
    
    // Si c'est PBKDF2 et qu'on pourrait utiliser Argon2, suggérer upgrade
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
      return {
        name: `Argon2id (${memoryMB} MiB)`,
        strength: 'high',
        memoryMB,
        iterations: params.timeCost || ARGON2_TIME_COST,
        estimatedTimeMs: 300,
        native: params.native || false,
      };
    } else {
      const iterations = params.iterations || PBKDF2_ITERATIONS_JS;
      let strength: 'high' | 'standard' | 'low';
      
      if (iterations >= 100000) {
        strength = 'standard';
      } else if (iterations >= 50000) {
        strength = 'standard';
      } else {
        strength = 'low';
      }
      
      return {
        name: 'PBKDF2-SHA256',
        strength,
        iterations,
        estimatedTimeMs: Math.round(iterations / 30),
        native: params.native || false,
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
 * Estime le temps de dérivation
 */
export async function estimateDerivationTime(paramsJson: string): Promise<number> {
  const params: KDFParams = JSON.parse(paramsJson);
  
  if (params.algorithm === 'argon2id') {
    const hasArgon2 = await checkArgon2Available();
    if (hasArgon2) {
      return 300; // ~300ms en natif
    }
    return -1; // Non disponible
  } else {
    const iterations = params.iterations || PBKDF2_ITERATIONS_JS;
    return Math.round(iterations / 30); // ~30 iter/ms en JS
  }
}

// ============================================
// LEGACY SUPPORT (simplifié - pour compatibilité API)
// ============================================

/**
 * Ancienne fonction de dérivation v2 (pour migration si nécessaire)
 * @deprecated Utiliser deriveKey à la place
 */
export async function deriveKeyLegacyV2(
  password: string,
  salt: Uint8Array
): Promise<Uint8Array> {
  console.warn('⚠️ deriveKeyLegacyV2 est déprécié');
  return deriveWithPBKDF2(password, salt, 20000);
}

/**
 * Ancienne fonction de dérivation v1
 * @deprecated Utiliser deriveKey à la place
 */
export async function deriveKeyLegacy(
  password: string,
  salt: Uint8Array,
  iterations: number = 10000
): Promise<Uint8Array> {
  console.warn('⚠️ deriveKeyLegacy est déprécié');
  return deriveWithPBKDF2(password, salt, iterations);
}

// ============================================
// VÉRIFICATION DE COMPATIBILITÉ
// ============================================

/**
 * Vérifie si les paramètres peuvent être utilisés dans l'environnement actuel
 */
export async function canDecryptWithParams(paramsJson: string): Promise<{
  canDecrypt: boolean;
  reason?: string;
}> {
  try {
    const params: KDFParams = JSON.parse(paramsJson);
    
    if (params.algorithm === 'argon2id') {
      const hasArgon2 = await checkArgon2Available();
      if (!hasArgon2) {
        return {
          canDecrypt: false,
          reason: 'Les données ont été chiffrées avec Argon2id. ' +
                  'Utilisez un build de production pour y accéder.',
        };
      }
    }
    
    return { canDecrypt: true };
  } catch {
    return { 
      canDecrypt: false, 
      reason: 'Paramètres de chiffrement invalides' 
    };
  }
}

// ============================================
// EXPORTS POUR DEBUG
// ============================================

export const _internal = {
  ARGON2_MEMORY_KIB,
  ARGON2_TIME_COST,
  ARGON2_PARALLELISM,
  PBKDF2_ITERATIONS_JS,
  CURRENT_VERSION,
  checkArgon2Available,
  detectExpoGo,
  isExpoGo: () => isExpoGo,
  hasArgon2: () => argon2Module !== null,
};