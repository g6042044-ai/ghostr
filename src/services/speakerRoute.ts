// src/services/speakerRoute.ts
//
// JS wrapper for the native AudioRouteModule.
//
// On Android 12+, AudioManager.setSpeakerphoneOn() is deprecated and silently
// ignored by Samsung, Pixel, etc. This module wraps the replacement API:
// AudioManager.setCommunicationDevice(TYPE_BUILTIN_SPEAKER).
//
// On iOS, routing is handled by AVAudioSession (via restartMicWithRoute in
// audioService.ts), so this module is Android-only.
//
// Usage:
//   import { setAndroidSpeaker, clearAndroidRoute } from './speakerRoute';
//   setAndroidSpeaker(true);   // → speaker
//   setAndroidSpeaker(false);  // → earpiece
//   clearAndroidRoute();       // → cleanup

import { NativeModules, Platform } from 'react-native';

const { AudioRouteModule } = NativeModules;

const isAndroid = Platform.OS === 'android';
const hasModule = isAndroid && AudioRouteModule != null;

/**
 * Route audio to speaker or earpiece on Android.
 * Uses setCommunicationDevice on Android 12+, setSpeakerphoneOn on older.
 * No-op on iOS/web.
 */
export function setAndroidSpeaker(useSpeaker: boolean): void {
  if (!hasModule) {
    if (isAndroid) {
      __DEV__ && console.warn('🔊 [SpeakerRoute] AudioRouteModule not available');
    }
    return;
  }
  try {
    AudioRouteModule.setSpeaker(useSpeaker);
    __DEV__ && console.log(`🔊 [SpeakerRoute] setSpeaker(${useSpeaker})`);
  } catch (e) {
    __DEV__ && console.error('🔊 [SpeakerRoute] setSpeaker error:', e);
  }
}

/**
 * Clear communication device routing (call cleanup).
 * No-op on iOS/web.
 */
export function clearAndroidRoute(): void {
  if (!hasModule) return;
  try {
    AudioRouteModule.clearRoute();
    __DEV__ && console.log('🔊 [SpeakerRoute] clearRoute()');
  } catch (e) {
    __DEV__ && console.error('🔊 [SpeakerRoute] clearRoute error:', e);
  }
}