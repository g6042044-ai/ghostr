// src/components/ui/ThemeContext.tsx
// ════════════════════════════════════════════════════════════════════════════
// CONTEXTE D'APPARENCE — Light / Dark / System
// ════════════════════════════════════════════════════════════════════════════
//
// Trois consommateurs principaux :
//   - `useTheme()`               → composants qui veulent les couleurs LIVE
//   - `useThemedStyles(builder)` → composants qui construisent un
//                                  `StyleSheet.create` dépendant des couleurs
//   - `useAppearancePreference()`→ écran Settings → ThemeScreen pour lire le
//                                  choix utilisateur courant et le modifier
//
// Il n'existe PLUS de consommateur legacy : `theme.colors` a été supprimé du
// module theme.ts, donc `useTheme()` / `useThemedStyles()` sont les seules
// portes d'entrée vers les couleurs. Tout changement d'apparence est
// instantané sur l'ensemble de l'application.
//
// ════════════════════════════════════════════════════════════════════════════
// COMPORTEMENT
// ════════════════════════════════════════════════════════════════════════════
//
// Au mount du provider :
//   1. On lit le préf stocké via `loadStoredAppearance()` (cache module
//      probablement déjà résolu — < 30 ms typique au cold start).
//   2. On résout `effectiveScheme` :
//        - 'system' → `Appearance.getColorScheme()` (ou 'dark' fallback)
//        - 'light'  → 'light'
//        - 'dark'   → 'dark'

// Au changement de préf :
//   - `setAppearance(pref)` met à jour l'état React → re-render de tout
//     consommateur `useTheme()`.
//   - Persiste via `storeAppearance(pref)`.
//
// Au changement de préférence système (Appearance.addChangeListener) :
//   - Si la préf user est `'system'`, on met à jour `effectiveScheme`
//     immédiatement, sinon on ignore (l'override gagne).

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Appearance, StyleSheet } from 'react-native';

import {
  getColorsForScheme,
  getBootScheme,
  type ColorPalette,
  type ColorScheme,
} from './theme';
import {
  loadStoredAppearanceSync,
  loadStoredAppearance,
  storeAppearance,
  type AppearancePreference,
} from '../../services/themeStorage';

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────

export interface ThemeContextValue {
  /** Palette LIVE (change quand la préf change). */
  colors: ColorPalette;
  /** Scheme effectivement résolu — utile pour StatusBar barStyle, etc. */
  scheme: ColorScheme;
  /** Convenience flag. */
  isDark: boolean;
  /** Préférence utilisateur stockée (avant résolution 'system' → light/dark). */
  preference: AppearancePreference;
  /** Met à jour la préférence + persiste. */
  setAppearance: (pref: AppearancePreference) => Promise<void>;
}
// `requiresReload` et `getBootScheme` ont été RETIRÉS du contexte. Ils
// servaient à prévenir l'utilisateur qu'une partie de l'app resterait figée
// sur l'ancienne palette jusqu'au prochain démarrage. Plus aucun style n'est
// figé, donc le drapeau serait toujours faux et le flux de redémarrage qu'il
// pilotait a été supprimé de ThemeScreen.

// ────────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────────

function resolveScheme(pref: AppearancePreference): ColorScheme {
  if (pref === 'light' || pref === 'dark') return pref;
  // 'system' — lis l'OS. `null` (jamais défini) → on retombe sur le
  // bootScheme qui a déjà été déterminé au mieux à l'import de theme.ts.
  try {
    const os = Appearance.getColorScheme();
    if (os === 'light' || os === 'dark') return os;
  } catch {
    /* getColorScheme peut throw sur certaines builds */
  }
  return getBootScheme();
}

// ────────────────────────────────────────────────────────────────────────────
// CONTEXT
// ────────────────────────────────────────────────────────────────────────────

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  children: React.ReactNode;
  /**
   * Préférence initiale connue au moment du mount. Si fournie (et que le
   * cache AsyncStorage est résolu côté bootstrap), évite un 1er render sur
   * 'system' suivi d'un re-render sur la valeur stockée. Cf. App.tsx.
   */
  initialPreference?: AppearancePreference;
}

export function ThemeProvider({ children, initialPreference }: ThemeProviderProps) {
  // Init synchrone — privilégie initialPreference, sinon cache sync, sinon
  // 'system'. La promesse top-level de themeStorage est généralement déjà
  // résolue à ce point (cf. comment dans themeStorage.ts).
  const [preference, setPreference] = useState<AppearancePreference>(() => {
    if (initialPreference) return initialPreference;
    return loadStoredAppearanceSync();
  });

  const [scheme, setScheme] = useState<ColorScheme>(() => resolveScheme(preference));

  // Tracks whether `setAppearance` has been called on this mount. Used by
  // the async re-check below to avoid overriding a freshly user-set value
  // with the stale value that AsyncStorage was holding before the user
  // wrote — a tiny race window (boot promise resolves in ~30 ms, faster
  // than the user can possibly navigate to ThemeScreen) but still a real
  // correctness issue if it ever fires.
  const userTouchedRef = useRef(false);

  // ALWAYS run an async re-check of the stored preference, regardless of
  // whether `initialPreference` was provided. The sync read used to seed
  // initial state can legitimately return the 'system' fallback when the
  // AsyncStorage cache hasn't resolved yet (e.g. first render on a cold
  // bundle with very fast UI). Without this re-check, a user whose stored
  // preference is 'light' or 'dark' would silently stay on 'system' until
  // the next cold start. The setState updater keeps work at zero if
  // nothing actually changed.
  useEffect(() => {
    let cancelled = false;
    loadStoredAppearance().then((pref) => {
      if (cancelled) return;
      // If the user has explicitly set a preference since mount, don't
      // restore the (potentially stale) async value — their choice wins.
      if (userTouchedRef.current) return;
      setPreference((current) => (current === pref ? current : pref));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Recalcule le scheme effectif quand la préf change OU quand l'OS change
  // ET que la préf est 'system'.
  useEffect(() => {
    const next = resolveScheme(preference);
    setScheme((current) => (current === next ? current : next));
  }, [preference]);

  useEffect(() => {
    if (preference !== 'system') return;
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      const next: ColorScheme = colorScheme === 'light' ? 'light' : 'dark';
      setScheme((current) => (current === next ? current : next));
    });
    return () => {
      sub.remove();
    };
  }, [preference]);

  const setAppearance = useCallback(async (next: AppearancePreference) => {
    userTouchedRef.current = true;
    setPreference(next);
    // Persistence en parallèle — pas besoin d'attendre pour mettre à jour
    // l'UI. Les erreurs sont swallowed dans storeAppearance.
    await storeAppearance(next);
  }, []);

  const colors = useMemo(() => getColorsForScheme(scheme), [scheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      colors,
      scheme,
      isDark: scheme === 'dark',
      preference,
      setAppearance,
    }),
    [colors, scheme, preference, setAppearance],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// ────────────────────────────────────────────────────────────────────────────
// HOOKS
// ────────────────────────────────────────────────────────────────────────────

/**
 * Renvoie le contexte complet. Throw en dev si le provider est absent — on
 * NE veut PAS d'un fallback silencieux qui masquerait des oublis de wrapping.
 *
 * En prod, par sécurité, on retombe sur les couleurs du bootScheme (le pire
 * cas affiche un thème statique, jamais une crash).
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx;
  if (__DEV__) {
    throw new Error(
      '[ThemeContext] useTheme() called outside <ThemeProvider>. ' +
        'Wrap your app in <ThemeProvider> in App.tsx.',
    );
  }
  // Fallback prod — palette du bootScheme, pas d'updates live.
  const bootScheme = getBootScheme();
  return {
    colors: getColorsForScheme(bootScheme),
    scheme: bootScheme,
    isDark: bootScheme === 'dark',
    preference: 'system',
    setAppearance: async () => {},
  };
}

/**
 * Variante uniquement-couleurs — la majorité des cas d'usage. Évite de
 * détruire l'objet à chaque render.
 */
export function useThemeColors(): ColorPalette {
  return useTheme().colors;
}

/**
 * Helper pour construire un StyleSheet qui dépend des couleurs. Mémoïse par
 * référence de la palette, donc :
 *   - 0 work tant que la palette ne change pas
 *   - 1 `StyleSheet.create` quand l'utilisateur switch de thème
 *
 * Utilisation :
 *   const styles = useThemedStyles((colors) => ({
 *     container: { backgroundColor: colors.background },
 *     title: { color: colors.text },
 *   }));
 *
 * Le générique préserve l'auto-complétion sur `styles.X`.
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<unknown>>(
  builder: (colors: ColorPalette) => T,
): T {
  const colors = useThemeColors();
  // useMemo sur la référence des couleurs : `getColorsForScheme` renvoie
  // toujours le MÊME objet par scheme, donc l'identity-check sur `colors`
  // est exact.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => StyleSheet.create(builder(colors)), [colors]);
}
