// src/services/media1to1.ts
// v28.0: Envoi de médias via Encrypted Blob Storage — iOS performance fix
//
// ARCHITECTURE:
//   1. Traiter le média (compression image, lecture fichier/vocal)
//   2. Chiffrer + padder + uploader le blob via relay (encryptedBlobService)
//   3. Envoyer une petite référence E2E (~200-5000B) via sendMediaRef1to1
//   4. Le destinataire télécharge le blob à la demande via downloadMediaBlob
//
// SÉCURITÉ:
//   - XSalsa20-Poly1305 côté client (clé random par blob)
//   - Padding à tiers fixes [256KB, 1MB, 4MB, 16MB]
//   - Upload/download via CF Relay (IP cachée)
//   - Path UUID aléatoire (aucun lien session)
//   - Clé de déchiffrement dans le message E2E uniquement
//
// ============================================================================
// v28.0 — iOS PERFORMANCE FIX:
//
// PROBLÈMES CORRIGÉS:
//
//   1. ENCRYPT/UPLOAD ASYNC AVEC YIELD UI:
//      encryptAndUploadBlob est maintenant entièrement async et yield au
//      thread JS entre les phases lourdes (cf. encryptedBlobService.ts v28).
//      Le callback onProgress reçoit donc des notifications RÉELLES alignées
//      avec les phases plutôt qu'un saut 0→100 quand le thread se débloque.
//
//   2. PROGRESS MORE GRANULAR:
//      Anciennement, onProgress('processing', 60) → onProgress('uploading', 0)
//      étaient envoyés immédiatement après le yield ImageManipulator. Quand
//      le NaCl secretbox bloquait 2s, l'UI ne voyait rien. Maintenant on
//      découpe en 'processing' → 'encrypting' → 'uploading' → 'sending'.
//
//   3. CALLBACK PROGRESS YIELD:
//      Après chaque onProgress, on yield au thread JS pour que React puisse
//      effectivement redessiner l'overlay de progression. Sans ce yield,
//      les setState seraient batchés et l'utilisateur ne verrait que la
//      progression finale.
// ============================================================================

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import i18n from '../i18n';
import { sendMediaRef1to1, Message1to1, saveLocalMessage1to1 } from './api1to1';
import { sessionService } from './tripleRatchet';
import { encryptAndUploadBlob, downloadAndDecryptBlob, base64ToUint8Array, uint8ArrayToBase64 } from './encryptedBlobService';

// ============================================
// CONSTANTES
// ============================================

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_QUALITY_STEPS = [
  { width: 2000, quality: 0.92 },
  { width: 2000, quality: 0.85 },
  { width: 1600, quality: 0.75 },
  { width: 1200, quality: 0.70 },
  { width: 1000, quality: 0.60 },
];

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_VOICE_SIZE = 10 * 1024 * 1024;
const MAX_VOICE_DURATION = 600;

// ============================================
// UTILS
// ============================================

/**
 * Yield au thread JS pour laisser React redessiner l'overlay de progression.
 * Indispensable sur iOS où le thread JS est très chargé pendant l'encryption.
 */
function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ============================================
// ENVOI D'IMAGE
// ============================================

export interface SendImageResult {
  success: boolean;
  messageId?: string;
  error?: string;
  localMessage?: Message1to1;
}

export async function sendImageMessage1to1(
  sessionId: string,
  imageUri: string,
  onProgress?: (stage: 'processing' | 'encrypting' | 'uploading' | 'sending', progress: number) => void
): Promise<SendImageResult> {
  try {
    __DEV__ && console.log('[media1to1] 📸 Starting image send (v28.0 blob storage)...');
    onProgress?.('processing', 0);
    await yieldToUI();

    // 1. Compression (ImageManipulator est natif → ne bloque pas le thread JS)
    const processedImage = await processImage(imageUri);
    onProgress?.('processing', 100);
    await yieldToUI();

    // 2. Chiffrer + uploader le blob (interne: yield JS entre chaque phase lourde)
    onProgress?.('encrypting', 0);
    await yieldToUI();
    const imageBytes = base64ToUint8Array(processedImage.base64);
    onProgress?.('encrypting', 50);
    await yieldToUI();

    onProgress?.('uploading', 0);
    const blobResult = await encryptAndUploadBlob(imageBytes);
    __DEV__ && console.log('[media1to1] ✅ Blob uploaded:', blobResult.blobId.slice(0, 12) + '...');
    onProgress?.('uploading', 100);
    await yieldToUI();

    // 3. Envoyer la référence E2E (~350B sans thumbnail → tier 2KB = indistinguable des decoys)
    onProgress?.('sending', 0);
    const result = await sendMediaRef1to1(sessionId, blobResult, 'image', {
      // thumbnailData supprimé — pas envoyé, pas stocké
      imageWidth: processedImage.width,
      imageHeight: processedImage.height,
      localImageData: processedImage.base64,
    });
    onProgress?.('sending', 100);

    if (result.success) {
      __DEV__ && console.log('[media1to1] ✅ Image sent via blob storage!');
      const myProfile = sessionService.getMyProfile();
      const localMessage: Message1to1 = {
        id: result.messageId!,
        sessionId,
        content: '[Image]',
        timestamp: Date.now(),
        isMine: true,
        displayName: myProfile.displayName,
        senderAvatarBase64: myProfile.avatarBase64,
        status: 'sent',
        messageType: 'image',
        imageData: processedImage.base64,
        // thumbnailData supprimé — l'envoyeur a imageData, le récepteur ne le reçoit pas
        imageWidth: processedImage.width,
        imageHeight: processedImage.height,
      };
      return { success: true, messageId: result.messageId, localMessage };
    }
    return result;
  } catch (error: any) {
    __DEV__ && console.error('[media1to1] ❌ Exception:', error);
    return { success: false, error: error.message || i18n.t('errors.imageSendFailed') };
  }
}

// ============================================
// ENVOI DE FICHIER
// ============================================

export interface SendFileResult {
  success: boolean;
  messageId?: string;
  error?: string;
  errorCode?: string;
  localMessage?: Message1to1;
}

export async function sendFileMessage1to1(
  sessionId: string,
  fileUri: string,
  fileName: string,
  mimeType: string,
  onProgress?: (stage: 'validating' | 'reading' | 'uploading' | 'sending', progress: number) => void
): Promise<SendFileResult> {
  try {
    __DEV__ && console.log('[media1to1] 📎 Starting file send (v28.0 blob storage)...');
    onProgress?.('validating', 0);
    await yieldToUI();

    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    if (!fileInfo.exists) return { success: false, error: 'Fichier introuvable' };
    const fileSize = (fileInfo as any).size || 0;
    if (fileSize > MAX_FILE_SIZE) {
      return { success: false, error: `Fichier trop volumineux (${Math.round(fileSize / 1024 / 1024 * 10) / 10}MB). Max: 10MB`, errorCode: 'FILE_TOO_LARGE' };
    }
    onProgress?.('validating', 100);
    await yieldToUI();

    // Lire (natif) + chiffrer + uploader (interne yield)
    onProgress?.('reading', 0);
    const base64Content = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
    onProgress?.('reading', 100);
    await yieldToUI();

    onProgress?.('uploading', 0);
    const fileBytes = base64ToUint8Array(base64Content);
    const blobResult = await encryptAndUploadBlob(fileBytes);
    onProgress?.('uploading', 100);
    await yieldToUI();

    // Envoyer la référence E2E (~300B, pas de thumbnail)
    onProgress?.('sending', 0);
    const result = await sendMediaRef1to1(sessionId, blobResult, 'file', {
      fileName,
      fileSize,
      fileMimeType: mimeType,
      localFileData: base64Content,
    });
    onProgress?.('sending', 100);

    if (result.success) {
      const myProfile = sessionService.getMyProfile();
      const localMessage: Message1to1 = {
        id: result.messageId!, sessionId,
        content: `[Fichier: ${fileName}]`, timestamp: Date.now(),
        isMine: true, displayName: myProfile.displayName,
        senderAvatarBase64: myProfile.avatarBase64, status: 'sent',
        messageType: 'file', fileData: base64Content,
        fileName, fileSize, fileMimeType: mimeType,
      };
      return { success: true, messageId: result.messageId, localMessage };
    }
    return result;
  } catch (error: any) {
    __DEV__ && console.error('[media1to1] ❌ Exception:', error);
    return { success: false, error: error.message || i18n.t('errors.fileSendFailed') };
  }
}

// ============================================
// ENVOI DE MESSAGE VOCAL
// ============================================

export interface SendVoiceResult {
  success: boolean;
  messageId?: string;
  error?: string;
  localMessage?: Message1to1;
}

export async function sendVoiceMessage1to1(
  sessionId: string,
  audioUri: string,
  duration: number,
  onProgress?: (stage: 'reading' | 'uploading' | 'sending', progress: number) => void
): Promise<SendVoiceResult> {
  try {
    const durationSeconds = duration / 1000;
    __DEV__ && console.log('[media1to1] 🎤 Starting voice send (v28.0 blob storage)...');
    if (durationSeconds > MAX_VOICE_DURATION) {
      return { success: false, error: i18n.t('errors.voiceTooLong', { minutes: 10 }) };
    }

    onProgress?.('reading', 0);
    await yieldToUI();
    const fileInfo = await FileSystem.getInfoAsync(audioUri);
    if (!fileInfo.exists) return { success: false, error: 'Fichier audio introuvable' };
    if (((fileInfo as any).size || 0) > MAX_VOICE_SIZE) {
      return { success: false, error: i18n.t('errors.voiceTooLarge') };
    }
    const base64Content = await FileSystem.readAsStringAsync(audioUri, { encoding: FileSystem.EncodingType.Base64 });
    onProgress?.('reading', 100);
    await yieldToUI();

    onProgress?.('uploading', 0);
    const voiceBytes = base64ToUint8Array(base64Content);
    const blobResult = await encryptAndUploadBlob(voiceBytes);
    onProgress?.('uploading', 100);
    await yieldToUI();

    onProgress?.('sending', 0);
    const result = await sendMediaRef1to1(sessionId, blobResult, 'voice', {
      voiceDuration: durationSeconds,
      localVoiceData: base64Content,
    });
    onProgress?.('sending', 100);

    if (result.success) {
      const myProfile = sessionService.getMyProfile();
      const localMessage: Message1to1 = {
        id: result.messageId!, sessionId,
        content: i18n.t('messages.voiceMessagePlaceholder', { seconds: Math.round(durationSeconds) }), timestamp: Date.now(),
        isMine: true, displayName: myProfile.displayName,
        senderAvatarBase64: myProfile.avatarBase64, status: 'sent',
        messageType: 'voice', voiceData: base64Content, voiceDuration: durationSeconds,
      };
      return { success: true, messageId: result.messageId, localMessage };
    }
    return result;
  } catch (error: any) {
    __DEV__ && console.error('[media1to1] ❌ Exception:', error);
    return { success: false, error: error.message || i18n.t('errors.voiceSendFailed') };
  }
}

// ============================================
// TÉLÉCHARGEMENT DE BLOB (côté réception)
// ============================================

/**
 * Télécharge et déchiffre un blob média, met à jour le message local.
 * Appelé par l'UI quand l'utilisateur tap sur un média non téléchargé.
 */
export async function downloadMediaBlob(
  sessionId: string,
  message: Message1to1
): Promise<{ success: boolean; base64Data?: string; error?: string }> {
  try {
    if (!message.blobId || !message.blobKey || !message.blobNonce || !message.blobSize) {
      return { success: false, error: 'Missing blob references' };
    }
    __DEV__ && console.log(`[media1to1] ⬇️ Downloading ${message.blobMediaType} blob: ${message.blobId.slice(0, 12)}...`);

    // 1. Télécharger + déchiffrer via relay
    const decryptedData = await downloadAndDecryptBlob(
      message.blobId, message.blobKey, message.blobNonce, message.blobSize
    );
    const base64Data = uint8ArrayToBase64(decryptedData);
    __DEV__ && console.log(`[media1to1] ✅ Downloaded: ${Math.round(decryptedData.length / 1024)}KB`);

    // 2. Mettre à jour le message local avec les données complètes
    const updatedMessage: Message1to1 = { ...message };
    switch (message.blobMediaType) {
      case 'image': updatedMessage.imageData = base64Data; break;
      case 'file':  updatedMessage.fileData = base64Data; break;
      case 'voice': updatedMessage.voiceData = base64Data; break;
    }
    // Supprimer les clés crypto (le média est maintenant local)
    delete updatedMessage.blobKey;
    delete updatedMessage.blobNonce;
    delete updatedMessage.blobSize;

    // 3. Sauvegarder (externalizeMedia enverra au filesystem)
    await saveLocalMessage1to1(sessionId, updatedMessage);

    return { success: true, base64Data };
  } catch (error: any) {
    __DEV__ && console.error('[media1to1] ❌ Download error:', error);
    return { success: false, error: error.message || i18n.t('errors.downloadError') };
  }
}

// ============================================
// TRAITEMENT D'IMAGE
// ============================================

async function processImage(uri: string): Promise<{ base64: string; width: number; height: number }> {
  let resized: ImageManipulator.ImageResult | null = null;
  let base64 = '';

  for (const step of IMAGE_QUALITY_STEPS) {
    resized = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: step.width } }],
      { compress: step.quality, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    base64 = resized.base64!;
    const sizeBytes = base64.length * 0.75;
    __DEV__ && console.log(`[media1to1] Pass ${step.width}px@${step.quality}: ${Math.round(sizeBytes / 1024)}KB`);
    if (sizeBytes <= MAX_IMAGE_BYTES) break;
  }
  if (!resized) throw new Error('Image processing failed');
  return { base64, width: resized.width, height: resized.height };
}

// v27.1: createThumbnail supprimé — plus utilisé (ni envoyé, ni stocké).
// L'envoyeur a imageData, le récepteur télécharge le blob à la demande.

// ============================================
// HELPERS
// ============================================

export async function base64ToTempUri(base64: string, extension: string = 'jpg'): Promise<string> {
  const tempPath = `${FileSystem.cacheDirectory}temp_${Date.now()}.${extension}`;
  await FileSystem.writeAsStringAsync(tempPath, base64, { encoding: FileSystem.EncodingType.Base64 });
  return tempPath;
}

export async function saveBase64File(base64: string, fileName: string): Promise<string> {
  const docPath = `${FileSystem.documentDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(docPath, base64, { encoding: FileSystem.EncodingType.Base64 });
  return docPath;
}
