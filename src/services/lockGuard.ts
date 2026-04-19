// src/services/lockGuard.ts
// Garde globale de suppression du verrouillage + gestion couplée de la
// protection de capture d'écran (FLAG_SECURE Android).
//
// Empêche le verrouillage automatique quand l'app passe temporairement en
// background pour des raisons internes : image picker, caméra, document
// picker, écrans modals Android, etc.
//
// DÉSACTIVE ÉGALEMENT FLAG_SECURE temporairement, car sur certains modèles
// Android FLAG_SECURE bloque l'affichage de la preview caméra et de la
// galerie dans les pickers système (écran noir). La protection est ré-armée
// automatiquement au retour.
//
// Utilisation depuis n'importe quel écran :
//   import { suppressLock, releaseLock } from '../services/lockGuard';
//   suppressLock();
//   try {
//     const result = await ImagePicker.launchImageLibraryAsync(...);
//   } finally {
//     releaseLock();
//   }
//
// Le compteur est incrémental : si 2 composants appellent suppressLock(),
// il faut 2 releaseLock() pour ré-activer le verrouillage et FLAG_SECURE.
// Un timer de sécurité relâche automatiquement après 30s pour éviter
// un blocage permanent en cas de crash/oubli.

import * as ScreenCapture from 'expo-screen-capture';

let suppressCount = 0;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;

const SAFETY_TIMEOUT_MS = 30_000; // 30s max — au-delà, on considère l'Activity
                                  // système (picker/caméra) abandonnée et on
                                  // force la levée de la suppression pour que
                                  // le verrouillage puisse reprendre.

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
 * Vérifie si le verrouillage est actuellement supprimé.
 * Utilisé par le handler AppState dans App.tsx.
 */
export function isLockSuppressed(): boolean {
  return suppressCount > 0;
}