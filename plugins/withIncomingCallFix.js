// plugins/withIncomingCallFix.js
//
// Expo config plugin — Patches react-native-full-screen-notification-incoming-call
// for React Native 0.81+ New Architecture compatibility.
//
// PROBLÈME: ReactFragment.Builder.setComponentName() est ambigu dans RN 0.81+
// car les deux architectures (old/new) exposent un Builder avec la même méthode.
// Erreur: "reference to setComponentName is ambiguous"
// Voir: https://github.com/facebook/react-native/issues/54396
//
// FIX: On remplace le bloc problématique par le layout par défaut.
// La fonctionnalité "mainComponent" (custom React UI dans la notification)
// n'est pas utilisée par Ghostr — on utilise le layout natif standard.
//
// Ce plugin s'applique automatiquement à chaque `npx expo prebuild`.

const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withIncomingCallFix(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      // Chemin vers le fichier Java dans node_modules
      // (copié dans le projet Android par le build Gradle)
      const javaFile = path.resolve(
        config.modRequest.projectRoot,
        'node_modules',
        'react-native-full-screen-notification-incoming-call',
        'android', 'src', 'main', 'java',
        'com', 'reactnativefullscreennotificationincomingcall',
        'IncomingCallActivity.java'
      );

      if (!fs.existsSync(javaFile)) {
        console.warn('[withIncomingCallFix] IncomingCallActivity.java not found, skipping');
        return config;
      }

      let content = fs.readFileSync(javaFile, 'utf8');

      // Vérifier si le patch est déjà appliqué
      if (content.includes('RN 0.81+ workaround')) {
        console.log('[withIncomingCallFix] ✅ Already patched');
        return config;
      }

      // Vérifier que le code problématique est présent
      if (!content.includes('.setComponentName(mainComponent)')) {
        console.log('[withIncomingCallFix] ⚠️ Code pattern not found, skipping');
        return config;
      }

      // Remplacer le bloc problématique
      const oldCode = [
        '    if (bundle.containsKey("mainComponent") && bundle.getString("mainComponent") != null) {',
        '      String mainComponent = bundle.getString("mainComponent");',
        '      setContentView(R.layout.custom_ingcoming_call_rn);',
        '      Fragment reactNativeFragment = new ReactFragment.Builder()',
        '        .setComponentName(mainComponent)',
        '        .setLaunchOptions(bundle)',
        '        .build();',
        '',
        '      getSupportFragmentManager()',
        '        .beginTransaction()',
        '        .add(R.id.reactNativeFragment, reactNativeFragment)',
        '        .commit();',
        '      return;',
        '    } else {',
        '      setContentView(R.layout.activity_call_incoming);',
        '    }',
      ].join('\n');

      const newCode = [
        '    // RN 0.81+ workaround: ReactFragment.Builder.setComponentName() is ambiguous',
        '    // See: https://github.com/facebook/react-native/issues/54396',
        '    if (bundle.containsKey("mainComponent") && bundle.getString("mainComponent") != null) {',
        '      Log.w(TAG, "mainComponent not supported with RN 0.81+ New Architecture");',
        '    }',
        '    setContentView(R.layout.activity_call_incoming);',
      ].join('\n');

      if (content.includes(oldCode)) {
        content = content.replace(oldCode, newCode);
        fs.writeFileSync(javaFile, content, 'utf8');
        console.log('[withIncomingCallFix] ✅ Patched IncomingCallActivity.java for RN 0.81+');
      } else {
        console.warn('[withIncomingCallFix] ⚠️ Could not find exact code block to patch');
      }

      return config;
    },
  ]);
}

module.exports = withIncomingCallFix;
