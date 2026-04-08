// plugins/withCallKeep.js
//
// Expo config plugin — Configure react-native-callkeep for iOS CallKit
//
// REMPLACE @config-plugins/react-native-callkeep qui est incompatible
// avec Expo 54 (peer dep expo@^52).
//
// CE QUE FAIT CE PLUGIN:
//   iOS:
//     - Ajoute 'voip' à UIBackgroundModes dans Info.plist
//       (nécessaire pour que CallKit fonctionne en background)
//     - Le framework CallKit.framework est linké automatiquement
//       par CocoaPods via le podspec de react-native-callkeep
//
//   Android:
//     - Rien — Ghostr utilise react-native-full-screen-notification-incoming-call
//       pour Android, pas CallKeep. Le module CallKeep est chargé uniquement
//       sur iOS (import lazy conditionnel dans pushNotificationService.ts).
//
// SÉCURITÉ: Ce plugin ne manipule que des configs plist.
// Aucune donnée utilisateur, aucun contenu identifiable.

const { withInfoPlist } = require('expo/config-plugins');

function withCallKeep(config) {
  // ══════════════════════════════════════════════
  // iOS: Ajouter 'voip' à UIBackgroundModes
  // ══════════════════════════════════════════════
  //
  // CallKit a besoin du background mode 'voip' pour:
  //   - Réveiller l'app quand un push VoIP arrive
  //   - Maintenir l'audio session pendant un appel en background
  //   - Afficher l'interface native d'appel entrant depuis le lockscreen
  //
  // Les autres modes nécessaires ('audio', 'remote-notification') sont
  // déjà déclarés dans app.json → infoPlist → UIBackgroundModes.
  // Ce plugin s'assure que 'voip' est présent sans dupliquer.
  //
  // NOTE: On utilise withInfoPlist (safe mod) plutôt que withDangerousMod
  // car c'est un simple ajout à un tableau plist existant.
  config = withInfoPlist(config, (config) => {
    const bgModes = config.modResults.UIBackgroundModes || [];

    if (!bgModes.includes('voip')) {
      bgModes.push('voip');
      console.log('[withCallKeep] iOS: added "voip" to UIBackgroundModes');
    } else {
      console.log('[withCallKeep] iOS: "voip" already in UIBackgroundModes');
    }

    config.modResults.UIBackgroundModes = bgModes;
    return config;
  });

  return config;
}

module.exports = withCallKeep;
