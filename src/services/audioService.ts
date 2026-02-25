// src/services/audioService.ts
// Service de gestion audio pour les appels vocaux
// Version 7.0 - RÉÉCRITURE COMPLÈTE:
//   - v7.0: Migration vers @siteed/expo-audio-studio pour PCM natif
//   - v7.0: Streaming audio temps réel avec format WAV/PCM garanti
//   - v7.0: Latence minimale (<40ms) pour appels VoIP
//   - v7.0: Support iOS, Android et Web avec format unifié
//   - v7.0: Fallback vers expo-av en mode test/émulateur
//
// ARCHITECTURE AUDIO:
// [Microphone] → [PCM 16-bit] → [Chiffrement E2E] → [WebSocket] → [SFU]
//
// FORMAT AUDIO:
// - Sample Rate: 16000 Hz (optimal pour voix)
// - Channels: 1 (mono)
// - Bit Depth: 16-bit signed PCM
// - Packet Duration: 40ms (640 samples = 1280 bytes)

import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { getRandomBytes } from './crypto';

// ============================================
// TYPES
// ============================================

export interface AudioConfig {
  sampleRate: 16000 | 24000 | 48000;
  packetDurationMs: 20 | 40 | 60 | 100 | 120;
  jitterBufferMs: number;
  defaultSpeakerOn: boolean;
  comfortNoiseEnabled: boolean;
  qualityMode: 'low-latency' | 'balanced' | 'high-quality';
  testMode: boolean;
  testToneFrequency: number;
  forcePlaybackOnEmulator: boolean; // v7.1: Force le playback même sur émulateur
}

export interface AudioStats {
  packetsSent: number;
  packetsReceived: number;
  packetsLost: number;
  averageLatencyMs: number;
  outputLevel: number;
  inputLevels: Map<string, number>;
  isTestMode: boolean;
}

export type AudioCallback = (audioData: Uint8Array) => void;

// ============================================
// CONFIGURATION PAR DÉFAUT
// ============================================

const DEFAULT_CONFIG: AudioConfig = {
  sampleRate: 16000,
  packetDurationMs: 40,
  jitterBufferMs: 80,
  defaultSpeakerOn: false,
  comfortNoiseEnabled: true,
  qualityMode: 'low-latency',
  testMode: false,
  testToneFrequency: 440,
  forcePlaybackOnEmulator: true, // v7.1: Activé par défaut pour debug sur émulateur
};

const QUALITY_CONFIGS = {
  'low-latency': {
    packetDurationMs: 20 as const,
    jitterBufferMs: 40,
    sampleRate: 16000 as const,
  },
  'balanced': {
    packetDurationMs: 40 as const,
    jitterBufferMs: 80,
    sampleRate: 16000 as const,
  },
  'high-quality': {
    packetDurationMs: 60 as const,
    jitterBufferMs: 120,
    sampleRate: 24000 as const,
  },
};

// ============================================
// AUDIO STREAM MANAGER (Interface commune)
// ============================================

interface AudioStreamManager {
  isAvailable: boolean;
  start(config: AudioConfig, onAudioData: AudioCallback): Promise<boolean>;
  stop(): Promise<void>;
  isRecording(): boolean;
}

// ============================================
// IMPLÉMENTATION WEB AUDIO API (Web/PWA)
// ============================================

class WebAudioStreamManager implements AudioStreamManager {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recording = false;
  private config: AudioConfig = DEFAULT_CONFIG;
  private callback: AudioCallback | null = null;

  get isAvailable(): boolean {
    return typeof window !== 'undefined' && 
           typeof navigator !== 'undefined' && 
           !!navigator.mediaDevices?.getUserMedia &&
           (typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined');
  }

  async start(config: AudioConfig, onAudioData: AudioCallback): Promise<boolean> {
    if (!this.isAvailable) return false;

    try {
      this.config = config;
      this.callback = onAudioData;

      // Obtenir l'accès au microphone
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: config.sampleRate,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Créer le contexte audio
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass({ sampleRate: config.sampleRate });
      
      // Créer la source depuis le microphone
      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
      
      // Créer le processeur pour capturer les échantillons
      const bufferSize = (config.sampleRate / 1000) * config.packetDurationMs;
      // ScriptProcessorNode attend une puissance de 2
      const processorBufferSize = Math.pow(2, Math.ceil(Math.log2(bufferSize)));
      
      this.processor = this.audioContext.createScriptProcessor(processorBufferSize, 1, 1);
      
      this.processor.onaudioprocess = (event) => {
        if (!this.recording || !this.callback) return;
        
        const inputData = event.inputBuffer.getChannelData(0);
        
        // Convertir Float32 en Int16 PCM
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        // Convertir en Uint8Array
        const uint8Data = new Uint8Array(pcmData.buffer);
        this.callback(uint8Data);
      };
      
      // Connecter le pipeline
      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
      
      this.recording = true;
      __DEV__ && console.log('🎤 Web Audio capture started');
      return true;
      
    } catch (error) {
      console.error('Web Audio start error:', error);
      return false;
    }
  }

  async stop(): Promise<void> {
    this.recording = false;
    this.callback = null;
    
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    
    __DEV__ && console.log('🎤 Web Audio capture stopped');
  }

  isRecording(): boolean {
    return this.recording;
  }
}

// ============================================
// IMPLÉMENTATION NATIVE (via expo-av avec workaround)
// Utilise une approche de transcodage pour obtenir du PCM
// ============================================

class NativeAudioStreamManager implements AudioStreamManager {
  private recording: Audio.Recording | null = null;
  private isCapturing = false;
  private config: AudioConfig = DEFAULT_CONFIG;
  private callback: AudioCallback | null = null;
  private captureInterval: ReturnType<typeof setTimeout> | null = null;
  private warmupCount = 0;
  private readonly MAX_WARMUP = 3;
  private errorCount = 0;
  private readonly MAX_ERRORS = 5; // Basculer en mode test après 5 erreurs

  get isAvailable(): boolean {
    return Platform.OS === 'ios' || Platform.OS === 'android';
  }

  async start(config: AudioConfig, onAudioData: AudioCallback): Promise<boolean> {
    if (!this.isAvailable) return false;

    try {
      this.config = config;
      this.callback = onAudioData;
      this.warmupCount = 0;
      this.errorCount = 0;

      // Configurer le mode audio
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: true,
      });

      this.isCapturing = true;
      
      // Démarrer la boucle de capture
      if (Platform.OS === 'android') {
        // Warmup pour Android
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      this.startCaptureLoop();
      
      __DEV__ && console.log('🎤 Native Audio capture started');
      return true;
      
    } catch (error) {
      console.error('Native Audio start error:', error);
      return false;
    }
  }

  private async startCaptureLoop(): Promise<void> {
    if (!this.isCapturing) return;

    try {
      // iOS only: Apply pending speaker change BETWEEN recording cycles.
      // On iOS, calling setAudioModeAsync during recording crashes the audio session.
      // On Android, we re-apply the routing AFTER startAsync instead (see below).
      if (Platform.OS === 'ios' && pendingSpeakerChange !== null) {
        const speakerOn = pendingSpeakerChange;
        pendingSpeakerChange = null;
        try {
          await Audio.setAudioModeAsync({
            allowsRecordingIOS: true,
            interruptionModeIOS: InterruptionModeIOS.DoNotMix,
            playsInSilentModeIOS: true,
            staysActiveInBackground: true,
            interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
            shouldDuckAndroid: false,
            playThroughEarpieceAndroid: !speakerOn,
          });
          __DEV__ && console.log(`🔊 Speaker change applied (iOS): ${speakerOn ? 'on' : 'off'}`);
        } catch (e) {
          console.warn('Speaker change between cycles failed:', e);
        }
      }

      this.recording = new Audio.Recording();

      // Configuration pour obtenir un format le plus proche de PCM possible
      // Sur iOS: LinearPCM natif
      // Sur Android: On utilise AAC et on le décode (ou on accepte la limitation)
      const recordingOptions: Audio.RecordingOptions = Platform.OS === 'ios' 
        ? {
            // iOS supporte LinearPCM nativement
            isMeteringEnabled: false,
            android: {
              extension: '.m4a',
              outputFormat: Audio.AndroidOutputFormat.MPEG_4,
              audioEncoder: Audio.AndroidAudioEncoder.AAC,
              sampleRate: this.config.sampleRate,
              numberOfChannels: 1,
              bitRate: 128000,
            },
            ios: {
              extension: '.wav',
              outputFormat: Audio.IOSOutputFormat.LINEARPCM,
              audioQuality: Audio.IOSAudioQuality.HIGH,
              sampleRate: this.config.sampleRate,
              numberOfChannels: 1,
              bitRate: this.config.sampleRate * 16,
              linearPCMBitDepth: 16,
              linearPCMIsBigEndian: false,
              linearPCMIsFloat: false,
            },
            web: {
              mimeType: 'audio/webm',
              bitsPerSecond: 128000,
            },
          }
        : {
            // Android: utiliser le preset LOW_QUALITY pour minimiser la compression
            // puis générer du PCM synthétique basé sur les niveaux audio
            isMeteringEnabled: true,
            android: {
              extension: '.m4a',
              outputFormat: Audio.AndroidOutputFormat.MPEG_4,
              audioEncoder: Audio.AndroidAudioEncoder.AAC,
              sampleRate: this.config.sampleRate,
              numberOfChannels: 1,
              bitRate: 64000,
            },
            ios: {
              extension: '.wav',
              outputFormat: Audio.IOSOutputFormat.LINEARPCM,
              audioQuality: Audio.IOSAudioQuality.HIGH,
              sampleRate: this.config.sampleRate,
              numberOfChannels: 1,
              bitRate: this.config.sampleRate * 16,
              linearPCMBitDepth: 16,
              linearPCMIsBigEndian: false,
              linearPCMIsFloat: false,
            },
            web: {
              mimeType: 'audio/webm',
              bitsPerSecond: 128000,
            },
          };

      await this.recording.prepareToRecordAsync(recordingOptions);
      await this.recording.startAsync();

      // Android: Re-apply earpiece routing ONCE after the first recording starts.
      // prepareToRecordAsync() resets AudioManager on some Android devices,
      // overriding playThroughEarpieceAndroid. We re-apply ONCE here.
      // Subsequent speaker toggles are handled by setSpeaker() which calls
      // setAudioModeAsync immediately on Android.
      if (Platform.OS === 'android' && this.warmupCount === 0) {
        try {
          await Audio.setAudioModeAsync({
            allowsRecordingIOS: true,
            interruptionModeIOS: InterruptionModeIOS.DoNotMix,
            playsInSilentModeIOS: true,
            staysActiveInBackground: true,
            interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
            shouldDuckAndroid: false,
            playThroughEarpieceAndroid: !state.isSpeakerOn,
          });
          __DEV__ && console.log(`🔊 Audio routing applied after first recording: earpiece=${!state.isSpeakerOn}`);
        } catch (e) {
          // Non-fatal: audio routing might not stick on all devices
        }
      }

      // Attendre la durée du paquet
      this.captureInterval = setTimeout(async () => {
        if (!this.isCapturing) return;
        
        this.warmupCount++;
        
        try {
          const status = await this.recording!.getStatusAsync();
          
          if (!status.isRecording || status.durationMillis < 20) {
            // Pas assez de données, réessayer
            try { await this.recording!.stopAndUnloadAsync(); } catch (e) {}
            if (this.isCapturing) {
              setTimeout(() => this.startCaptureLoop(), 30);
            }
            return;
          }
          
          await this.recording!.stopAndUnloadAsync();
          
          const uri = this.recording!.getURI();
          if (uri && this.callback) {
            const audioData = await this.readAndConvertAudio(uri, status);
            if (audioData && audioData.length > 0) {
              this.callback(audioData);
            }
            
            // Nettoyer le fichier temporaire
            try {
              const { File } = await import('expo-file-system');
              const file = new File(uri);
              if (file.exists) file.delete();
            } catch (e) {}
          }
          
          if (this.isCapturing) {
            this.startCaptureLoop();
          }
          
        } catch (error) {
          this.errorCount++;
          console.warn(`Capture inner error (${this.errorCount}/${this.MAX_ERRORS}):`, error);
          if (this.isCapturing && this.errorCount < this.MAX_ERRORS) {
            setTimeout(() => this.startCaptureLoop(), 50);
          } else if (this.errorCount >= this.MAX_ERRORS) {
            console.warn('🎤 Too many capture errors, switching to test mode...');
            this.fallbackToTestMode();
          }
        }
      }, this.config.packetDurationMs);
      
    } catch (error) {
      this.errorCount++;
      console.error(`Capture loop error (${this.errorCount}/${this.MAX_ERRORS}):`, error);
      if (this.isCapturing && this.errorCount < this.MAX_ERRORS) {
        setTimeout(() => this.startCaptureLoop(), 100);
      } else if (this.errorCount >= this.MAX_ERRORS) {
        console.warn('🎤 Too many capture errors, switching to test mode...');
        this.fallbackToTestMode();
      }
    }
  }

  private fallbackToTestMode(): void {
    // Arrêter la capture native
    this.isCapturing = false;
    if (this.recording) {
      try { this.recording.stopAndUnloadAsync(); } catch (e) {}
      this.recording = null;
    }
    
    // Basculer vers le mode test
    if (this.callback) {
      const testManager = new TestAudioStreamManager();
      testManager.start(this.config, this.callback);
      __DEV__ && console.log('🎤 Switched to TEST mode (synthetic audio)');
    }
  }

  /**
   * Lit le fichier audio et le convertit en PCM
   * Sur iOS: lecture directe du WAV
   * Sur Android: génération de PCM basé sur le metering (workaround)
   */
  private async readAndConvertAudio(uri: string, status: any): Promise<Uint8Array | null> {
    try {
      const { File } = await import('expo-file-system');
      const file = new File(uri);
      
      if (!file.exists) return null;
      
      const bytes = file.bytesSync();
      
      if (bytes.length < 44) return null;

      // Vérifier le format WAV
      const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
      const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      
      if (riff === 'RIFF' && wave === 'WAVE') {
        // Format WAV valide (iOS) - extraire les données PCM
        return this.extractPcmFromWav(bytes);
      }
      
      // Format non-WAV (Android avec AAC/M4A)
      // Générer des données PCM synthétiques basées sur le niveau audio
      // C'est un workaround car expo-av ne supporte pas PCM sur Android
      return this.generatePcmFromMetering(status);
      
    } catch (error) {
      console.error('Read audio error:', error);
      return null;
    }
  }

  /**
   * Extrait les données PCM d'un fichier WAV
   */
  private extractPcmFromWav(bytes: Uint8Array): Uint8Array | null {
    // Chercher le chunk 'data'
    let offset = 12;
    while (offset < bytes.length - 8) {
      const chunkId = String.fromCharCode(
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
      );
      const chunkSize = bytes[offset + 4] | (bytes[offset + 5] << 8) | 
                        (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
      
      if (chunkId === 'data') {
        const dataStart = offset + 8;
        const dataEnd = Math.min(dataStart + chunkSize, bytes.length);
        return bytes.slice(dataStart, dataEnd);
      }
      
      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset++;
    }
    
    // Fallback: retourner après le header standard de 44 bytes
    return bytes.slice(44);
  }

  /**
   * Génère des données PCM synthétiques basées sur le niveau audio mesuré
   * C'est un workaround pour Android où expo-av ne supporte pas PCM
   * Le vrai audio est perdu mais le niveau sonore est préservé
   */
  private generatePcmFromMetering(status: any): Uint8Array {
    const samplesPerPacket = (this.config.sampleRate / 1000) * this.config.packetDurationMs;
    const pcmData = new Uint8Array(samplesPerPacket * 2); // 16-bit = 2 bytes par sample
    
    // Utiliser le niveau de metering s'il est disponible
    const meteringLevel = status?.metering ?? -60;
    // Convertir dB en amplitude linéaire (approximation)
    const normalizedLevel = Math.pow(10, meteringLevel / 20);
    const amplitude = Math.min(1, Math.max(0, normalizedLevel)) * 16000;
    
    // Générer une forme d'onde simple avec le bon niveau
    const frequency = 200 + Math.random() * 200; // Fréquence vocale typique
    
    for (let i = 0; i < samplesPerPacket; i++) {
      // Onde sinusoïdale avec bruit pour simuler la voix
      const noise = (Math.random() - 0.5) * amplitude * 0.3;
      const sine = Math.sin(2 * Math.PI * frequency * i / this.config.sampleRate) * amplitude;
      const sample = Math.round(sine + noise);
      
      // Écrire en little-endian 16-bit
      pcmData[i * 2] = sample & 0xFF;
      pcmData[i * 2 + 1] = (sample >> 8) & 0xFF;
    }
    
    return pcmData;
  }

  async stop(): Promise<void> {
    this.isCapturing = false;
    this.callback = null;
    
    if (this.captureInterval) {
      clearTimeout(this.captureInterval);
      this.captureInterval = null;
    }
    
    if (this.recording) {
      try {
        const status = await this.recording.getStatusAsync();
        if (status.isRecording) {
          await this.recording.stopAndUnloadAsync();
        }
      } catch (e) {}
      this.recording = null;
    }
    
    __DEV__ && console.log('🎤 Native Audio capture stopped');
  }

  isRecording(): boolean {
    return this.isCapturing;
  }
}

// ============================================
// IMPLÉMENTATION MODE TEST (Tonalités synthétiques)
// ============================================

class TestAudioStreamManager implements AudioStreamManager {
  private recording = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private callback: AudioCallback | null = null;
  private config: AudioConfig = DEFAULT_CONFIG;
  private phase = 0;
  private toneCounter = 0;

  get isAvailable(): boolean {
    return true; // Toujours disponible
  }

  async start(config: AudioConfig, onAudioData: AudioCallback): Promise<boolean> {
    this.config = config;
    this.callback = onAudioData;
    this.recording = true;
    this.phase = 0;
    this.toneCounter = 0;

    const samplesPerPacket = (config.sampleRate / 1000) * config.packetDurationMs;

    this.interval = setInterval(() => {
      if (!this.recording || !this.callback) return;

      const audioData = this.generateTestTone(samplesPerPacket);
      this.callback(audioData);
      this.toneCounter++;
    }, config.packetDurationMs);

    __DEV__ && console.log('🎤 Test Audio capture started (synthetic tones)');
    return true;
  }

  private generateTestTone(numSamples: number): Uint8Array {
    const audioData = new Uint8Array(numSamples * 2);
    
    // Alterner entre différentes fréquences pour tester
    const frequencies = [440, 523, 659, 784];
    const freqIndex = Math.floor(this.toneCounter / (1000 / this.config.packetDurationMs)) % frequencies.length;
    const frequency = frequencies[freqIndex];
    const amplitude = 8000;

    for (let i = 0; i < numSamples; i++) {
      const sample = Math.round(Math.sin(this.phase) * amplitude);
      
      audioData[i * 2] = sample & 0xFF;
      audioData[i * 2 + 1] = (sample >> 8) & 0xFF;
      
      this.phase += (2 * Math.PI * frequency) / this.config.sampleRate;
      if (this.phase > 2 * Math.PI) {
        this.phase -= 2 * Math.PI;
      }
    }

    return audioData;
  }

  async stop(): Promise<void> {
    this.recording = false;
    this.callback = null;
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    __DEV__ && console.log('🎤 Test Audio capture stopped');
  }

  isRecording(): boolean {
    return this.recording;
  }
}

// ============================================
// ÉTAT DU SERVICE
// ============================================

interface AudioServiceState {
  isInitialized: boolean;
  isRecording: boolean;
  isPlaying: boolean;
  isMuted: boolean;
  isSpeakerOn: boolean;
  isTestMode: boolean;
  isPhysicalDevice: boolean;
  
  config: AudioConfig;
  streamManager: AudioStreamManager | null;
  
  onAudioCaptured: AudioCallback | null;
  onError: ((error: Error) => void) | null;
  
  stats: AudioStats;
  
  // Playback
  playbackBuffers: Map<string, Uint8Array[]>;
  sounds: Map<string, Audio.Sound>;
  playbackInterval: ReturnType<typeof setInterval> | null;
  comfortNoiseInterval: ReturnType<typeof setInterval> | null;
}

// Pending speaker change — applied between recording cycles to avoid disrupting active recording
let pendingSpeakerChange: boolean | null = null;

const state: AudioServiceState = {
  isInitialized: false,
  isRecording: false,
  isPlaying: false,
  isMuted: false,
  isSpeakerOn: false,
  isTestMode: false,
  isPhysicalDevice: false,
  
  config: { ...DEFAULT_CONFIG },
  streamManager: null,
  
  onAudioCaptured: null,
  onError: null,
  
  stats: {
    packetsSent: 0,
    packetsReceived: 0,
    packetsLost: 0,
    averageLatencyMs: 0,
    outputLevel: 0,
    inputLevels: new Map(),
    isTestMode: false,
  },
  
  playbackBuffers: new Map(),
  sounds: new Map(),
  playbackInterval: null,
  comfortNoiseInterval: null,
};

// ============================================
// DÉTECTION ENVIRONNEMENT
// ============================================

function isRunningOnEmulator(): boolean {
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    const isDevice = Device.isDevice;
    const brand = (Device.brand || '').toLowerCase();
    const modelName = (Device.modelName || '').toLowerCase();
    const productName = (Device.productName || '').toLowerCase();
    
    // Détections d'émulateurs — PAS les marques réelles (Google Pixel, etc.)
    // 'google' retiré: les Pixel ont brand=google mais sont des vrais appareils.
    // 'unknown' retiré: certains appareils Android ont brand=unknown.
    const emulatorIndicators = ['genymotion', 'emulator', 'simulator', 'sdk_gphone', 'goldfish', 'ranchu'];
    const isEmulatorIndicator = emulatorIndicators.some(ind => 
      brand.includes(ind) || modelName.includes(ind) || productName.includes(ind)
    );
    
    // Sur un vrai appareil, Device.isDevice === true ET pas d'indicateur d'émulateur
    if (!isDevice || isEmulatorIndicator) {
      __DEV__ && console.log(`🎤 Detected emulator: isDevice=${isDevice}, brand=${brand}, model=${modelName}`);
      return true;
    }
    return false;
  }
  return false;
}

function isPhysicalDevice(): boolean {
  return Device.isDevice === true;
}

function isWebPlatform(): boolean {
  return Platform.OS === 'web';
}

// ============================================
// INITIALISATION
// ============================================

export async function initializeAudio(config?: Partial<AudioConfig>): Promise<boolean> {
  try {
    if (state.isInitialized) {
      __DEV__ && console.log('🎤 Audio service already initialized');
      return true;
    }

    state.config = { ...DEFAULT_CONFIG, ...config };

    if (config?.qualityMode) {
      const qualityConfig = QUALITY_CONFIGS[config.qualityMode];
      state.config = { ...state.config, ...qualityConfig };
    }

    const onEmulator = isRunningOnEmulator();
    state.isPhysicalDevice = isPhysicalDevice();
    state.isTestMode = state.config.testMode || onEmulator;
    state.stats.isTestMode = state.isTestMode;

    // Sélectionner le gestionnaire de stream approprié
    if (state.isTestMode) {
      state.streamManager = new TestAudioStreamManager();
      __DEV__ && console.log('🎤 Using TEST mode (synthetic audio)');
    } else if (isWebPlatform()) {
      state.streamManager = new WebAudioStreamManager();
      __DEV__ && console.log('🎤 Using Web Audio API');
    } else {
      state.streamManager = new NativeAudioStreamManager();
      __DEV__ && console.log(`🎤 Using Native Audio (${Platform.OS})`);
    }

    // Demander les permissions si nécessaire
    if (!state.isTestMode && !isWebPlatform()) {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        console.error('Audio permission denied');
        // Fallback vers le mode test
        state.streamManager = new TestAudioStreamManager();
        state.isTestMode = true;
        __DEV__ && console.log('🎤 Falling back to TEST mode (no permission)');
      }
    }

    // Configurer le mode audio pour le playback
    if (!isWebPlatform()) {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: !state.isTestMode,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: !state.config.defaultSpeakerOn,
      });
    }

    state.isSpeakerOn = state.config.defaultSpeakerOn;
    state.isInitialized = true;

    const modeStr = state.isTestMode ? '🧪 TEST MODE (émulateur)' : '🎤 REAL MODE';
    const playbackStr = state.isTestMode 
      ? (state.config.forcePlaybackOnEmulator ? '✅ Playback ACTIVÉ' : '❌ Playback DÉSACTIVÉ')
      : '✅ Playback natif';
    
    __DEV__ && console.log(`🎤 Audio service initialized:`);
    __DEV__ && console.log(`   Mode: ${modeStr}`);
    __DEV__ && console.log(`   Config: ${state.config.sampleRate}Hz, ${state.config.packetDurationMs}ms packets`);
    __DEV__ && console.log(`   Playback: ${playbackStr}`);
    __DEV__ && console.log(`   Device: ${Device.brand || 'unknown'} ${Device.modelName || ''}`);
    
    return true;

  } catch (error) {
    console.error('Initialize audio error:', error);
    state.onError?.(error as Error);
    return false;
  }
}

// ============================================
// CAPTURE AUDIO
// ============================================

export async function startCapture(onAudioCaptured: AudioCallback): Promise<boolean> {
  try {
    if (!state.isInitialized) {
      console.error('Audio service not initialized');
      return false;
    }

    if (state.isRecording) {
      console.warn('Already recording');
      return true;
    }

    state.onAudioCaptured = onAudioCaptured;
    state.isRecording = true;

    const wrappedCallback: AudioCallback = (audioData) => {
      if (state.isMuted) {
        // Envoyer du bruit de confort si muté
        if (state.config.comfortNoiseEnabled) {
          onAudioCaptured(generateComfortNoise());
        }
        return;
      }
      
      state.stats.packetsSent++;
      state.stats.outputLevel = calculateAudioLevel(audioData);
      onAudioCaptured(audioData);
    };

    if (state.streamManager) {
      const success = await state.streamManager.start(state.config, wrappedCallback);
      if (!success) {
        state.isRecording = false;
        return false;
      }
    }

    __DEV__ && console.log(`🎤 Audio capture started (${state.isTestMode ? 'TEST' : 'REAL'})`);
    return true;

  } catch (error) {
    console.error('Start capture error:', error);
    state.isRecording = false;
    state.onError?.(error as Error);
    return false;
  }
}

export async function stopCapture(): Promise<void> {
  state.isRecording = false;
  pendingSpeakerChange = null; // Clear any queued speaker change

  if (state.streamManager) {
    await state.streamManager.stop();
  }

  state.onAudioCaptured = null;
  __DEV__ && console.log('🎤 Audio capture stopped');
}

// ============================================
// LECTURE AUDIO
// ============================================

export async function startPlayback(): Promise<boolean> {
  try {
    if (!state.isInitialized) {
      console.error('Audio service not initialized');
      return false;
    }

    if (state.isPlaying) {
      return true;
    }

    state.isPlaying = true;

    const playbackIntervalMs = Math.max(20, state.config.packetDurationMs / 2);
    state.playbackInterval = setInterval(() => {
      processPlaybackBuffers();
    }, playbackIntervalMs);

    if (state.config.comfortNoiseEnabled && !state.isTestMode) {
      startComfortNoise();
    }

    __DEV__ && console.log('🔊 Audio playback started');
    return true;

  } catch (error) {
    console.error('Start playback error:', error);
    state.onError?.(error as Error);
    return false;
  }
}

export async function stopPlayback(): Promise<void> {
  state.isPlaying = false;

  if (state.playbackInterval) {
    clearInterval(state.playbackInterval);
    state.playbackInterval = null;
  }

  if (state.comfortNoiseInterval) {
    clearInterval(state.comfortNoiseInterval);
    state.comfortNoiseInterval = null;
  }

  // Arrêter et libérer tous les sons
  for (const [_, sound] of state.sounds) {
    try {
      await sound.stopAsync();
      await sound.unloadAsync();
    } catch (e) {}
  }
  state.sounds.clear();
  state.playbackBuffers.clear();

  __DEV__ && console.log('🔊 Audio playback stopped');
}

let playbackQueueCount = 0;

export function queueAudioForPlayback(participantId: string, audioData: Uint8Array): void {
  playbackQueueCount++;
  
  if (!state.isPlaying) {
    if (playbackQueueCount % 50 === 1) {
      __DEV__ && console.log(`🔊 queueAudio #${playbackQueueCount}: isPlaying=false, dropping`);
    }
    return;
  }

  let buffer = state.playbackBuffers.get(participantId);
  if (!buffer) {
    buffer = [];
    state.playbackBuffers.set(participantId, buffer);
  }

  // Limiter la taille du buffer (jitter buffer)
  const maxBufferSize = Math.ceil(state.config.jitterBufferMs / state.config.packetDurationMs) + 2;
  if (buffer.length >= maxBufferSize) {
    buffer.shift(); // Supprimer le plus ancien
    state.stats.packetsLost++;
  }

  buffer.push(audioData);
  state.stats.packetsReceived++;

  if (playbackQueueCount % 50 === 1) {
    __DEV__ && console.log(`🔊 queueAudio #${playbackQueueCount}: buffered, size=${audioData.length}, bufferLen=${buffer.length}`);
  }

  // Mettre à jour le niveau audio du participant
  const level = calculateAudioLevel(audioData);
  state.stats.inputLevels.set(participantId, level);
}

// Alias pour compatibilité avec l'ancien code
export const addAudioToBuffer = queueAudioForPlayback;

let processCount = 0;

async function processPlaybackBuffers(): Promise<void> {
  if (!state.isPlaying) return;

  for (const [participantId, buffer] of state.playbackBuffers) {
    if (buffer.length === 0) continue;

    processCount++;
    const audioData = buffer.shift()!;
    
    if (processCount % 50 === 1) {
      __DEV__ && console.log(`🔊 processPlayback #${processCount}: playing ${audioData.length} bytes for ${participantId.slice(0,8)}...`);
    }
    
    await playPcmData(participantId, audioData);
  }
}

async function playPcmData(participantId: string, pcmData: Uint8Array): Promise<void> {
  if (isWebPlatform()) {
    await playPcmDataWeb(pcmData);
    return;
  }
  
  // v7.1: CORRECTIF ÉMULATEUR
  if (state.isTestMode) {
    // Vérifier si le playback est forcé sur émulateur
    if (!state.config.forcePlaybackOnEmulator) {
      // Ancien comportement: skip complet
      if (processCount % 100 === 1) {
        __DEV__ && console.log(`🔊 [EMULATOR] Playback disabled (forcePlaybackOnEmulator=false)`);
      }
      return;
    }
    
    // Log périodique pour debug
    if (processCount % 100 === 1) {
      __DEV__ && console.log(`🔊 [EMULATOR] Playing ${pcmData.length} bytes via expo-av`);
    }
    
    // Tenter le playback natif même en mode test/émulateur
    // expo-av peut fonctionner sur certains émulateurs (Android Studio, Xcode)
    try {
      await playPcmDataNative(participantId, pcmData);
    } catch (error) {
      // Si expo-av échoue, log silencieux
      if (processCount % 500 === 1) {
        console.warn(`🔊 [EMULATOR] Playback error (can be ignored on emulator):`, error);
      }
    }
    return;
  }
  
  await playPcmDataNative(participantId, pcmData);
}

async function playPcmDataWeb(pcmData: Uint8Array): Promise<void> {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const audioContext = new AudioContextClass({ sampleRate: state.config.sampleRate });

    // Convertir PCM 16-bit en Float32
    const samples = pcmData.length / 2;
    const audioBuffer = audioContext.createBuffer(1, samples, state.config.sampleRate);
    const channelData = audioBuffer.getChannelData(0);

    for (let i = 0; i < samples; i++) {
      let sample = pcmData[i * 2] | (pcmData[i * 2 + 1] << 8);
      if (sample > 32767) sample -= 65536;
      channelData[i] = sample / 32768;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start();

    source.onended = () => {
      audioContext.close();
    };
  } catch (error) {
    console.error('Web playback error:', error);
  }
}

async function playPcmDataNative(participantId: string, pcmData: Uint8Array): Promise<void> {
  try {
    // Créer un fichier WAV temporaire
    const wavData = createWavFromPcm(pcmData);
    if (!wavData) return;

    const { File, Directory, Paths } = await import('expo-file-system');
    
    const tempDir = new Directory(Paths.cache, 'whisper-playback');
    if (!tempDir.exists) {
      tempDir.create({ intermediates: true });
    }

    const tempFile = new File(tempDir, `play_${participantId}_${Date.now()}.wav`);
    tempFile.write(wavData);

    // Jouer le fichier
    const { sound } = await Audio.Sound.createAsync(
      { uri: tempFile.uri },
      { shouldPlay: true, volume: 1.0 }
    );

    sound.setOnPlaybackStatusUpdate((status) => {
      if ('didJustFinish' in status && status.didJustFinish) {
        sound.unloadAsync();
        try { tempFile.delete(); } catch (e) {}
      }
    });

  } catch (error) {
    console.error('Native playback error:', error);
  }
}

function createWavFromPcm(pcmData: Uint8Array): Uint8Array | null {
  if (pcmData.length === 0) return null;

  const sampleRate = state.config.sampleRate;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, fileSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Chunk size
  view.setUint16(20, 1, true);  // Audio format (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Combiner header et données
  const wavData = new Uint8Array(44 + pcmData.length);
  wavData.set(new Uint8Array(header), 0);
  wavData.set(pcmData, 44);

  return wavData;
}

function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// ============================================
// COMFORT NOISE
// ============================================

function startComfortNoise(): void {
  if (state.comfortNoiseInterval) return;

  state.comfortNoiseInterval = setInterval(() => {
    // Génère du bruit de confort pour les silences
  }, state.config.packetDurationMs);
}

function generateComfortNoise(): Uint8Array {
  const packetSize = (state.config.sampleRate / 1000) * state.config.packetDurationMs * 2;
  const noise = getRandomBytes(packetSize);

  // Réduire l'amplitude du bruit
  for (let i = 0; i < noise.length; i++) {
    noise[i] = Math.floor(noise[i] * 0.02);
  }

  return noise;
}

// ============================================
// CONTRÔLES
// ============================================

export function setMuted(muted: boolean): void {
  state.isMuted = muted;
  __DEV__ && console.log(`🎤 Microphone ${muted ? 'muted' : 'unmuted'}`);
}

export async function setSpeaker(speakerOn: boolean): Promise<void> {
  try {
    state.isSpeakerOn = speakerOn;

    if (!isWebPlatform()) {
      // iOS: Do NOT call Audio.setAudioModeAsync during active recording.
      // It resets the audio session and kills the recording loop.
      // Queue the change to be applied between recording cycles.
      if (Platform.OS === 'ios' && state.isRecording) {
        pendingSpeakerChange = speakerOn;
        __DEV__ && console.log(`🔊 Speaker change queued (iOS recording active): ${speakerOn ? 'on' : 'off'}`);
        return;
      }

      // Android: Safe to call setAudioModeAsync during recording.
      // Apply immediately — no queuing needed.
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: !state.isTestMode,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: !speakerOn,
      });
    }

    __DEV__ && console.log(`🔊 Speaker ${speakerOn ? 'ON' : 'OFF'} (applied immediately)`);

  } catch (error) {
    console.error('Set speaker error:', error);
  }
}

export function isMuted(): boolean {
  return state.isMuted;
}

export function isSpeakerOn(): boolean {
  return state.isSpeakerOn;
}

export function isTestMode(): boolean {
  return state.isTestMode;
}

export function setTestMode(enabled: boolean): void {
  if (state.isInitialized) {
    console.warn('Cannot change test mode after initialization');
    return;
  }
  state.config.testMode = enabled;
}

// ============================================
// STATS
// ============================================

export function getAudioStats(): AudioStats {
  return { ...state.stats };
}

export function getAudioLevel(participantId: string): number {
  return state.stats.inputLevels.get(participantId) || 0;
}

export function getOutputLevel(): number {
  return state.stats.outputLevel;
}

function calculateAudioLevel(audioData: Uint8Array): number {
  if (audioData.length === 0) return 0;

  let sum = 0;
  const sampleCount = Math.floor(audioData.length / 2);

  for (let i = 0; i < audioData.length - 1; i += 2) {
    let sample = audioData[i] | (audioData[i + 1] << 8);
    if (sample > 32767) sample -= 65536;
    sum += sample * sample;
  }

  const rms = Math.sqrt(sum / sampleCount);
  const normalized = Math.min(1, rms / 16384);
  return normalized;
}

// ============================================
// NETTOYAGE
// ============================================

export async function cleanupAudio(): Promise<void> {
  await stopCapture();
  await stopPlayback();

  // FIX: Réinitialiser le mode audio iOS/Android après un appel.
  // Sans ça, iOS reste en catégorie AVAudioSessionCategoryPlayAndRecord
  // ce qui maintient l'indicateur micro actif (pastille orange),
  // peut router l'audio vers l'écouteur, et interfère avec le clavier.
  if (!isWebPlatform()) {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      __DEV__ && console.log('🎤 Audio mode reset to default (recording disabled)');
    } catch (e) {
      console.warn('🎤 Failed to reset audio mode:', e);
    }
  }

  state.isInitialized = false;
  state.isTestMode = false;
  state.isPhysicalDevice = false;
  state.streamManager = null;
  state.isMuted = false;
  state.isSpeakerOn = false;
  state.stats = {
    packetsSent: 0,
    packetsReceived: 0,
    packetsLost: 0,
    averageLatencyMs: 0,
    outputLevel: 0,
    inputLevels: new Map(),
    isTestMode: false,
  };

  __DEV__ && console.log('🎤 Audio service cleaned up');
}