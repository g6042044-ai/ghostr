// src/services/audioService.ts — v24.0
//
// ARCHITECTURE (v24.0):
//
//   Android AudioTrack uses USAGE_VOICE_COMMUNICATION (via native patch)
//   so that InCallManager.setForceSpeakerphoneOn() actually controls routing.
//   Without the patch, USAGE_MEDIA ignores InCallManager → always speaker.
//
//   iOS playSound() goes through SoundPlayer AVAudioEngine with VP I/O.
//   InCallManager.start({ media: 'audio' }) sets .voiceChat mode → earpiece.
//   Microphone.swift does NOT reconfigure AVAudioSession → InCallManager preserved.
//
//   initializeAudio() → module load only, zero native calls
//   reconfigurePlaybackEngine() → setSoundConfig (AFTER InCallManager.start)
//   startCapture() → startMicrophone
//   startCallAudioPipeline() → atomic: reconfigure → capture → playback → prime → route
//
//   v24.0 KEY CHANGES:
//   - NEW startCallAudioPipeline(): single atomic function for both caller and callee
//   - reconfigurePlaybackEngine(): removed internal setForceSpeakerphoneOn call
//   - startCapture(): removed internal setForceSpeakerphoneOn call
//   - Fixed iOS VP I/O priming: always prime AFTER mic is active, regardless of
//     earlyAudioBuffer state (old logic skipped priming when buffer was non-empty)
//   - Samsung warm-up delay increased from 150ms to 300ms in reconfigurePlaybackEngine
//   - Removed hasEPAS=true fallback on setSoundConfig retry failure (silent failure mask)
//
//   cleanup: teardown everything, reset to defaults

import { Platform, DeviceEventEmitter } from 'react-native';
import * as Device from 'expo-device';
import InCallManager from 'react-native-incall-manager';
import { getRandomBytes } from './crypto';
import { setSpeakerSyncCallback, isRingtoneActive, stopInCallManager } from './callTones';

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
  forcePlaybackOnEmulator: boolean;
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

const DEFAULT_CONFIG: AudioConfig = {
  sampleRate: 16000, packetDurationMs: 40, jitterBufferMs: 80,
  defaultSpeakerOn: false, comfortNoiseEnabled: true, qualityMode: 'low-latency',
  testMode: false, testToneFrequency: 440, forcePlaybackOnEmulator: true,
};

const QUALITY_CONFIGS = {
  'low-latency':  { packetDurationMs: 20 as const, jitterBufferMs: 40,  sampleRate: 16000 as const },
  'balanced':     { packetDurationMs: 40 as const, jitterBufferMs: 80,  sampleRate: 16000 as const },
  'high-quality': { packetDurationMs: 60 as const, jitterBufferMs: 120, sampleRate: 24000 as const },
};

// ============================================
// STATE
// ============================================

let initialized = false;
let recording = false;
let playing = false;
let muted = false;
let speakerOn = false;
let config: AudioConfig = { ...DEFAULT_CONFIG };
let playCount = 0;

let EPAS: any = null;       // native module — nulled in cleanup for cold reset (v30.0)
let hasEPAS = false;         // true after setSoundConfig succeeds
let androidWarmUpDone = false; // v30.1: Skip warm-up cycle on 2nd+ Android call (routing table already primed)
let micSub: { remove(): void } | null = null;
let stopMicPromise: Promise<void> | null = null;
let captureCallback: AudioCallback | null = null;

const stats: AudioStats = {
  packetsSent: 0, packetsReceived: 0, packetsLost: 0,
  averageLatencyMs: 0, outputLevel: 0, inputLevels: new Map(), isTestMode: false,
};

// ============================================
// GAIN
// ============================================
// v22.1: With USAGE_VOICE_COMMUNICATION (native patch), Android audio routes
// through the voice call stream at correct call volume. ANY software gain
// overwhelms the platform AEC → echo. Set everything to 1.0 (passthrough).
// iOS VP I/O also handles volume correctly. No gain needed on either platform.

interface GainProfile { earpiece: number; speaker: number; }

const ANDROID_GAINS: Record<string, GainProfile> = {};
const ANDROID_DEFAULT: GainProfile = { earpiece: 1.0, speaker: 1.0 };
const IOS_GAIN: GainProfile = { earpiece: 1.0, speaker: 1.0 };

function getPlaybackGain(): number {
  if (Platform.OS === 'ios') return speakerOn ? IOS_GAIN.speaker : IOS_GAIN.earpiece;
  if (Platform.OS !== 'android') return 1.0;
  const brand = (Device.brand || '').toLowerCase();
  const p = ANDROID_GAINS[brand] || ANDROID_DEFAULT;
  return speakerOn ? p.speaker : p.earpiece;
}

const MAX_PCM_CHUNK = 3200;

// ============================================
// WEB AUDIO (unchanged)
// ============================================

let webCtx: AudioContext | null = null; let webStream: MediaStream | null = null;
let webProc: ScriptProcessorNode | null = null; let webSrc: MediaStreamAudioSourceNode | null = null; let webOn = false;
async function startWebCapture(cfg: AudioConfig, cb: AudioCallback): Promise<boolean> { if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false; try { webStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: cfg.sampleRate, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); const C = window.AudioContext || (window as any).webkitAudioContext; webCtx = new C({ sampleRate: cfg.sampleRate }); webSrc = webCtx.createMediaStreamSource(webStream); const bs = Math.pow(2, Math.ceil(Math.log2((cfg.sampleRate / 1000) * cfg.packetDurationMs))); webProc = webCtx.createScriptProcessor(bs, 1, 1); webProc.onaudioprocess = (e) => { if (!webOn) return; const inp = e.inputBuffer.getChannelData(0); const pcm = new Int16Array(inp.length); for (let i = 0; i < inp.length; i++) { const s = Math.max(-1, Math.min(1, inp[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; } cb(new Uint8Array(pcm.buffer)); }; webSrc.connect(webProc); webProc.connect(webCtx.destination); webOn = true; return true; } catch (e) { __DEV__ && console.error('Web capture:', e); return false; } }
async function stopWebCapture(): Promise<void> { webOn = false; if (webProc) { webProc.disconnect(); webProc = null; } if (webSrc) { webSrc.disconnect(); webSrc = null; } if (webCtx) { await webCtx.close(); webCtx = null; } if (webStream) { webStream.getTracks().forEach(t => t.stop()); webStream = null; } }
async function playPcmWeb(pcm: Uint8Array, sr: number): Promise<void> { try { const C = window.AudioContext || (window as any).webkitAudioContext; const c = new C({ sampleRate: sr }); const n = pcm.length / 2; const buf = c.createBuffer(1, n, sr); const ch = buf.getChannelData(0); for (let i = 0; i < n; i++) { let s = pcm[i * 2] | (pcm[i * 2 + 1] << 8); if (s > 32767) s -= 65536; ch[i] = s / 32768; } const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination); src.start(); src.onended = () => c.close(); } catch {} }

// ============================================
// HELPERS
// ============================================

function b64toU8(b: string): Uint8Array { try { const s = atob(b); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; } catch { return new Uint8Array(0); } }
function u8toB64(u: Uint8Array): string { let b = ''; for (let i = 0; i < u.length; i++) b += String.fromCharCode(u[i]); return btoa(b); }
function audioLevel(d: Uint8Array): number { if (d.length < 2) return 0; let sum = 0; const n = d.length / 2; for (let i = 0; i < n; i++) { let s = d[i * 2] | (d[i * 2 + 1] << 8); if (s > 32767) s -= 65536; sum += s * s; } return Math.sqrt(sum / n) / 32768; }
function comfortNoise(): Uint8Array { const sz = (config.sampleRate / 1000) * config.packetDurationMs * 2; const n = getRandomBytes(sz); for (let i = 0; i < n.length; i++) n[i] = Math.floor(n[i] * 0.02); return n; }
function isWeb(): boolean { return Platform.OS === 'web'; }

function applyPlaybackGain(pcm: Uint8Array, gain: number): Uint8Array {
  if (gain === 1.0 || pcm.length < 2) return pcm;
  const KNEE = 24575; const HEAD = 32767 - KNEE;
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    let s = pcm[i] | (pcm[i + 1] << 8);
    if (s > 32767) s -= 65536;
    s = (s * gain) | 0;
    if (s > KNEE) { s = KNEE + HEAD * Math.tanh((s - KNEE) / HEAD); }
    else if (s < -KNEE) { s = -(KNEE + HEAD * Math.tanh((-s - KNEE) / HEAD)); }
    s = Math.round(s);
    out[i] = s & 0xFF;
    out[i + 1] = (s >> 8) & 0xFF;
  }
  return out;
}

function emitChunked(pcm: Uint8Array, cb: AudioCallback): void {
  if (pcm.length <= MAX_PCM_CHUNK) { stats.packetsSent++; cb(pcm); return; }
  let offset = 0;
  while (offset < pcm.length) {
    const end = Math.min(offset + MAX_PCM_CHUNK, pcm.length);
    const aligned = end - (end % 2);
    if (aligned <= offset) break;
    stats.packetsSent++;
    cb(pcm.slice(offset, aligned));
    offset = aligned;
  }
}

// ============================================
// PRE-WARM
// ============================================

let nativePreWarmed = false;

export async function preWarmNativeAudio(): Promise<void> {
  if (isWeb() || nativePreWarmed) return;
  try {
    const mod = await import('@mykin-ai/expo-audio-stream');
    EPAS = mod.ExpoPlayAudioStream || mod.default;
    if (!EPAS || typeof EPAS.setSoundConfig !== 'function') { EPAS = null; }
    else { __DEV__ && console.log('🎤 [PreWarm] EPAS ✅'); }
    nativePreWarmed = true;
  } catch (e) { __DEV__ && console.warn('🎤 [PreWarm] Failed:', e); }
}

// ============================================
// INITIALIZE — module load only
// ============================================

export async function initializeAudio(cfg?: Partial<AudioConfig>): Promise<boolean> {
  try {
    if (initialized) return true;
    config = { ...DEFAULT_CONFIG, ...cfg };
    if (cfg?.qualityMode) config = { ...config, ...QUALITY_CONFIGS[cfg.qualityMode] };
    if (isWeb()) { initialized = true; speakerOn = config.defaultSpeakerOn; return true; }

    if (stopMicPromise) {
      __DEV__ && console.log('🎤 Waiting for pending mic stop...');
      try { await stopMicPromise; } catch {}
      stopMicPromise = null;
    }

    if (!EPAS) {
      try { const mod = await import('@mykin-ai/expo-audio-stream'); EPAS = mod.ExpoPlayAudioStream || mod.default; } catch {}
    }
    if (!EPAS || typeof EPAS.setSoundConfig !== 'function') {
      __DEV__ && console.error('🎤 ❌ EPAS not available');
      return false;
    }

    // v22: NO setSoundConfig() here. hasEPAS stays false until reconfigurePlaybackEngine().
    speakerOn = config.defaultSpeakerOn;
    initialized = true;
    stats.isTestMode = false;
    __DEV__ && console.log(`🎤 Init ✅ (module loaded) | ${Platform.OS} | ${Device.brand || '?'}`);
    return true;
  } catch (e) { __DEV__ && console.error('🎤 Init error:', e); return false; }
}

// ============================================
// RECONFIGURE — the SOLE setSoundConfig call
// ============================================
// MUST be called AFTER InCallManager.start() has set MODE_IN_COMMUNICATION
// (via transitionToCallAudio which guarantees settle delay).
//
// v24.0: Removed internal setForceSpeakerphoneOn() call. Route enforcement
// is now done ONCE at the end of startCallAudioPipeline() to prevent
// multiple competing route changes that confuse Samsung's AudioPolicyManager.

export async function reconfigurePlaybackEngine(): Promise<void> {
  if (isWeb() || !EPAS) return;

  if (stopMicPromise) {
    __DEV__ && console.log('🔊 Waiting for pending mic stop before reconfigure...');
    try { await stopMicPromise; } catch {}
    stopMicPromise = null;
  }

  // Platform-specific playback mode:
  // Android 'conversation' → with native patch: USAGE_VOICE_COMMUNICATION + CONTENT_TYPE_SPEECH
  // iOS 'voiceProcessing' → VP I/O engine with AEC (playSound requires this)
  const playbackMode = Platform.OS === 'android' ? 'conversation' : 'voiceProcessing';

  __DEV__ && console.log(`🔊 [${Platform.OS}] Configuring audio engine (${playbackMode})...`);

  // Step 1: Release any leftover engine from previous call.
  // iOS: VP I/O unit drains asynchronously. 400ms ensures the AVAudioEngine
  // state machine fully settles before the warm-up cycle.
  // Android 1st call: AudioTrack.release() is async, Samsung needs 200-300ms.
  // Android 2nd+ call: EPAS was nulled in cleanup, nothing to release — skip.
  const needsRelease = Platform.OS === 'ios' || !androidWarmUpDone;
  if (needsRelease) {
    try { EPAS.stopAudio(); } catch {}
    const releaseDelay = Platform.OS === 'ios' ? 400 : 250;
    await new Promise(r => setTimeout(r, releaseDelay));
  }

  // Step 2: Engine warm-up cycle.
  //
  // Android: Primes Samsung's AudioPolicyManager routing table for
  // USAGE_VOICE_COMMUNICATION (first-call cold-start issue).
  // v30.1: SKIP on 2nd+ call — the routing table is already primed.
  // Samsung only needs the warm-up on the very first AudioTrack creation
  // in a process lifetime. Saves ~650ms on every subsequent call.
  //
  // iOS: Create a conversation-mode engine and EXERCISE IT by playing
  // silence frames. This forces CoreAudio to release VP I/O resources.
  // ALWAYS runs on iOS (VP I/O leak is per-call, not per-process).
  const needsWarmUp = Platform.OS === 'ios' || !androidWarmUpDone;
  if (needsWarmUp) {
    const warmUpMode = Platform.OS === 'android' ? playbackMode : 'conversation';
    try {
      await EPAS.setSoundConfig({ sampleRate: 16000, playbackMode: warmUpMode });

      // iOS: Exercise the warm-up engine by playing silence through it.
      // Forces CoreAudio to allocate output buffer → releases VP I/O hardware.
      if (Platform.OS === 'ios') {
        try {
          const silence = u8toB64(new Uint8Array(640));
          for (let i = 0; i < 10; i++) {
            EPAS.playSound(silence, 'call', 'pcm_s16le');
          }
        } catch {}
        await new Promise(r => setTimeout(r, 200));
      }

      try { EPAS.stopAudio(); } catch {}
      const warmUpSettle = Platform.OS === 'android' ? 400 : 500;
      await new Promise(r => setTimeout(r, warmUpSettle));
      __DEV__ && console.log(`🔊 [${Platform.OS}] Engine warm-up done (native state reset)`);
    } catch {}

    if (Platform.OS === 'android') {
      androidWarmUpDone = true;
    }
  } else {
    __DEV__ && console.log(`🔊 [android] Warm-up skipped (routing table already primed)`);
  }

  // Re-enforce InCallManager routing after warm-up.
  InCallManager.setForceSpeakerphoneOn(speakerOn ? true : false);

  // Step 3: Configure with call-mode settings
  try {
    await EPAS.setSoundConfig({ sampleRate: 16000, playbackMode });
    hasEPAS = true;
    __DEV__ && console.log(`🔊 [${Platform.OS}] setSoundConfig(${playbackMode}) ✅`);
  } catch (e) {
    __DEV__ && console.error(`🔊 [${Platform.OS}] ❌ setSoundConfig failed:`, e);
    // Retry once after delay
    await new Promise(r => setTimeout(r, 400));
    try {
      try { EPAS.stopAudio(); } catch {}
      await new Promise(r => setTimeout(r, 250));
      await EPAS.setSoundConfig({ sampleRate: 16000, playbackMode });
      hasEPAS = true;
      __DEV__ && console.log(`🔊 [${Platform.OS}] setSoundConfig (retry) ✅`);
    } catch (e2) {
      // v24.0 FIX: Do NOT set hasEPAS=true on failure. The old code masked
      // engine creation failures, allowing startCapture() and playback to
      // proceed with a dead engine → no sound. Now we properly report failure
      // and startCallAudioPipeline() will return false.
      __DEV__ && console.error(`🔊 [${Platform.OS}] ❌ setSoundConfig retry FAILED — engine not ready`);
      return; // hasEPAS remains false
    }
  }

  // Step 4: Let engine settle after creation.
  // v24.0: Route enforcement removed from here. It's now done once at the end
  // of startCallAudioPipeline(). Multiple setForceSpeakerphoneOn() calls during
  // engine startup confuse Samsung's AudioPolicyManager (each call triggers a
  // full routing re-evaluation while the engine is still initializing).
  // v29.0 FIX: iOS settle increased from 450ms to 600ms. On iOS 17+ devices
  // (iPhone 12/13/14/15), VP I/O render graph initialization can take up to
  // 550ms after setSoundConfig returns, especially on the 2nd/3rd call where
  // residual CoreAudio VP I/O resources are still being reclaimed. The render
  // callback must be fully installed before startMicrophone installs its input
  // tap, or the tap registers but the render thread never pulls from it.
  const delay = Platform.OS === 'ios' ? 600 : 200;
  await new Promise(r => setTimeout(r, delay));
  __DEV__ && console.log(`🔊 [${Platform.OS}] Engine configured (${delay}ms settle)`);
}

// ============================================
// CAPTURE
// ============================================

export async function startCapture(onAudioCaptured: AudioCallback): Promise<boolean> {
  try {
    if (!initialized) return false;
    if (recording) return true;
    if (stopMicPromise) { try { await stopMicPromise; } catch {} stopMicPromise = null; }

    captureCallback = onAudioCaptured;

    if (isWeb()) {
      recording = true;
      return await startWebCapture(config, (d) => {
        if (muted) { if (config.comfortNoiseEnabled) onAudioCaptured(comfortNoise()); return; }
        stats.packetsSent++; stats.outputLevel = audioLevel(d); onAudioCaptured(d);
      });
    }

    if (!hasEPAS || !EPAS) {
      __DEV__ && console.error('🎤 ❌ EPAS not configured (call reconfigurePlaybackEngine first)');
      return false;
    }

    const handler = (event: any) => {
      if (!recording) return;
      let pcm: Uint8Array;
      if (typeof event?.data === 'string') pcm = b64toU8(event.data);
      else if (event?.data instanceof Uint8Array) pcm = event.data;
      else if (event?.data instanceof ArrayBuffer) pcm = new Uint8Array(event.data);
      else return;
      if (pcm.length === 0) return;
      stats.outputLevel = event.soundLevel ?? audioLevel(pcm);
      if (stats.packetsSent <= 3) __DEV__ && console.log(`🎤 MIC: ${pcm.length}B`);
      if (muted) { stats.packetsSent++; if (config.comfortNoiseEnabled) onAudioCaptured(comfortNoise()); return; }
      emitChunked(pcm, onAudioCaptured);
    };

    try {
      const result = await EPAS.startMicrophone({
        sampleRate: 16000, channels: 1, encoding: 'pcm_16bit',
        enableProcessing: true, interval: 40, onAudioStream: handler,
      });
      recording = true;
      if (result?.subscription) { micSub = result.subscription; }
      if (!micSub && typeof EPAS.subscribeToAudioEvents === 'function') {
        micSub = EPAS.subscribeToAudioEvents(handler);
      }
      __DEV__ && console.log(`🎤 [${Platform.OS}] startMicrophone ✅`);
    } catch (e) {
      __DEV__ && console.error(`🎤 [${Platform.OS}] ❌ startMicrophone:`, e);
      return false;
    }

    // v24.0: Route enforcement removed from here. It's now done once at the end
    // of startCallAudioPipeline(). On Samsung, startMicrophone() can trigger an
    // internal AudioPolicyManager routing re-evaluation. If we immediately call
    // setForceSpeakerphoneOn() while that's in progress, the two routing changes
    // collide → unpredictable output device. The pipeline delay handles this.
    await new Promise(r => setTimeout(r, 100));
    __DEV__ && console.log(`🎤 [${Platform.OS}] Mic started, awaiting pipeline route enforcement`);

    return true;
  } catch (e) { __DEV__ && console.error('🎤 Capture error:', e); recording = false; return false; }
}

export async function stopCapture(): Promise<void> {
  const wasRecording = recording;
  recording = false;
  if (isWeb()) { await stopWebCapture(); return; }
  if (micSub) { try { micSub.remove(); } catch {} micSub = null; }
  if (wasRecording && EPAS && typeof EPAS.stopMicrophone === 'function') {
    const p = (async () => { try { await EPAS.stopMicrophone(); } catch {} })();
    stopMicPromise = p;
    await p;
    if (stopMicPromise === p) stopMicPromise = null;
  }
  __DEV__ && console.log('🎤 Capture stopped');
}

// iOS speaker toggle: must restart mic to change VP I/O route
async function restartMicWithRoute(toSpeaker: boolean): Promise<void> {
  if (Platform.OS !== 'ios' || !recording || !captureCallback || !EPAS) return;

  __DEV__ && console.log(`🔊 [iOS] Restarting mic for ${toSpeaker ? 'speaker' : 'earpiece'}...`);
  if (micSub) { try { micSub.remove(); } catch {} micSub = null; }
  // Gate recording so queueAudioForPlayback buffers instead of calling
  // playSound on a VP I/O whose render graph is being torn down.
  recording = false;
  try { await EPAS.stopMicrophone(); } catch {}
  stopMicPromise = null;

  InCallManager.setForceSpeakerphoneOn(toSpeaker ? true : false);
  await new Promise(r => setTimeout(r, 150));

  const cb = captureCallback;
  const handler = (event: any) => {
    if (!recording) return;
    let pcm: Uint8Array;
    if (typeof event?.data === 'string') pcm = b64toU8(event.data);
    else if (event?.data instanceof Uint8Array) pcm = event.data;
    else if (event?.data instanceof ArrayBuffer) pcm = new Uint8Array(event.data);
    else return;
    if (pcm.length === 0) return;
    stats.outputLevel = event.soundLevel ?? audioLevel(pcm);
    if (muted) { stats.packetsSent++; if (config.comfortNoiseEnabled) cb(comfortNoise()); return; }
    emitChunked(pcm, cb);
  };

  try {
    const result = await EPAS.startMicrophone({
      sampleRate: 16000, channels: 1, encoding: 'pcm_16bit',
      enableProcessing: true, interval: 40, onAudioStream: handler,
    });
    if (result?.subscription) micSub = result.subscription;
    if (!micSub && typeof EPAS.subscribeToAudioEvents === 'function') {
      micSub = EPAS.subscribeToAudioEvents(handler);
    }
    recording = true;

    // Re-prime VP I/O after mic restart
    if (hasEPAS) {
      try {
        const silence = u8toB64(new Uint8Array(640));
        for (let i = 0; i < 5; i++) EPAS.playSound(silence, 'call', 'pcm_s16le');
      } catch {}
    }

    // Flush audio buffered during the mic-off gap (trim stale packets)
    if (earlyAudioBuffer.length > 0 && playing) {
      const MAX_FLUSH = 15;
      const dropped = Math.max(0, earlyAudioBuffer.length - MAX_FLUSH);
      const trimmed = dropped > 0 ? earlyAudioBuffer.slice(-MAX_FLUSH) : earlyAudioBuffer;
      __DEV__ && console.log(`🔊 [iOS] Flushing ${trimmed.length} packets buffered during mic restart${dropped > 0 ? ` (dropped ${dropped} stale)` : ''}`);
      earlyAudioBuffer = [];
      for (const p of trimmed) queueAudioForPlayback(p.pid, p.data);
    }

    __DEV__ && console.log(`🔊 [iOS] Mic restarted on ${toSpeaker ? 'speaker' : 'earpiece'} ✅`);
  } catch (e) {
    recording = true; // Restore even on failure
    __DEV__ && console.error('🔊 [iOS] ❌ Mic restart failed:', e);
  }
}

// ============================================
// PLAYBACK
// ============================================

const EARLY_BUFFER_MAX = 200;
let earlyAudioBuffer: Array<{ pid: string; data: Uint8Array }> = [];

export async function startPlayback(): Promise<boolean> {
  if (!initialized) return false;
  if (playing) return true;
  playing = true;

  // v24.0: iOS VP I/O priming moved to startCallAudioPipeline() where it runs
  // AFTER both mic and playback are active. The old logic here had a condition
  // (earlyAudioBuffer.length === 0) that skipped priming on the caller side
  // (where early-buffered packets exist), causing VP I/O output to stay inactive.

  if (earlyAudioBuffer.length > 0) {
    // v29.0 FIX: Only flush the most recent packets to avoid stale audio lag.
    // On the 3rd+ call, earlyAudioBuffer can accumulate 60-100 packets (~1.2-2s)
    // during the transitionToCallAudio() settle delay. Flushing all of them at
    // once creates a perceptible audio burst/delay on Android. Trimming to the
    // last 15 packets (~300ms at 20ms/packet) ensures fresh audio playback.
    const MAX_FLUSH = 15;
    const dropped = Math.max(0, earlyAudioBuffer.length - MAX_FLUSH);
    const trimmed = dropped > 0 ? earlyAudioBuffer.slice(-MAX_FLUSH) : earlyAudioBuffer;
    __DEV__ && console.log(`🔊 Flushing ${trimmed.length} early-buffered packets${dropped > 0 ? ` (dropped ${dropped} stale)` : ''}`);
    earlyAudioBuffer = [];
    for (const p of trimmed) queueAudioForPlayback(p.pid, p.data);
  }
  __DEV__ && console.log('🔊 Playback started');
  return true;
}

export async function stopPlayback(): Promise<void> {
  playing = false;
  earlyAudioBuffer = [];
  __DEV__ && console.log('🔊 Playback stopped');
}

export function queueAudioForPlayback(participantId: string, audioData: Uint8Array): void {
  playCount++;
  if (!playing) {
    if (earlyAudioBuffer.length < EARLY_BUFFER_MAX) {
      earlyAudioBuffer.push({ pid: participantId, data: new Uint8Array(audioData) });
    }
    return;
  }
  stats.packetsReceived++;
  stats.inputLevels.set(participantId, audioLevel(audioData));

  if (isWeb()) { playPcmWeb(audioData, config.sampleRate); return; }
  if (!EPAS || !hasEPAS) return;

  // iOS playSound needs active mic (VP I/O). If mic is temporarily inactive
  // (during speaker toggle restartMicWithRoute), buffer instead of dropping.
  if (Platform.OS === 'ios' && !recording) {
    if (earlyAudioBuffer.length < EARLY_BUFFER_MAX) {
      earlyAudioBuffer.push({ pid: participantId, data: new Uint8Array(audioData) });
    }
    return;
  }

  try {
    const gain = getPlaybackGain();
    const playData = gain > 1.0 ? applyPlaybackGain(audioData, gain) : audioData;
    const b64 = u8toB64(playData);

    if (Platform.OS === 'ios') {
      EPAS.playSound(b64, 'call', 'pcm_s16le');
    } else {
      EPAS.playAudio(b64, 'call_audio', 'pcm_s16le');
    }
  } catch (e) {
    if (playCount % 100 === 1) {
      __DEV__ && console.error('🔊 play error:', e);
    }
  }
}

export const addAudioToBuffer = queueAudioForPlayback;

// ============================================
// CALL AUDIO PIPELINE — v24.0
// ============================================
//
// Atomic function that starts all audio engines in the correct order.
// BOTH caller (handleAnswer) and callee (acceptCall) use this.
//
// Precondition: transitionToCallAudio() has already run (InCallManager is in
// MODE_IN_COMMUNICATION and has fully settled).
//
// Order matters:
//   1. reconfigurePlaybackEngine → creates AudioTrack (Android) / VP I/O (iOS)
//   2. startCapture → starts microphone (iOS VP I/O needs recording=true)
//   3. startPlayback → enables audio output + flushes early buffer
//   4. iOS VP I/O prime → must run AFTER recording=true AND playing=true
//   5. Single route enforcement → AFTER all engines are created
//
// This eliminates the divergence where handleAnswer() and acceptCall() had
// different sequences, delays, and route enforcement timing.

export async function startCallAudioPipeline(
  onAudioCaptured: AudioCallback
): Promise<boolean> {
  if (isWeb()) return true;
  if (!EPAS || !initialized) {
    __DEV__ && console.error('🎤 ❌ startCallAudioPipeline: not initialized');
    return false;
  }

  __DEV__ && console.log(`🎤 [${Platform.OS}] startCallAudioPipeline() BEGIN`);

  // Step 1: Configure playback engine (creates AudioTrack / VP I/O)
  await reconfigurePlaybackEngine();
  if (!hasEPAS) {
    __DEV__ && console.error('🎤 ❌ startCallAudioPipeline: reconfigure failed');
    return false;
  }

  // Step 2: Start mic capture
  const captureOk = await startCapture(onAudioCaptured);
  if (!captureOk) {
    __DEV__ && console.error('🎤 ❌ startCallAudioPipeline: capture failed');
    return false;
  }

  // Step 3: Start playback (AFTER mic so iOS VP I/O has recording=true)
  await startPlayback();

  // Step 4: iOS VP I/O priming — ALWAYS prime after mic+playback are active.
  // The VP I/O render graph requires initial data to establish its output path.
  // Without priming, the VP I/O unit starts with an empty player node and its
  // render callback never activates the output → all playSound calls consumed silently.
  //
  // v24.0: This runs unconditionally (removed old earlyAudioBuffer.length === 0 condition).
  // On the caller side, early-buffered packets would skip priming → VP I/O stayed cold.
  // On the callee side, priming ran correctly but was inside startPlayback() which
  // could execute before recording=true → silent frames were dropped.
  if (Platform.OS === 'ios' && recording && EPAS && hasEPAS) {
    try {
      const silence = u8toB64(new Uint8Array(640)); // 20ms of 16kHz 16-bit mono
      for (let i = 0; i < 10; i++) {
        EPAS.playSound(silence, 'call', 'pcm_s16le');
      }
      __DEV__ && console.log('🔊 [ios] VP I/O primed (10 silent frames) ✅');
    } catch (e) {
      __DEV__ && console.warn('🔊 [ios] VP I/O prime failed:', e);
    }

    // Delayed re-prime: the VP I/O render graph output path connects
    // asynchronously. Initial prime may land before render callback installs.
    setTimeout(() => {
      if (recording && EPAS && hasEPAS) {
        try {
          const s = u8toB64(new Uint8Array(640));
          for (let i = 0; i < 5; i++) EPAS.playSound(s, 'call', 'pcm_s16le');
          __DEV__ && console.log('🔊 [ios] VP I/O re-primed (5 frames) ✅');
        } catch {}
      }
    }, 250);

    // v27.0 FIX: Third priming attempt at 500ms. On iPhone 12/13/14 with iOS 17+,
    // the VP I/O render graph can take up to 400ms to fully connect its output path
    // after the engine starts. If the first two primes land before this completes,
    // the silent frames are consumed by the engine but never reach the output.
    // This third attempt at 500ms catches the late-connecting render graph.
    setTimeout(() => {
      if (recording && EPAS && hasEPAS) {
        try {
          const s = u8toB64(new Uint8Array(640));
          for (let i = 0; i < 5; i++) EPAS.playSound(s, 'call', 'pcm_s16le');
          __DEV__ && console.log('🔊 [ios] VP I/O third prime (5 frames) ✅');
        } catch {}
      }
    }, 500);

    // v29.0 FIX: Fourth priming attempt at 1000ms. On the 2nd/3rd call,
    // residual VP I/O CoreAudio resources from the previous call can delay
    // the render graph connection by up to 800ms. The first three primes
    // may land before the graph is ready. This late prime ensures the
    // output path is activated even with delayed resource reclamation.
    setTimeout(() => {
      if (recording && EPAS && hasEPAS) {
        try {
          const s = u8toB64(new Uint8Array(640));
          for (let i = 0; i < 8; i++) EPAS.playSound(s, 'call', 'pcm_s16le');
          __DEV__ && console.log('🔊 [ios] VP I/O fourth prime (8 frames) ✅');
        } catch {}
      }
    }, 1000);
  }

  // Step 5: Single authoritative route enforcement AFTER all engines are ready.
  // This is the ONLY setForceSpeakerphoneOn call during startup. All the
  // per-step calls that existed in v22/v23 have been removed. On Samsung,
  // each setForceSpeakerphoneOn triggers a full AudioPolicyManager routing
  // re-evaluation. Multiple calls during engine startup cause race conditions
  // where the routing table is updated while engines are still initializing.
  const routeSettleMs = Platform.OS === 'android' ? 150 : 100;
  await new Promise(r => setTimeout(r, routeSettleMs));
  InCallManager.setForceSpeakerphoneOn(speakerOn ? true : false);

  __DEV__ && console.log(`🎤 [${Platform.OS}] startCallAudioPipeline() DONE, speaker=${speakerOn} ✅`);
  return true;
}

// ============================================
// CONTROLS
// ============================================

export function setMuted(m: boolean): void {
  const was = muted; muted = m;
  if (was !== m && !isWeb() && EPAS && typeof EPAS.toggleSilence === 'function' && recording) {
    try { EPAS.toggleSilence(); } catch {}
  }
  __DEV__ && console.log(`🎤 ${m ? 'Muted' : 'Unmuted'}`);
}

export async function setSpeaker(on: boolean): Promise<void> {
  if (speakerOn === on) {
    __DEV__ && console.log(`🔊 Speaker already ${on ? 'ON' : 'OFF'}, skipping`);
    return;
  }
  speakerOn = on;
  if (isWeb()) return;
  if (Platform.OS === 'ios' && recording) {
    await restartMicWithRoute(on);
  } else {
    InCallManager.setForceSpeakerphoneOn(on ? true : false);
  }
  __DEV__ && console.log(`🔊 Speaker ${on ? 'ON' : 'OFF'} | gain=${getPlaybackGain().toFixed(1)}x`);
}

export function isMuted(): boolean { return muted; }
export function isSpeakerOn(): boolean { return speakerOn; }
export function isTestMode(): boolean { return false; }
export function setTestMode(_: boolean): void {}
export function forceAudioRoute(): void {
  if (isWeb() || isRingtoneActive()) return;
  InCallManager.setForceSpeakerphoneOn(speakerOn ? true : false);
}
export const forceEarpieceNow = forceAudioRoute;

// ============================================
// PROXIMITY LISTENER
// ============================================

let proximitySubscription: { remove(): void } | null = null;

export function startProximityRouteEnforcer(): void {
  if (isWeb()) return;
  stopProximityRouteEnforcer();
  proximitySubscription = DeviceEventEmitter.addListener('Proximity', (data: { isNear: boolean }) => {
    // After each proximity change, InCallManager does its own internal routing
    // update. On Samsung/Xiaomi, this can INCORRECTLY switch to speaker (v21.0
    // comment in original code: "the exact opposite of desired behavior").
    //
    // We re-enforce our desired route TWICE:
    //   - 250ms: catches InCallManager's immediate routing update
    //   - 700ms: catches Samsung's delayed AudioPolicyManager re-evaluation
    //     which can undo the first enforcement on some OneUI versions
    if (recording || playing) {
      setTimeout(() => {
        if (recording || playing) {
          InCallManager.setForceSpeakerphoneOn(speakerOn ? true : false);
        }
      }, 250);
      setTimeout(() => {
        if (recording || playing) {
          InCallManager.setForceSpeakerphoneOn(speakerOn ? true : false);
        }
      }, 700);
      __DEV__ && console.log(`📱 Proximity ${data?.isNear ? 'near' : 'far'} → route enforcement scheduled: speaker=${speakerOn}`);
    }
  });
  __DEV__ && console.log('📱 Proximity route enforcer started');
}

export function stopProximityRouteEnforcer(): void {
  if (proximitySubscription) {
    proximitySubscription.remove();
    proximitySubscription = null;
  }
}

// ============================================
// STATS
// ============================================

export function getAudioStats(): AudioStats { return { ...stats }; }
export function getAudioLevel(pid: string): number { return stats.inputLevels.get(pid) || 0; }
export function getOutputLevel(): number { return stats.outputLevel; }

// ============================================
// AUDIO HEALTH CHECK
// ============================================

let lastHealthCheckRecvCount = 0;
let healthCheckSilentTicks = 0;

export function checkAudioHealth(): { healthy: boolean; silentTicks: number } {
  if (!playing || !recording || isWeb()) return { healthy: true, silentTicks: 0 };
  const currentRecv = stats.packetsReceived;
  if (currentRecv > lastHealthCheckRecvCount) {
    lastHealthCheckRecvCount = currentRecv;
    healthCheckSilentTicks = 0;
    return { healthy: true, silentTicks: 0 };
  }
  healthCheckSilentTicks++;
  return { healthy: healthCheckSilentTicks < 3, silentTicks: healthCheckSilentTicks };
}

export function resetAudioHealth(): void {
  lastHealthCheckRecvCount = 0;
  healthCheckSilentTicks = 0;
}

// ============================================
// PIPELINE RESTART
// ============================================

export async function restartCallAudioPipeline(
  onAudioCaptured: AudioCallback
): Promise<boolean> {
  if (isWeb()) return true;
  __DEV__ && console.log(`🎤 [${Platform.OS}] ⚠️ RESTARTING audio pipeline (health recovery)`);

  if (recording) await stopCapture();
  if (playing) await stopPlayback();
  earlyAudioBuffer = [];

  if (Platform.OS === 'ios') await new Promise(r => setTimeout(r, 200));

  if (EPAS) {
    if (Platform.OS === 'ios') {
      // v30.0: Exercise conversation engine to force VP I/O release (same as cleanup)
      try { await EPAS.setSoundConfig({ sampleRate: 16000, playbackMode: 'conversation' }); } catch {}
      await new Promise(r => setTimeout(r, 100));
      try {
        const silence = u8toB64(new Uint8Array(640));
        for (let i = 0; i < 10; i++) {
          EPAS.playSound(silence, 'call', 'pcm_s16le');
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
      try { EPAS.stopAudio(); } catch {}
      await new Promise(r => setTimeout(r, 400));
    } else {
      try { EPAS.stopAudio(); } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
  }

  hasEPAS = false;
  InCallManager.setForceSpeakerphoneOn(speakerOn ? true : false);
  await new Promise(r => setTimeout(r, 150));

  return startCallAudioPipeline(onAudioCaptured);
}

// ============================================
// CLEANUP
// ============================================

export async function cleanupAudio(): Promise<void> {
  __DEV__ && console.log('🎤 Cleanup starting...');

  // Stop proximity enforcer
  stopProximityRouteEnforcer();

  // Stop mic and playback
  if (recording) await stopCapture();
  if (playing) await stopPlayback();
  captureCallback = null;
  earlyAudioBuffer = [];
  setSpeakerSyncCallback(null);

  // Reset InCallManager route override
  if (!isWeb()) { try { InCallManager.setForceSpeakerphoneOn(null); } catch {} }

  // Drain delay between mic stop and engine teardown.
  // iOS: VP I/O is a single unit with both input and output. stopMicrophone()
  // tears down the input tap but the render thread may still be draining output.
  // Android: Samsung routing re-evaluation after AudioRecord release.
  const micDrainDelay = Platform.OS === 'ios' ? 200 : 100;
  await new Promise(r => setTimeout(r, micDrainDelay));

  // Teardown native engine.
  // ═══════════════════════════════════════════════════════════════
  // v30.0 COMPLETE COLD RESET — ensures call N+1 starts identically to call 1.
  //
  // THE PROBLEM: On iOS, VP I/O (Voice Processing I/O) creates hardware-level
  // CoreAudio render graph connections (AEC pipeline, render callbacks, I/O
  // buffers). These are allocated lazily and released asynchronously. Simply
  // calling stopAudio() stops the engine but doesn't deallocate the render
  // graph — CoreAudio keeps the VP I/O resources "warm" for potential reuse.
  //
  // On the 2nd call, setSoundConfig('voiceProcessing') creates a NEW VP I/O
  // unit, but CoreAudio still has phantom connections from the old one.
  // The new render callback registers but the output never fires because
  // CoreAudio's internal routing table still points to the dead output.
  // playSound() calls succeed (no error thrown) but audio goes nowhere.
  //
  // THE FIX: Force CoreAudio to FULLY commit to a non-VP audio graph by
  // actually exercising it (playing silence through a conversation-mode
  // engine). CoreAudio lazily allocates hardware — if no audio passes
  // through the engine, it never fully releases the VP I/O resources.
  // By pumping real audio data through a conversation engine, CoreAudio
  // MUST release the VP I/O hardware to give it to the new engine.
  // Then we destroy the conversation engine and null out EPAS entirely.
  //
  // This ensures the next call's initializeAudio() + reconfigurePlaybackEngine()
  // creates VP I/O on a truly clean CoreAudio state, identical to call 1.
  // ═══════════════════════════════════════════════════════════════
  if (EPAS) {
    if (Platform.OS === 'ios') {
      // Step 1: Switch to conversation mode → dismantles VP I/O render graph
      try { await EPAS.setSoundConfig({ sampleRate: 16000, playbackMode: 'conversation' }); } catch {}
      await new Promise(r => setTimeout(r, 150));

      // Step 2: EXERCISE the conversation engine by playing silence.
      // This is the critical step that was missing. CoreAudio lazily
      // allocates hardware resources. Without actual audio data flowing,
      // it doesn't fully commit to the new (non-VP) audio graph, which
      // means it doesn't fully release the old VP I/O resources.
      // Playing 20 silence frames forces CoreAudio to:
      //   a) Allocate the conversation engine's output buffer
      //   b) Connect it to the hardware output
      //   c) Release the VP I/O hardware connections (can't have both)
      try {
        const silence = u8toB64(new Uint8Array(640)); // 20ms at 16kHz 16-bit mono
        for (let i = 0; i < 20; i++) {
          EPAS.playSound(silence, 'call', 'pcm_s16le');
        }
        __DEV__ && console.log('🎤 [ios] Cleanup: exercised conversation engine (20 silence frames)');
      } catch {}
      await new Promise(r => setTimeout(r, 300));

      // Step 3: Stop and destroy the conversation engine
      try { EPAS.stopAudio(); } catch {}
      await new Promise(r => setTimeout(r, 500));

      __DEV__ && console.log('🎤 [ios] Cleanup: VP I/O resources force-released via conversation exercise');
    } else {
      // Android: simple stop is sufficient (no VP I/O complexity)
      try { EPAS.stopAudio(); } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Stop InCallManager (restores normal audio mode, deactivates AVAudioSession)
  stopInCallManager();

  // v30.0: Null out EPAS to force complete re-initialization on next call.
  // The native module is a singleton — re-import returns the same object.
  // But nulling ensures initializeAudio() re-runs the full import path,
  // and more importantly, hasEPAS/initialized are reset so the next call
  // goes through the complete reconfigurePlaybackEngine() warm-up cycle.
  EPAS = null;

  // Reset all state to cold-start defaults
  hasEPAS = false;
  initialized = false;
  nativePreWarmed = false;
  muted = false;
  speakerOn = false;
  playCount = 0;
  stats.packetsSent = 0; stats.packetsReceived = 0; stats.packetsLost = 0;
  stats.averageLatencyMs = 0; stats.outputLevel = 0;
  stats.inputLevels = new Map(); stats.isTestMode = false;
  resetAudioHealth();

  __DEV__ && console.log('🎤 Cleanup complete (cold reset)');
}