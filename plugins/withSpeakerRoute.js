// plugins/withSpeakerRoute.js
//
// Expo config plugin — Injects a standalone native Android module that
// exposes AudioManager.setCommunicationDevice() to JavaScript.
//
// WHY: On Android 12+ (API 31), AudioManager.setSpeakerphoneOn() is deprecated
// and silently ignored by Samsung, Pixel, etc. react-native-incall-manager
// still uses the deprecated API, so speaker toggle does nothing.
//
// This module creates "AudioRouteModule" accessible via NativeModules.

const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PACKAGE_DIR = 'com/ghostr/audioroute';

// ══════════════════════════════════════════════
// NATIVE KOTLIN SOURCE
// ══════════════════════════════════════════════

const AUDIO_ROUTE_MODULE_KT = `package com.ghostr.audioroute

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class AudioRouteModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "AudioRouteModule"
    }

    override fun getName() = "AudioRouteModule"

    private fun getAudioManager(): AudioManager {
        return reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    }

    @ReactMethod
    fun setSpeaker(useSpeaker: Boolean) {
        val am = getAudioManager()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                if (useSpeaker) {
                    val speaker = am.availableCommunicationDevices
                        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    if (speaker != null) {
                        val result = am.setCommunicationDevice(speaker)
                        Log.d(TAG, "setCommunicationDevice(SPEAKER): result=\$result")
                    } else {
                        Log.w(TAG, "SPEAKER not in availableCommunicationDevices, trying legacy")
                        @Suppress("DEPRECATION")
                        am.isSpeakerphoneOn = true
                    }
                } else {
                    am.clearCommunicationDevice()
                    val earpiece = am.availableCommunicationDevices
                        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
                    if (earpiece != null) {
                        val result = am.setCommunicationDevice(earpiece)
                        Log.d(TAG, "setCommunicationDevice(EARPIECE): result=\$result")
                    } else {
                        Log.w(TAG, "EARPIECE not in availableCommunicationDevices, trying legacy")
                        @Suppress("DEPRECATION")
                        am.isSpeakerphoneOn = false
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "setCommunicationDevice failed: \${e.message}")
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = useSpeaker
            }
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = useSpeaker
            Log.d(TAG, "setSpeakerphoneOn(legacy): \$useSpeaker")
        }
    }

    @ReactMethod
    fun clearRoute() {
        val am = getAudioManager()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.clearCommunicationDevice()
                Log.d(TAG, "clearCommunicationDevice() done")
            }
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = false
        } catch (e: Exception) {
            Log.w(TAG, "clearRoute failed: \${e.message}")
        }
    }
}
`;

const AUDIO_ROUTE_PACKAGE_KT = `package com.ghostr.audioroute

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AudioRoutePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(AudioRouteModule(reactContext))
    }
    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
`;

// ══════════════════════════════════════════════
// CONFIG PLUGIN
// ══════════════════════════════════════════════

function withSpeakerRoute(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.platformProjectRoot;

      // 1. Create Kotlin source files
      const kotlinDir = path.join(
        projectRoot, 'app', 'src', 'main', 'java', ...PACKAGE_DIR.split('/')
      );
      fs.mkdirSync(kotlinDir, { recursive: true });

      fs.writeFileSync(
        path.join(kotlinDir, 'AudioRouteModule.kt'),
        AUDIO_ROUTE_MODULE_KT
      );
      fs.writeFileSync(
        path.join(kotlinDir, 'AudioRoutePackage.kt'),
        AUDIO_ROUTE_PACKAGE_KT
      );
      console.log(`[withSpeakerRoute] ✅ Created native AudioRouteModule in ${kotlinDir}`);

      // 2. Register the package in MainApplication.kt
      //    Expo SDK 54 generates MainApplication.kt at:
      //    android/app/src/main/java/com/<package>/MainApplication.kt
      const mainAppPath = path.join(
        projectRoot, 'app', 'src', 'main', 'java', 'com', 'ghostr', 'app', 'MainApplication.kt'
      );

      if (!fs.existsSync(mainAppPath)) {
        console.warn(`[withSpeakerRoute] ⚠️ MainApplication.kt not found at ${mainAppPath}`);
        return config;
      }

      let content = fs.readFileSync(mainAppPath, 'utf8');

      if (content.includes('AudioRoutePackage')) {
        console.log('[withSpeakerRoute] ✅ Already registered in MainApplication');
        return config;
      }

      // Add import after the last import line
      const importLine = 'import com.ghostr.audioroute.AudioRoutePackage';
      const lastImportIdx = content.lastIndexOf('\nimport ');
      if (lastImportIdx !== -1) {
        const endOfLine = content.indexOf('\n', lastImportIdx + 1);
        content = content.slice(0, endOfLine + 1) + importLine + '\n' + content.slice(endOfLine + 1);
      }

      // Expo SDK 54 pattern (New Architecture):
      //   PackageList(this).packages.apply {
      //       // add(MyReactNativePackage())
      //   }
      //
      // We inject: add(AudioRoutePackage())
      let patched = false;

      // Pattern 1: .packages.apply { ... }  (Expo SDK 54)
      if (content.includes('.packages.apply {') || content.includes('.packages.apply{')) {
        content = content.replace(
          /(\.packages\.apply\s*\{)/,
          '$1\n                add(AudioRoutePackage())'
        );
        patched = true;
      }

      // Pattern 2: .packages (without .apply) — add .apply block
      if (!patched && content.includes('PackageList(this).packages')) {
        content = content.replace(
          /(PackageList\(this\)\.packages)/,
          '$1.apply {\n                add(AudioRoutePackage())\n            }'
        );
        patched = true;
      }

      // Pattern 3: Legacy "return packages" (older Expo)
      if (!patched && content.includes('return packages')) {
        content = content.replace(
          /(\s*)(return packages)/,
          '$1packages.add(AudioRoutePackage())\n$1$2'
        );
        patched = true;
      }

      if (patched) {
        fs.writeFileSync(mainAppPath, content);
        console.log('[withSpeakerRoute] ✅ Registered AudioRoutePackage in MainApplication.kt');
      } else {
        console.error('[withSpeakerRoute] ❌ Could not find package registration pattern in MainApplication.kt');
        console.error('[withSpeakerRoute] Please manually add: add(AudioRoutePackage()) to your packages list');
      }

      return config;
    },
  ]);
}

module.exports = withSpeakerRoute;