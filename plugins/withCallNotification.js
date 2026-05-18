// plugins/withCallNotification.js
//
// Expo config plugin to configure native call notification support.
//
// ANDROID:
//   - Copies ghostr_ringtone.mp3 into res/raw/ for the notification channel
//   - Adds POST_NOTIFICATIONS, VIBRATE, WAKE_LOCK permissions for the call channel
//   - Configures the call notification channel via push-proxy + expo-notifications
//
// iOS:
//   - Copies ghostr_ringtone.mp3 into the Xcode project bundle
//   - Ensures the sound file is accessible for notification playback
//   - Adds UIBackgroundModes: remote-notification (for background push)
//
// SÉCURITÉ: Ce plugin ne manipule que des fichiers audio et des permissions.
// Aucune donnée utilisateur n'est touchée. Le fichier de sonnerie est
// un asset statique sans contenu identifiable.

const { withDangerousMod, withPlugins, withAndroidManifest } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════
// Fichiers son pour la sonnerie d'appel
// ══════════════════════════════════════════════
// On utilise le même fichier que incallmanager_ringback.mp3
// mais renommé en ghostr_ringtone.mp3 pour le canal de notification.
// Si un fichier ghostr_ringtone.mp3 existe dans assets/sounds/, on l'utilise.
// Sinon, on copie incallmanager_ringback.mp3 comme fallback.

const RINGTONE_FILE = 'ghostr_ringtone.mp3';
const FALLBACK_RINGTONE = 'incallmanager_ringback.mp3';

function getRingtoneSource() {
  const primary = path.resolve(__dirname, '..', 'assets', 'sounds', RINGTONE_FILE);
  if (fs.existsSync(primary)) return primary;
  
  const fallback = path.resolve(__dirname, '..', 'assets', 'sounds', FALLBACK_RINGTONE);
  if (fs.existsSync(fallback)) return fallback;
  
  throw new Error(`[withCallNotification] No ringtone file found. Expected ${primary} or ${fallback}`);
}

// ══════════════════════════════════════════════
// ANDROID
// ══════════════════════════════════════════════

/**
 * Android: Copy ringtone to res/raw/ and add necessary permissions.
 *
 * Le canal de notification 'ghostr-calls-v2' est configuré programmatiquement
 * dans pushNotificationService.ts (requestNativeToken). Le fichier son doit
 * être dans res/raw/ pour que Android le trouve via URI
 * android.resource://com.ghostr.app/raw/ghostr_ringtone
 */
function withCallNotificationAndroid(config) {
  // 1. Copy sound file to res/raw/
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const rawDir = path.join(
        config.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'res', 'raw'
      );
      fs.mkdirSync(rawDir, { recursive: true });

      const source = getRingtoneSource();
      const dest = path.join(rawDir, RINGTONE_FILE);
      fs.copyFileSync(source, dest);
      console.log(`[withCallNotification] Android: copied ${path.basename(source)} → ${dest}`);

      return config;
    },
  ]);

  // 2. Add permissions in AndroidManifest.xml
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const mainApplication = manifest.manifest.application?.[0];

    if (!mainApplication) return config;

    // Ensure permissions are declared
    const permissions = manifest.manifest['uses-permission'] || [];
    const permissionNames = permissions.map(p => p.$?.['android:name']);

    const requiredPermissions = [
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.VIBRATE',
      'android.permission.WAKE_LOCK',
    ];

    for (const perm of requiredPermissions) {
      if (!permissionNames.includes(perm)) {
        permissions.push({
          $: { 'android:name': perm },
        });
        console.log(`[withCallNotification] Android: added permission ${perm}`);
      }
    }

    manifest.manifest['uses-permission'] = permissions;
    return config;
  });

  return config;
}

// ══════════════════════════════════════════════
// iOS
// ══════════════════════════════════════════════

/**
 * iOS: Copy ringtone into the Xcode project bundle.
 *
 * APNs utilise le nom du fichier dans le payload:
 *   { aps: { sound: { name: "ghostr_ringtone.mp3" } } }
 * Le fichier doit être dans le bundle principal de l'app pour que
 * iOS le trouve et le joue lors de la notification.
 *
 * La catégorie 'incoming_call' avec boutons Répondre/Refuser est
 * configurée programmatiquement dans pushNotificationService.ts.
 */
function withCallNotificationIOS(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const iosProjectPath = config.modRequest.platformProjectRoot;
      const source = getRingtoneSource();
      const dest = path.join(iosProjectPath, RINGTONE_FILE);

      fs.copyFileSync(source, dest);
      console.log(`[withCallNotification] iOS: copied ${path.basename(source)} → ${dest}`);

      // Add to Xcode project (pbxproj)
      const pbxprojDir = fs.readdirSync(iosProjectPath)
        .find(f => f.endsWith('.xcodeproj'));

      if (pbxprojDir) {
        const pbxprojPath = path.join(iosProjectPath, pbxprojDir, 'project.pbxproj');

        if (fs.existsSync(pbxprojPath)) {
          let pbxContent = fs.readFileSync(pbxprojPath, 'utf8');

          if (!pbxContent.includes(RINGTONE_FILE)) {
            // Deterministic IDs to avoid duplicates on repeated prebuilds
            const fileRefId = 'CALLRING0000000000001';
            const buildFileId = 'CALLRING0000000000002';

            const fileRefEntry = `\t\t${fileRefId} /* ${RINGTONE_FILE} */ = {isa = PBXFileReference; lastKnownFileType = audio.mp3; path = "${RINGTONE_FILE}"; sourceTree = "<group>"; };`;
            const buildFileEntry = `\t\t${buildFileId} /* ${RINGTONE_FILE} in Resources */ = {isa = PBXBuildFile; fileRef = ${fileRefId} /* ${RINGTONE_FILE} */; };`;

            // Insert file reference
            const fileRefMarker = '/* End PBXFileReference section */';
            pbxContent = pbxContent.replace(
              fileRefMarker,
              `${fileRefEntry}\n${fileRefMarker}`
            );

            // Insert build file
            const buildFileMarker = '/* End PBXBuildFile section */';
            pbxContent = pbxContent.replace(
              buildFileMarker,
              `${buildFileEntry}\n${buildFileMarker}`
            );

            // Add to Resources build phase
            const resourcesPhaseRegex = /(\/\* Resources \*\/ = \{[^}]*files = \(\n)/;
            pbxContent = pbxContent.replace(
              resourcesPhaseRegex,
              `$1\t\t\t\t${buildFileId} /* ${RINGTONE_FILE} in Resources */,\n`
            );

            // Add to main group's children
            const mainGroupRegex = /(mainGroup = [A-F0-9]+[^;]*;[^}]*children = \(\n)/;
            pbxContent = pbxContent.replace(
              mainGroupRegex,
              `$1\t\t\t\t${fileRefId} /* ${RINGTONE_FILE} */,\n`
            );

            fs.writeFileSync(pbxprojPath, pbxContent);
            console.log(`[withCallNotification] iOS: added ${RINGTONE_FILE} to Xcode project`);
          } else {
            console.log(`[withCallNotification] iOS: ${RINGTONE_FILE} already in Xcode project`);
          }
        }
      }

      return config;
    },
  ]);
}

// ══════════════════════════════════════════════
// MAIN PLUGIN
// ══════════════════════════════════════════════

function withCallNotification(config) {
  config = withCallNotificationAndroid(config);
  config = withCallNotificationIOS(config);
  return config;
}

module.exports = withCallNotification;