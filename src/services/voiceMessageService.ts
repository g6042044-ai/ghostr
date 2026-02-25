// src/services/voiceMessageService.ts
// Service de gestion des messages vocaux chiffrés E2E
// Version 1.0 - Compatible avec le pattern de sécurité existant
//
// Fonctionnalités:
// - Enregistrement audio avec expo-av
// - Génération de waveform pour visualisation
// - Chiffrement NaCl identique aux images/fichiers
// - Cache local pour lecture

import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { supabaseStorage } from './api';
import { getRandomBytes } from './crypto';

// ============================================
// CONFIGURATION
// ============================================

const STORAGE_BUCKET = 'whisper-media';
const MAX_VOICE_DURATION_MS = 5 * 60 * 1000; // 5 minutes max
const MAX_VOICE_SIZE_MB = 10;
const MAX_VOICE_SIZE_BYTES = MAX_VOICE_SIZE_MB * 1024 * 1024;
const WAVEFORM_SAMPLES = 50; // Nombre de points pour la visualisation

// Configuration d'enregistrement optimisée pour la voix
const RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: true, // Activer le metering pour la waveform
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1, // Mono pour la voix
    bitRate: 64000, // 64kbps - bon compromis qualité/taille
  },
  ios: {
    extension: '.m4a',
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.MEDIUM,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 64000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 64000,
  },
};

// ============================================
// TYPES
// ============================================

export interface VoiceMetadata {
  duration: number;        // Durée en millisecondes
  size: number;            // Taille en bytes
  waveform: number[];      // Points de visualisation (0-1)
  mimeType: string;        // 'audio/mp4' ou 'audio/m4a'
}

export interface VoiceMessagePayload {
  type: 'voice';
  fileId: string;
  storagePath: string;
  fileKeyEncrypted: string;
  fileNonce: string;
  metadata: VoiceMetadata;
}

export interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
  duration: number;         // Durée actuelle en ms
  waveformData: number[];   // Données de waveform en temps réel
  uri: string | null;       // URI du fichier enregistré
}

export interface EncryptedVoiceData {
  encryptedData: Uint8Array;
  nonce: Uint8Array;
  fileKey: Uint8Array;
}

export interface UploadedVoice {
  fileId: string;
  storagePath: string;
  fileUrl: string;
  fileKey: Uint8Array;
  fileNonce: Uint8Array;
  metadata: VoiceMetadata;
}

// ============================================
// ÉTAT DU SERVICE
// ============================================

interface VoiceServiceState {
  recording: Audio.Recording | null;
  sound: Audio.Sound | null;
  currentPlayingId: string | null;
  playbackPosition: number;
  playbackDuration: number;
  isPlaying: boolean;
  meteringData: number[];
  recordingStartTime: number;
  meteringInterval: ReturnType<typeof setInterval> | null;
}

const state: VoiceServiceState = {
  recording: null,
  sound: null,
  currentPlayingId: null,
  playbackPosition: 0,
  playbackDuration: 0,
  isPlaying: false,
  meteringData: [],
  recordingStartTime: 0,
  meteringInterval: null,
};

// Callbacks pour les mises à jour
type RecordingCallback = (duration: number, waveform: number[]) => void;
type PlaybackCallback = (position: number, duration: number, isPlaying: boolean) => void;

let recordingCallback: RecordingCallback | null = null;
let playbackCallback: PlaybackCallback | null = null;

// ============================================
// INITIALISATION
// ============================================

/**
 * Initialise le service audio pour l'enregistrement de vocaux
 */
export async function initializeVoiceService(): Promise<boolean> {
  try {
    // Demander les permissions
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== 'granted') {
      console.error('🎤 Permission microphone refusée');
      return false;
    }

    // FIX: Configurer en mode LECTURE seule au démarrage.
    // On n'active le mode enregistrement que dans startRecording(),
    // juste avant de créer le Recording object.
    // Avant ce fix, initializeVoiceService() activait le mode enregistrement
    // dès le mount du composant, ce qui sur Android :
    //  - prenait le focus audio exclusif (DoNotMix)
    //  - maintenait la session micro active en permanence
    //  - interférait avec le clavier / routage audio après un appel
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });

    __DEV__ && console.log('🎤 Voice service initialized (playback mode)');
    return true;
  } catch (error) {
    console.error('🎤 Voice service init error:', error);
    return false;
  }
}

// ============================================
// ENREGISTREMENT
// ============================================

/**
 * Démarre l'enregistrement d'un message vocal
 * @param onUpdate - Callback pour recevoir les mises à jour (durée, waveform)
 */
export async function startRecording(
  onUpdate?: RecordingCallback
): Promise<boolean> {
  try {
    // S'assurer qu'aucun enregistrement n'est en cours
    if (state.recording) {
      await stopRecording();
    }

    // Arrêter la lecture si en cours
    if (state.sound) {
      await state.sound.stopAsync();
      await state.sound.unloadAsync();
      state.sound = null;
      state.currentPlayingId = null;
    }

    recordingCallback = onUpdate || null;
    state.meteringData = [];
    state.recordingStartTime = Date.now();

    // Configurer pour l'enregistrement
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });

    // Créer et démarrer l'enregistrement
    const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
    state.recording = recording;

    // Démarrer le suivi du metering pour la waveform
    state.meteringInterval = setInterval(async () => {
      if (state.recording) {
        try {
          const status = await state.recording.getStatusAsync();
          if (status.isRecording && status.metering !== undefined) {
            // Convertir dB en valeur 0-1 (metering est généralement entre -160 et 0)
            const normalizedLevel = Math.max(0, Math.min(1, (status.metering + 60) / 60));
            state.meteringData.push(normalizedLevel);

            // Limiter le nombre de points
            if (state.meteringData.length > 200) {
              state.meteringData = state.meteringData.slice(-200);
            }

            const duration = Date.now() - state.recordingStartTime;
            
            // Vérifier la durée maximale
            if (duration >= MAX_VOICE_DURATION_MS) {
              __DEV__ && console.log('🎤 Max duration reached, stopping recording');
              await stopRecording();
              return;
            }

            // Notifier le callback
            if (recordingCallback) {
              recordingCallback(duration, [...state.meteringData]);
            }
          }
        } catch (e) {
          // Ignorer les erreurs de status pendant l'arrêt
        }
      }
    }, 100); // Échantillonnage toutes les 100ms

    __DEV__ && console.log('🎤 Recording started');
    return true;
  } catch (error) {
    console.error('🎤 Start recording error:', error);
    return false;
  }
}

/**
 * Arrête l'enregistrement et retourne les données
 */
export async function stopRecording(): Promise<{
  uri: string;
  duration: number;
  waveform: number[];
} | null> {
  try {
    // Arrêter le metering
    if (state.meteringInterval) {
      clearInterval(state.meteringInterval);
      state.meteringInterval = null;
    }

    if (!state.recording) {
      return null;
    }

    // Arrêter l'enregistrement
    await state.recording.stopAndUnloadAsync();
    const uri = state.recording.getURI();
    const duration = Date.now() - state.recordingStartTime;

    // Réduire la waveform à WAVEFORM_SAMPLES points
    const waveform = compressWaveform(state.meteringData, WAVEFORM_SAMPLES);

    // Nettoyer
    state.recording = null;
    recordingCallback = null;

    // Reconfigurer pour la lecture
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });

    if (!uri) {
      console.error('🎤 No recording URI');
      return null;
    }

    __DEV__ && console.log('🎤 Recording stopped:', { uri, duration, waveformLength: waveform.length });

    return {
      uri,
      duration,
      waveform,
    };
  } catch (error) {
    console.error('🎤 Stop recording error:', error);
    state.recording = null;
    return null;
  }
}

/**
 * Annule l'enregistrement en cours sans sauvegarder
 */
export async function cancelRecording(): Promise<void> {
  try {
    if (state.meteringInterval) {
      clearInterval(state.meteringInterval);
      state.meteringInterval = null;
    }

    if (state.recording) {
      await state.recording.stopAndUnloadAsync();
      const uri = state.recording.getURI();
      state.recording = null;

      // Supprimer le fichier temporaire
      if (uri) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      }
    }

    state.meteringData = [];
    recordingCallback = null;
    
    // Reconfigurer pour la lecture
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });

    __DEV__ && console.log('🎤 Recording cancelled');
  } catch (error) {
    console.error('🎤 Cancel recording error:', error);
  }
}

/**
 * Vérifie si un enregistrement est en cours
 */
export function isRecording(): boolean {
  return state.recording !== null;
}

// ============================================
// LECTURE
// ============================================

/**
 * Joue un message vocal
 * @param voiceId - ID unique du vocal pour tracking
 * @param uri - URI locale du fichier audio
 * @param onUpdate - Callback pour les mises à jour de position
 */
export async function playVoice(
  voiceId: string,
  uri: string,
  onUpdate?: PlaybackCallback
): Promise<boolean> {
  try {
    // Si on joue déjà ce vocal, toggle pause/play ou rejouer depuis le début
    if (state.currentPlayingId === voiceId && state.sound) {
      const status = await state.sound.getStatusAsync();
      if (status.isLoaded) {
        if (status.isPlaying) {
          // En cours de lecture -> pause
          await state.sound.pauseAsync();
          state.isPlaying = false;
        } else {
          // En pause ou terminé -> rejouer
          // Si la position est à 0 ou proche de la fin, remettre au début
          if (state.playbackPosition === 0 || 
              (state.playbackDuration > 0 && state.playbackPosition >= state.playbackDuration - 100)) {
            await state.sound.setPositionAsync(0);
            state.playbackPosition = 0;
          }
          await state.sound.playAsync();
          state.isPlaying = true;
        }
        if (onUpdate) {
          onUpdate(state.playbackPosition, state.playbackDuration, state.isPlaying);
        }
        return true;
      }
    }

    // Arrêter tout son en cours
    if (state.sound) {
      await state.sound.stopAsync();
      await state.sound.unloadAsync();
      state.sound = null;
    }

    playbackCallback = onUpdate || null;
    state.currentPlayingId = voiceId;
    state.playbackPosition = 0;

    // Charger et jouer le son
    const { sound } = await Audio.Sound.createAsync(
      { uri },
      { shouldPlay: true },
      onPlaybackStatusUpdate
    );

    state.sound = sound;
    state.isPlaying = true;

    __DEV__ && console.log('🎤 Playing voice:', voiceId);
    return true;
  } catch (error) {
    console.error('🎤 Play voice error:', error);
    return false;
  }
}

/**
 * Met en pause la lecture
 */
export async function pauseVoice(): Promise<void> {
  if (state.sound) {
    await state.sound.pauseAsync();
    state.isPlaying = false;
  }
}

/**
 * Arrête la lecture
 */
export async function stopVoice(): Promise<void> {
  if (state.sound) {
    await state.sound.stopAsync();
    await state.sound.unloadAsync();
    state.sound = null;
    state.currentPlayingId = null;
    state.isPlaying = false;
    state.playbackPosition = 0;
    playbackCallback = null;
  }
}

/**
 * Seek dans la lecture
 * @param position - Position en millisecondes
 */
export async function seekVoice(position: number): Promise<void> {
  if (state.sound) {
    await state.sound.setPositionAsync(position);
    state.playbackPosition = position;
  }
}

/**
 * Change la vitesse de lecture
 * @param rate - Vitesse (1.0 = normale, 1.5, 2.0)
 */
export async function setPlaybackRate(rate: number): Promise<void> {
  if (state.sound) {
    await state.sound.setRateAsync(rate, true);
  }
}

/**
 * Retourne l'ID du vocal en cours de lecture
 */
export function getCurrentPlayingId(): string | null {
  return state.currentPlayingId;
}

/**
 * Callback interne pour les mises à jour de lecture
 */
function onPlaybackStatusUpdate(status: any): void {
  if (status.isLoaded) {
    state.playbackPosition = status.positionMillis || 0;
    state.playbackDuration = status.durationMillis || 0;
    state.isPlaying = status.isPlaying;

    if (playbackCallback) {
      playbackCallback(state.playbackPosition, state.playbackDuration, state.isPlaying);
    }

    // Fin de lecture - ne pas réinitialiser playbackPosition à 0 pour permettre le rejeu
    // On signale juste que la lecture est terminée mais on garde la référence au son
    if (status.didJustFinish) {
      state.isPlaying = false;
      // IMPORTANT: On ne remet PAS playbackPosition à 0 ici
      // Cela permet de détecter que la lecture est terminée et de la relancer
      // La position sera remise à 0 quand on appelle playVoice à nouveau
      if (playbackCallback) {
        // Envoyer la durée totale comme position pour indiquer la fin
        playbackCallback(state.playbackDuration, state.playbackDuration, false);
      }
    }
  }
}

// ============================================
// CHIFFREMENT
// ============================================

/**
 * Chiffre un fichier audio avec une clé unique
 */
export async function encryptVoice(uri: string): Promise<EncryptedVoiceData> {
  // Lire le fichier en base64
  const base64Data = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Convertir en Uint8Array
  const audioData = decodeBase64(base64Data);

  // Générer une clé unique pour ce fichier
  const fileKey = getRandomBytes(32);
  const nonce = getRandomBytes(nacl.secretbox.nonceLength);

  // Chiffrer
  const encrypted = nacl.secretbox(audioData, nonce, fileKey);

  if (!encrypted) {
    throw new Error('Échec du chiffrement du vocal');
  }

  return {
    encryptedData: encrypted,
    nonce,
    fileKey,
  };
}

/**
 * Déchiffre un fichier audio
 */
export function decryptVoice(
  encryptedData: Uint8Array,
  nonce: Uint8Array,
  fileKey: Uint8Array
): Uint8Array {
  const decrypted = nacl.secretbox.open(encryptedData, nonce, fileKey);

  if (!decrypted) {
    throw new Error('Échec du déchiffrement du vocal');
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
  return encodeBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Upload un vocal chiffré sur Supabase Storage
 * @param storagePath - Le chemin de base (tag anonyme) pour le stockage
 * @param voiceUri - URI locale du fichier audio
 * @param duration - Durée en millisecondes
 * @param waveform - Données de waveform
 */
export async function uploadEncryptedVoice(
  storagePath: string,
  voiceUri: string,
  duration: number,
  waveform: number[]
): Promise<UploadedVoice> {
  const fileId = generateAnonymousFileId();

  // Obtenir la taille du fichier
  const fileInfo = await FileSystem.getInfoAsync(voiceUri);
  const fileSize = fileInfo.exists ? (fileInfo as any).size || 0 : 0;

  // Valider la taille
  if (fileSize > MAX_VOICE_SIZE_BYTES) {
    throw new Error(`VOICE_TOO_LARGE:${(fileSize / (1024 * 1024)).toFixed(1)}`);
  }

  // Chiffrer le vocal
  const encrypted = await encryptVoice(voiceUri);

  // Path dans le storage (anonymisé avec le tag)
  const fullPath = `${storagePath}/${fileId}_voice.enc`;

  // Upload du fichier chiffré
  const { error } = await supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .upload(fullPath, encrypted.encryptedData, {
      contentType: 'application/octet-stream',
      cacheControl: '3600',
      upsert: false,
    });

  if (error) {
    throw new Error(`Échec upload vocal: ${error.message}`);
  }

  // Obtenir l'URL publique
  const { data: urlData } = supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(fullPath);

  // Supprimer le fichier local temporaire
  try {
    await FileSystem.deleteAsync(voiceUri, { idempotent: true });
  } catch (e) {
    console.warn('Erreur suppression fichier vocal temporaire:', e);
  }

  return {
    fileId,
    storagePath,
    fileUrl: urlData.publicUrl,
    fileKey: encrypted.fileKey,
    fileNonce: encrypted.nonce,
    metadata: {
      duration,
      size: fileSize,
      waveform,
      mimeType: 'audio/mp4',
    },
  };
}

/**
 * Chiffre la clé du fichier avec la clé E2E de la conversation
 */
export function encryptVoiceKey(fileKey: Uint8Array, e2eKey: Uint8Array): string {
  const nonce = getRandomBytes(nacl.secretbox.nonceLength);
  const encrypted = nacl.secretbox(fileKey, nonce, e2eKey);

  if (!encrypted) {
    throw new Error('Échec chiffrement clé vocal');
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
export function decryptVoiceKey(encryptedKey: string, e2eKey: Uint8Array): Uint8Array {
  const combined = decodeBase64(encryptedKey);
  const nonce = combined.slice(0, nacl.secretbox.nonceLength);
  const encrypted = combined.slice(nacl.secretbox.nonceLength);

  const decrypted = nacl.secretbox.open(encrypted, nonce, e2eKey);

  if (!decrypted) {
    throw new Error('Échec déchiffrement clé vocal');
  }

  return decrypted;
}

/**
 * Crée le payload pour un message vocal
 */
export function createVoiceMessagePayload(
  uploadedVoice: UploadedVoice,
  e2eKey: Uint8Array
): VoiceMessagePayload {
  // Chiffrer la clé du fichier avec la clé E2E
  const fileKeyEncrypted = encryptVoiceKey(uploadedVoice.fileKey, e2eKey);

  return {
    type: 'voice',
    fileId: uploadedVoice.fileId,
    storagePath: uploadedVoice.storagePath,
    fileKeyEncrypted,
    fileNonce: encodeBase64(uploadedVoice.fileNonce),
    metadata: uploadedVoice.metadata,
  };
}

// ============================================
// TÉLÉCHARGEMENT ET CACHE
// ============================================

const voiceCache = new Map<string, string>();

/**
 * Télécharge et déchiffre un vocal
 */
export async function downloadAndDecryptVoice(
  url: string,
  fileKeyEncrypted: string,
  nonceBase64: string,
  e2eKey: Uint8Array
): Promise<string> {
  // Déchiffrer la clé du fichier
  const fileKey = decryptVoiceKey(fileKeyEncrypted, e2eKey);
  const nonce = decodeBase64(nonceBase64);

  // Télécharger le fichier chiffré
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Échec téléchargement: ${response.status}`);
  }

  const encryptedBuffer = await response.arrayBuffer();
  const encryptedData = new Uint8Array(encryptedBuffer);

  // Déchiffrer
  const decryptedData = decryptVoice(encryptedData, nonce, fileKey);

  // Sauvegarder temporairement pour lecture
  const cacheDir = FileSystem.cacheDirectory + 'whisper-voice/';
  await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });

  const tempPath = cacheDir + generateAnonymousFileId() + '.m4a';
  await FileSystem.writeAsStringAsync(
    tempPath,
    encodeBase64(decryptedData),
    { encoding: FileSystem.EncodingType.Base64 }
  );

  return tempPath;
}

/**
 * Obtient un vocal du cache ou le télécharge
 */
export async function getCachedVoice(
  fileId: string,
  url: string,
  fileKeyEncrypted: string,
  nonceBase64: string,
  e2eKey: Uint8Array
): Promise<string> {
  // Vérifier le cache mémoire
  if (voiceCache.has(fileId)) {
    const cachedPath = voiceCache.get(fileId)!;
    const info = await FileSystem.getInfoAsync(cachedPath);
    if (info.exists) {
      return cachedPath;
    }
  }

  // Télécharger et déchiffrer
  const localPath = await downloadAndDecryptVoice(
    url,
    fileKeyEncrypted,
    nonceBase64,
    e2eKey
  );

  // Mettre en cache
  voiceCache.set(fileId, localPath);

  return localPath;
}

/**
 * Nettoie le cache de vocaux
 */
export async function clearVoiceCache(): Promise<void> {
  const cacheDir = FileSystem.cacheDirectory + 'whisper-voice/';
  try {
    await FileSystem.deleteAsync(cacheDir, { idempotent: true });
    voiceCache.clear();
  } catch (e) {
    console.warn('Erreur nettoyage cache vocaux:', e);
  }
}

// ============================================
// SUPPRESSION
// ============================================

/**
 * Supprime un vocal du storage
 */
export async function deleteVoiceFromStorage(
  storagePath: string,
  fileId: string
): Promise<void> {
  const fullPath = `${storagePath}/${fileId}_voice.enc`;

  await supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .remove([fullPath]);

  // Nettoyer le cache local
  voiceCache.delete(fileId);
}

// ============================================
// URL PUBLIQUE
// ============================================

/**
 * Génère l'URL publique d'un vocal dans le storage
 */
export function getVoicePublicUrl(storagePath: string, fileId: string): string {
  const fullPath = `${storagePath}/${fileId}_voice.enc`;
  const { data } = supabaseStorage.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(fullPath);
  return data.publicUrl;
}

// ============================================
// UTILITAIRES
// ============================================

/**
 * Compresse les données de waveform en un nombre fixe de points
 */
function compressWaveform(data: number[], targetSamples: number): number[] {
  if (data.length === 0) {
    return new Array(targetSamples).fill(0.1); // Valeur minimale par défaut
  }

  if (data.length <= targetSamples) {
    // Pas assez de données, on complète avec des valeurs interpolées
    const result: number[] = [];
    for (let i = 0; i < targetSamples; i++) {
      const index = Math.floor((i / targetSamples) * data.length);
      result.push(data[index] || 0.1);
    }
    return result;
  }

  // Réduire par moyenne de blocs
  const blockSize = data.length / targetSamples;
  const result: number[] = [];

  for (let i = 0; i < targetSamples; i++) {
    const start = Math.floor(i * blockSize);
    const end = Math.floor((i + 1) * blockSize);
    const block = data.slice(start, end);

    // Calculer la moyenne du bloc
    const avg = block.reduce((sum, v) => sum + v, 0) / block.length;
    result.push(Math.max(0.1, avg)); // Minimum 0.1 pour visibilité
  }

  return result;
}

/**
 * Formate la durée en mm:ss
 */
export function formatVoiceDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Valide un fichier vocal avant upload
 */
export async function validateVoiceFile(uri: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const fileInfo = await FileSystem.getInfoAsync(uri);
    if (!fileInfo.exists) {
      return { valid: false, error: 'Fichier introuvable' };
    }

    const sizeBytes = (fileInfo as any).size || 0;
    if (sizeBytes > MAX_VOICE_SIZE_BYTES) {
      return {
        valid: false,
        error: `Le vocal fait ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB. La limite est de ${MAX_VOICE_SIZE_MB} MB.`,
      };
    }

    return { valid: true };
  } catch (e) {
    console.error('Erreur validation vocal:', e);
    return { valid: false, error: 'Impossible de valider le fichier' };
  }
}

// ============================================
// NETTOYAGE
// ============================================

/**
 * Nettoie toutes les ressources du service
 */
export async function cleanupVoiceService(): Promise<void> {
  // Arrêter l'enregistrement si en cours
  if (state.recording) {
    await cancelRecording();
  }

  // Arrêter la lecture si en cours
  if (state.sound) {
    await stopVoice();
  }

  // Vider les callbacks
  recordingCallback = null;
  playbackCallback = null;

  __DEV__ && console.log('🎤 Voice service cleaned up');
}