// src/services/callTones.ts
// Tonalités d'appel modernes générées programmatiquement.
//
// - Ringback (appelant)  : Double tonalité douce pendant l'attente
// - Ringtone (appelé)    : Mélodie d'appel entrant
// - Busy                 : Tonalité d'occupation courte
// - Call connected       : Bip de confirmation discret
//
// Tout est synthétisé comme WAV PCM 16-bit, joué via expo-av en boucle.
// Aucun fichier audio externe requis.

import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import { Platform } from 'react-native';

// ============================================
// CONSTANTS
// ============================================

const SAMPLE_RATE = 44100;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

// ============================================
// STATE
// ============================================

let currentSound: Audio.Sound | null = null;
let isPlaying = false;

// ============================================
// WAV GENERATION UTILITIES
// ============================================

/**
 * Crée un header WAV pour les données PCM
 */
function createWavHeader(pcmLength: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  const byteRate = SAMPLE_RATE * blockAlign;

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmLength, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, pcmLength, true);

  return new Uint8Array(header);
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Convertit des samples Float32 [-1, 1] en PCM 16-bit Little Endian
 */
function floatToPcm16(samples: Float32Array): Uint8Array {
  const pcm = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 32768 : s * 32767;
    const val = Math.round(s);
    pcm[i * 2] = val & 0xFF;
    pcm[i * 2 + 1] = (val >> 8) & 0xFF;
  }
  return pcm;
}

/**
 * Génère un buffer WAV complet depuis des samples float
 */
function samplesToWav(samples: Float32Array): Uint8Array {
  const pcm = floatToPcm16(samples);
  const header = createWavHeader(pcm.length);
  const wav = new Uint8Array(header.length + pcm.length);
  wav.set(header, 0);
  wav.set(pcm, header.length);
  return wav;
}

// ============================================
// TONE SYNTHESIS
// ============================================

/** Sine wave avec amplitude */
function sine(phase: number): number {
  return Math.sin(phase * 2 * Math.PI);
}

/** Envelope fade in/out en samples */
function applyEnvelope(
  samples: Float32Array,
  start: number,
  length: number,
  fadeInMs: number,
  fadeOutMs: number
): void {
  const fadeInSamples = Math.floor((fadeInMs / 1000) * SAMPLE_RATE);
  const fadeOutSamples = Math.floor((fadeOutMs / 1000) * SAMPLE_RATE);

  for (let i = 0; i < length; i++) {
    let gain = 1.0;
    if (i < fadeInSamples) {
      // Smooth ease-in (cosine curve)
      gain = 0.5 * (1 - Math.cos((Math.PI * i) / fadeInSamples));
    }
    if (i >= length - fadeOutSamples) {
      const fadePos = i - (length - fadeOutSamples);
      gain *= 0.5 * (1 + Math.cos((Math.PI * fadePos) / fadeOutSamples));
    }
    samples[start + i] *= gain;
  }
}

/**
 * Génère une tonalité (somme de sinus) dans le buffer
 */
function addTone(
  samples: Float32Array,
  startMs: number,
  durationMs: number,
  frequencies: number[],
  amplitude: number,
  fadeInMs: number = 30,
  fadeOutMs: number = 50
): void {
  const startSample = Math.floor((startMs / 1000) * SAMPLE_RATE);
  const numSamples = Math.floor((durationMs / 1000) * SAMPLE_RATE);

  for (let i = 0; i < numSamples; i++) {
    const t = (startSample + i) / SAMPLE_RATE;
    let val = 0;
    for (const freq of frequencies) {
      val += sine(t * freq);
    }
    val = (val / frequencies.length) * amplitude;
    samples[startSample + i] += val;
  }

  applyEnvelope(samples, startSample, numSamples, fadeInMs, fadeOutMs);
}

// ============================================
// TONE PATTERNS
// ============================================

/**
 * RINGBACK TONE (appelant — en attente de réponse)
 * 
 * Inspiré des apps modernes (Signal, WhatsApp, Telegram) :
 * Deux impulsions douces et espacées, tonalité chaude, repos long.
 * 
 * Pattern (boucle ~4s) :
 *   [tone 400ms] — [silence 200ms] — [tone 400ms] — [silence 3s]
 * 
 * Fréquences : 440Hz + 480Hz (dual-tone doux, standard télécom adouci)
 * Amplitude faible pour ne pas agresser l'oreille.
 */
function generateRingback(): Uint8Array {
  const totalMs = 4000;
  const totalSamples = Math.floor((totalMs / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);

  // Première impulsion : 0-400ms
  addTone(samples, 0, 400, [440, 480], 0.18, 40, 60);

  // Deuxième impulsion : 600-1000ms
  addTone(samples, 600, 400, [440, 480], 0.18, 40, 60);

  // Silence 3000ms (reste du buffer = zéros)

  return samplesToWav(samples);
}

/**
 * RINGTONE (appelé — appel entrant)
 * 
 * Pattern mélodique moderne : 3 notes ascendantes avec harmoniques,
 * suivi d'un repos. Doux mais suffisamment distinctif pour attirer
 * l'attention. Inspiré des sonneries minimalistes iOS/Android récentes.
 * 
 * Pattern (boucle ~3.5s) :
 *   [C5 250ms] — [80ms] — [E5 250ms] — [80ms] — [G5 350ms] — [silence 2.5s]
 */
function generateRingtone(): Uint8Array {
  const totalMs = 3500;
  const totalSamples = Math.floor((totalMs / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);

  const amp = 0.22;

  // Note 1 : C5 (523 Hz) + harmonique douce
  addTone(samples, 0, 250, [523.25, 1046.5], amp, 20, 40);

  // Note 2 : E5 (659 Hz)
  addTone(samples, 330, 250, [659.25, 1318.5], amp, 20, 40);

  // Note 3 : G5 (784 Hz) — légèrement plus longue pour la résolution
  addTone(samples, 660, 350, [783.99, 1567.98], amp * 0.9, 20, 80);

  // Silence 2.5s

  return samplesToWav(samples);
}

/**
 * CALL CONNECTED — Bip de confirmation
 * 
 * Un seul bip court et doux pour confirmer que l'appel est connecté.
 * Discret, juste une confirmation auditive.
 */
function generateConnectedBeep(): Uint8Array {
  const totalMs = 200;
  const totalSamples = Math.floor((totalMs / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);

  addTone(samples, 0, 150, [880], 0.12, 15, 40);

  return samplesToWav(samples);
}

/**
 * BUSY TONE — Tonalité d'occupation
 * 
 * Impulsions rapides et courtes. Standard télécom.
 * Pattern : [tone 250ms] — [250ms] — [tone 250ms] — [250ms] (1s total)
 */
function generateBusyTone(): Uint8Array {
  const totalMs = 1000;
  const totalSamples = Math.floor((totalMs / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);

  addTone(samples, 0, 250, [480, 620], 0.2, 15, 30);
  addTone(samples, 500, 250, [480, 620], 0.2, 15, 30);

  return samplesToWav(samples);
}

// ============================================
// PLAYBACK
// ============================================

/**
 * Joue un buffer WAV. Si loop=true, boucle indéfiniment.
 */
async function playWav(wavData: Uint8Array, loop: boolean): Promise<void> {
  await stopCurrentTone();

  try {
    // Convertir en base64 pour expo-av
    const base64 = uint8ArrayToBase64(wavData);
    const uri = `data:audio/wav;base64,${base64}`;

    const { sound } = await Audio.Sound.createAsync(
      { uri },
      {
        isLooping: loop,
        volume: 1.0,
        shouldPlay: true,
      }
    );

    currentSound = sound;
    isPlaying = true;

    // Cleanup automatique quand le son finit (si pas en boucle)
    if (!loop) {
      sound.setOnPlaybackStatusUpdate((status) => {
        if ('didJustFinish' in status && status.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          if (currentSound === sound) {
            currentSound = null;
            isPlaying = false;
          }
        }
      });
    }

    __DEV__ && console.log(`🔔 Tone playing (loop=${loop})`);
  } catch (error) {
    console.warn('🔔 Failed to play tone:', error);
    isPlaying = false;
  }
}

/**
 * Arrête la tonalité en cours
 */
async function stopCurrentTone(): Promise<void> {
  if (currentSound) {
    try {
      await currentSound.stopAsync();
      await currentSound.unloadAsync();
    } catch (e) {
      // Son déjà déchargé
    }
    currentSound = null;
    isPlaying = false;
  }
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Joue la tonalité de retour d'appel (ringback) en boucle.
 * Pour l'appelant, pendant l'attente de réponse.
 */
export async function startRingback(): Promise<void> {
  __DEV__ && console.log('🔔 Starting ringback tone...');
  const wav = generateRingback();
  await playWav(wav, true);
}

/**
 * Joue la sonnerie d'appel entrant en boucle.
 * Pour l'appelé, quand un appel arrive.
 */
export async function startRingtone(): Promise<void> {
  __DEV__ && console.log('🔔 Starting ringtone...');
  const wav = generateRingtone();
  await playWav(wav, true);
}

/**
 * Joue le bip de confirmation de connexion (une fois).
 */
export async function playConnectedBeep(): Promise<void> {
  __DEV__ && console.log('🔔 Playing connected beep');
  const wav = generateConnectedBeep();
  await playWav(wav, false);
}

/**
 * Joue la tonalité d'occupation (une fois).
 */
export async function playBusyTone(): Promise<void> {
  __DEV__ && console.log('🔔 Playing busy tone');
  const wav = generateBusyTone();
  await playWav(wav, false);
}

/**
 * Arrête toute tonalité en cours.
 */
export async function stopTone(): Promise<void> {
  if (isPlaying) {
    __DEV__ && console.log('🔔 Stopping tone');
    await stopCurrentTone();
  }
}

/**
 * Vérifie si une tonalité est en cours de lecture.
 */
export function isTonePlaying(): boolean {
  return isPlaying;
}

// ============================================
// HELPERS
// ============================================

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // @ts-ignore — btoa est disponible en React Native (Hermes)
  return btoa(binary);
}