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
// Pour les ~30 fichiers qui consomment encore `theme.colors.X` au top-level
// d'un `StyleSheet.create`, voir THEME_MIGRATION.md.
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
//   3. On verrouille `_lockBootScheme()` pour empêcher toute mutation
//      ultérieure de `theme.colors` côté legacy (cohérence garantie entre
//      styles frozen et styles live).
//
// Au changement de préf :
//   - `setAppearance(pref)` met à jour l'état React → re-render de tout
//     consommateur `useTheme()`.
//   - Persiste via `storeAppearance(pref)`.
//   - Si le nouveau `effectiveScheme` DIFFÈRE du `bootScheme` initialement
//     appliqué à `theme.colors`, on expose `requiresReload = true` pour que
//     l'UI puisse afficher un message « relancez l'app pour appliquer
//     partout ». Les composants qui consomment `useTheme()` voient le bon
//     thème immédiatement ; ceux qui consomment encore le legacy export ne
//     bougeront qu'au prochain cold start.
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
  _lockBootScheme,
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
  /**
   * Vrai si `scheme` diffère du scheme qui a été appliqué au boot. Quand
   * c'est le cas, les styles legacy (au top-level d'un StyleSheet.create)
   * sont encore figés sur l'ancien thème — un reload du JS bundle est
   * nécessaire pour qu'ils s'alignent. Les ThemeScreen / SettingsScreen
   * utilisent ce flag pour afficher un message d'attente.
   */
  requiresReload: boolean;
  /**
   * The scheme captured at module load — the palette that legacy
   * module-level `StyleSheet.create({ color: theme.colors.X })` calls
   * actually used. Exposed so the UI can decide, BEFORE applying a
   * choice, whether that choice would require a restart.
   */
  getBootScheme: () => ColorScheme;
}

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

  // First mount: notify the theme module that the UI has started rendering.
  // Currently a no-op (kept for API stability) — see the docstring of
  // `_lockBootScheme` in theme.ts for the historical context.
  const lockedRef = useRef(false);
  if (!lockedRef.current) {
    _lockBootScheme();
    lockedRef.current = true;
  }

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

  const requiresReload = useMemo(() => scheme !== getBootScheme(), [scheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      colors,
      scheme,
      isDark: scheme === 'dark',
      preference,
      setAppearance,
      requiresReload,
      getBootScheme,
    }),
    [colors, scheme, preference, setAppearance, requiresReload],
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
    requiresReload: false,
    getBootScheme,
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
