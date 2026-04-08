// plugins/withRingbackTone.js
//
// Expo config plugin to inject a custom 440Hz ringback tone into the native
// projects. react-native-incall-manager looks for 'incallmanager_ringback.mp3':
//   iOS:     [[NSBundle mainBundle] URLForResource:@"incallmanager_ringback" withExtension:@"mp3"]
//   Android: res/raw/incallmanager_ringback.mp3
//
// Without this file, InCallManager falls back to system sounds which sound
// like ringtones rather than proper call-waiting beeps.

const { withDangerousMod, withPlugins } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SOUND_FILE = 'incallmanager_ringback.mp3';
const SOURCE_PATH = path.resolve(__dirname, '..', 'assets', 'sounds', SOUND_FILE);

/**
 * iOS: Overwrite the pod's default ringback with our custom version.
 *
 * BUILD FIX: The previous approach added the MP3 as a separate Xcode project
 * resource. But react-native-incall-manager's pod ALSO copies its own version
 * via [CP] Copy Pods Resources → TWO commands produce the same output file
 * → "Multiple commands produce incallmanager_ringback.mp3" → build failure.
 *
 * SOLUTION: Overwrite the file inside node_modules BEFORE pod install copies it.
 * CocoaPods then copies OUR version. One command, one file, no conflict.
 */
function withRingbackToneIOS(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;

      // Possible locations of the pod's default ringback file
      const candidates = [
        path.join(projectRoot, 'node_modules', 'react-native-incall-manager', 'ios', 'RNInCallManager', SOUND_FILE),
        path.join(projectRoot, 'node_modules', 'react-native-incall-manager', 'ios', SOUND_FILE),
      ];

      let overwritten = false;
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          fs.copyFileSync(SOURCE_PATH, candidate);
          console.log(`[withRingbackTone] iOS: overwrote pod default at ${candidate}`);
          overwritten = true;
          break;
        }
      }

      if (!overwritten) {
        // Fallback: if the pod structure changed, copy next to the pod's ios dir
        const fallbackDir = path.join(projectRoot, 'node_modules', 'react-native-incall-manager', 'ios', 'RNInCallManager');
        fs.mkdirSync(fallbackDir, { recursive: true });
        const fallbackPath = path.join(fallbackDir, SOUND_FILE);
        fs.copyFileSync(SOURCE_PATH, fallbackPath);
        console.log(`[withRingbackTone] iOS: placed custom ringback at ${fallbackPath} (fallback)`);
      }

      // DO NOT modify pbxproj — the pod handles its own resource copying.
      // Adding the file to the Xcode project would cause the duplicate error.

      return config;
    },
  ]);
}

/**
 * Android: Copy MP3 into res/raw/ directory.
 * InCallManager looks for R.raw.incallmanager_ringback.
 */
function withRingbackToneAndroid(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const rawDir = path.join(
        config.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'res', 'raw'
      );

      // Create res/raw/ if it doesn't exist
      fs.mkdirSync(rawDir, { recursive: true });

      const destPath = path.join(rawDir, SOUND_FILE);
      fs.copyFileSync(SOURCE_PATH, destPath);
      console.log(`[withRingbackTone] Android: copied ${SOUND_FILE} to ${destPath}`);

      // ── Icône téléphone pour la notification d'appel ──
      // Android exige un small icon pour toute notification. Pour les appels,
      // on utilise un icône de téléphone au lieu du logo de l'app, pour éviter
      // un doublon avec l'avatar (grand logo Ghostr).
      // L'icône est un PNG 96x96 blanc sur transparent (monochrome requis par Android),
      // embarqué en base64 pour éviter de dépendre d'un fichier externe.
      const drawableDir = path.join(
        config.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'res', 'drawable'
      );
      fs.mkdirSync(drawableDir, { recursive: true });

      const phoneIconBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAABoElEQVR42u2dQQ7DIAwEA///M31BpUY1sN6dubepdjAhYDXPAwAAAAAAAAAAKYwbF11rra8/aIyBgAvBp4oYasGniZjK4Vd8PlpAVXjOEqZ6+O4SZofwmYJEwncUOwnIRMCp8N0kT8aggQCmHiogVwCjnwpAAAQJcNsdpQIQkDv6qQAHAadGpevJGBXgIODE6ORARgDOAwTmaLajkaA9BSHhZV7dQ+q+PLUYrZ0lSPzwCkFdJUgsQyvC63pPkHkOSJUg9SCWKEHuSThNguRWRJIE2b2gFAnSm3EJEuR3Q90ltNiOdpbQ5jzAVUJcV4SahMjGLCUJLQ/lnSS07YpwkdC+16Y6xNPb2hbNTjtG8rGGs8eEXdPJbhE2nXG7gtp9n7BqTewowa43tJsEy+bcThIsBXT6vwra0y9LmIRz9zpUwGUQcLkKEEAFZFcBAqgABPAUjAAqgCpAABVAFVy4jnUFdJiK7KegnRIqvjviHqBcCTE34WoJVd8XtQqqCq1SZtwy9N/wyispeQ2u8FanaAG/iEh7rxkAAAAAAAAAWPMBjt/ceM1p420AAAAASUVORK5CYII=';
      const phoneIconDest = path.join(drawableDir, 'ghostr_call_phone_icon.png');
      fs.writeFileSync(phoneIconDest, Buffer.from(phoneIconBase64, 'base64'));
      console.log(`[withRingbackTone] Android: created phone icon → ${phoneIconDest}`);

      return config;
    },
  ]);
}

/**
 * Main plugin: applies both iOS and Android modifications.
 */
function withRingbackTone(config) {
  config = withRingbackToneIOS(config);
  config = withRingbackToneAndroid(config);
  return config;
}

module.exports = withRingbackTone;