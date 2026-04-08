// src/services/lockGuard.ts
// Garde globale de suppression du verrouillage.
//
// Empêche le verrouillage automatique quand l'app passe temporairement en
// background pour des raisons internes : image picker, caméra, document
// picker, écrans modals Android, etc.
//
// Utilisation depuis n'importe quel écran :
//   import { suppressLock, releaseLock } from '../services/lockGuard';
//   suppressLock();
//   const result = await ImagePicker.launchImageLibraryAsync(...);
//   releaseLock();
//
// Le compteur est incrémental : si 2 composants appellent suppressLock(),
// il faut 2 releaseLock() pour ré-activer le verrouillage.
// Un timer de sécurité relâche automatiquement après 120s pour éviter
// un blocage permanent en cas de crash/oubli.

let suppressCount = 0;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;

const SAFETY_TIMEOUT_MS = 120_000; // 2 minutes max

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
    }
    safetyTimer = null;
  }, SAFETY_TIMEOUT_MS);
}

/**
 * Supprime le verrouillage automatique.
 * Appeler AVANT d'ouvrir un picker, la caméra, ou toute Activity système.
 */
export function suppressLock(): void {
  suppressCount++;
  resetSafetyTimer();
  __DEV__ && console.log(`[lockGuard] suppress (count=${suppressCount})`);
}

/**
 * Relâche la suppression du verrouillage.
 * Appeler APRÈS le retour du picker/caméra/Activity système.
 */
export function releaseLock(): void {
  if (suppressCount > 0) {
    suppressCount--;
  }
  if (suppressCount === 0 && safetyTimer) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
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