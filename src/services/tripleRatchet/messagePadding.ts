// src/services/tripleRatchet/messagePadding.ts
// Message Padding pour protection de l'anonymat
// Version 2.0 - Support des fichiers volumineux (images, vidéos)
//
// IMPORTANCE DU PADDING:
// =====================
// Sans padding, un observateur peut déduire le type de contenu
// en analysant la taille des messages chiffrés:
// - Petits messages (~100 bytes) = texte court, accusé de réception
// - Moyens messages (~1-5 KB) = texte normal, commandes
// - Grands messages (>10 KB) = fichiers, images
//
// Le padding normalise les tailles pour empêcher cette analyse.
//
// FORMATS DE PADDING:
// ==================
// Format v1 (messages < 64KB):
//   [0x01][length: 2 bytes LE][message][random padding]
//   - Préfixe 0x01 indique format v1
//   - Longueur sur 2 bytes, max 65533 bytes
//
// Format v2 (messages >= 64KB, jusqu'à ~4GB):
//   [0x02][length: 4 bytes LE][message][minimal padding]
//   - Préfixe 0x02 indique format v2
//   - Longueur sur 4 bytes, max ~4GB
//   - Padding minimal (arrondi à 64KB) pour les gros fichiers
//
// STRATÉGIES DE PADDING:
// 1. Messages < 64KB: Buckets classiques (256B, 1KB, 4KB, 16KB, 64KB)
// 2. Messages >= 64KB: Arrondi au multiple de 64KB supérieur

import { getSecureRandomBytes, zeroize } from './primitives';
import { secureRandomInt } from '../crypto';

// ============================================
// CONFIGURATION
// ============================================

export const PADDING_CONFIG = {
  // Tailles des buckets en bytes (pour messages < 64KB)
  BUCKET_SIZES: {
    tiny: 256,        // Très petits messages (ACK, signaux)
    small: 1024,      // Petits messages texte
    medium: 4096,     // Messages texte normaux
    large: 16384,     // Messages moyens
    xlarge: 65536,    // Seuil pour format v2
  },
  
  // Format v1: 2 bytes pour la longueur
  FORMAT_V1_PREFIX: 0x01,
  FORMAT_V1_LENGTH_SIZE: 2,
  FORMAT_V1_MAX_SIZE: 65533, // 2^16 - 3
  
  // Format v2: 4 bytes pour la longueur (gros fichiers)
  FORMAT_V2_PREFIX: 0x02,
  FORMAT_V2_LENGTH_SIZE: 4,
  FORMAT_V2_MAX_SIZE: 100 * 1024 * 1024, // 100MB max raisonnable
  FORMAT_V2_BUCKET_SIZE: 65536, // Arrondir au multiple de 64KB
  
  // Variation aléatoire dans chaque bucket (%)
  RANDOM_VARIATION_PERCENT: 10,
} as const;

export type PaddingSize = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge' | 'auto';

// ============================================
// FONCTIONS PRINCIPALES
// ============================================

/**
 * Applique le padding à un message
 * Sélectionne automatiquement le format v1 ou v2 selon la taille
 * 
 * Format v1: [0x01][length: 2 bytes][message][random padding]
 * Format v2: [0x02][length: 4 bytes][message][minimal padding]
 * 
 * @param message - Message original
 * @param targetSize - Taille cible ou 'auto' pour sélection automatique
 * @returns Message paddé
 */
export function padMessage(message: Uint8Array, targetSize: PaddingSize = 'auto'): Uint8Array {
  const originalLength = message.length;
  
  // Vérifier la taille maximum absolue
  if (originalLength > PADDING_CONFIG.FORMAT_V2_MAX_SIZE) {
    throw new Error(`Message too large: ${originalLength} > ${PADDING_CONFIG.FORMAT_V2_MAX_SIZE}`);
  }
  
  // Choisir le format selon la taille
  if (originalLength <= PADDING_CONFIG.FORMAT_V1_MAX_SIZE) {
    return padMessageV1(message, targetSize);
  } else {
    return padMessageV2(message);
  }
}

/**
 * Padding format v1 (messages < 64KB)
 * Format: [0x01][length: 2 bytes LE][message][random padding]
 */
function padMessageV1(message: Uint8Array, targetSize: PaddingSize): Uint8Array {
  const originalLength = message.length;
  
  // Calculer la taille cible (incluant le préfixe de version)
  const totalNeeded = 1 + PADDING_CONFIG.FORMAT_V1_LENGTH_SIZE + originalLength;
  const target = calculateTargetSizeV1(totalNeeded, targetSize);
  
  // Allouer le buffer paddé
  const padded = new Uint8Array(target);
  
  // Écrire le préfixe de version
  padded[0] = PADDING_CONFIG.FORMAT_V1_PREFIX;
  
  // Écrire la longueur originale (little-endian, 2 bytes)
  padded[1] = originalLength & 0xFF;
  padded[2] = (originalLength >> 8) & 0xFF;
  
  // Copier le message original
  const messageOffset = 1 + PADDING_CONFIG.FORMAT_V1_LENGTH_SIZE;
  padded.set(message, messageOffset);
  
  // Remplir le reste avec des bytes aléatoires
  const paddingStart = messageOffset + originalLength;
  const paddingLength = target - paddingStart;
  
  if (paddingLength > 0) {
    const randomPadding = getSecureRandomBytes(paddingLength);
    padded.set(randomPadding, paddingStart);
  }
  
  return padded;
}

/**
 * Padding format v2 (messages >= 64KB)
 * Format: [0x02][length: 4 bytes LE][message][minimal padding to 64KB boundary]
 */
function padMessageV2(message: Uint8Array): Uint8Array {
  const originalLength = message.length;
  
  // Calculer la taille cible (arrondi au multiple de 64KB supérieur)
  const totalNeeded = 1 + PADDING_CONFIG.FORMAT_V2_LENGTH_SIZE + originalLength;
  const bucketSize = PADDING_CONFIG.FORMAT_V2_BUCKET_SIZE;
  const target = Math.ceil(totalNeeded / bucketSize) * bucketSize;
  
  // Allouer le buffer paddé
  const padded = new Uint8Array(target);
  
  // Écrire le préfixe de version
  padded[0] = PADDING_CONFIG.FORMAT_V2_PREFIX;
  
  // Écrire la longueur originale (little-endian, 4 bytes)
  padded[1] = originalLength & 0xFF;
  padded[2] = (originalLength >> 8) & 0xFF;
  padded[3] = (originalLength >> 16) & 0xFF;
  padded[4] = (originalLength >> 24) & 0xFF;
  
  // Copier le message original
  const messageOffset = 1 + PADDING_CONFIG.FORMAT_V2_LENGTH_SIZE;
  padded.set(message, messageOffset);
  
  // Remplir le reste avec des bytes aléatoires
  const paddingStart = messageOffset + originalLength;
  const paddingLength = target - paddingStart;
  
  if (paddingLength > 0) {
    const randomPadding = getSecureRandomBytes(paddingLength);
    padded.set(randomPadding, paddingStart);
  }
  
  __DEV__ && console.log(`[Padding] v2 format: ${originalLength} bytes → ${target} bytes (${Math.ceil(target / 1024)}KB)`);
  
  return padded;
}

/**
 * Retire le padding d'un message (détecte automatiquement le format)
 * 
 * @param paddedMessage - Message paddé
 * @returns Message original
 */
export function unpadMessage(paddedMessage: Uint8Array): Uint8Array {
  // Vérifier la taille minimum
  if (paddedMessage.length < 3) {
    throw new Error('Padded message too short');
  }
  
  // Détecter le format
  const formatPrefix = paddedMessage[0];
  
  if (formatPrefix === PADDING_CONFIG.FORMAT_V1_PREFIX) {
    return unpadMessageV1(paddedMessage);
  } else if (formatPrefix === PADDING_CONFIG.FORMAT_V2_PREFIX) {
    return unpadMessageV2(paddedMessage);
  } else {
    // Compatibilité: ancien format sans préfixe (v0)
    return unpadMessageLegacy(paddedMessage);
  }
}

/**
 * Unpadding format v1
 */
function unpadMessageV1(paddedMessage: Uint8Array): Uint8Array {
  if (paddedMessage.length < 1 + PADDING_CONFIG.FORMAT_V1_LENGTH_SIZE + 1) {
    throw new Error('Padded message v1 too short');
  }
  
  // Lire la longueur originale (little-endian, 2 bytes)
  const originalLength = paddedMessage[1] | (paddedMessage[2] << 8);
  
  // Vérifier la cohérence
  const messageOffset = 1 + PADDING_CONFIG.FORMAT_V1_LENGTH_SIZE;
  if (originalLength > paddedMessage.length - messageOffset) {
    throw new Error('Invalid padding v1: declared length exceeds available data');
  }
  
  // Extraire le message original
  return paddedMessage.slice(messageOffset, messageOffset + originalLength);
}

/**
 * Unpadding format v2
 */
function unpadMessageV2(paddedMessage: Uint8Array): Uint8Array {
  if (paddedMessage.length < 1 + PADDING_CONFIG.FORMAT_V2_LENGTH_SIZE + 1) {
    throw new Error('Padded message v2 too short');
  }
  
  // Lire la longueur originale (little-endian, 4 bytes)
  const originalLength = 
    paddedMessage[1] |
    (paddedMessage[2] << 8) |
    (paddedMessage[3] << 16) |
    (paddedMessage[4] << 24);
  
  // Vérifier la cohérence
  const messageOffset = 1 + PADDING_CONFIG.FORMAT_V2_LENGTH_SIZE;
  if (originalLength > paddedMessage.length - messageOffset) {
    throw new Error('Invalid padding v2: declared length exceeds available data');
  }
  
  if (originalLength > PADDING_CONFIG.FORMAT_V2_MAX_SIZE) {
    throw new Error('Invalid padding v2: declared length exceeds maximum');
  }
  
  // Extraire le message original
  return paddedMessage.slice(messageOffset, messageOffset + originalLength);
}

/**
 * Unpadding format legacy (ancien format sans préfixe de version)
 * Pour compatibilité avec les messages existants
 */
function unpadMessageLegacy(paddedMessage: Uint8Array): Uint8Array {
  if (paddedMessage.length < 3) {
    throw new Error('Padded message legacy too short');
  }
  
  // Ancien format: [length: 2 bytes][message][padding]
  const originalLength = paddedMessage[0] | (paddedMessage[1] << 8);
  
  // Vérifier la cohérence
  if (originalLength > paddedMessage.length - 2) {
    throw new Error('Invalid legacy padding: declared length exceeds available data');
  }
  
  // Extraire le message original
  return paddedMessage.slice(2, 2 + originalLength);
}

/**
 * Calcule la taille cible pour le format v1
 */
function calculateTargetSizeV1(totalNeeded: number, strategy: PaddingSize): number {
  if (strategy === 'auto') {
    return selectBucketV1(totalNeeded);
  }
  
  const bucketSize = PADDING_CONFIG.BUCKET_SIZES[strategy];
  
  if (totalNeeded > bucketSize) {
    return selectBucketV1(totalNeeded);
  }
  
  return addRandomVariation(bucketSize);
}

/**
 * Sélectionne le bucket approprié pour le format v1
 */
function selectBucketV1(size: number): number {
  const buckets = Object.values(PADDING_CONFIG.BUCKET_SIZES).sort((a, b) => a - b);
  
  for (const bucket of buckets) {
    if (size <= bucket) {
      return addRandomVariation(bucket);
    }
  }
  
  // Si aucun bucket ne convient, utiliser le plus grand
  return PADDING_CONFIG.BUCKET_SIZES.xlarge;
}

/**
 * Ajoute une variation aléatoire à la taille du bucket
 */
function addRandomVariation(baseSize: number): number {
  const variationPercent = PADDING_CONFIG.RANDOM_VARIATION_PERCENT;
  const maxVariation = Math.floor(baseSize * variationPercent / 100);
  
  if (maxVariation === 0) {
    return baseSize;
  }
  
  const variation = secureRandomInt(maxVariation);
  
  return baseSize + variation;
}

// ============================================
// PADDING CONSTANT TIME (POUR HAUTE SÉCURITÉ)
// ============================================

/**
 * Version constant-time du padding pour éviter les timing attacks
 * Utilise le format v1 uniquement (pour messages < 64KB)
 */
export function padMessageConstantTime(
  message: Uint8Array,
  fixedSize: number
): Uint8Array {
  const originalLength = message.length;
  const headerSize = 1 + PADDING_CONFIG.FORMAT_V1_LENGTH_SIZE;
  
  if (originalLength > fixedSize - headerSize) {
    throw new Error('Message too large for fixed size padding');
  }
  
  const padded = new Uint8Array(fixedSize);
  
  // Version prefix
  padded[0] = PADDING_CONFIG.FORMAT_V1_PREFIX;
  
  // Longueur (constant time)
  padded[1] = originalLength & 0xFF;
  padded[2] = (originalLength >> 8) & 0xFF;
  
  // Copier le message (constant time via loop complet)
  const dataArea = fixedSize - headerSize;
  for (let i = 0; i < dataArea; i++) {
    const inBounds = i < originalLength ? 1 : 0;
    const messageByte = i < originalLength ? message[i] : 0;
    const randomByte = getSecureRandomBytes(1)[0];
    
    padded[headerSize + i] = 
      (messageByte & (-inBounds)) | (randomByte & (~(-inBounds) & 0xFF));
  }
  
  return padded;
}

/**
 * Version constant-time de l'unpadding
 */
export function unpadMessageConstantTime(
  paddedMessage: Uint8Array,
  expectedMaxSize: number
): Uint8Array {
  const headerSize = 1 + PADDING_CONFIG.FORMAT_V1_LENGTH_SIZE;
  
  if (paddedMessage.length < headerSize) {
    throw new Error('Padded message too short');
  }
  
  // Vérifier le format (doit être v1 pour constant time)
  if (paddedMessage[0] !== PADDING_CONFIG.FORMAT_V1_PREFIX) {
    throw new Error('Constant time unpad only supports v1 format');
  }
  
  const declaredLength = paddedMessage[1] | (paddedMessage[2] << 8);
  const maxPossible = paddedMessage.length - headerSize;
  
  let valid = 1;
  valid &= (declaredLength <= maxPossible) ? 1 : 0;
  valid &= (declaredLength <= expectedMaxSize) ? 1 : 0;
  
  if (!valid) {
    throw new Error('Invalid padding');
  }
  
  const result = new Uint8Array(declaredLength);
  for (let i = 0; i < declaredLength; i++) {
    result[i] = paddedMessage[headerSize + i];
  }
  
  return result;
}

// ============================================
// UTILITAIRES
// ============================================

/**
 * Estime la taille paddée d'un message
 */
export function estimatePaddedSize(messageLength: number, strategy: PaddingSize = 'auto'): number {
  if (messageLength > PADDING_CONFIG.FORMAT_V1_MAX_SIZE) {
    // Format v2
    const totalNeeded = 1 + PADDING_CONFIG.FORMAT_V2_LENGTH_SIZE + messageLength;
    const bucketSize = PADDING_CONFIG.FORMAT_V2_BUCKET_SIZE;
    return Math.ceil(totalNeeded / bucketSize) * bucketSize;
  } else {
    // Format v1
    const totalNeeded = 1 + PADDING_CONFIG.FORMAT_V1_LENGTH_SIZE + messageLength;
    return calculateTargetSizeV1(totalNeeded, strategy);
  }
}

/**
 * Vérifie si un message paddé est valide
 */
export function isValidPaddedMessage(paddedMessage: Uint8Array): boolean {
  if (paddedMessage.length < 3) {
    return false;
  }
  
  const formatPrefix = paddedMessage[0];
  
  if (formatPrefix === PADDING_CONFIG.FORMAT_V1_PREFIX) {
    const declaredLength = paddedMessage[1] | (paddedMessage[2] << 8);
    const headerSize = 1 + PADDING_CONFIG.FORMAT_V1_LENGTH_SIZE;
    return declaredLength <= paddedMessage.length - headerSize;
  } else if (formatPrefix === PADDING_CONFIG.FORMAT_V2_PREFIX) {
    if (paddedMessage.length < 6) return false;
    const declaredLength = 
      paddedMessage[1] |
      (paddedMessage[2] << 8) |
      (paddedMessage[3] << 16) |
      (paddedMessage[4] << 24);
    const headerSize = 1 + PADDING_CONFIG.FORMAT_V2_LENGTH_SIZE;
    return declaredLength <= paddedMessage.length - headerSize &&
           declaredLength <= PADDING_CONFIG.FORMAT_V2_MAX_SIZE;
  } else {
    // Legacy format
    const declaredLength = paddedMessage[0] | (paddedMessage[1] << 8);
    return declaredLength <= paddedMessage.length - 2;
  }
}

/**
 * Retourne les statistiques de padding pour analyse/debug
 */
export function getPaddingStats(paddedMessage: Uint8Array): {
  totalSize: number;
  originalSize: number;
  paddingSize: number;
  overhead: number;
  overheadPercent: number;
  format: 'v1' | 'v2' | 'legacy';
} {
  const totalSize = paddedMessage.length;
  let originalSize: number;
  let headerSize: number;
  let format: 'v1' | 'v2' | 'legacy';
  
  const formatPrefix = paddedMessage[0];
  
  if (formatPrefix === PADDING_CONFIG.FORMAT_V1_PREFIX) {
    originalSize = paddedMessage[1] | (paddedMessage[2] << 8);
    headerSize = 1 + PADDING_CONFIG.FORMAT_V1_LENGTH_SIZE;
    format = 'v1';
  } else if (formatPrefix === PADDING_CONFIG.FORMAT_V2_PREFIX) {
    originalSize = 
      paddedMessage[1] |
      (paddedMessage[2] << 8) |
      (paddedMessage[3] << 16) |
      (paddedMessage[4] << 24);
    headerSize = 1 + PADDING_CONFIG.FORMAT_V2_LENGTH_SIZE;
    format = 'v2';
  } else {
    originalSize = paddedMessage[0] | (paddedMessage[1] << 8);
    headerSize = 2;
    format = 'legacy';
  }
  
  const paddingSize = totalSize - headerSize - originalSize;
  const overhead = totalSize - originalSize;
  const overheadPercent = originalSize > 0 ? (overhead / originalSize) * 100 : 0;
  
  return {
    totalSize,
    originalSize,
    paddingSize,
    overhead,
    overheadPercent,
    format,
  };
}

// ============================================
// PADDING POUR TYPES SPÉCIFIQUES
// ============================================

/**
 * Padding optimisé pour les messages texte
 */
export function padTextMessage(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  return padMessage(encoded, 'auto');
}

/**
 * Unpadding et décodage pour les messages texte
 */
export function unpadTextMessage(paddedMessage: Uint8Array): string {
  const unpadded = unpadMessage(paddedMessage);
  return new TextDecoder().decode(unpadded);
}

/**
 * Padding pour les fichiers/médias
 * Utilise automatiquement le format v2 si nécessaire
 */
export function padMediaMessage(data: Uint8Array): Uint8Array {
  // padMessage détecte automatiquement si v2 est nécessaire
  return padMessage(data, 'xlarge');
}

/**
 * Padding minimal pour les signaux de contrôle (ACK, typing, etc.)
 */
export function padControlMessage(data: Uint8Array): Uint8Array {
  return padMessage(data, 'tiny');
}

// ============================================
// EXPORTS
// ============================================

// PaddingSize type is already exported above