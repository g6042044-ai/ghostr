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
// REDÉMARRAGE DU BUNDLE — SUPPRIMÉ
// ════════════════════════════════════════════════════════════════════════════
// `canRestartApp()` et `restartApp()` (basés sur `expo-updates.reloadAsync`)
// vivaient ici pour que ThemeScreen puisse relancer le bundle JS après un
// changement d'apparence.
//
// Ce détour n'a plus d'objet : la palette est intégralement réactive
// (`theme.colors` supprimé, toutes les feuilles de styles converties en
// fabriques consommées par `useThemedStyles`). Un changement de thème est
// appliqué instantanément sur tous les écrans, donc plus aucun appelant.
//
// Redémarrer le bundle sur une messagerie chiffrée n'était de toute façon pas
// anodin : cela détruit l'état en mémoire, coupe les abonnements au relais et
// impose de ressaisir le mot de passe si le verrouillage est actif — un prix
// disproportionné pour passer du sombre au clair.
