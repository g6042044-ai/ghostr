// src/services/permissions.ts
//
// Centralisation de TOUTES les demandes de permission de l'app.
//
// ─── Pourquoi ce service ? ──────────────────────────────────────────────
//
// Avant : chaque écran faisait son propre `requestCameraPermissionsAsync()` /
//   `requestMediaLibraryPermissionsAsync()` / etc., avec des `Alert.alert()`
//   inconsistants, sans distinction entre "refusé une fois" et "refusé
//   définitivement", sans lien vers les paramètres système, et sans
//   `suppressLock()` partout (l'app se verrouillait pendant le dialog OS).
//   Pire : les appels vocaux ne demandaient PAS le micro du tout, le natif
//   le faisait implicitement au premier `startMicrophone()`.
//
// Après : une seule API uniforme `ensureXxxPermission()` qui :
//
//   1. Tente d'abord `getPermissionsAsync()` (cache OS) — si déjà `granted`,
//      retourne immédiatement sans dialog.
//   2. Sinon, appelle `requestPermissionsAsync()` — déclenche le dialog OS.
//      Le `suppressLock()` est posé automatiquement avant, et libéré après
//      avec un délai de grâce (sur Android, le dialog fait passer l'app en
//      background et le retour 'active' arrive avec quelques ms de retard).
//   3. Mappe le résultat sur 3 états utiles :
//        - 'granted' : utilisable
//        - 'denied'  : refusé cette fois, mais l'utilisateur peut re-prompter
//                      → on lui redemande la prochaine fois (pas de cache local)
//        - 'blocked' : refusé définitivement (Android "Ne plus demander",
//                      iOS refus initial sans possibilité de redemander).
//                      → seule solution : Paramètres système. On affiche un
//                      Alert avec un bouton "Ouvrir les paramètres".
//
// ─── Stratégie "redemander à chaque fois" ───────────────────────────────
//
// On ne stocke JAMAIS un "déjà refusé" côté app. L'OS gère ça via
// `canAskAgain`. Concrètement :
//   - Sur iOS : refuser fait passer en 'blocked' immédiat (l'OS ne permet
//     pas de re-prompter, seul Settings est valide). Donc 1 prompt natif max.
//   - Sur Android : refuser une fois reste 'denied' avec `canAskAgain=true`.
//     L'utilisateur peut cocher "Ne plus demander" → devient 'blocked'.
//
// Ce service ne "cache" donc rien : il appelle `getPermissionsAsync()`
// fraîchement à chaque tentative. Pas de migration nécessaire si un jour
// l'utilisateur va dans les Settings activer/désactiver — on lit l'état réel.
//
// ─── Note WebRTC ───────────────────────────────────────────────────────
//
// Ce service utilise `expo-av` (Audio) et `expo-image-picker` (Caméra/Galerie)
// pour les permissions, MÊME pour les appels (où le micro est ensuite utilisé
// par `@mykin-ai/expo-audio-stream`). Le système Android/iOS ne distingue pas
// QUI demande la permission : c'est la permission `RECORD_AUDIO` /
// `NSMicrophoneUsageDescription` au niveau OS qui compte. Demander via expo-av
// et utiliser via expo-audio-stream est parfaitement légal et standard.

import { Alert, Linking, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as Notifications from 'expo-notifications';
import { Audio } from 'expo-av';
import i18n from '../i18n';
import { suppressLock, releaseLockDeferred } from './lockGuard';

// ─── Types ──────────────────────────────────────────────────────────────

export type PermissionStatus = 'granted' | 'denied' | 'blocked';

export interface PermissionResult {
  status: PermissionStatus;
  /** Si false, l'OS refusera tout nouveau prompt → seule solution = Settings. */
  canAskAgain: boolean;
}

/** Type de permission, utilisé pour les libellés du dialog "Ouvrir les paramètres". */
type PermissionKind = 'microphone' | 'camera' | 'mediaLibrary' | 'saveToLibrary' | 'notifications';

// ─── Helpers internes ───────────────────────────────────────────────────

/**
 * Mappe le retour Expo `{ status, canAskAgain }` vers notre `PermissionResult`.
 * Note : `granted` reste `granted`. `denied` + `canAskAgain=false` → `blocked`.
 */
function normalize(raw: { status: string; canAskAgain?: boolean }): PermissionResult {
  // Sur certaines versions Expo, `canAskAgain` peut être absent → on assume true
  // (vaut mieux re-prompter et que l'OS dise non que présumer un blocage).
  const canAskAgain = raw.canAskAgain !== false;
  if (raw.status === 'granted') {
    return { status: 'granted', canAskAgain: true };
  }
  // 'denied' avec canAskAgain=false → l'OS refusera le prochain request.
  // On le classe 'blocked' pour que le caller propose direct les Settings.
  if (!canAskAgain) {
    return { status: 'blocked', canAskAgain: false };
  }
  return { status: 'denied', canAskAgain: true };
}

/**
 * Wrap `requestXxxPermissionsAsync()` avec suppressLock/releaseLock.
 * Le dialog système sur Android fait passer l'app en 'background' → sans
 * suppressLock l'app se verrouillerait pendant que l'utilisateur lit le dialog.
 *
 * On `releaseLockDeferred(1500)` pour couvrir le retour 'active' post-dialog
 * sur ROMs lentes (Samsung One UI, Xiaomi MIUI peuvent prendre 700-1200ms).
 */
async function withLockSuppression<T>(fn: () => Promise<T>): Promise<T> {
  suppressLock();
  try {
    return await fn();
  } finally {
    releaseLockDeferred(1500);
  }
}

/** Renvoie un libellé localisé pour le type de permission (titres/messages). */
function labelForKind(kind: PermissionKind): {
  title: string;
  blockedMessage: string;
  deniedMessage: string;
} {
  const t = (k: string) => i18n.t(k);
  switch (kind) {
    case 'microphone':
      return {
        title: t('permissions.microphone.title'),
        blockedMessage: t('permissions.microphone.blockedMessage'),
        deniedMessage: t('permissions.microphone.deniedMessage'),
      };
    case 'camera':
      return {
        title: t('permissions.camera.title'),
        blockedMessage: t('permissions.camera.blockedMessage'),
        deniedMessage: t('permissions.camera.deniedMessage'),
      };
    case 'mediaLibrary':
      return {
        title: t('permissions.mediaLibrary.title'),
        blockedMessage: t('permissions.mediaLibrary.blockedMessage'),
        deniedMessage: t('permissions.mediaLibrary.deniedMessage'),
      };
    case 'saveToLibrary':
      return {
        title: t('permissions.saveToLibrary.title'),
        blockedMessage: t('permissions.saveToLibrary.blockedMessage'),
        deniedMessage: t('permissions.saveToLibrary.deniedMessage'),
      };
    case 'notifications':
      return {
        title: t('permissions.notifications.title'),
        blockedMessage: t('permissions.notifications.blockedMessage'),
        deniedMessage: t('permissions.notifications.deniedMessage'),
      };
  }
}

/**
 * Affiche l'alert "Ouvrir les paramètres" pour une permission bloquée.
 * Le caller peut choisir d'afficher (showAlertIfBlocked=true) ou pas (silencieux).
 */
function showBlockedAlert(kind: PermissionKind): void {
  const labels = labelForKind(kind);
  Alert.alert(
    labels.title,
    labels.blockedMessage,
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t('permissions.openSettings'),
        onPress: () => {
          // `Linking.openSettings()` : ouvre l'écran de paramètres de l'app
          // (iOS : Settings → Ghostr ; Android : équivalent).
          // Disponible depuis RN 0.61+, expo support natif.
          Linking.openSettings().catch(() => {
            // Si openSettings échoue (rare, vieux Android), on tente l'URL scheme.
            if (Platform.OS === 'ios') {
              Linking.openURL('app-settings:').catch(() => {});
            }
            // Sur Android, pas de fallback fiable — l'utilisateur ira manuellement.
          });
        },
      },
    ],
  );
}

/**
 * Affiche un message simple "permission refusée" sans bouton settings.
 * Utilisé quand l'utilisateur a refusé une fois et qu'on suppose qu'il peut
 * réessayer plus tard (Android avec canAskAgain=true).
 */
function showDeniedAlert(kind: PermissionKind): void {
  const labels = labelForKind(kind);
  Alert.alert(labels.title, labels.deniedMessage, [{ text: i18n.t('common.ok') }]);
}

// ─── API publique : ensureXxxPermission() ───────────────────────────────

/**
 * Options communes pour toutes les fonctions ensureXxx().
 */
export interface EnsureOptions {
  /**
   * Si true (défaut), affiche automatiquement le bon Alert quand la permission
   * est refusée ou bloquée. Si false, le caller gère lui-même l'UX du refus
   * (utile quand on veut un message contextualisé custom).
   */
  showAlertOnFailure?: boolean;
}

// ─── Microphone ─────────────────────────────────────────────────────────

/**
 * Permission micro — utilisée pour : appels vocaux 1-to-1 ET messages vocaux.
 *
 * Appeler AVANT toute opération qui touche au micro :
 *   - startCall() / acceptCall() dans call1to1Service
 *   - startRecording() de voiceMessageService
 *
 * Si refusé/bloqué, l'opération doit être ANNULÉE proprement (pas démarrer
 * la signalisation/crypto/sonnerie d'appel pour ensuite tomber sur un micro muet).
 */
export async function ensureMicrophonePermission(
  options: EnsureOptions = {},
): Promise<PermissionResult> {
  const showAlert = options.showAlertOnFailure !== false;

  // 1. Vérifier l'état actuel (sans prompt si déjà granted)
  try {
    const current = await Audio.getPermissionsAsync();
    const currentNormalized = normalize(current);
    if (currentNormalized.status === 'granted') {
      return currentNormalized;
    }
    // Si déjà bloqué (canAskAgain=false), ne pas tenter un prompt qui ne
    // donnera rien — afficher direct le dialog Settings.
    if (currentNormalized.status === 'blocked') {
      if (showAlert) showBlockedAlert('microphone');
      return currentNormalized;
    }
  } catch {
    // getPermissionsAsync n'a pas dû fail mais on continue vers le request.
  }

  // 2. Tenter le request (prompt OS)
  const result = await withLockSuppression(() => Audio.requestPermissionsAsync());
  const normalized = normalize(result);

  if (showAlert && normalized.status !== 'granted') {
    if (normalized.status === 'blocked') {
      showBlockedAlert('microphone');
    } else {
      showDeniedAlert('microphone');
    }
  }

  return normalized;
}

// ─── Camera ─────────────────────────────────────────────────────────────

/**
 * Permission caméra — utilisée pour : QR scan, prise de photo, photo de profil.
 *
 * Note : si tu utilises `expo-camera` (Camera.requestCameraPermissionsAsync)
 * dans un écran spécifique (ex: Join1to1Screen avec useCameraPermissions),
 * tu peux soit utiliser ce service, soit garder le hook — le résultat est
 * identique côté OS (même permission Android/iOS sous-jacente).
 */
export async function ensureCameraPermission(
  options: EnsureOptions = {},
): Promise<PermissionResult> {
  const showAlert = options.showAlertOnFailure !== false;

  try {
    const current = await ImagePicker.getCameraPermissionsAsync();
    const currentNormalized = normalize(current);
    if (currentNormalized.status === 'granted') {
      return currentNormalized;
    }
    if (currentNormalized.status === 'blocked') {
      if (showAlert) showBlockedAlert('camera');
      return currentNormalized;
    }
  } catch {}

  const result = await withLockSuppression(() => ImagePicker.requestCameraPermissionsAsync());
  const normalized = normalize(result);

  if (showAlert && normalized.status !== 'granted') {
    if (normalized.status === 'blocked') {
      showBlockedAlert('camera');
    } else {
      showDeniedAlert('camera');
    }
  }

  return normalized;
}

// ─── Galerie (lecture) ──────────────────────────────────────────────────

/**
 * Permission galerie en LECTURE — utilisée pour : sélectionner une photo
 * dans le picker (envoyer une image dans une conversation, choisir un avatar).
 *
 * Note Android 13+ : la permission READ_MEDIA_IMAGES remplace READ_EXTERNAL_STORAGE.
 * expo-image-picker gère ça automatiquement.
 *
 * Note Android 14+ : il existe une permission "partial access" (l'utilisateur
 * sélectionne seulement certaines photos). Ce statut apparaît comme 'granted'
 * via expo-image-picker — c'est le comportement souhaité (l'app voit ce que
 * l'utilisateur veut bien lui montrer, le reste n'existe pas pour elle).
 */
export async function ensureMediaLibraryPermission(
  options: EnsureOptions = {},
): Promise<PermissionResult> {
  const showAlert = options.showAlertOnFailure !== false;

  try {
    const current = await ImagePicker.getMediaLibraryPermissionsAsync();
    const currentNormalized = normalize(current);
    if (currentNormalized.status === 'granted') {
      return currentNormalized;
    }
    if (currentNormalized.status === 'blocked') {
      if (showAlert) showBlockedAlert('mediaLibrary');
      return currentNormalized;
    }
  } catch {}

  const result = await withLockSuppression(() =>
    ImagePicker.requestMediaLibraryPermissionsAsync(),
  );
  const normalized = normalize(result);

  if (showAlert && normalized.status !== 'granted') {
    if (normalized.status === 'blocked') {
      showBlockedAlert('mediaLibrary');
    } else {
      showDeniedAlert('mediaLibrary');
    }
  }

  return normalized;
}

// ─── Galerie (écriture) ─────────────────────────────────────────────────

/**
 * Permission ÉCRITURE galerie — utilisée pour : sauvegarder une image reçue
 * dans la pellicule (MediaLibrary.saveToLibraryAsync).
 *
 * Sur iOS, cette permission est distincte de la lecture (NSPhotoLibraryAdd).
 * Sur Android, depuis API 29+ (Scoped Storage), elle est implicite — pas de
 * prompt. Donc cette fonction retourne 'granted' silencieusement sur Android.
 */
export async function ensureSaveToLibraryPermission(
  options: EnsureOptions = {},
): Promise<PermissionResult> {
  const showAlert = options.showAlertOnFailure !== false;

  try {
    // MediaLibrary.getPermissionsAsync({ writeOnly: true }) : iOS uniquement
    // demande la perm "add" (NSPhotoLibraryAdd) si dispo. Sur Android, écrire
    // dans le shared MediaStore via MediaLibrary.saveToLibraryAsync ne demande
    // PAS de permission depuis API 29 — donc on retourne granted directement.
    if (Platform.OS === 'android' && Platform.Version >= 29) {
      return { status: 'granted', canAskAgain: true };
    }

    const current = await MediaLibrary.getPermissionsAsync(true);
    const currentNormalized = normalize(current);
    if (currentNormalized.status === 'granted') {
      return currentNormalized;
    }
    if (currentNormalized.status === 'blocked') {
      if (showAlert) showBlockedAlert('saveToLibrary');
      return currentNormalized;
    }
  } catch {}

  const result = await withLockSuppression(() => MediaLibrary.requestPermissionsAsync(true));
  const normalized = normalize(result);

  if (showAlert && normalized.status !== 'granted') {
    if (normalized.status === 'blocked') {
      showBlockedAlert('saveToLibrary');
    } else {
      showDeniedAlert('saveToLibrary');
    }
  }

  return normalized;
}

// ─── Notifications ──────────────────────────────────────────────────────

/**
 * Permission notifications — utilisée pour : push messages + push appels.
 *
 * Note : sur iOS, demander la permission notifs déclenche un prompt système
 * UNIQUE (pas de re-prompt possible). Sur Android 13+ (API 33), le runtime
 * permission POST_NOTIFICATIONS est requis.
 *
 * Ce service est complémentaire au NotificationOnboarding existant : le
 * onboarding s'occupe du "premier passage" avec contexte UX riche. Cette
 * fonction est pour les cas où on veut vérifier/redemander plus tard
 * (ex: après un changement de paramètre, ou pour un appel entrant).
 */
export async function ensureNotificationPermission(
  options: EnsureOptions = {},
): Promise<PermissionResult> {
  const showAlert = options.showAlertOnFailure !== false;

  try {
    const current = await Notifications.getPermissionsAsync();
    // expo-notifications a un schéma légèrement différent : on lit `granted`
    // dans le champ `status` ET dans `ios.status` (settings spécifiques iOS).
    const status =
      current.status === 'granted' ||
      (Platform.OS === 'ios' &&
        (current.ios?.status === 2 /* AUTHORIZED */ ||
          current.ios?.status === 3 /* PROVISIONAL */))
        ? 'granted'
        : current.status;
    const canAskAgain = current.canAskAgain !== false;

    if (status === 'granted') {
      return { status: 'granted', canAskAgain: true };
    }
    if (!canAskAgain) {
      if (showAlert) showBlockedAlert('notifications');
      return { status: 'blocked', canAskAgain: false };
    }
  } catch {}

  const result = await withLockSuppression(() =>
    Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
        // Time-sensitive : autorise les notifs d'appel à percer Focus/DoNotDisturb.
        allowProvisional: false,
      },
    }),
  );

  const normalized = normalize({
    status: result.status,
    canAskAgain: result.canAskAgain,
  });

  if (showAlert && normalized.status !== 'granted') {
    if (normalized.status === 'blocked') {
      showBlockedAlert('notifications');
    } else {
      showDeniedAlert('notifications');
    }
  }

  return normalized;
}

// ─── Helpers utilitaires ────────────────────────────────────────────────

/**
 * Ouvre directement les paramètres de l'app, sans prompt préalable.
 * Pour les boutons "Réactiver les notifications" dans Settings, etc.
 */
export function openAppSettings(): void {
  Linking.openSettings().catch(() => {
    if (Platform.OS === 'ios') {
      Linking.openURL('app-settings:').catch(() => {});
    }
  });
}

/**
 * Vérification non-intrusive : retourne l'état sans rien prompt.
 * Utile pour disabled un bouton dans l'UI sans déclencher de dialog.
 */
export async function checkMicrophonePermission(): Promise<PermissionResult> {
  try {
    return normalize(await Audio.getPermissionsAsync());
  } catch {
    return { status: 'denied', canAskAgain: true };
  }
}

export async function checkCameraPermission(): Promise<PermissionResult> {
  try {
    return normalize(await ImagePicker.getCameraPermissionsAsync());
  } catch {
    return { status: 'denied', canAskAgain: true };
  }
}

export async function checkNotificationPermission(): Promise<PermissionResult> {
  try {
    const r = await Notifications.getPermissionsAsync();
    return normalize({ status: r.status, canAskAgain: r.canAskAgain });
  } catch {
    return { status: 'denied', canAskAgain: true };
  }
}
