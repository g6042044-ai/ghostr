// src/services/themeStorage.ts
// Persistance du choix d'apparence (Light / Dark / System) de l'utilisateur.
//
// ════════════════════════════════════════════════════════════════════════════
// SÉCURITÉ / PRIVACY
// ════════════════════════════════════════════════════════════════════════════
// La préférence d'apparence est de la MÉTADONNÉE d'UI. Elle ne doit JAMAIS :
//  - être envoyée au serveur ou aux relays
//  - apparaître dans les logs server-side
//  - être incluse dans des télémetries
//
// AsyncStorage suffit (pas de donnée sensible). On évite expo-secure-store
// pour ne pas gaspiller le store sécurisé, dédié aux clés crypto.
//
// Le pattern de cache et de promesse top-level est repris de
// `src/i18n/storage.ts` pour rester cohérent avec le reste du boot.

import AsyncStorage from '@react-native-async-storage/async-storage';

// Préfixe `@ghostr/...` identique au reste de l'app (cf. App.tsx
// ONBOARDING_COMPLETED_KEY, etc.) pour cohérence de scope.
const STORAGE_KEY = '@ghostr/appearance';

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────
//
// `null` ou `'system'` représentent tous deux "suivre l'OS". On normalise à
// `'system'` côté API publique et on omet l'entrée AsyncStorage dans ce cas
// (la clé absente = défaut = système). Le typage `ColorScheme` ne contient
// QUE les modes explicites, conformément au pattern des préférences i18n.

export type AppearancePreference = 'light' | 'dark' | 'system';

const VALID: ReadonlySet<AppearancePreference> = new Set(['light', 'dark', 'system']);

function isValidPreference(v: unknown): v is AppearancePreference {
  return typeof v === 'string' && VALID.has(v as AppearancePreference);
}

// ────────────────────────────────────────────────────────────────────────────
// CACHE MODULE-LEVEL
// ────────────────────────────────────────────────────────────────────────────
//
// Démarre la lecture AU PLUS TÔT (avant que React ne mount). Au moment où
// `ThemeProvider` se monte, la promesse est généralement déjà résolue → init
// synchrone effectif → pas de flash de la mauvaise apparence après le 1er
// render.
//
// Pour l'application AVANT le 1er render (afin que `theme.colors` reflète
// déjà la préférence stockée au moment où d'autres modules exécutent leur
// `StyleSheet.create`), on doit attendre cette promesse pendant le bootstrap.
// Cf. App.tsx, où la même attente existe pour i18n.

let _cache: AppearancePreference | 'unloaded' = 'unloaded';

// The boot promise hydrates `_cache` from AsyncStorage at module load.
// IMPORTANT: only set `_cache` if it's still 'unloaded'. Theoretically the
// user could call `storeAppearance(pref)` BEFORE the boot promise resolves
// (cold start → ThemeScreen → tap, in under ~30 ms). If we unconditionally
// overwrote `_cache` from the boot promise's resolved value, we'd revert
// the user's freshly-stored choice to the stale value that was on disk at
// module-load time. In practice this race is extremely unlikely (the user
// has to navigate Settings → Appearance before AsyncStorage finishes
// reading a single key) but the guard is cheap and the bug would be
// silent if it ever fired.
const _bootPromise: Promise<AppearancePreference> = AsyncStorage.getItem(STORAGE_KEY)
  .then((v) => {
    const pref: AppearancePreference = isValidPreference(v) ? v : 'system';
    if (_cache === 'unloaded') _cache = pref;
    return pref;
  })
  .catch(() => {
    if (_cache === 'unloaded') _cache = 'system';
    return 'system' as AppearancePreference;
  });

// ────────────────────────────────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Lit la préférence d'apparence stockée. Retourne `'system'` si l'utilisateur
 * n'a jamais fait de choix explicite, ou si la clé est corrompue.
 *
 * Bloque uniquement si la promesse top-level n'est pas encore résolue, ce qui
 * n'arrive qu'au tout début du boot.
 */
export async function loadStoredAppearance(): Promise<AppearancePreference> {
  if (_cache !== 'unloaded') return _cache;
  return _bootPromise;
}

/**
 * Version synchrone : renvoie la valeur cachée si déjà chargée, sinon
 * `'system'`. Utile pour le 1er render quand on ne peut pas bloquer.
 *
 * Sécurité : ne PAS appeler avant que la promesse top-level ait au moins eu
 * une chance de tourner — sinon on retourne `'system'` à tort. En pratique,
 * appeler depuis un composant React garantit que la frame de rendu suit
 * l'import du module donc la promesse a démarré.
 */
export function loadStoredAppearanceSync(): AppearancePreference {
  if (_cache === 'unloaded') return 'system';
  return _cache;
}

/**
 * Persiste le choix d'apparence. Pour revenir à "Système", passer `'system'`
 * (ou omettre l'argument) — la clé AsyncStorage est supprimée plutôt que
 * d'être écrite, ce qui rend le défaut explicite au prochain démarrage.
 */
export async function storeAppearance(pref: AppearancePreference = 'system'): Promise<void> {
  try {
    if (pref === 'system') {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } else {
      await AsyncStorage.setItem(STORAGE_KEY, pref);
    }
    _cache = pref;
  } catch {
    // Silencieux : la préférence n'est pas critique. L'utilisateur pourra
    // simplement re-choisir au prochain démarrage. On NE log PAS pour éviter
    // d'écrire un signal sur AsyncStorage dans les logs natifs.
  }
}

/**
 * Retourne la promesse de chargement initial. Utilisé par le bootstrap pour
 * `await` la préférence stockée AVANT d'appeler `_applyBootScheme()` dans
 * `theme.ts`. Cf. App.tsx.
 */
export function appearanceBootPromise(): Promise<AppearancePreference> {
  return _bootPromise;
}

// ════════════════════════════════════════════════════════════════════════════
// RESTART HELPERS
// ════════════════════════════════════════════════════════════════════════════
//
// Why these live here and not in a generic service: theme switching is
// currently the only consumer of an explicit "reload the JS bundle"
// operation. If you later add other consumers (locale changes, etc.) it
// might be worth promoting these to e.g. `services/restart.ts`.
//
// `expo-updates` is the standard way to programmatically restart a React
// Native bundle in Expo apps. It's lazy-loaded here because:
//  1. Not all apps install it, and we want this module to import cleanly
//     in dev/test environments where the native module is missing.
//  2. The native module isn't loaded until first call — saves a few ms at
//     boot.
//
// If `expo-updates` is not installed/available, `canRestartApp()` returns
// `false` and the UI falls back to showing the "restart manually" banner.

let _restartChecked = false;
let _restartFn: (() => Promise<void>) | null = null;

function ensureRestartModule(): void {
  if (_restartChecked) return;
  _restartChecked = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Updates = require('expo-updates');
    // The module exposes `reloadAsync` as the standard restart API.
    if (Updates && typeof Updates.reloadAsync === 'function') {
      _restartFn = () => Updates.reloadAsync();
    }
  } catch {
    // Module not installed or native side missing. _restartFn stays null.
  }
}

/**
 * True if the app can programmatically restart its JS bundle.
 * False if `expo-updates` isn't installed or the native module isn't
 * linked (e.g., in some dev configurations).
 *
 * UI callers should use this to decide whether to offer an auto-restart
 * flow vs. fall back to the "please restart manually" banner.
 */
export function canRestartApp(): boolean {
  ensureRestartModule();
  return _restartFn !== null;
}

/**
 * Restart the JS bundle. Resolves only if the restart fails — on success
 * the JS context tears down before this promise can resolve.
 *
 * Callers should `await` this and handle errors by falling back to the
 * banner. Don't render UI between calling this and the bundle reloading;
 * the user briefly sees the native splash.
 */
export async function restartApp(): Promise<void> {
  ensureRestartModule();
  if (!_restartFn) {
    throw new Error(
      'expo-updates is not available. Install it with `npx expo install expo-updates` to enable auto-restart.',
    );
  }
  await _restartFn();
}
