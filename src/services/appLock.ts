// src/services/appLock.ts
// Système de verrouillage de l'application - Ultra-sécurisé
// Version 6.0 - Argon2id + PBKDF2 fallback
// 
// FONCTIONNALITÉS:
// - Argon2id en production (EAS Build) - sécurité maximale OWASP 2025
// - PBKDF2 fallback en développement (Expo Go)
// - Affichage du niveau de sécurité
// - Anti-brute-force avec lockout progressif
// - Pas de hash stocké (vérification par déchiffrement)

import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { 
  deriveKey, 
  deriveKeyWithParams, 
  generateSalt, 
  deriveSubKey, 
  deriveKeyLegacyV2,
  needsMigration,
  getAlgorithmInfo,
  AlgorithmInfo,
} from './kdf';
import { securityLogger } from './securityLogger';

// ============================================
// TYPES
// ============================================

export interface LockSettings {
  enabled: boolean;
  useBiometrics: boolean;
  timeoutMinutes: number;
}

export interface LockState {
  failedAttempts: number;
  lockoutUntil: number | null;
  remainingLockoutSeconds: number;
}

// v6: Infos de sécurité pour l'UI
export interface SecurityInfo {
  algorithmName: string;
  strength: 'high' | 'standard' | 'low';
  needsUpgrade: boolean;
  iterations?: number;
  memoryMB?: number;
  warning?: string;
}

interface StoredLockData {
  version: 6;
  kdfParams: string;           // JSON des paramètres KDF (Argon2id ou PBKDF2)
  encryptedMasterKey: string;  // Clé maître chiffrée (Base64)
  nonce: string;               // Nonce pour le chiffrement (Base64)
  useBiometrics: boolean;
  timeoutMinutes: number;
  conversationsKeyNonce: string; // Nonce pour dériver la clé conversations
}

// Structure v4 pour migration
interface StoredLockDataV4 {
  version: 4;
  kdfParams: string;
  encryptedMasterKey: string;
  nonce: string;
  useBiometrics: boolean;
  timeoutMinutes: number;
  conversationsKeyNonce: string;
}

// ============================================
// CONSTANTES
// ============================================

const STORAGE_KEYS = {
  LOCK_DATA: 'whisper_lock_data_v6',
  LOCK_DATA_V5: 'whisper_lock_data_v5',
  LOCK_DATA_V4: 'whisper_lock_data_v4',
  FAILED_ATTEMPTS: 'whisper_failed_attempts_v2',
  LOCKOUT_UNTIL: 'whisper_lockout_until_v2',
  AUTO_WIPE_ENABLED: 'whisper_auto_wipe_enabled',
  // Legacy keys pour migration
  LEGACY_V3_DATA: 'whisper_lock_data_v3',
  LEGACY_ENABLED: 'whisper_lock_enabled',
  LEGACY_HASH: 'whisper_password_hash',
  LEGACY_SALT: 'whisper_password_salt',
  LEGACY_BIOMETRICS: 'whisper_use_biometrics',
  LEGACY_TIMEOUT: 'whisper_lock_timeout',
  LEGACY_ENCRYPTION_KEY: 'whisper_encryption_key',
};

// Contextes HKDF pour dérivation de sous-clés
const KEY_CONTEXTS = {
  LOCAL_ENCRYPTION: 'whisper:local:v6',      // Chiffrement messages locaux
  CONVERSATIONS: 'whisper:conversations:v6', // Chiffrement conversations
  BIOMETRIC: 'whisper:biometric:v6',         // Stockage biométrique
};

// Délais de lockout progressifs (en secondes)
const LOCKOUT_SCHEDULE = [
  { attempts: 3, seconds: 30 },
  { attempts: 5, seconds: 60 },
  { attempts: 7, seconds: 300 },    // 5 min
  { attempts: 10, seconds: 900 },   // 15 min
  { attempts: 15, seconds: 3600 },  // 1 heure
  { attempts: 20, seconds: -1 },    // Wipe (indicateur spécial)
];

// ============================================
// FONCTIONS UTILITAIRES CRYPTO
// ============================================

/**
 * Chiffre des données avec une clé
 */
function encryptWithKey(data: Uint8Array, key: Uint8Array): { encrypted: string; nonce: string } {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const encrypted = nacl.secretbox(data, nonce, key);
  
  if (!encrypted) {
    throw new Error('Encryption failed');
  }
  
  return {
    encrypted: encodeBase64(encrypted),
    nonce: encodeBase64(nonce),
  };
}

/**
 * Déchiffre des données avec une clé
 */
function decryptWithKey(encryptedBase64: string, nonceBase64: string, key: Uint8Array): Uint8Array | null {
  try {
    const encrypted = decodeBase64(encryptedBase64);
    const nonce = decodeBase64(nonceBase64);
    return nacl.secretbox.open(encrypted, nonce, key);
  } catch {
    return null;
  }
}

/**
 * Calcule le lockout pour un nombre de tentatives
 */
function getLockoutForAttempts(attempts: number): number {
  let lockoutSeconds = 0;
  for (const level of LOCKOUT_SCHEDULE) {
    if (attempts >= level.attempts) {
      lockoutSeconds = level.seconds;
    }
  }
  return lockoutSeconds;
}

// ============================================
// ACTION 1: Secure counter management (SecureStore)
// ============================================

async function resetBruteForceCounters(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEYS.FAILED_ATTEMPTS);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LOCKOUT_UNTIL);
  } catch {
    // Non-critical
  }
}

// ============================================
// ACTION 3: Password strength estimation
// ============================================

export interface PasswordStrength {
  score: number;        // 0-4 (0=very weak, 4=very strong)
  entropy: number;      // Estimated bits of entropy
  crackTime: string;    // Human readable crack time
  isAcceptable: boolean; // Meets minimum requirements
  feedback: string[];   // Suggestions to improve
}

/**
 * Estime la force d'un mot de passe sans dépendance externe.
 * Utilise l'entropie Shannon + détection de patterns faibles.
 */
export function estimatePasswordStrength(password: string): PasswordStrength {
  const feedback: string[] = [];
  
  if (password.length < 8) {
    return {
      score: 0,
      entropy: 0,
      crackTime: 'instantané',
      isAcceptable: false,
      feedback: ['Minimum 8 caractères requis'],
    };
  }
  
  // Calculate charset size
  let charsetSize = 0;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigits = /[0-9]/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);
  
  if (hasLower) charsetSize += 26;
  if (hasUpper) charsetSize += 26;
  if (hasDigits) charsetSize += 10;
  if (hasSpecial) charsetSize += 32;
  
  // Base entropy: log2(charsetSize) * length
  let entropy = Math.log2(charsetSize) * password.length;
  
  // Penalty for pure numeric (PIN-like)
  const isPureNumeric = /^\d+$/.test(password);
  if (isPureNumeric) {
    entropy = Math.log2(10) * password.length;
    feedback.push('Ajoutez des lettres pour augmenter la sécurité');
  }
  
  // Penalty for sequential/repeated patterns
  const hasSequential = /(?:012|123|234|345|456|567|678|789|890|abc|bcd|cde|def)/i.test(password);
  if (hasSequential) {
    entropy *= 0.7;
    feedback.push('Évitez les séquences (123, abc...)');
  }
  
  const hasRepeated = /(.)\1{2,}/.test(password);
  if (hasRepeated) {
    entropy *= 0.7;
    feedback.push('Évitez les caractères répétés');
  }
  
  // Common passwords penalty
  const commonPatterns = [
    'password', 'qwerty', 'azerty', 'motdepasse', 'ghostr',
    '000000', '111111', '123456', '654321', 'abcdef',
  ];
  const lowerPw = password.toLowerCase();
  if (commonPatterns.some(p => lowerPw.includes(p))) {
    entropy *= 0.3;
    feedback.push('Ce mot de passe est trop commun');
  }
  
  // Determine score
  let score: number;
  let crackTime: string;
  
  // With Argon2id at 64 MiB, ~60ms/attempt on GPU → ~17 attempts/sec
  // Offline attacker with $10k hardware: ~1000 attempts/sec
  const attemptsPerSec = 1000;
  const totalAttempts = Math.pow(2, entropy);
  const secondsToCrack = totalAttempts / attemptsPerSec / 2; // average case
  
  if (secondsToCrack < 60) {
    score = 0;
    crackTime = 'moins d\'une minute';
  } else if (secondsToCrack < 3600) {
    score = 1;
    crackTime = `~${Math.round(secondsToCrack / 60)} minutes`;
  } else if (secondsToCrack < 86400 * 30) {
    score = 2;
    crackTime = `~${Math.round(secondsToCrack / 86400)} jours`;
  } else if (secondsToCrack < 86400 * 365 * 100) {
    score = 3;
    crackTime = `~${Math.round(secondsToCrack / (86400 * 365))} ans`;
  } else {
    score = 4;
    crackTime = 'des siècles';
  }
  
  // Suggestions
  if (password.length < 12) {
    feedback.push('Un mot de passe de 12+ caractères est recommandé');
  }
  if (!hasLower || !hasUpper) {
    feedback.push('Mélangez majuscules et minuscules');
  }
  if (!hasSpecial && !hasDigits) {
    feedback.push('Ajoutez des chiffres ou caractères spéciaux');
  }
  
  // Minimum acceptable: score >= 2 (at least days to crack with Argon2id)
  const isAcceptable = score >= 2;
  
  return { score, entropy: Math.round(entropy), crackTime, isAcceptable, feedback };
}

// ============================================
// ACTION 4: Auto-wipe on brute-force
// ============================================

/**
 * Active/désactive le wipe automatique après 20 tentatives échouées
 */
export async function setAutoWipeEnabled(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(
    STORAGE_KEYS.AUTO_WIPE_ENABLED,
    enabled ? 'true' : 'false'
  );
  __DEV__ && console.log(`🔒 Auto-wipe ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

/**
 * Vérifie si le wipe automatique est activé
 */
export async function isAutoWipeEnabled(): Promise<boolean> {
  try {
    const value = await SecureStore.getItemAsync(STORAGE_KEYS.AUTO_WIPE_ENABLED);
    return value === 'true';
  } catch {
    return false;
  }
}

/**
 * Effectue un wipe complet de sécurité (toutes les données)
 * Appelé par le système anti-brute-force quand auto-wipe est activé
 */
async function performSecurityWipe(): Promise<void> {
  try {
    // Use the nuclearReset from storage.ts 
    const { nuclearReset } = await import('./storage');
    await nuclearReset();
    __DEV__ && console.log('☢️ Security wipe completed');
  } catch (error) {
    __DEV__ && console.error('☢️ Security wipe error:', error);
    // Fallback: at minimum clear SecureStore lock data so the attacker can't retry
    try {
      await SecureStore.deleteItemAsync(STORAGE_KEYS.LOCK_DATA);
      await SecureStore.deleteItemAsync(STORAGE_KEYS.LOCK_DATA_V5);
      await SecureStore.deleteItemAsync(STORAGE_KEYS.LOCK_DATA_V4);
      const AsyncStorageFallback = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorageFallback.clear();
    } catch {
      // Last resort
    }
  }
}

// ============================================
// API PRINCIPALE
// ============================================

/**
 * Vérifie si le verrouillage est activé
 */
export async function isLockEnabled(): Promise<boolean> {
  try {
    // Vérifier v6
    const dataV6 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA);
    if (dataV6) return true;
    
    // Vérifier v5
    const dataV5 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V5);
    if (dataV5) return true;
    
    // Vérifier v4
    const dataV4 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V4);
    if (dataV4) return true;
    
    // Vérifier v3
    const dataV3 = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_V3_DATA);
    if (dataV3) return true;
    
    // Vérifier legacy
    const legacyEnabled = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_ENABLED);
    return legacyEnabled === 'true';
  } catch {
    return false;
  }
}

/**
 * Récupère les paramètres de verrouillage
 */
export async function getLockSettings(): Promise<LockSettings> {
  try {
    // V6
    const dataV6 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA);
    if (dataV6) {
      const lockData: StoredLockData = JSON.parse(dataV6);
      return {
        enabled: true,
        useBiometrics: lockData.useBiometrics,
        timeoutMinutes: lockData.timeoutMinutes,
      };
    }
    
    // V5
    const dataV5 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V5);
    if (dataV5) {
      const lockData = JSON.parse(dataV5);
      return {
        enabled: true,
        useBiometrics: lockData.useBiometrics,
        timeoutMinutes: lockData.timeoutMinutes,
      };
    }
    
    // V4
    const dataV4 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V4);
    if (dataV4) {
      const lockData: StoredLockDataV4 = JSON.parse(dataV4);
      return {
        enabled: true,
        useBiometrics: lockData.useBiometrics,
        timeoutMinutes: lockData.timeoutMinutes,
      };
    }
    
    // V3
    const dataV3 = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_V3_DATA);
    if (dataV3) {
      const lockData = JSON.parse(dataV3);
      return {
        enabled: true,
        useBiometrics: lockData.useBiometrics || false,
        timeoutMinutes: lockData.timeoutMinutes || 1,
      };
    }
    
    // Legacy
    const legacyEnabled = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_ENABLED);
    if (legacyEnabled === 'true') {
      const biometrics = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_BIOMETRICS);
      const timeout = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_TIMEOUT);
      
      return {
        enabled: true,
        useBiometrics: biometrics === 'true',
        timeoutMinutes: timeout ? parseInt(timeout, 10) : 1,
      };
    }
    
    return { enabled: false, useBiometrics: false, timeoutMinutes: 1 };
  } catch {
    return { enabled: false, useBiometrics: false, timeoutMinutes: 1 };
  }
}

/**
 * Récupère l'état actuel du verrouillage (tentatives, lockout)
 */
export async function getLockState(): Promise<LockState> {
  try {
    const attemptsStr = await SecureStore.getItemAsync(STORAGE_KEYS.FAILED_ATTEMPTS);
    const lockoutStr = await SecureStore.getItemAsync(STORAGE_KEYS.LOCKOUT_UNTIL);
    
    const failedAttempts = attemptsStr ? parseInt(attemptsStr, 10) : 0;
    const lockoutUntil = lockoutStr ? parseInt(lockoutStr, 10) : null;
    
    let remainingLockoutSeconds = 0;
    if (lockoutUntil && Date.now() < lockoutUntil) {
      remainingLockoutSeconds = Math.ceil((lockoutUntil - Date.now()) / 1000);
    }
    
    return { failedAttempts, lockoutUntil, remainingLockoutSeconds };
  } catch {
    return { failedAttempts: 0, lockoutUntil: null, remainingLockoutSeconds: 0 };
  }
}

/**
 * Récupère les informations de sécurité actuelles
 */
export async function getSecurityInfo(): Promise<SecurityInfo | null> {
  try {
    // V6
    const dataV6 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA);
    if (dataV6) {
      const lockData: StoredLockData = JSON.parse(dataV6);
      const info = getAlgorithmInfo(lockData.kdfParams);
      return {
        algorithmName: info.name,
        strength: info.strength,
        needsUpgrade: needsMigration(lockData.kdfParams),
        iterations: info.iterations,
        memoryMB: info.memoryMB,
        warning: info.warning,
      };
    }
    
    // V5 (ancien)
    const dataV5 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V5);
    if (dataV5) {
      const lockData = JSON.parse(dataV5);
      const info = getAlgorithmInfo(lockData.kdfParams);
      return {
        algorithmName: info.name,
        strength: info.strength,
        needsUpgrade: true, // V5 doit être migré vers V6
        iterations: info.iterations,
        memoryMB: info.memoryMB,
      };
    }
    
    // V4
    const dataV4 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V4);
    if (dataV4) {
      const lockData: StoredLockDataV4 = JSON.parse(dataV4);
      const info = getAlgorithmInfo(lockData.kdfParams);
      return {
        algorithmName: info.name,
        strength: info.strength,
        needsUpgrade: true,
        iterations: info.iterations,
        memoryMB: info.memoryMB,
      };
    }
    
    // Legacy
    const legacyEnabled = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_ENABLED);
    if (legacyEnabled === 'true') {
      return {
        algorithmName: 'PBKDF2 (legacy)',
        strength: 'low',
        needsUpgrade: true,
      };
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Configure le verrouillage avec un nouveau mot de passe
 */
export async function setupLock(
  password: string,
  useBiometrics: boolean = false,
  timeoutMinutes: number = 1,
  onProgress?: (progress: number) => void
): Promise<boolean> {
  try {
    if (password.length < 8) {
      __DEV__ && console.warn('Mot de passe trop court (minimum 8 caractères)');
      return false;
    }
    
    // 1. Générer une clé maître aléatoire (32 bytes)
    const masterKey = nacl.randomBytes(32);
    
    // 2. Dériver une clé du mot de passe (nouveau KDF v5)
    const { key: derivedKey, params: kdfParams, algorithmInfo } = await deriveKey(password, undefined, onProgress);
    
    __DEV__ && console.log(`🔐 Setup avec ${algorithmInfo.name} (${algorithmInfo.strength})`);
    
    // 3. Chiffrer la clé maître avec la clé dérivée
    const { encrypted: encryptedMasterKey, nonce } = encryptWithKey(masterKey, derivedKey);
    
    // 4. Générer un nonce pour la dérivation de la clé conversations
    const conversationsKeyNonce = encodeBase64(nacl.randomBytes(32));
    
    // 5. Stocker les données
    const lockData: StoredLockData = {
      version: 6,
      kdfParams,
      encryptedMasterKey,
      nonce,
      useBiometrics,
      timeoutMinutes,
      conversationsKeyNonce,
    };
    
    await SecureStore.setItemAsync(STORAGE_KEYS.LOCK_DATA, JSON.stringify(lockData));
    
    // 6. Réinitialiser les compteurs
    await resetBruteForceCounters();
    
    // 7. Nettoyer les anciennes versions
    await cleanupLegacyData();
    
    // 8. Effacer les clés de la mémoire
    derivedKey.fill(0);
    masterKey.fill(0);
    
    __DEV__ && console.log('✅ Verrouillage v6 configuré');
    return true;
  } catch (e) {
    __DEV__ && console.error('setupLock error:', e);
    return false;
  }
}

/**
 * Désactive le verrouillage (nécessite le mot de passe)
 */
export async function disableLock(password: string): Promise<boolean> {
  try {
    // Vérifier le mot de passe
    const keys = await getEncryptionKeys(password);
    if (!keys) {
      return false;
    }
    
    // Effacer les clés de la mémoire
    keys.localKey.fill(0);
    keys.conversationsKey.fill(0);
    
    // Supprimer toutes les données de verrouillage
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LOCK_DATA);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LOCK_DATA_V4);
    await resetBruteForceCounters();
    
    // Nettoyer les anciennes versions
    await cleanupLegacyData();
    
    __DEV__ && console.log('✅ Verrouillage désactivé');
    return true;
  } catch (e) {
    __DEV__ && console.error('disableLock error:', e);
    return false;
  }
}

/**
 * Met à jour les paramètres de verrouillage
 */
export async function updateLockSettings(
  useBiometrics: boolean,
  timeoutMinutes: number
): Promise<boolean> {
  try {
    // Essayer V5 d'abord
    const dataV5 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA);
    if (dataV5) {
      const lockData: StoredLockData = JSON.parse(dataV5);
      lockData.useBiometrics = useBiometrics;
      lockData.timeoutMinutes = timeoutMinutes;
      await SecureStore.setItemAsync(STORAGE_KEYS.LOCK_DATA, JSON.stringify(lockData));
      return true;
    }
    
    // Essayer V4
    const dataV4 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V4);
    if (dataV4) {
      const lockData: StoredLockDataV4 = JSON.parse(dataV4);
      lockData.useBiometrics = useBiometrics;
      lockData.timeoutMinutes = timeoutMinutes;
      await SecureStore.setItemAsync(STORAGE_KEYS.LOCK_DATA_V4, JSON.stringify(lockData));
      return true;
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Change le mot de passe
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
  onProgress?: (progress: number) => void
): Promise<boolean> {
  try {
    if (newPassword.length < 8) return false;
    
    // Récupérer les clés avec l'ancien mot de passe
    const keys = await getEncryptionKeys(currentPassword, (p) => onProgress?.(p * 0.3));
    if (!keys) return false;
    
    // Récupérer les données actuelles
    let lockData: StoredLockData | null = null;
    let masterKey: Uint8Array | null = null;
    
    const dataV6 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA);
    if (dataV6) {
      lockData = JSON.parse(dataV6);
    } else {
      const dataV5 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V5);
      if (dataV5) {
        lockData = JSON.parse(dataV5);
      } else {
        const dataV4 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V4);
        if (dataV4) {
          const v4Data: StoredLockDataV4 = JSON.parse(dataV4);
          // Convertir en structure V6
          lockData = {
            ...v4Data,
            version: 6,
          };
        }
      }
    }
    
    if (!lockData) return false;
    
    // Déchiffrer la clé maître actuelle
    const derivedKeyOld = await deriveKeyWithParams(currentPassword, lockData.kdfParams);
    masterKey = decryptWithKey(lockData.encryptedMasterKey, lockData.nonce, derivedKeyOld);
    derivedKeyOld.fill(0);
    
    if (!masterKey) {
      __DEV__ && console.error('Failed to decrypt master key');
      return false;
    }
    
    // Dériver une nouvelle clé du nouveau mot de passe (KDF v6)
    const { key: newDerivedKey, params: newKdfParams, algorithmInfo } = await deriveKey(
      newPassword,
      undefined,
      (p) => onProgress?.(0.3 + p * 0.6)
    );
    
    __DEV__ && console.log(`🔐 Changement MdP avec ${algorithmInfo.name} (${algorithmInfo.strength})`);
    
    // Re-chiffrer la clé maître avec la nouvelle clé dérivée
    const { encrypted: newEncryptedMasterKey, nonce: newNonce } = encryptWithKey(masterKey, newDerivedKey);
    
    // Stocker les nouvelles données (toujours en V6)
    const newLockData: StoredLockData = {
      version: 6,
      kdfParams: newKdfParams,
      encryptedMasterKey: newEncryptedMasterKey,
      nonce: newNonce,
      useBiometrics: lockData.useBiometrics,
      timeoutMinutes: lockData.timeoutMinutes,
      conversationsKeyNonce: lockData.conversationsKeyNonce,
    };
    
    await SecureStore.setItemAsync(STORAGE_KEYS.LOCK_DATA, JSON.stringify(newLockData));
    
    // Supprimer les anciennes versions si elles existaient
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LOCK_DATA_V5);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LOCK_DATA_V4);
    
    // Réinitialiser les compteurs
    await resetBruteForceCounters();
    
    onProgress?.(1);
    
    // Effacer les clés de la mémoire
    keys.localKey.fill(0);
    keys.conversationsKey.fill(0);
    newDerivedKey.fill(0);
    masterKey.fill(0);
    
    __DEV__ && console.log('✅ Mot de passe changé');
    return true;
  } catch (e) {
    __DEV__ && console.error('changePassword error:', e);
    return false;
  }
}

// ============================================
// RÉCUPÉRATION DES CLÉS
// ============================================

export interface EncryptionKeys {
  localKey: Uint8Array;         // Pour chiffrer les messages locaux (AsyncStorage)
  conversationsKey: Uint8Array; // Pour chiffrer les conversations (SecureStore)
}

export interface UnlockResult {
  keys: EncryptionKeys | null;
  securityInfo: SecurityInfo | null;
  migrated: boolean;
}

/**
 * Récupère les clés de chiffrement (vérifie le mot de passe)
 * Retourne null si le mot de passe est incorrect ou si locked out
 * 
 * Effectue automatiquement la migration si nécessaire
 */
export async function getEncryptionKeys(
  password: string,
  onProgress?: (progress: number) => void
): Promise<EncryptionKeys | null> {
  const result = await getEncryptionKeysWithInfo(password, onProgress);
  return result.keys;
}

/**
 * Version étendue qui retourne aussi les infos de sécurité
 */
export async function getEncryptionKeysWithInfo(
  password: string,
  onProgress?: (progress: number) => void
): Promise<UnlockResult> {
  try {
    // Vérifier le lockout
    const state = await getLockState();
    if (state.remainingLockoutSeconds > 0) {
      __DEV__ && console.log(`Lockout actif: ${state.remainingLockoutSeconds}s restantes`);
      return { keys: null, securityInfo: null, migrated: false };
    }
    
    // Récupérer les données de verrouillage (V6 d'abord)
    const dataV6 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA);
    
    if (dataV6) {
      const result = await unlockV6(password, dataV6, onProgress);
      if (result.keys) {
        // Vérifier si migration interne nécessaire (anciens params KDF dans V6)
        const lockData: StoredLockData = JSON.parse(dataV6);
        if (needsMigration(lockData.kdfParams)) {
          // Migration silencieuse en background
          __DEV__ && console.log('🔄 Migration silencieuse des paramètres KDF...');
          await migrateKdfParams(password, lockData, result.keys);
        }
      }
      return result;
    }
    
    // Essayer V5
    const dataV5 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V5);
    if (dataV5) {
      return await unlockV5AndMigrate(password, dataV5, onProgress);
    }
    
    // Essayer V4
    const dataV4 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA_V4);
    if (dataV4) {
      return await unlockV4AndMigrate(password, dataV4, onProgress);
    }
    
    // Essayer V3
    const dataV3 = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_V3_DATA);
    if (dataV3) {
      return await unlockV3AndMigrate(password, dataV3, onProgress);
    }
    
    // Essayer legacy
    return await unlockLegacyAndMigrate(password);
  } catch (e) {
    __DEV__ && console.error('getEncryptionKeys error:', e);
    await handleFailedAttempt();
    return { keys: null, securityInfo: null, migrated: false };
  }
}

/**
 * Compatibilité: ancienne API qui retourne une seule clé
 * @deprecated Utiliser getEncryptionKeys à la place
 */
export async function getEncryptionKey(
  password: string,
  onProgress?: (progress: number) => void
): Promise<Uint8Array | null> {
  const keys = await getEncryptionKeys(password, onProgress);
  return keys?.localKey || null;
}

// ============================================
// DÉVERROUILLAGE PAR VERSION
// ============================================

async function unlockV6(
  password: string,
  dataJson: string,
  onProgress?: (progress: number) => void
): Promise<UnlockResult> {
  const lockData: StoredLockData = JSON.parse(dataJson);
  
  // Dériver la clé du mot de passe
  const derivedKey = await deriveKeyWithParams(password, lockData.kdfParams, onProgress);
  
  // Déchiffrer la clé maître
  const masterKey = decryptWithKey(lockData.encryptedMasterKey, lockData.nonce, derivedKey);
  
  if (!masterKey) {
    await handleFailedAttempt();
    return { keys: null, securityInfo: null, migrated: false };
  }
  
  // Succès ! Réinitialiser les compteurs
  await resetBruteForceCounters();
  
  // Dériver les sous-clés
  const localKey = await deriveSubKey(masterKey, KEY_CONTEXTS.LOCAL_ENCRYPTION);
  const conversationsKey = await deriveSubKey(masterKey, KEY_CONTEXTS.CONVERSATIONS);
  
  // Infos de sécurité
  const info = getAlgorithmInfo(lockData.kdfParams);
  const securityInfo: SecurityInfo = {
    algorithmName: info.name,
    strength: info.strength,
    needsUpgrade: needsMigration(lockData.kdfParams),
    iterations: info.iterations,
    memoryMB: info.memoryMB,
  };
  
  // Effacer la clé dérivée et master de la mémoire
  derivedKey.fill(0);
  masterKey.fill(0);
  
  return { 
    keys: { localKey, conversationsKey }, 
    securityInfo,
    migrated: false,
  };
}

async function unlockV4AndMigrate(
  password: string,
  dataJson: string,
  onProgress?: (progress: number) => void
): Promise<UnlockResult> {
  const lockData: StoredLockDataV4 = JSON.parse(dataJson);
  
  // Dériver la clé du mot de passe (anciens params)
  const derivedKey = await deriveKeyWithParams(password, lockData.kdfParams, (p) => onProgress?.(p * 0.5));
  
  // Déchiffrer la clé maître
  const masterKey = decryptWithKey(lockData.encryptedMasterKey, lockData.nonce, derivedKey);
  
  if (!masterKey) {
    await handleFailedAttempt();
    return { keys: null, securityInfo: null, migrated: false };
  }
  
  __DEV__ && console.log('✅ V4 déverrouillé - migration vers v6 avec nouveau KDF');
  
  // Migrer vers V6 avec les nouveaux paramètres KDF
  const { key: newDerivedKey, params: newKdfParams, algorithmInfo } = await deriveKey(
    password,
    undefined,
    (p) => onProgress?.(0.5 + p * 0.4)
  );
  
  __DEV__ && console.log(`🔐 Migration vers ${algorithmInfo.name} (${algorithmInfo.strength})`);
  
  // Re-chiffrer la clé maître
  const { encrypted: newEncryptedMasterKey, nonce: newNonce } = encryptWithKey(masterKey, newDerivedKey);
  
  // Créer les données V6
  const newLockData: StoredLockData = {
    version: 6,
    kdfParams: newKdfParams,
    encryptedMasterKey: newEncryptedMasterKey,
    nonce: newNonce,
    useBiometrics: lockData.useBiometrics,
    timeoutMinutes: lockData.timeoutMinutes,
    conversationsKeyNonce: lockData.conversationsKeyNonce,
  };
  
  await SecureStore.setItemAsync(STORAGE_KEYS.LOCK_DATA, JSON.stringify(newLockData));
  
  // Supprimer V4
  await SecureStore.deleteItemAsync(STORAGE_KEYS.LOCK_DATA_V4);
  
  // Réinitialiser les compteurs
  await resetBruteForceCounters();
  
  onProgress?.(1);
  
  // Dériver les sous-clés
  const localKey = await deriveSubKey(masterKey, KEY_CONTEXTS.LOCAL_ENCRYPTION);
  const conversationsKey = await deriveSubKey(masterKey, KEY_CONTEXTS.CONVERSATIONS);
  
  // Infos de sécurité
  const securityInfo: SecurityInfo = {
    algorithmName: algorithmInfo.name,
    strength: algorithmInfo.strength,
    needsUpgrade: false,
    iterations: algorithmInfo.iterations,
    memoryMB: algorithmInfo.memoryMB,
  };
  
  // Effacer les clés de la mémoire
  derivedKey.fill(0);
  newDerivedKey.fill(0);
  masterKey.fill(0);
  
  __DEV__ && console.log('✅ Migration V4 → V6 terminée');
  
  return { 
    keys: { localKey, conversationsKey }, 
    securityInfo,
    migrated: true,
  };
}

async function unlockV3AndMigrate(
  password: string,
  dataJson: string,
  onProgress?: (progress: number) => void
): Promise<UnlockResult> {
  const lockData = JSON.parse(dataJson);
  
  // Dériver la clé du mot de passe
  const derivedKey = await deriveKeyWithParams(password, lockData.kdfParams, (p) => onProgress?.(p * 0.3));
  
  // Déchiffrer la clé maître
  const masterKey = decryptWithKey(lockData.encryptedKey, lockData.nonce, derivedKey);
  
  if (!masterKey) {
    await handleFailedAttempt();
    return { keys: null, securityInfo: null, migrated: false };
  }
  
  __DEV__ && console.log('✅ V3 déverrouillé - migration vers v6');
  
  // Migrer vers V6
  const { key: newDerivedKey, params: newKdfParams, algorithmInfo } = await deriveKey(
    password,
    undefined,
    (p) => onProgress?.(0.3 + p * 0.6)
  );
  
  // Re-chiffrer la clé maître
  const { encrypted: newEncryptedMasterKey, nonce: newNonce } = encryptWithKey(masterKey, newDerivedKey);
  
  // Créer les données V6
  const newLockData: StoredLockData = {
    version: 6,
    kdfParams: newKdfParams,
    encryptedMasterKey: newEncryptedMasterKey,
    nonce: newNonce,
    useBiometrics: lockData.useBiometrics || false,
    timeoutMinutes: lockData.timeoutMinutes || 1,
    conversationsKeyNonce: encodeBase64(nacl.randomBytes(32)),
  };
  
  await SecureStore.setItemAsync(STORAGE_KEYS.LOCK_DATA, JSON.stringify(newLockData));
  
  // Nettoyer V3
  await SecureStore.deleteItemAsync(STORAGE_KEYS.LEGACY_V3_DATA);
  
  // Réinitialiser les compteurs
  await resetBruteForceCounters();
  
  onProgress?.(1);
  
  // Dériver les sous-clés
  const localKey = await deriveSubKey(masterKey, KEY_CONTEXTS.LOCAL_ENCRYPTION);
  const conversationsKey = await deriveSubKey(masterKey, KEY_CONTEXTS.CONVERSATIONS);
  
  const securityInfo: SecurityInfo = {
    algorithmName: algorithmInfo.name,
    strength: algorithmInfo.strength,
    needsUpgrade: false,
    iterations: algorithmInfo.iterations,
    memoryMB: algorithmInfo.memoryMB,
  };
  
  derivedKey.fill(0);
  newDerivedKey.fill(0);
  masterKey.fill(0);
  
  __DEV__ && console.log('✅ Migration V3 → V6 terminée');
  
  return { 
    keys: { localKey, conversationsKey }, 
    securityInfo,
    migrated: true,
  };
}

async function unlockLegacyAndMigrate(password: string): Promise<UnlockResult> {
  const legacyEnabled = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_ENABLED);
  if (legacyEnabled !== 'true') {
    return { keys: null, securityInfo: null, migrated: false };
  }
  
  const legacyHash = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_HASH);
  const legacySalt = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_SALT);
  
  if (!legacyHash || !legacySalt) {
    return { keys: null, securityInfo: null, migrated: false };
  }
  
  // Vérifier avec l'ancien algorithme
  const salt = decodeBase64(legacySalt);
  const derivedKey = await deriveKeyLegacyV2(password, salt);
  const derivedHash = encodeBase64(derivedKey);
  
  if (derivedHash !== legacyHash) {
    await handleFailedAttempt();
    return { keys: null, securityInfo: null, migrated: false };
  }
  
  __DEV__ && console.log('✅ Legacy déverrouillé - migration vers v6');
  
  // Récupérer les paramètres legacy
  const biometrics = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_BIOMETRICS);
  const timeout = await SecureStore.getItemAsync(STORAGE_KEYS.LEGACY_TIMEOUT);
  
  // Migrer vers V6
  await setupLock(
    password,
    biometrics === 'true',
    timeout ? parseInt(timeout, 10) : 1
  );
  
  // Nettoyer les données legacy
  await cleanupLegacyData();
  
  // Réessayer avec V6
  const dataV6 = await SecureStore.getItemAsync(STORAGE_KEYS.LOCK_DATA);
  if (dataV6) {
    const result = await unlockV6(password, dataV6);
    return { ...result, migrated: true };
  }
  
  return { keys: null, securityInfo: null, migrated: false };
}

/**
 * Migration V5 → V6 (pour les anciennes installations)
 */
async function unlockV5AndMigrate(
  password: string,
  dataJson: string,
  onProgress?: (progress: number) => void
): Promise<UnlockResult> {
  const lockData = JSON.parse(dataJson);
  
  // Dériver la clé du mot de passe (anciens params)
  const derivedKey = await deriveKeyWithParams(password, lockData.kdfParams, (p) => onProgress?.(p * 0.5));
  
  // Déchiffrer la clé maître
  const masterKey = decryptWithKey(lockData.encryptedMasterKey, lockData.nonce, derivedKey);
  
  if (!masterKey) {
    await handleFailedAttempt();
    return { keys: null, securityInfo: null, migrated: false };
  }
  
  __DEV__ && console.log('✅ V5 déverrouillé - migration vers v6');
  
  // Migrer vers V6 avec les nouveaux paramètres KDF
  const { key: newDerivedKey, params: newKdfParams, algorithmInfo } = await deriveKey(
    password,
    undefined,
    (p) => onProgress?.(0.5 + p * 0.4)
  );
  
  __DEV__ && console.log(`🔐 Migration vers ${algorithmInfo.name} (${algorithmInfo.strength})`);
  
  // Re-chiffrer la clé maître
  const { encrypted: newEncryptedMasterKey, nonce: newNonce } = encryptWithKey(masterKey, newDerivedKey);
  
  // Créer les données V6
  const newLockData: StoredLockData = {
    version: 6,
    kdfParams: newKdfParams,
    encryptedMasterKey: newEncryptedMasterKey,
    nonce: newNonce,
    useBiometrics: lockData.useBiometrics,
    timeoutMinutes: lockData.timeoutMinutes,
    conversationsKeyNonce: lockData.conversationsKeyNonce,
  };
  
  await SecureStore.setItemAsync(STORAGE_KEYS.LOCK_DATA, JSON.stringify(newLockData));
  
  // Supprimer V5
  await SecureStore.deleteItemAsync(STORAGE_KEYS.LOCK_DATA_V5);
  
  // Réinitialiser les compteurs
  await resetBruteForceCounters();
  
  onProgress?.(1);
  
  // Dériver les sous-clés
  const localKey = await deriveSubKey(masterKey, KEY_CONTEXTS.LOCAL_ENCRYPTION);
  const conversationsKey = await deriveSubKey(masterKey, KEY_CONTEXTS.CONVERSATIONS);
  
  // Infos de sécurité
  const securityInfo: SecurityInfo = {
    algorithmName: algorithmInfo.name,
    strength: algorithmInfo.strength,
    needsUpgrade: false,
    iterations: algorithmInfo.iterations,
    memoryMB: algorithmInfo.memoryMB,
  };
  
  // Effacer les clés de la mémoire
  derivedKey.fill(0);
  newDerivedKey.fill(0);
  masterKey.fill(0);
  
  __DEV__ && console.log('✅ Migration V5 → V6 terminée');
  
  return { 
    keys: { localKey, conversationsKey }, 
    securityInfo,
    migrated: true,
  };
}

// ============================================
// MIGRATION SILENCIEUSE DES PARAMS KDF
// ============================================

/**
 * Migre les paramètres KDF vers la dernière version
 * Appelé silencieusement après un déverrouillage réussi
 */
async function migrateKdfParams(
  password: string,
  currentLockData: StoredLockData,
  currentKeys: EncryptionKeys
): Promise<void> {
  try {
    // Déchiffrer la clé maître avec les anciens params
    const oldDerivedKey = await deriveKeyWithParams(password, currentLockData.kdfParams);
    const masterKey = decryptWithKey(currentLockData.encryptedMasterKey, currentLockData.nonce, oldDerivedKey);
    
    if (!masterKey) {
      __DEV__ && console.error('Migration KDF: impossible de déchiffrer la clé maître');
      return;
    }
    
    // Dériver une nouvelle clé avec les nouveaux params
    const { key: newDerivedKey, params: newKdfParams, algorithmInfo } = await deriveKey(password);
    
    __DEV__ && console.log(`🔄 Migration KDF silencieuse vers ${algorithmInfo.name}`);
    
    // Re-chiffrer la clé maître
    const { encrypted: newEncryptedMasterKey, nonce: newNonce } = encryptWithKey(masterKey, newDerivedKey);
    
    // Mettre à jour les données
    const newLockData: StoredLockData = {
      ...currentLockData,
      kdfParams: newKdfParams,
      encryptedMasterKey: newEncryptedMasterKey,
      nonce: newNonce,
    };
    
    await SecureStore.setItemAsync(STORAGE_KEYS.LOCK_DATA, JSON.stringify(newLockData));
    
    // Cleanup
    oldDerivedKey.fill(0);
    newDerivedKey.fill(0);
    masterKey.fill(0);
    
    __DEV__ && console.log('✅ Migration KDF silencieuse terminée');
  } catch (e) {
    // Ne pas faire échouer le déverrouillage si la migration échoue
    __DEV__ && console.error('Migration KDF silencieuse échouée (non bloquant):', e);
  }
}

// ============================================
// GESTION DES ÉCHECS
// ============================================

async function handleFailedAttempt(): Promise<void> {
  try {
    const attemptsStr = await SecureStore.getItemAsync(STORAGE_KEYS.FAILED_ATTEMPTS);
    const attempts = (attemptsStr ? parseInt(attemptsStr, 10) : 0) + 1;
    
    await SecureStore.setItemAsync(STORAGE_KEYS.FAILED_ATTEMPTS, attempts.toString());
    
    // Logger la tentative échouée
    await securityLogger.logPinAttempt(false, attempts);
    
    const lockoutSeconds = getLockoutForAttempts(attempts);
    
    if (lockoutSeconds === -1) {
      __DEV__ && console.warn('⚠️ Trop de tentatives - vérification auto-wipe');
      // Logger la tentative de brute-force
      await securityLogger.log('BRUTE_FORCE_ATTEMPT', {
        source: 'appLock',
        count: attempts,
      });
      
      // ACTION 4: Auto-wipe si activé par l'utilisateur
      const autoWipeEnabled = await SecureStore.getItemAsync(STORAGE_KEYS.AUTO_WIPE_ENABLED);
      if (autoWipeEnabled === 'true') {
        __DEV__ && console.warn('☢️ AUTO-WIPE TRIGGERED — erasing all data');
        await securityLogger.log('AUTO_WIPE_TRIGGERED', {
          source: 'appLock',
          attempts,
        });
        await performSecurityWipe();
      }
    } else if (lockoutSeconds > 0) {
      const lockoutUntil = Date.now() + (lockoutSeconds * 1000);
      await SecureStore.setItemAsync(STORAGE_KEYS.LOCKOUT_UNTIL, lockoutUntil.toString());
      __DEV__ && console.log(`Lockout: ${lockoutSeconds}s (${attempts} tentatives)`);
    }
  } catch (e) {
    __DEV__ && console.error('handleFailedAttempt error:', e);
  }
}

// ============================================
// NETTOYAGE
// ============================================

async function cleanupLegacyData(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LEGACY_V3_DATA);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LEGACY_ENABLED);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LEGACY_HASH);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LEGACY_SALT);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LEGACY_BIOMETRICS);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.LEGACY_TIMEOUT);
  } catch {
    // Ignorer les erreurs
  }
}