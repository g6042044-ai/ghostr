// src/services/callTones.ts — v24.6
//
// RINGBACK (outgoing call): PCM 440Hz sine wave via EPAS on both platforms.
//   Android: playAudio() with USAGE_VOICE_COMMUNICATION (native patch) → earpiece
//   iOS: playSound() with VP I/O (requires mic started) → earpiece
//
// RINGTONE (incoming call): InCallManager.startRingtone() (independent of start/stop)
//
// TRANSITION: transitionToCallAudio()
//   Android: full stop→restart (Samsung drift reset)
//   iOS: keep session alive (AVAudioSession deactivation breaks it)

import { Platform, Vibration, DeviceEventEmitter } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import InCallManager from 'react-native-incall-manager';

let ringtoneActive = false;
let ringbackActive = false;
let isPlaying = false;
let inCallStarted = false;

// Flag set by transitionToCallAudio: true = InCallManager was freshly started
// (callee path or first call), false = already running from ringback (caller path).
// audioService reads this to decide whether iOS warm-up is safe.
// Warm-up calls EPAS.stopAudio() which resets AVAudioSession. When InCallManager
// was freshly started, the session survives. When InCallManager is still running
// from ringback, stopAudio() corrupts its session → VP I/O engine fails.
let lastTransitionWasFreshStart = false;
export function wasLastTransitionFreshStart(): boolean { return lastTransitionWasFreshStart; }

export function isRingtoneActive(): boolean { return ringtoneActive; }

let speakerSyncCallback: (() => void) | null = null;
export function setSpeakerSyncCallback(cb: (() => void) | null): void { speakerSyncCallback = cb; }

const SILENT_MODE_KEY = 'ghostr_silent_mode';
let silentMode = false;
export function isSilentMode(): boolean { return silentMode; }
export async function setSilentMode(enabled: boolean): Promise<void> {
  silentMode = enabled;
  try { await AsyncStorage.setItem(SILENT_MODE_KEY, enabled ? '1' : '0'); } catch {}
  if (enabled && isPlaying) await stopTone();
}
export async function loadSilentMode(): Promise<boolean> {
  try { const v = await AsyncStorage.getItem(SILENT_MODE_KEY); silentMode = v === '1'; } catch { silentMode = false; }
  return silentMode;
}

// ============================================
// RINGBACK
// ============================================

export async function startRingback(): Promise<void> {
  if (silentMode) return;
  ringtoneActive = false;
  ringbackActive = true;
  isPlaying = true;
  if (Platform.OS === 'web') return;

  if (Platform.OS === 'android') {
    // ═══════════════════════════════════════════════════════════════
    // ANDROID: EPAS PCM tone via USAGE_VOICE_COMMUNICATION AudioTrack.
    // InCallManager's ToneGenerator ringback is broken on Android
    // (Issue #218: plays like ringtone, too loud, through speaker).
    // ═══════════════════════════════════════════════════════════════

    // Phase 1: Set MODE_IN_COMMUNICATION, enforce earpiece
    InCallManager.start({ media: 'audio' });
    InCallManager.setKeepScreenOn(true);
    inCallStarted = true;

    await new Promise(r => setTimeout(r, 500));
    if (!ringbackActive) return;
    InCallManager.setForceSpeakerphoneOn(false);
    await new Promise(r => setTimeout(r, 100));
    if (!ringbackActive) return;

    // Phase 2: Start PCM tone via EPAS
    await startEPASRingback();
    if (!ringbackActive) return;

    // Phase 3: Post-engine enforcement + proximity enforcer.
    // CRITICAL: Proximity enforcer must start AFTER startEPASRingback() returns.
    // On the first call, startEPASRingback() creates the first-ever
    // USAGE_VOICE_COMMUNICATION AudioTrack. Samsung's AudioPolicyManager needs
    // time to fully process this new stream type in its routing table. If a
    // proximity event fires DURING AudioTrack creation (warm-up phase), the
    // setForceSpeakerphoneOn(false) lands on an AudioManager in transition
    // → enforcement silently lost → speaker output.
    // On the second call, the routing table already has this usage → works.
    await new Promise(r => setTimeout(r, 300));
    if (!ringbackActive) return;
    InCallManager.setForceSpeakerphoneOn(false);
    startRingbackProximityEnforcer();

  } else {
    // ═══════════════════════════════════════════════════════════════
    // iOS: InCallManager _BUNDLE_ ringback through earpiece.
    //
    // CRITICAL: Do NOT use EPAS (setSoundConfig/playAudio) for
    // ringback on iOS. ANY EPAS call during ringback poisons the
    // AVAudioEngine/AudioSessionManager state. When the call
    // connects and reconfigurePlaybackEngine() creates VP I/O,
    // the VP I/O render callback never fires → no call audio.
    //
    // The _BUNDLE_ option plays incallmanager_ringback.mp3 from
    // the iOS app bundle. A custom 440Hz ringback tone file is
    // included in the project to replace the default ringtone sound.
    // InCallManager plays this via AVAudioPlayer which is completely
    // independent from EPAS's AVAudioEngine → no state corruption.
    // ═══════════════════════════════════════════════════════════════
    InCallManager.start({ media: 'audio', ringback: '_BUNDLE_' });
    InCallManager.setKeepScreenOn(true);
    InCallManager.setForceSpeakerphoneOn(false);
    inCallStarted = true;
  }

  __DEV__ && console.log(`🔔 Ringback ✅ (${Platform.OS})`);
}

// ============================================
// EPAS RINGBACK ENGINE (Android only)
// ============================================
// Android uses EPAS playAudio() with USAGE_VOICE_COMMUNICATION AudioTrack
// because InCallManager's ToneGenerator ringback is broken (Issue #218).
// iOS uses InCallManager _BUNDLE_ with custom incallmanager_ringback.mp3
// because ANY EPAS call during ringback corrupts AVAudioEngine state
// and breaks subsequent call audio.

let epasRingbackModule: any = null;
let epasRingbackConfigured = false;
let epasRingbackCycleTimer: ReturnType<typeof setTimeout> | null = null;
let epasRingbackChunkTimer: ReturnType<typeof setInterval> | null = null;
let epasRingbackToneChunk: string = '';

function u8toB64(u: Uint8Array): string {
  let b = '';
  for (let i = 0; i < u.length; i++) b += String.fromCharCode(u[i]);
  return btoa(b);
}

function generateRingbackToneB64(sampleRate: number, durationMs: number, freq: number): string {
  const numSamples = Math.floor((sampleRate / 1000) * durationMs);
  const pcm = new Uint8Array(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // 0.06 amplitude = ~-24dB, appropriate for earpiece at call volume
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.06;
    const s16 = Math.round(sample * 32767);
    pcm[i * 2] = s16 & 0xFF;
    pcm[i * 2 + 1] = (s16 >> 8) & 0xFF;
  }
  return u8toB64(pcm);
}

async function startEPASRingback(): Promise<void> {
  if (Platform.OS !== 'android') return; // iOS uses InCallManager _BUNDLE_

  try {
    if (!epasRingbackModule) {
      const mod = await import('@mykin-ai/expo-audio-stream');
      epasRingbackModule = mod.ExpoPlayAudioStream || mod.default;
    }
    if (!epasRingbackModule?.setSoundConfig || !epasRingbackModule?.playAudio) {
      __DEV__ && console.warn('🔔 [android] EPAS not available for ringback');
      return;
    }

    // Samsung warm-up: create + destroy a brief AudioTrack to prime routing table.
    // On Samsung's first call, USAGE_VOICE_COMMUNICATION has never been seen by
    // AudioPolicyManager. The warm-up cycle primes the routing table so the real
    // AudioTrack is routed correctly to earpiece.
    try {
      await epasRingbackModule.setSoundConfig({ sampleRate: 16000, playbackMode: 'conversation' });
      // v26.0: Samsung's AudioPolicyManager needs the USAGE_VOICE_COMMUNICATION
      // AudioTrack to EXIST for ~100-200ms to register the routing entry.
      // Without this, create+destroy in same tick = entry never registered
      // → first proximity event has no earpiece route → falls back to speaker.
      await new Promise(r => setTimeout(r, 150));
      try { epasRingbackModule.stopAudio(); } catch {}
      await new Promise(r => setTimeout(r, 300));
      __DEV__ && console.log('🔔 [android] Samsung AudioTrack warm-up done');
    } catch {}
    if (!ringbackActive) return;

    // Create the real AudioTrack with USAGE_VOICE_COMMUNICATION
    await epasRingbackModule.setSoundConfig({ sampleRate: 16000, playbackMode: 'conversation' });
    epasRingbackConfigured = true;

    // Re-enforce earpiece after AudioTrack creation.
    // Samsung's first-ever USAGE_VOICE_COMMUNICATION routing table update
    // takes ~200-300ms. Enforce at 300ms to catch the delayed update.
    InCallManager.setForceSpeakerphoneOn(false);
    await new Promise(r => setTimeout(r, 300));
    InCallManager.setForceSpeakerphoneOn(false);

    // Generate 200ms tone chunk (440Hz = ITU-T E.180 European ringback)
    if (!epasRingbackToneChunk) {
      epasRingbackToneChunk = generateRingbackToneB64(16000, 200, 440);
    }

    __DEV__ && console.log('🔔 [android] EPAS ringback engine ready');
    playRingbackCycle();
  } catch (e) {
    __DEV__ && console.warn('🔔 [android] EPAS ringback failed:', e);
  }
}

function playRingbackCycle(): void {
  if (!ringbackActive || !epasRingbackConfigured) return;

  let elapsed = 0;
  const TONE_DURATION = 1500;   // 1.5s tone
  const SILENCE_DURATION = 3500; // 3.5s silence
  const CHUNK_INTERVAL = 200;   // 200ms PCM chunks

  epasRingbackChunkTimer = setInterval(() => {
    if (!ringbackActive || !epasRingbackConfigured) {
      if (epasRingbackChunkTimer) { clearInterval(epasRingbackChunkTimer); epasRingbackChunkTimer = null; }
      return;
    }

    if (elapsed >= TONE_DURATION) {
      if (epasRingbackChunkTimer) { clearInterval(epasRingbackChunkTimer); epasRingbackChunkTimer = null; }
      epasRingbackCycleTimer = setTimeout(() => playRingbackCycle(), SILENCE_DURATION);
      return;
    }

    try {
      epasRingbackModule.playAudio(epasRingbackToneChunk, 'ringback_tone', 'pcm_s16le');
    } catch (e) {
      // Non-fatal: AudioTrack may not be ready on first chunk
    }
    elapsed += CHUNK_INTERVAL;
  }, CHUNK_INTERVAL);
}

function stopEPASRingback(): void {
  if (epasRingbackChunkTimer) {
    clearInterval(epasRingbackChunkTimer);
    epasRingbackChunkTimer = null;
  }
  if (epasRingbackCycleTimer) {
    clearTimeout(epasRingbackCycleTimer);
    epasRingbackCycleTimer = null;
  }
  if (epasRingbackModule && epasRingbackConfigured) {
    try { epasRingbackModule.stopAudio(); } catch {}
    epasRingbackConfigured = false;
  }
  stopRingbackProximityEnforcer();
}

// ============================================
// RINGBACK PROXIMITY ENFORCER (Android only)
// ============================================
// Prevents proximity sensor from switching audio to speaker during ringback.
//
// Samsung first-call issue: The first-ever USAGE_VOICE_COMMUNICATION AudioTrack
// creates a new entry in the AudioPolicyManager routing table. This entry is
// "unstable" for the first few seconds. Proximity events trigger deep routing
// re-evaluations that undo earpiece enforcement at unpredictable delays
// (250ms, 700ms, even 1000ms+). Single-shot enforcement can't reliably catch
// all of Samsung's re-evaluation waves.
//
// Fix: PERIODIC enforcement every 500ms while ringback is active. This
// continuously re-asserts earpiece routing regardless of when Samsung's
// AudioPolicyManager decides to re-evaluate. On the second call, the routing
// table entry is already established and the periodic enforcement is a no-op.
//
// iOS doesn't need this: InCallManager's _BUNDLE_ ringback uses AVAudioPlayer
// which respects the session's earpiece routing without interference.

let ringbackProximitySub: { remove(): void } | null = null;
let ringbackPeriodicEnforcer: ReturnType<typeof setInterval> | null = null;

function startRingbackProximityEnforcer(): void {
  if (Platform.OS !== 'android') return;
  stopRingbackProximityEnforcer();

  // Periodic enforcement: re-assert earpiece every 500ms while ringback is active.
  // This catches Samsung's unpredictable AudioPolicyManager re-evaluations on
  // first-call USAGE_VOICE_COMMUNICATION routing table initialization.
  ringbackPeriodicEnforcer = setInterval(() => {
    if (ringbackActive && inCallStarted) {
      InCallManager.setForceSpeakerphoneOn(false);
    } else {
      if (ringbackPeriodicEnforcer) { clearInterval(ringbackPeriodicEnforcer); ringbackPeriodicEnforcer = null; }
    }
  }, 500);

  // Event-driven enforcement: responds immediately to proximity changes
  ringbackProximitySub = DeviceEventEmitter.addListener('Proximity', (data: { isNear: boolean }) => {
    if (ringbackActive && inCallStarted) {
      // Immediate + delayed enforcement on each proximity event
      InCallManager.setForceSpeakerphoneOn(false);
      setTimeout(() => {
        if (ringbackActive && inCallStarted) {
          InCallManager.setForceSpeakerphoneOn(false);
        }
      }, 300);
      __DEV__ && console.log(`🔔 Ringback proximity ${data?.isNear ? 'near' : 'far'} → earpiece enforced`);
    }
  });
  __DEV__ && console.log('🔔 Ringback proximity enforcer started (periodic + event-driven)');
}

function stopRingbackProximityEnforcer(): void {
  if (ringbackPeriodicEnforcer) {
    clearInterval(ringbackPeriodicEnforcer);
    ringbackPeriodicEnforcer = null;
  }
  if (ringbackProximitySub) {
    ringbackProximitySub.remove();
    ringbackProximitySub = null;
  }
}

// ============================================
// RINGTONE (incoming call)
// ============================================

export async function startRingtone(): Promise<void> {
  if (silentMode) return;
  ringtoneActive = true;
  ringbackActive = false;
  isPlaying = true;
  if (Platform.OS === 'web') return;
  InCallManager.startRingtone('_DEFAULT_');
  Vibration.vibrate([0, 1000, 1000], true);
  __DEV__ && console.log('🔔 Ringtone ✅');
}

export function ensureInCallStarted(): void {
  if (!inCallStarted && Platform.OS !== 'web') {
    InCallManager.start({ media: 'audio' });
    InCallManager.setKeepScreenOn(true);
    InCallManager.setForceSpeakerphoneOn(false);
    inCallStarted = true;
    __DEV__ && console.log('🔔 InCallManager started ✅');
  }
}

// ============================================
// TRANSITION TO CALL AUDIO
// ============================================

export async function transitionToCallAudio(): Promise<void> {
  if (Platform.OS === 'web') return;

  __DEV__ && console.log(`🔔 transitionToCallAudio() BEGIN (inCallStarted=${inCallStarted}, ringback=${ringbackActive}, ringtone=${ringtoneActive})`);

  // ═══════════════════════════════════════════════════════════════
  // v27.0 CRITICAL FIX: UNCONDITIONAL stop of ALL tone sources.
  //
  // BEFORE: stopRingback/stopRingtone were gated by ringbackActive/
  // ringtoneActive flags. But these flags can be cleared prematurely
  // by playConnectedBeep() (called when remote audio arrives before
  // the answer signal). This caused the iOS AVAudioPlayer to keep
  // playing the ringback MP3 forever.
  //
  // FIX: Always call stop methods regardless of flag state.
  // InCallManager.stopRingback() and stopRingtone() are safe no-ops
  // when nothing is playing (they check _ringback/_ringtone != nil).
  // ═══════════════════════════════════════════════════════════════

  // Step 1: Stop ALL tone sources unconditionally
  InCallManager.stopRingtone();
  InCallManager.stopRingback();
  Vibration.cancel();
  stopEPASRingback();
  ringtoneActive = false;
  ringbackActive = false;
  isPlaying = false;

  // Step 2: Platform-specific InCallManager lifecycle
  if (Platform.OS === 'android') {
    // Android: full stop→restart (Samsung AudioPolicyManager drift reset)
    if (inCallStarted) {
      InCallManager.stop();
      inCallStarted = false;

      const stopSettleMs = 350;
      await new Promise(r => setTimeout(r, stopSettleMs));
      __DEV__ && console.log(`🔔 [android] InCallManager stopped, settled ${stopSettleMs}ms`);
    }

    InCallManager.start({ media: 'audio' });
    InCallManager.setKeepScreenOn(true);
    InCallManager.setForceSpeakerphoneOn(false);
    inCallStarted = true;

    const startSettleMs = 500;
    await new Promise(r => setTimeout(r, startSettleMs));
    __DEV__ && console.log(`🔔 [android] transitionToCallAudio() DONE (settled ${startSettleMs}ms) ✅`);

  } else {
    // iOS: keep session alive (stop→restart breaks AVAudioSession — Issue #38)
    if (!inCallStarted) {
      // Callee path: startRingtone() doesn't set inCallStarted → fresh start
      InCallManager.start({ media: 'audio' });
      InCallManager.setKeepScreenOn(true);
      InCallManager.setForceSpeakerphoneOn(false);
      inCallStarted = true;
      lastTransitionWasFreshStart = true;

      const settleMs = 500;
      await new Promise(r => setTimeout(r, settleMs));
      __DEV__ && console.log(`🔔 [ios] InCallManager fresh start, settled ${settleMs}ms`);
    } else {
      // Caller path: already running from startRingback → session is healthy.
      //
      // ═══════════════════════════════════════════════════════════════
      // v29.0 FIX: Caller path — InCallManager already running from
      // startRingback(). The AVAudioPlayer (ringback) was stopped in
      // Step 1 but its I/O connections release asynchronously.
      //
      // v29.0: Increased to 650ms. On iOS 17+ (iPhone 12/13/14/15),
      // AVAudioPlayer can hold CoreAudio I/O resources for up to 600ms
      // after stopRingback(). If VP I/O creation starts while these
      // resources are still held, the render callback registers but
      // never fires → no sound on the 2nd/3rd call. The extra 150ms
      // after the redundant stopRingback ensures full I/O release.
      // ═══════════════════════════════════════════════════════════════
      lastTransitionWasFreshStart = false;
      InCallManager.setForceSpeakerphoneOn(false);

      const callerSettleMs = 650;
      await new Promise(r => setTimeout(r, callerSettleMs));
      
      // Redundant stop after AVAudioPlayer has had time to release.
      // Safe no-op if already stopped. Catches edge cases where the
      // first stopRingback() in Step 1 didn't fully release.
      InCallManager.stopRingback();
      // v29.0: Additional settle after redundant stop to ensure I/O release
      await new Promise(r => setTimeout(r, 150));
      InCallManager.setForceSpeakerphoneOn(false);
      __DEV__ && console.log(`🔔 [ios] InCallManager already active, settled ${callerSettleMs}ms after ringback stop`);
    }

    __DEV__ && console.log('🔔 [ios] transitionToCallAudio() DONE ✅');
  }
}

// ============================================
// CALL STATE TONES
// ============================================

// ═══════════════════════════════════════════════════════════════
// IN-CALL TONE GENERATION (PCM 16-bit 16kHz mono)
//
// These tones play through the call audio pipeline (EPAS) during
// a connected call. They are injected via addAudioToBuffer() which
// uses the same AudioTrack/VP I/O as remote audio → earpiece output.
//
// CONNECTING TONE: Short beep every 3s while waiting for remote audio.
//   Indicates the call is established but no voice is flowing yet.
//   Similar to Messenger's "waiting for connection" tone.
//
// CONNECTED BEEP: Ascending double-beep when first remote audio arrives.
//   Signals that voice communication is established.
//
// END CALL BEEP: Short descending tone when the call ends.
// ═══════════════════════════════════════════════════════════════

/** Callback to inject PCM into the call audio pipeline */
let _callAudioPlayFn: ((data: Uint8Array) => void) | null = null;

export function setCallTonePlayFn(fn: ((data: Uint8Array) => void) | null): void {
  _callAudioPlayFn = fn;
}

/**
 * Generates PCM 16-bit mono at given sample rate.
 * Used for all in-call beep tones.
 */
function generatePCM(freq: number, durationMs: number, volume: number, sampleRate: number = 16000): Uint8Array {
  const numSamples = Math.floor((sampleRate / 1000) * durationMs);
  const pcm = new Uint8Array(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Apply fade-in/fade-out envelope (5ms) to avoid click
    const fadeMs = 5;
    const fadeSamples = Math.floor((sampleRate / 1000) * fadeMs);
    let envelope = 1.0;
    if (i < fadeSamples) envelope = i / fadeSamples;
    if (i > numSamples - fadeSamples) envelope = (numSamples - i) / fadeSamples;
    
    const sample = Math.sin(2 * Math.PI * freq * t) * volume * envelope;
    const s16 = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
    pcm[i * 2] = s16 & 0xFF;
    pcm[i * 2 + 1] = (s16 >> 8) & 0xFF;
  }
  return pcm;
}

/** Generates silence PCM (gap between beeps) */
function generateSilence(durationMs: number, sampleRate: number = 16000): Uint8Array {
  const numSamples = Math.floor((sampleRate / 1000) * durationMs);
  return new Uint8Array(numSamples * 2); // Zeros = silence
}

/** Concatenates multiple PCM buffers */
function concatPCM(...buffers: Uint8Array[]): Uint8Array {
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
}

// ── Pre-generated tone buffers (created once, reused) ──

let _connectingBeep: Uint8Array | null = null;
let _connectedBeep: Uint8Array | null = null;
let _endCallBeep: Uint8Array | null = null;

function getConnectingBeep(): Uint8Array {
  if (!_connectingBeep) {
    _connectingBeep = generatePCM(800, 100, 0.10);
  }
  return _connectingBeep;
}

/** Exported for call1to1Service to play inline from its own timer */
export function getConnectingBeepPCM(): Uint8Array {
  return getConnectingBeep();
}

function getConnectedBeep(): Uint8Array {
  if (!_connectedBeep) {
    // Ascending double-beep: 80ms at 850Hz + 60ms silence + 80ms at 1100Hz
    _connectedBeep = concatPCM(
      generatePCM(850, 80, 0.12),
      generateSilence(60),
      generatePCM(1100, 80, 0.12)
    );
  }
  return _connectedBeep;
}

function getEndCallBeep(): Uint8Array {
  if (!_endCallBeep) {
    // Descending double-beep: 100ms at 700Hz + 50ms silence + 140ms at 480Hz
    _endCallBeep = concatPCM(
      generatePCM(700, 100, 0.10),
      generateSilence(50),
      generatePCM(480, 140, 0.10)
    );
  }
  return _endCallBeep;
}

export async function playConnectedBeep(): Promise<void> {
  if (silentMode) return;
  
  // ═══════════════════════════════════════════════════════════════
  // v27.0 CRITICAL FIX: Do NOT clear ringbackActive/ringtoneActive here.
  //
  // RACE CONDITION (iOS caller):
  //   1. Both peers connect to SFU → audio starts flowing
  //   2. Remote audio arrives at caller BEFORE the answer signal
  //   3. onRemoteAudioReceived() → playConnectedBeep() → ringbackActive = false
  //   4. Answer signal arrives → transitionToCallAudio()
  //   5. transitionToCallAudio() checks ringbackActive → FALSE
  //   6. InCallManager.stopRingback() is NEVER called
  //   7. iOS AVAudioPlayer continues playing ringback MP3 FOREVER
  //   8. AVAudioPlayer holds I/O resources → VP I/O creation may fail
  //      → no call audio (intermittent no-sound bug)
  //
  // FIX: These flags belong to the ringback/ringtone lifecycle managed
  // by transitionToCallAudio(). In-call tones must not touch them.
  // ═══════════════════════════════════════════════════════════════
  
  // Play through call audio pipeline
  if (_callAudioPlayFn) {
    _callAudioPlayFn(getConnectedBeep());
    __DEV__ && console.log('🔔 Connected beep played ✅');
  }
}

export async function playEndCallBeep(): Promise<void> {
  // v27.0 FIX: Do NOT clear ringbackActive/ringtoneActive — same reason
  // as playConnectedBeep. These flags are managed by transitionToCallAudio().
  
  // Play through call audio pipeline
  if (_callAudioPlayFn) {
    _callAudioPlayFn(getEndCallBeep());
    __DEV__ && console.log('🔔 End call beep played ✅');
  }
}

export async function playBusyTone(): Promise<void> {
  if (silentMode) return;
  ringtoneActive = false;
  ringbackActive = false;
  isPlaying = true;
  if (Platform.OS !== 'web') {
    InCallManager.stopRingback();
  }
  setTimeout(() => { isPlaying = false; }, 2000);
}

export async function playMessageNotification(): Promise<void> {
  if (silentMode || isPlaying) return;
  Vibration.vibrate(200);
}

export async function stopTone(): Promise<void> {
  if (Platform.OS !== 'web') {
    // v27.0 FIX: Always call stop methods unconditionally.
    // Flags may have been cleared prematurely by in-call tones.
    InCallManager.stopRingtone();
    InCallManager.stopRingback();
    Vibration.cancel();
    stopEPASRingback();
  }
  ringtoneActive = false;
  ringbackActive = false;
  isPlaying = false;
}

export function isTonePlaying(): boolean { return isPlaying; }

export function stopInCallManager(): void {
  if (inCallStarted && Platform.OS !== 'web') {
    InCallManager.stop();
    inCallStarted = false;
    __DEV__ && console.log('🔔 InCallManager stopped');
  }
}

export function restartInCallManager(): void {
  if (Platform.OS === 'web') return;
  if (inCallStarted) {
    InCallManager.stop();
    inCallStarted = false;
  }
  InCallManager.start({ media: 'audio' });
  InCallManager.setKeepScreenOn(true);
  InCallManager.setForceSpeakerphoneOn(false);
  inCallStarted = true;
  __DEV__ && console.log('🔔 InCallManager restarted (fresh mode) ✅');
}