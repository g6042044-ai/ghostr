// plugins/withLargeScreenCompat.js
//
// Expo config plugin — Conserve le verrouillage portrait sur grands écrans
// quand l'app cible Android 16 (API 36).
//
// PROBLÈME:
//   À partir de targetSdkVersion 36, Android ignore les restrictions
//   d'orientation, de ratio et de redimensionnement sur tout écran dont la
//   plus petite largeur atteint 600dp (tablettes, pliables ouverts, bureau).
//   Le "orientation": "portrait" de app.json n'y est donc plus respecté et
//   l'app s'étire en paysage plein écran, sur des écrans (appel, chat, scan
//   QR) dessinés pour du portrait téléphone.
//
// SOLUTION:
//   Déclarer la propriété de compatibilité prévue par Android, qui restaure
//   l'ancien comportement pour toute l'application.
//
// ATTENTION — MESURE TEMPORAIRE:
//   Android supprime cet opt-out à partir de l'API 37 : les écrans devront
//   alors gérer réellement le paysage et les grandes largeurs.
//   Voir https://developer.android.com/guide/practices/device-compatibility-mode

const { withAndroidManifest } = require('expo/config-plugins');

const PROPERTY_NAME = 'android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY';

function withLargeScreenCompat(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];

    if (!application) {
      console.warn('[withLargeScreenCompat] ⚠️ <application> introuvable dans AndroidManifest.xml');
      return config;
    }

    application.property = application.property ?? [];

    const existing = application.property.find(
      (entry) => entry.$?.['android:name'] === PROPERTY_NAME
    );

    if (existing) {
      existing.$['android:value'] = 'true';
      console.log('[withLargeScreenCompat] ✅ Propriété déjà présente, valeur confirmée');
      return config;
    }

    application.property.push({
      $: {
        'android:name': PROPERTY_NAME,
        'android:value': 'true',
      },
    });
    console.log('[withLargeScreenCompat] ✅ Opt-out grands écrans ajouté au manifeste');

    return config;
  });
}

module.exports = withLargeScreenCompat;
