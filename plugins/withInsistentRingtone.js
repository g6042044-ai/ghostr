// plugins/withInsistentRingtone.js
//
// Expo config plugin — FLAG_INSISTENT pour sonnerie continue sur Android
//
// PROBLÈME:
//   expo-notifications joue le son de notification UNE SEULE FOIS.
//   Pour un appel entrant, on veut que la sonnerie boucle en continu
//   jusqu'à ce que l'utilisateur interagisse (comme un vrai appel).
//
// SOLUTION:
//   Android supporte Notification.FLAG_INSISTENT qui fait boucler
//   le son de la notification indéfiniment. Ce plugin patche
//   ExpoNotificationBuilder.kt pour ajouter ce flag aux notifications
//   dont le data contient isCall=true.
//
//   Les notifications de messages normales ne sont PAS affectées.
//
// REBUILD NÉCESSAIRE: Ce plugin modifie du code Kotlin natif.

const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PATCH_MARKER = 'GHOSTR_FLAG_INSISTENT';

function withInsistentRingtone(config) {
  return withDangerousMod(config, ['android', async (config) => {
    const builderPath = path.join(
      config.modRequest.projectRoot,
      'node_modules', 'expo-notifications', 'android', 'src', 'main',
      'java', 'expo', 'modules', 'notifications', 'notifications',
      'presentation', 'builders', 'ExpoNotificationBuilder.kt'
    );

    if (!fs.existsSync(builderPath)) {
      console.warn('[withInsistentRingtone] ExpoNotificationBuilder.kt not found');
      return config;
    }

    let content = fs.readFileSync(builderPath, 'utf8');

    if (content.includes(PATCH_MARKER)) {
      console.log('[withInsistentRingtone] Already patched');
      return config;
    }

    // Patch: remplacer "return builder.build()" par une version qui
    // ajoute FLAG_INSISTENT pour les notifications d'appel.
    const original = '    return builder.build()';
    const patched = [
      `    // ═══ ${PATCH_MARKER} ═══`,
      '    val notification = builder.build()',
      '    if (channelId?.contains("incoming-calls") == true) {',
      '      notification.flags = notification.flags or android.app.Notification.FLAG_INSISTENT',
      '      notification.flags = notification.flags or android.app.Notification.FLAG_NO_CLEAR',
      '      android.util.Log.d("expo-notifications",',
      '        "[GHOSTR] FLAG_INSISTENT applied (channel=$channelId)")',
      '    }',
      `    // ═══ END ${PATCH_MARKER} ═══`,
      '    return notification',
    ].join('\n');

    if (content.includes(original)) {
      content = content.replace(original, patched);
      fs.writeFileSync(builderPath, content);
      console.log('[withInsistentRingtone] ✅ ExpoNotificationBuilder.kt patched');
    } else {
      console.warn('[withInsistentRingtone] ⚠️ Could not find "return builder.build()" to patch');
    }

    return config;
  }]);
}

module.exports = withInsistentRingtone;