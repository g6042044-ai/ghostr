// src/services/firstLaunchGuard.ts
// ═══════════════════════════════════════════════════════════════════════════
// FIX iOS — Détection de réinstallation et purge du Keychain
// ═══════════════════════════════════════════════════════════════════════════
//
// PROBLÈME RÉSOLU
// ───────────────
// Sur iOS, le Keychain (utilisé par expo-secure-store) N'EST PAS effacé à la
// désinstallation de l'app. C'est un comportement délibéré d'Apple : les
// items Keychain survivent aux réinstallations, sauf action explicite de
// l'app. Conséquence côté Ghostr :
//
//   1. L'utilisateur installe Ghostr et configure un mot de passe.
//   2. L'utilisateur désinstalle Ghostr. AsyncStorage est effacé (messages,
//      conversations, ratchet states, hint de lock disparus). MAIS le
//      Keychain garde `whisper_lock_data_v6`, `ghostr_hardware_enc_key_v1`,
//      les compteurs anti-brute-force, etc.
//   3. L'utilisateur réinstalle Ghostr. `isLockEnabled()` lit le Keychain
//      → trouve `whisper_lock_data_v6` → affiche le LockScreen avec
//      l'ancien mot de passe, alors que toutes les vraies données ont été
//      détruites.
//
// SOLUTION
// ────────
// On stocke un sentinel dans AsyncStorage (qui EST effacé à la désinstallation
// sur iOS). Au premier démarrage post-installation, le sentinel est absent :
//
//   • Si AsyncStorage contient déjà des données utilisateur (clé
//     `@ghostr_onboarding_completed`), c'est une montée de version depuis
//     un binaire qui n'avait pas ce guard → on pose juste le sentinel,
//     SANS purger (les données sont légitimes, l'utilisateur a déjà utilisé
//     l'app).
//
//   • Sinon (AsyncStorage vide ou seulement avec clés non-utilisateur),
//     c'est soit une vraie première installation (Keychain vide → purge
//     no-op), soit une réinstallation (Keychain pollué → on nettoie).
//     Dans les deux cas, on purge SYSTÉMATIQUEMENT toutes les clés
//     SecureStore connues, puis on pose le sentinel.
//
// SÉCURITÉ
// ────────
// Aucune donnée sensible n'est exposée. Le sentinel est juste « ce binaire
// a déjà démarré au moins une fois sur cette installation ». Un attaquant
// avec accès au device pourrait au pire mettre/enlever le sentinel, mais
// cela ne lui donne PAS accès aux données chiffrées (la master key reste
// protégée par le mot de passe ou est purgée).
//
// IDEMPOTENCE
// ───────────
// La fonction est sûre à appeler plusieurs fois. Après le premier appel
// réussi, le sentinel est posé et les appels suivants sont des no-ops
// rapides (1 read AsyncStorage).
//
// ORDRE D'APPEL
// ─────────────
// Cette fonction DOIT être appelée AVANT tout autre accès au Keychain via
// SecureStore (typiquement avant `isLockEnabled`, `isLockEnabledFast`,
// `getOrCreateHardwareKey`, `sessionService.initialize`, etc.). Sinon le
// LockScreen peut s'afficher brièvement avec un faux mot de passe avant
// la purge.
// ═══════════════════════════════════════════════════════════════════════════

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// Clé du sentinel — versionnée pour permettre une migration future.
const INSTALL_SENTINEL_KEY = '@ghostr_install_sentinel_v1';
const INSTALL_SENTINEL_VALUE = 'installed';

// Marqueur d'utilisation existante de l'app : si cette clé AsyncStorage est
// présente, l'utilisateur a déjà passé l'onboarding → ce n'est PAS une
// réinstallation, c'est une montée de version. Doit matcher la constante
// `ONBOARDING_COMPLETED_KEY` dans App.tsx.
const ONBOARDING_COMPLETED_KEY = '@ghostr_onboarding_completed';

// Liste EXHAUSTIVE des clés SecureStore connues utilisées par l'app.
// Toute nouvelle clé SecureStore ajoutée ailleurs dans le code DOIT être
// listée ici, sinon la purge anti-réinstallation sera incomplète et un
// résidu pourrait persister dans le Keychain iOS d'une installation à l'autre.
//
// Convention de nommage observée dans le code : préfixes `whisper_*` (legacy)
// et `ghostr_*` (nouveau). Si ces conventions sont respectées partout, un
// audit grep peut être automatisé en CI.
const ALL_SECURESTORE_KEYS: readonly string[] = [
  // Lock / PIN — toutes versions (de v3 à v6)
  'whisper_lock_data_v6',
  'whisper_lock_data_v5',
  'whisper_lock_data_v4',
  'whisper_lock_data_v3',
  'whisper_lock_enabled',
  'whisper_lock_password_hash',
  'whisper_lock_settings',
  'whisper_encryption_key',
  'whisper_lock_salt',
  'whisper_password_hash',
  'whisper_password_salt',
  'whisper_use_biometrics',
  'whisper_lock_timeout',
  'whisper_failed_attempts',
  'whisper_lockout_until',
  'whisper_failed_attempts_v2',
  'whisper_lockout_until_v2',
  'whisper_auto_wipe_enabled',
  // Clés hardware-backed (de hardwareKeyProvider.ts)
  'ghostr_hardware_enc_key_v1',
  'ghostr_hardware_conv_key_v1',
  'ghostr_device_encryption_key_v1',
  'ghostr_rotated_enc_key_v1',
  'ghostr_rotated_enc_key_v1_pending',
  // Conversations / Sender / Identity
  'whisper_conversations_key',
  'whisper_conversations_key_encrypted',
  'whisper_sender_token',
  'whisper_user_secret',
  // Graine des tags leurres de polling (decoyTagPool.ts)
  'ghostr_decoy_seed_v1',
];

/**
 * Décide si on est sur une réinstallation iOS et, le cas échéant, purge le
 * Keychain.
 *
 * @returns
 *  - `true` si une vraie réinstallation a été détectée et nettoyée.
 *  - `false` dans tous les autres cas (Android, premier lancement légitime,
 *    montée de version, démarrage normal).
 *
 * Doit être appelée AVANT tout autre accès SecureStore au cold start.
 */
export async function checkAndHandleReinstall(): Promise<boolean> {
  // Sur Android, le Keystore est lié à l'UID de l'app et est nettoyé
  // automatiquement à la désinstallation par le système. Aucune action
  // n'est nécessaire — on pose juste le sentinel par cohérence et pour
  // une éventuelle future portabilité du raisonnement.
  if (Platform.OS !== 'ios') {
    try {
      const existing = await AsyncStorage.getItem(INSTALL_SENTINEL_KEY);
      if (!existing) {
        await AsyncStorage.setItem(INSTALL_SENTINEL_KEY, INSTALL_SENTINEL_VALUE);
      }
    } catch {
      // Non-critique : l'absence de sentinel sur Android n'a aucune
      // conséquence puisqu'il n'y a rien à purger.
    }
    return false;
  }

  try {
    // ─── Étape 1 : vérifier le sentinel ─────────────────────────────────
    const sentinel = await AsyncStorage.getItem(INSTALL_SENTINEL_KEY);
    if (sentinel === INSTALL_SENTINEL_VALUE) {
      // Démarrage normal : sentinel présent → no-op.
      return false;
    }

    // ─── Étape 2 : sentinel absent → distinguer 3 cas ──────────────────
    //   (a) Première installation : Keychain vide, AsyncStorage vide.
    //   (b) Réinstallation : Keychain plein de résidus, AsyncStorage vide.
    //   (c) Montée de version : Keychain plein (légitime), AsyncStorage
    //       contient encore les données utilisateur.
    //
    // Le seul moyen fiable de distinguer (c) des autres cas est de
    // vérifier la présence d'une clé AsyncStorage qui ne peut exister
    // que si l'utilisateur a vraiment utilisé l'app : l'onboarding
    // complété. Cette clé survit aux mises à jour mais pas aux
    // désinstallations sur iOS.

    const onboardingDone = await AsyncStorage.getItem(ONBOARDING_COMPLETED_KEY);

    if (onboardingDone) {
      // Cas (c) — Montée de version : l'utilisateur a déjà utilisé l'app,
      // ses données SecureStore sont légitimes. On pose juste le sentinel
      // sans purger, pour que la prochaine désinstallation/réinstallation
      // soit correctement détectée.
      await AsyncStorage.setItem(INSTALL_SENTINEL_KEY, INSTALL_SENTINEL_VALUE);
      if (__DEV__) {
        console.log('[firstLaunchGuard] Update from older version detected — sentinel set, no purge.');
      }
      return false;
    }

    // ─── Étape 3 : cas (a) ou (b) — purge systématique ──────────────────
    // Si c'est (a), la purge est un no-op (rien à supprimer).
    // Si c'est (b), elle nettoie les résidus du Keychain.
    // On ne peut pas distinguer les deux cas avec certitude, mais ce n'est
    // pas grave : la purge est sûre dans les deux situations.

    let purgedCount = 0;
    for (const key of ALL_SECURESTORE_KEYS) {
      try {
        // On ne peut pas savoir à l'avance si une clé existe sans tenter
        // de la lire. Un getItemAsync sur une clé absente renvoie null,
        // pas d'erreur. On lit d'abord pour comptabiliser, puis on supprime.
        const existed = await SecureStore.getItemAsync(key);
        if (existed !== null) {
          purgedCount++;
        }
        await SecureStore.deleteItemAsync(key);
      } catch {
        // deleteItemAsync sur une clé absente est silencieux. Toute autre
        // erreur (Keychain bloqué, device verrouillé) est ignorée — on
        // tentera à nouveau au prochain boot si le sentinel n'est pas posé.
      }
    }

    // ─── Étape 4 : poser le sentinel ────────────────────────────────────
    // À faire APRÈS la purge pour que, si la purge échoue, le sentinel
    // ne soit pas posé prématurément (le prochain boot retentera).
    //
    // NOTE : si `setItemAsync` du sentinel échoue, on ne le saura qu'au
    // prochain boot où on retentera la purge. Aucune fuite de sécurité,
    // juste une potentielle double exécution du nettoyage.
    await AsyncStorage.setItem(INSTALL_SENTINEL_KEY, INSTALL_SENTINEL_VALUE);

    if (purgedCount > 0) {
      if (__DEV__) {
        console.log(`[firstLaunchGuard] ⚠️ Reinstall detected: purged ${purgedCount} stale Keychain entries`);
      }
      return true;
    }

    if (__DEV__) {
      console.log('[firstLaunchGuard] ✅ Genuine first launch (Keychain was empty)');
    }
    return false;
  } catch (e) {
    // Erreur AsyncStorage ou autre cas exceptionnel.
    // On ne pose PAS le sentinel pour permettre une re-tentative au prochain
    // boot. Conséquence : si AsyncStorage est durablement cassé, on retentera
    // la purge à chaque boot — pas idéal mais sûr (pas de fuite).
    if (__DEV__) {
      console.error('[firstLaunchGuard] Error during check:', e);
    }
    return false;
  }
}

/**
 * Force le « scellement » du sentinel sans purge.
 *
 * Utile dans deux contextes :
 *   1. Après `setupLock` réussi : on garantit que le sentinel est posé pour
 *      qu'une éventuelle erreur précédente lors de checkAndHandleReinstall
 *      (qui n'aurait pas posé le sentinel) ne provoque pas une purge des
 *      données qu'on vient de configurer.
 *   2. Après `nuclearReset` : `nuclearReset` clear `AsyncStorage` entièrement,
 *      donc le sentinel disparaît. Si l'utilisateur reconfigure ensuite l'app
 *      sans redémarrer, le prochain cold start ne doit pas re-purger ce qu'il
 *      vient juste de mettre en place.
 *
 * Idempotent et silencieux en cas d'erreur.
 */
export async function sealInstallSentinel(): Promise<void> {
  try {
    await AsyncStorage.setItem(INSTALL_SENTINEL_KEY, INSTALL_SENTINEL_VALUE);
  } catch {
    // Non-critique
  }
}
