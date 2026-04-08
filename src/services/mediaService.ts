// src/services/mediaService.ts
// Service de gestion des médias chiffrés E2E
// Version 1.1 - Correction du storagePath pour les images/fichiers

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { supabase, supabaseStorage } from './api';
import { getRandomBytes, encryptE2E, decryptE2E } from './crypto';
// P0-A2: legacyMediaProxy supprimé — tous les downloads via OHTTP relay
import { fetchMediaViaRelay } from './encryptedBlobService';

// ============================================
// CONFIGURATION
// ============================================

const MAX_IMAGE_DIMENSION = 2048;  // Max pixels (côté le plus long)
const THUMBNAIL_SIZE = 300;        // Taille miniature
const JPEG_QUALITY_FULL = 0.8;     // Qualité image principale
const JPEG_QUALITY_THUMB = 0.6;    // Qualité miniature
const STORAGE_BUCKET = 'ghostr-blobs';

// Limite de taille (doit correspondre à la config Supabase)
const MAX_FILE_SIZE_MB = 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// ============================================
// FONCTION UTILITAIRE POUR URLS PUBLIQUES
// ============================================

/**
 * Génère l'URL publique d'un fichier média dans le storage
 * @param storagePath - Le chemin de base (tag)
 * @param fileId - L'ID du fichier
 * @param suffix - Suffixe optionnel ('_thumb' pour miniature)
 */
export function getMediaPublicUrl(storagePath: string, fileId: string, suffix: string = ''): string {
  const fullPath = `${storagePath}/${fileId}${suffix}.enc`;
  const { data } = supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(fullPath);
  return data.publicUrl;
}

// ============================================
// TYPES
// ============================================

export interface ImageMetadata {
  width: number;
  height: number;
  size: number;
  mimeType: string;
}

export interface FileMetadata {
  name: string;
  size: number;
  mimeType: string;
  extension: string;
}

export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface EncryptedImageData {
  encryptedData: Uint8Array;
  nonce: Uint8Array;
  fileKey: Uint8Array;
}

export interface EncryptedFileData {
  encryptedData: Uint8Array;
  nonce: Uint8Array;
  fileKey: Uint8Array;
}

export interface ImageMessagePayload {
  type: 'image';
  fileId: string;           // ID unique du fichier
  storagePath: string;      // ✅ AJOUTÉ: Chemin de base dans le storage (tag)
  fileKeyEncrypted: string; // Clé de fichier chiffrée avec e2eKey
  fileNonce: string;        // Nonce pour déchiffrer le fichier
  thumbKeyEncrypted: string;// Clé miniature (même clé, nonce différent)
  thumbNonce: string;       // Nonce pour déchiffrer la miniature
  metadata: ImageMetadata;
}

export interface FileMessagePayload {
  type: 'file';
  fileId: string;           // ID unique du fichier
  storagePath: string;      // ✅ AJOUTÉ: Chemin de base dans le storage (tag)
  fileKeyEncrypted: string; // Clé de fichier chiffrée avec e2eKey
  fileNonce: string;        // Nonce pour déchiffrer le fichier
  metadata: FileMetadata;
}

export interface ProcessedImage {
  fullUri: string;          // URI locale de l'image traitée
  thumbUri: string;         // URI locale de la miniature
  metadata: ImageMetadata;
}

export interface UploadedImage {
  fileId: string;
  storagePath: string;      // ✅ AJOUTÉ: Chemin de base utilisé pour le stockage
  fileUrl: string;
  thumbUrl: string;
  fileKey: Uint8Array;
  fileNonce: Uint8Array;
  thumbNonce: Uint8Array;
  metadata: ImageMetadata;
}

export interface UploadedFile {
  fileId: string;
  storagePath: string;      // ✅ AJOUTÉ: Chemin de base utilisé pour le stockage
  fileUrl: string;
  fileKey: Uint8Array;
  fileNonce: Uint8Array;
  metadata: FileMetadata;
}

// ============================================
// SÉLECTION D'IMAGE
// ============================================

/**
 * Demande les permissions et ouvre le picker d'images
 */
export async function pickImage(): Promise<string | null> {
  // Demander permission
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== 'granted') {
    throw new Error('Permission d\'accès à la galerie refusée');
  }

  // Ouvrir le picker
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'], // SDK 54 syntax
    allowsEditing: false,
    quality: 1,
    exif: false,  // Ne pas inclure les métadonnées EXIF
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }

  return result.assets[0].uri;
}

/**
 * Ouvre la caméra pour prendre une photo
 */
export async function takePhoto(): Promise<string | null> {
  // Demander permission
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') {
    throw new Error('Permission d\'accès à la caméra refusée');
  }

  // Ouvrir la caméra
  const result = await ImagePicker.launchCameraAsync({
    allowsEditing: false,
    quality: 1,
    exif: false,  // Ne pas inclure les métadonnées EXIF
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }

  return result.assets[0].uri;
}

// ============================================
// SÉLECTION DE FICHIERS
// ============================================

/**
 * Ouvre le sélecteur de fichiers système
 * @returns Informations sur le fichier sélectionné ou null si annulé
 */
export async function pickFile(): Promise<PickedFile | null> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',  // Tous types de fichiers
      copyToCacheDirectory: true,  // Copier dans le cache pour accès
    });

    // Vérifier si l'utilisateur a annulé
    if (result.canceled || !result.assets || result.assets.length === 0) {
      return null;
    }

    const asset = result.assets[0];

    // Obtenir la taille du fichier si non fournie
    let fileSize = asset.size || 0;
    if (!fileSize) {
      try {
        const fileInfo = await FileSystem.getInfoAsync(asset.uri);
        if (fileInfo.exists) {
          fileSize = (fileInfo as any).size || 0;
        }
      } catch (e) {
        __DEV__ && console.warn('Impossible d\'obtenir la taille du fichier:', e);
      }
    }

    return {
      uri: asset.uri,
      name: asset.name || 'fichier',
      mimeType: asset.mimeType || 'application/octet-stream',
      size: fileSize,
    };
  } catch (error) {
    __DEV__ && console.error('Erreur sélection fichier:', error);
    throw new Error('Impossible de sélectionner le fichier');
  }
}

// ============================================
// TRAITEMENT D'IMAGE
// ============================================

/**
 * Traite une image : redimensionne, compresse, crée miniature
 * Supprime toutes les métadonnées EXIF
 * @throws Error si l'image dépasse 20MB après compression
 */
export async function processImage(uri: string): Promise<ProcessedImage> {
  // Vérifier la taille du fichier original
  const originalFileInfo = await FileSystem.getInfoAsync(uri);
  if (originalFileInfo.exists) {
    const originalSize = (originalFileInfo as any).size || 0;
    // On vérifie la taille originale mais on laisse passer car la compression peut réduire
    if (originalSize > MAX_FILE_SIZE_BYTES * 2) {
      // Si vraiment trop gros (>40MB), on refuse directement
      throw new Error(`IMAGE_TOO_LARGE:${(originalSize / (1024 * 1024)).toFixed(1)}`);
    }
  }

  // Obtenir les dimensions originales
  const originalInfo = await getImageInfo(uri);
  
  // Calculer les nouvelles dimensions (garder le ratio)
  const { width: newWidth, height: newHeight } = calculateDimensions(
    originalInfo.width,
    originalInfo.height,
    MAX_IMAGE_DIMENSION
  );

  // Créer l'image principale (redimensionnée + compressée)
  const fullImage = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: newWidth, height: newHeight } }],
    {
      compress: JPEG_QUALITY_FULL,
      format: ImageManipulator.SaveFormat.JPEG,
      // Pas de base64 pour économiser la mémoire
    }
  );

  // Vérifier la taille après compression
  const compressedInfo = await FileSystem.getInfoAsync(fullImage.uri);
  const compressedSize = compressedInfo.exists ? (compressedInfo as any).size || 0 : 0;
  
  if (compressedSize > MAX_FILE_SIZE_BYTES) {
    // Nettoyer le fichier temporaire
    await FileSystem.deleteAsync(fullImage.uri, { idempotent: true });
    throw new Error(`IMAGE_TOO_LARGE_AFTER_COMPRESSION:${(compressedSize / (1024 * 1024)).toFixed(1)}`);
  }

  // Créer la miniature
  const { width: thumbWidth, height: thumbHeight } = calculateDimensions(
    originalInfo.width,
    originalInfo.height,
    THUMBNAIL_SIZE
  );

  const thumbImage = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: thumbWidth, height: thumbHeight } }],
    {
      compress: JPEG_QUALITY_THUMB,
      format: ImageManipulator.SaveFormat.JPEG,
    }
  );

  return {
    fullUri: fullImage.uri,
    thumbUri: thumbImage.uri,
    metadata: {
      width: newWidth,
      height: newHeight,
      size: compressedSize,
      mimeType: 'image/jpeg',
    },
  };
}

/**
 * Obtient les informations d'une image
 */
async function getImageInfo(uri: string): Promise<{ width: number; height: number }> {
  // Utiliser ImageManipulator pour obtenir les dimensions
  const manipulated = await ImageManipulator.manipulateAsync(
    uri,
    [],
    { format: ImageManipulator.SaveFormat.JPEG }
  );
  
  // Obtenir les dimensions via une manipulation nulle
  // Note: expo-image-manipulator ne retourne pas directement les dimensions
  // On doit utiliser une autre méthode
  
  return new Promise((resolve, reject) => {
    const Image = require('react-native').Image;
    Image.getSize(
      uri,
      (width: number, height: number) => resolve({ width, height }),
      (error: any) => reject(error)
    );
  });
}

/**
 * Calcule les dimensions en conservant le ratio
 */
function calculateDimensions(
  originalWidth: number,
  originalHeight: number,
  maxDimension: number
): { width: number; height: number } {
  if (originalWidth <= maxDimension && originalHeight <= maxDimension) {
    return { width: originalWidth, height: originalHeight };
  }

  const ratio = originalWidth / originalHeight;

  if (originalWidth > originalHeight) {
    return {
      width: maxDimension,
      height: Math.round(maxDimension / ratio),
    };
  } else {
    return {
      width: Math.round(maxDimension * ratio),
      height: maxDimension,
    };
  }
}

// ============================================
// CHIFFREMENT D'IMAGE
// ============================================

/**
 * Chiffre une image avec une clé unique
 */
export async function encryptImage(uri: string): Promise<EncryptedImageData> {
  // Lire le fichier en base64
  const base64Data = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Convertir en Uint8Array
  const imageData = decodeBase64(base64Data);

  // Générer une clé unique pour ce fichier
  const fileKey = getRandomBytes(32);
  const nonce = getRandomBytes(nacl.secretbox.nonceLength);

  // Chiffrer
  const encrypted = nacl.secretbox(imageData, nonce, fileKey);

  if (!encrypted) {
    throw new Error('Échec du chiffrement de l\'image');
  }

  return {
    encryptedData: encrypted,
    nonce,
    fileKey,
  };
}

/**
 * Déchiffre une image
 */
export function decryptImage(
  encryptedData: Uint8Array,
  nonce: Uint8Array,
  fileKey: Uint8Array
): Uint8Array {
  const decrypted = nacl.secretbox.open(encryptedData, nonce, fileKey);

  if (!decrypted) {
    throw new Error('Échec du déchiffrement de l\'image');
  }

  return decrypted;
}

// ============================================
// CHIFFREMENT DE FICHIERS GÉNÉRIQUES
// ============================================

/**
 * Chiffre un fichier avec une clé unique
 */
export async function encryptFile(uri: string): Promise<EncryptedFileData> {
  // Lire le fichier en base64
  const base64Data = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Convertir en Uint8Array
  const fileData = decodeBase64(base64Data);

  // Générer une clé unique pour ce fichier
  const fileKey = getRandomBytes(32);
  const nonce = getRandomBytes(nacl.secretbox.nonceLength);

  // Chiffrer
  const encrypted = nacl.secretbox(fileData, nonce, fileKey);

  if (!encrypted) {
    throw new Error('Échec du chiffrement du fichier');
  }

  return {
    encryptedData: encrypted,
    nonce,
    fileKey,
  };
}

/**
 * Déchiffre un fichier
 */
export function decryptFile(
  encryptedData: Uint8Array,
  nonce: Uint8Array,
  fileKey: Uint8Array
): Uint8Array {
  const decrypted = nacl.secretbox.open(encryptedData, nonce, fileKey);

  if (!decrypted) {
    throw new Error('Échec du déchiffrement du fichier');
  }

  return decrypted;
}

// ============================================
// UPLOAD
// ============================================

/**
 * Génère un ID de fichier anonyme
 */
function generateAnonymousFileId(): string {
  const bytes = getRandomBytes(24);
  // Utiliser un format compatible avec les URLs
  return encodeBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Upload une image chiffrée sur Supabase Storage
 * @param storagePath - Le chemin de base (tag anonyme) pour le stockage
 * @param processedImage - L'image traitée à uploader
 */
export async function uploadEncryptedImage(
  storagePath: string,
  processedImage: ProcessedImage
): Promise<UploadedImage> {
  const fileId = generateAnonymousFileId();
  
  // Chiffrer l'image principale
  const fullEncrypted = await encryptImage(processedImage.fullUri);
  
  // Chiffrer la miniature (même clé, nonce différent)
  const thumbBase64 = await FileSystem.readAsStringAsync(processedImage.thumbUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const thumbData = decodeBase64(thumbBase64);
  const thumbNonce = getRandomBytes(nacl.secretbox.nonceLength);
  const thumbEncrypted = nacl.secretbox(thumbData, thumbNonce, fullEncrypted.fileKey);

  if (!thumbEncrypted) {
    throw new Error('Échec du chiffrement de la miniature');
  }

  // Paths dans le storage (anonymisés avec le tag)
  const fullPath = `${storagePath}/${fileId}.enc`;
  const thumbPath = `${storagePath}/${fileId}_thumb.enc`;

  // Upload de l'image principale
  const { error: fullError } = await supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .upload(fullPath, fullEncrypted.encryptedData, {
      contentType: 'application/octet-stream',
      cacheControl: '3600',
      upsert: false,
    });

  if (fullError) {
    throw new Error(`Échec upload image: ${fullError.message}`);
  }

  // Upload de la miniature
  const { error: thumbError } = await supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .upload(thumbPath, thumbEncrypted, {
      contentType: 'application/octet-stream',
      cacheControl: '3600',
      upsert: false,
    });

  if (thumbError) {
    // Nettoyer l'image principale si la miniature échoue
    await supabaseStorage.storage.from(STORAGE_BUCKET).remove([fullPath]);
    throw new Error(`Échec upload miniature: ${thumbError.message}`);
  }

  // Obtenir les URLs publiques (le contenu reste chiffré)
  const { data: fullUrlData } = supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(fullPath);

  const { data: thumbUrlData } = supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(thumbPath);
    

  // Nettoyer les fichiers temporaires
  try {
    await FileSystem.deleteAsync(processedImage.fullUri, { idempotent: true });
    await FileSystem.deleteAsync(processedImage.thumbUri, { idempotent: true });
  } catch (e) {
    __DEV__ && console.warn('Erreur nettoyage fichiers temporaires:', e);
  }

  return {
    fileId,
    storagePath,  // ✅ Inclure le storagePath pour le payload
    fileUrl: fullUrlData.publicUrl,
    thumbUrl: thumbUrlData.publicUrl,
    fileKey: fullEncrypted.fileKey,
    fileNonce: fullEncrypted.nonce,
    thumbNonce,
    metadata: processedImage.metadata,
  };
}

/**
 * Télécharge et déchiffre une image
 */
export async function downloadAndDecryptImage(
  url: string,
  fileKeyEncrypted: string,
  nonceBase64: string,
  e2eKey: Uint8Array
): Promise<string> {
  // Déchiffrer la clé du fichier
  const fileKey = decryptFileKey(fileKeyEncrypted, e2eKey);
  const nonce = decodeBase64(nonceBase64);

  // Télécharger le fichier chiffré
  // ACTION-01: Route via OHTTP pour cacher le tag au CF Relay
  const encryptedData = await fetchMediaViaRelay(url);

  // Déchiffrer
  const decryptedData = decryptImage(encryptedData, nonce, fileKey);

  // Sauvegarder temporairement pour affichage
  const cacheDir = FileSystem.cacheDirectory + 'whisper-images/';
  await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });

  const tempPath = cacheDir + generateAnonymousFileId() + '.jpg';
  await FileSystem.writeAsStringAsync(
    tempPath,
    encodeBase64(decryptedData),
    { encoding: FileSystem.EncodingType.Base64 }
  );

  return tempPath;
}

/**
 * Chiffre la clé du fichier avec la clé E2E de la conversation
 */
export function encryptFileKey(fileKey: Uint8Array, e2eKey: Uint8Array): string {
  const nonce = getRandomBytes(nacl.secretbox.nonceLength);
  const encrypted = nacl.secretbox(fileKey, nonce, e2eKey);
  
  if (!encrypted) {
    throw new Error('Échec chiffrement clé fichier');
  }

  // Format: nonce + encrypted (tout en base64)
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce, 0);
  combined.set(encrypted, nonce.length);
  
  return encodeBase64(combined);
}

/**
 * Déchiffre la clé du fichier
 */
export function decryptFileKey(encryptedKey: string, e2eKey: Uint8Array): Uint8Array {
  const combined = decodeBase64(encryptedKey);
  const nonce = combined.slice(0, nacl.secretbox.nonceLength);
  const encrypted = combined.slice(nacl.secretbox.nonceLength);

  const decrypted = nacl.secretbox.open(encrypted, nonce, e2eKey);

  if (!decrypted) {
    throw new Error('Échec déchiffrement clé fichier');
  }

  return decrypted;
}

// ============================================
// CRÉATION DU PAYLOAD MESSAGE
// ============================================

/**
 * Crée le payload pour un message image
 */
export function createImageMessagePayload(
  uploadedImage: UploadedImage,
  e2eKey: Uint8Array
): ImageMessagePayload {
  // Chiffrer la clé du fichier avec la clé E2E
  const fileKeyEncrypted = encryptFileKey(uploadedImage.fileKey, e2eKey);

  return {
    type: 'image',
    fileId: uploadedImage.fileId,
    storagePath: uploadedImage.storagePath,  // ✅ AJOUTÉ: Inclure le chemin de stockage
    fileKeyEncrypted,
    fileNonce: encodeBase64(uploadedImage.fileNonce),
    thumbKeyEncrypted: fileKeyEncrypted, // Même clé pour la miniature
    thumbNonce: encodeBase64(uploadedImage.thumbNonce),
    metadata: uploadedImage.metadata,
  };
}

// ============================================
// CACHE LOCAL
// ============================================

const imageCache = new Map<string, string>();

/**
 * Obtient une image du cache ou la télécharge
 */
export async function getCachedImage(
  fileId: string,
  url: string,
  fileKeyEncrypted: string,
  nonceBase64: string,
  e2eKey: Uint8Array
): Promise<string> {
  // Vérifier le cache mémoire
  const cacheKey = `${fileId}_full`;
  if (imageCache.has(cacheKey)) {
    const cachedPath = imageCache.get(cacheKey)!;
    // Vérifier que le fichier existe toujours
    const info = await FileSystem.getInfoAsync(cachedPath);
    if (info.exists) {
      return cachedPath;
    }
  }

  // Télécharger et déchiffrer
  const localPath = await downloadAndDecryptImage(
    url,
    fileKeyEncrypted,
    nonceBase64,
    e2eKey
  );

  // Mettre en cache
  imageCache.set(cacheKey, localPath);

  return localPath;
}

/**
 * Obtient une miniature du cache ou la télécharge
 */
export async function getCachedThumbnail(
  fileId: string,
  url: string,
  thumbKeyEncrypted: string,
  nonceBase64: string,
  e2eKey: Uint8Array
): Promise<string> {
  // Vérifier le cache mémoire
  const cacheKey = `${fileId}_thumb`;
  if (imageCache.has(cacheKey)) {
    const cachedPath = imageCache.get(cacheKey)!;
    const info = await FileSystem.getInfoAsync(cachedPath);
    if (info.exists) {
      return cachedPath;
    }
  }

  // Télécharger et déchiffrer (même fonction, URL différente)
  const localPath = await downloadAndDecryptImage(
    url,
    thumbKeyEncrypted,
    nonceBase64,
    e2eKey
  );

  // Mettre en cache
  imageCache.set(cacheKey, localPath);

  return localPath;
}

/**
 * Nettoie le cache d'images
 */
export async function clearImageCache(): Promise<void> {
  const cacheDir = FileSystem.cacheDirectory + 'whisper-images/';
  try {
    await FileSystem.deleteAsync(cacheDir, { idempotent: true });
    imageCache.clear();
  } catch (e) {
    __DEV__ && console.warn('Erreur nettoyage cache images:', e);
  }
}

// ============================================
// SUPPRESSION
// ============================================

/**
 * Supprime une image du storage
 * @param storagePath - Le chemin de base (tag) utilisé lors de l'upload
 * @param fileId - L'ID du fichier
 */
export async function deleteImageFromStorage(
  storagePath: string,
  fileId: string
): Promise<void> {
  const fullPath = `${storagePath}/${fileId}.enc`;
  const thumbPath = `${storagePath}/${fileId}_thumb.enc`;

  await supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .remove([fullPath, thumbPath]);

  // Nettoyer le cache local
  imageCache.delete(`${fileId}_full`);
  imageCache.delete(`${fileId}_thumb`);
}

// ============================================
// VALIDATION
// ============================================

/**
 * Valide la taille d'un fichier avant upload
 * @param input - URI du fichier (string) ou taille en bytes (number)
 */
export async function validateFileSize(input: string | number): Promise<{ valid: boolean; error?: string }> {
  let sizeBytes: number;

  if (typeof input === 'string') {
    // C'est un URI, on doit récupérer la taille du fichier
    try {
      const fileInfo = await FileSystem.getInfoAsync(input);
      if (!fileInfo.exists) {
        return { valid: false, error: 'Fichier introuvable' };
      }
      sizeBytes = (fileInfo as any).size || 0;
    } catch (e) {
      __DEV__ && console.error('Erreur lecture taille fichier:', e);
      return { valid: false, error: 'Impossible de lire le fichier' };
    }
  } else {
    // C'est directement la taille en bytes
    sizeBytes = input;
  }

  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: `Le fichier fait ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB. La limite est de ${MAX_FILE_SIZE_MB} MB.`,
    };
  }
  return { valid: true };
}

// ============================================
// FICHIERS GÉNÉRIQUES - SÉLECTION
// ============================================

/**
 * Obtient l'extension d'un fichier
 */
function getFileExtension(fileName: string): string {
  const parts = fileName.split('.');
  if (parts.length > 1) {
    return parts[parts.length - 1].toLowerCase();
  }
  return '';
}

/**
 * Détermine le type MIME à partir de l'extension
 */
function getMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
  };
  return mimeTypes[extension] || 'application/octet-stream';
}

/**
 * Upload un fichier chiffré sur Supabase Storage
 * @param storagePath - Le chemin de base (tag anonyme) pour le stockage
 */
export async function uploadEncryptedFile(
  storagePath: string,
  fileUri: string,
  fileName: string,
  fileMimeType: string
): Promise<UploadedFile> {
  const fileId = generateAnonymousFileId();
  const extension = getFileExtension(fileName);

  // Obtenir la taille du fichier
  const fileInfo = await FileSystem.getInfoAsync(fileUri);
  const fileSize = fileInfo.exists ? (fileInfo as any).size || 0 : 0;

  // Chiffrer le fichier
  const encrypted = await encryptFile(fileUri);

  // Path dans le storage (anonymisé avec le tag)
  const fullPath = `${storagePath}/${fileId}.enc`;

  // Upload du fichier chiffré
  const { error } = await supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .upload(fullPath, encrypted.encryptedData, {
      contentType: 'application/octet-stream',
      cacheControl: '3600',
      upsert: false,
    });

  if (error) {
    throw new Error(`Échec upload fichier: ${error.message}`);
  }

  // Obtenir l'URL publique
  const { data: urlData } = supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(fullPath);

  return {
    fileId,
    storagePath,  // ✅ Inclure le storagePath pour le payload
    fileUrl: urlData.publicUrl,
    fileKey: encrypted.fileKey,
    fileNonce: encrypted.nonce,
    metadata: {
      name: fileName,
      size: fileSize,
      mimeType: fileMimeType || getMimeType(extension),
      extension,
    },
  };
}

/**
 * Télécharge et déchiffre un fichier
 */
export async function downloadAndDecryptFile(
  url: string,
  fileKeyEncrypted: string,
  nonceBase64: string,
  e2eKey: Uint8Array,
  fileName: string
): Promise<string> {
  // Déchiffrer la clé du fichier
  const fileKey = decryptFileKey(fileKeyEncrypted, e2eKey);
  const nonce = decodeBase64(nonceBase64);

  // Télécharger le fichier chiffré
  // ACTION-01: Route via OHTTP pour cacher le tag au CF Relay
  const encryptedData = await fetchMediaViaRelay(url);

  // Déchiffrer
  const decryptedData = decryptFile(encryptedData, nonce, fileKey);

  // Sauvegarder temporairement pour ouverture
  const cacheDir = FileSystem.cacheDirectory + 'whisper-files/';
  await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });

  // Utiliser le nom original pour faciliter l'ouverture
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const tempPath = cacheDir + `${Date.now()}_${safeFileName}`;
  
  await FileSystem.writeAsStringAsync(
    tempPath,
    encodeBase64(decryptedData),
    { encoding: FileSystem.EncodingType.Base64 }
  );

  return tempPath;
}

// ============================================
// FICHIERS GÉNÉRIQUES - PAYLOAD MESSAGE
// ============================================

/**
 * Crée le payload pour un message fichier
 */
export function createFileMessagePayload(
  uploadedFile: UploadedFile,
  e2eKey: Uint8Array
): FileMessagePayload {
  // Chiffrer la clé du fichier avec la clé E2E
  const fileKeyEncrypted = encryptFileKey(uploadedFile.fileKey, e2eKey);

  return {
    type: 'file',
    fileId: uploadedFile.fileId,
    storagePath: uploadedFile.storagePath,  // ✅ AJOUTÉ: Inclure le chemin de stockage
    fileKeyEncrypted,
    fileNonce: encodeBase64(uploadedFile.fileNonce),
    metadata: uploadedFile.metadata,
  };
}

// ============================================
// FICHIERS GÉNÉRIQUES - CACHE
// ============================================

const fileCache = new Map<string, string>();

/**
 * Obtient un fichier du cache ou le télécharge
 */
export async function getCachedFile(
  fileId: string,
  url: string,
  fileKeyEncrypted: string,
  nonceBase64: string,
  e2eKey: Uint8Array,
  fileName: string
): Promise<string> {
  // Vérifier le cache mémoire
  if (fileCache.has(fileId)) {
    const cachedPath = fileCache.get(fileId)!;
    const info = await FileSystem.getInfoAsync(cachedPath);
    if (info.exists) {
      return cachedPath;
    }
  }

  // Télécharger et déchiffrer
  const localPath = await downloadAndDecryptFile(
    url,
    fileKeyEncrypted,
    nonceBase64,
    e2eKey,
    fileName
  );

  // Mettre en cache
  fileCache.set(fileId, localPath);

  return localPath;
}

/**
 * Nettoie le cache de fichiers
 */
export async function clearFileCache(): Promise<void> {
  const cacheDir = FileSystem.cacheDirectory + 'whisper-files/';
  try {
    await FileSystem.deleteAsync(cacheDir, { idempotent: true });
    fileCache.clear();
  } catch (e) {
    __DEV__ && console.warn('Erreur nettoyage cache fichiers:', e);
  }
}

// ============================================
// FICHIERS GÉNÉRIQUES - SUPPRESSION
// ============================================

/**
 * Supprime un fichier du storage
 * @param storagePath - Le chemin de base (tag) utilisé lors de l'upload
 * @param fileId - L'ID du fichier
 */
export async function deleteFileFromStorage(
  storagePath: string,
  fileId: string
): Promise<void> {
  const filePath = `${storagePath}/${fileId}.enc`;

  await supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .remove([filePath]);

  // Nettoyer le cache local
  if (fileCache.has(fileId)) {
    try {
      await FileSystem.deleteAsync(fileCache.get(fileId)!, { idempotent: true });
    } catch (e) {}
    fileCache.delete(fileId);
  }
}

// ============================================
// UTILITAIRES - ICÔNES PAR TYPE
// ============================================

/**
 * Retourne l'emoji approprié pour un type de fichier
 */
export function getFileIcon(extension: string): string {
  const icons: Record<string, string> = {
    // Documents
    pdf: '📕',
    doc: '📘',
    docx: '📘',
    txt: '📄',
    rtf: '📄',
    // Tableurs
    xls: '📊',
    xlsx: '📊',
    csv: '📊',
    // Présentations
    ppt: '📙',
    pptx: '📙',
    // Archives
    zip: '🗜️',
    rar: '🗜️',
    '7z': '🗜️',
    tar: '🗜️',
    gz: '🗜️',
    // Audio
    mp3: '🎵',
    wav: '🎵',
    aac: '🎵',
    flac: '🎵',
    ogg: '🎵',
    // Vidéo
    mp4: '🎬',
    avi: '🎬',
    mov: '🎬',
    mkv: '🎬',
    webm: '🎬',
    // Code
    js: '💻',
    ts: '💻',
    py: '💻',
    java: '💻',
    cpp: '💻',
    html: '🌐',
    css: '🎨',
    json: '📋',
    xml: '📋',
    // Autres
    apk: '📱',
    exe: '⚙️',
    dmg: '💿',
  };
  return icons[extension.toLowerCase()] || '📎';
}

/**
 * Formate la taille d'un fichier pour affichage
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}