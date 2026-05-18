// src/services/lockGuard.ts
// Garde globale de suppression du verrouillage + gestion couplée de la
// protection de capture d'écran (FLAG_SECURE Android).
//
// Empêche le verrouillage automatique quand l'app passe temporairement en
// background pour des raisons internes : image picker, caméra, document
// picker, sheet de partage système, écrans modals Android, etc.
//
// DÉSACTIVE ÉGALEMENT FLAG_SECURE temporairement, car sur certains modèles
// Android FLAG_SECURE bloque l'affichage de la preview caméra et de la
// galerie dans les pickers système (écran noir). La protection est ré-armée
// automatiquement au retour.
//
// ═══════════════════════════════════════════════════════════════════════════
// TROIS APIs selon le besoin
// ═══════════════════════════════════════════════════════════════════════════
//
// 1. suppressLock() / releaseLock() — pour les Activity synchrones dont la
//    Promise résout APRÈS le retour à l'app (typique : ImagePicker). La
//    promise attend le retour, donc releaseLock() dans un finally est OK.
//
//    suppressLock();
//    try {
//      const result = await ImagePicker.launchImageLibraryAsync(...);
//    } finally {
//      releaseLock();
//    }
//
// 2. withExternalActivity(fn, graceMs?) — wrapper sûr pour les Activity dont
//    la Promise peut résoudre AVANT le retour à l'app (typique : Share.share
//    sur Android, où la promise résout au tap sur la cible, l'utilisateur
//    étant déjà dans l'app externe). Maintient la suppression pendant
//    `graceMs` millisecondes après le return de fn, puis release.
//
//    await withExternalActivity(() => Share.share({ message: '...' }));
//
// 3. isLockSuppressed() — lu par le handler AppState pour savoir s'il doit
//    ignorer un passage en 'background'.
// ═══════════════════════════════════════════════════════════════════════════

import { Platform } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';

let suppressCount = 0;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;

// 30s max : au-delà, on considère l'Activity système (picker/caméra/share)
// abandonnée et on force la levée de la suppression pour que le verrouillage
// puisse reprendre.
const SAFETY_TIMEOUT_MS = 30_000;

// Délai de grâce par défaut après la résolution d'une Promise d'Activity
// externe, avant de re-armer le verrouillage. Nécessaire surtout sur Android
// où les Promises type Share.share résolvent souvent dès le choix de la cible
// (app externe déjà ouverte, utilisateur pas encore de retour dans Ghostr).
const DEFAULT_GRACE_MS = 5_000;

const SCREEN_CAPTURE_TAG = 'ghostr-global';

function enableScreenCaptureForPicker(): void {
  // Retire FLAG_SECURE pendant l'ouverture du picker. Sans ça, certains
  // téléphones Android affichent une preview caméra noire.
  ScreenCapture.allowScreenCaptureAsync(SCREEN_CAPTURE_TAG).catch(() => {});
}

function restoreScreenCaptureProtection(): void {
  ScreenCapture.preventScreenCaptureAsync(SCREEN_CAPTURE_TAG).catch(() => {});
}

function resetSafetyTimer(): void {
  if (safetyTimer) {
    clearTimeout(safetyTimer);
  }
  safetyTimer = setTimeout(() => {
    if (suppressCount > 0) {
      __DEV__ && console.warn(
        `[lockGuard] ⚠️ Safety timeout: force-releasing ${suppressCount} suppression(s)`
      );
      suppressCount = 0;
      // Forcer aussi la restauration de la protection de capture
      restoreScreenCaptureProtection();
    }
    safetyTimer = null;
  }, SAFETY_TIMEOUT_MS);
}

/**
 * Supprime le verrouillage automatique ET FLAG_SECURE.
 * Appeler AVANT d'ouvrir un picker, la caméra, ou toute Activity système.
 */
export function suppressLock(): void {
  suppressCount++;
  if (suppressCount === 1) {
    // Premier appel : désactiver FLAG_SECURE. Les appels suivants ne
    // le redésactivent pas (déjà off) et n'en tiennent pas un compte séparé.
    enableScreenCaptureForPicker();
  }
  resetSafetyTimer();
  __DEV__ && console.log(`[lockGuard] suppress (count=${suppressCount})`);
}

/**
 * Relâche la suppression du verrouillage ET restaure FLAG_SECURE.
 * Appeler APRÈS le retour du picker/caméra/Activity système.
 */
export function releaseLock(): void {
  if (suppressCount > 0) {
    suppressCount--;
  }
  if (suppressCount === 0) {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    // Ré-armer FLAG_SECURE dès que plus personne n'a besoin du picker.
    restoreScreenCaptureProtection();
  }
  __DEV__ && console.log(`[lockGuard] release (count=${suppressCount})`);
}

/**
 * Version différée de releaseLock : garde la suppression active pendant
 * `graceMs` millisecondes supplémentaires avant de relâcher.
 *
 * Utile pour les APIs système dont la Promise résout avant le retour visuel
 * à l'application (typique : Share.share sur Android).
 */
export function releaseLockDeferred(graceMs: number = DEFAULT_GRACE_MS): void {
  setTimeout(() => {
    releaseLock();
  }, graceMs);
}

/**
 * Wrapper sûr pour les opérations qui ouvrent une Activity système externe
 * (Share.share, Linking.openURL, WebBrowser.openAuthSessionAsync, etc.).
 *
 * Garantit qu'aucun verrouillage de sécurité ne se déclenche pendant l'usage
 * de l'Activity externe, même si la Promise résout avant le retour de
 * l'utilisateur (cas typique Android Share : résolution au tap sur la cible).
 *
 * La protection est maintenue :
 *   - Toute la durée d'exécution de fn()
 *   - + graceMs millisecondes après (défaut : 5s)
 *   - Maximum SAFETY_TIMEOUT_MS (30s) par sécurité
 *
 * Le retour effectif de l'utilisateur (AppState → 'active') n'affecte pas
 * ce délai : si l'utilisateur revient vite, la grâce continue ; s'il revient
 * tard, le safetyTimer force la levée de la suppression.
 *
 * Exemple :
 *   await withExternalActivity(() =>
 *     Share.share({ message: 'Rejoins ma conv' })
 *   );
 *
 * Les erreurs lancées par fn() sont re-thrown après release, pour que
 * l'appelant puisse les gérer.
 */
export async function withExternalActivity<T>(
  fn: () => Promise<T>,
  graceMs?: number,
): Promise<T> {
  // Sur iOS le Share sheet est un overlay géré par l'app (pas une nouvelle
  // Activity), donc en théorie pas de 'background'. Mais on garde la
  // suppression par sécurité (certaines combinaisons iOS + OS-level share
  // extension peuvent déclencher 'background'). Impact nul sur le flow.
  suppressLock();

  // Sur Android, Share.share résout au moment du choix → l'utilisateur
  // n'est pas encore revenu. Grâce plus longue.
  // Sur iOS, la Promise résout après fermeture de la sheet → grâce courte OK.
  const effectiveGrace = graceMs ?? (Platform.OS === 'android' ? DEFAULT_GRACE_MS : 1_500);

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    // Release avec grâce même en cas d'erreur : l'utilisateur peut être
    // toujours dans l'Activity externe malgré l'erreur (cas Share.share
    // annulée qui throw sur certaines versions Android).
    releaseLockDeferred(effectiveGrace);
    throw err;
  }

  releaseLockDeferred(effectiveGrace);
  return result;
}

/**
 * Vérifie si le verrouillage est actuellement supprimé.
 * Utilisé par le handler AppState dans App.tsx.
 */
export function isLockSuppressed(): boolean {
  return suppressCount > 0;
}