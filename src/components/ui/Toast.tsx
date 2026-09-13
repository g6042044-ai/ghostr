// src/components/ui/Toast.tsx
// ════════════════════════════════════════════════════════════════════════════
// TOAST — confirmation éphémère, non bloquante
// ════════════════════════════════════════════════════════════════════════════
//
// POURQUOI CE COMPOSANT EXISTE
// ────────────────────────────────────────────────────────────────────────────
// L'app confirmait « lien copié » avec un `Alert.alert()` natif : une modale
// qui prend le focus, assombrit l'écran et EXIGE un tap sur « OK » pour une
// action qui a déjà réussi. Pour une confirmation sans enjeu, c'est trois
// gestes de trop, et cela casse l'élan de l'utilisateur qui allait coller le
// lien dans une autre app.
//
// `InviteModal` avait déjà résolu le problème localement (le bouton copie
// passe à « Copié ✓ » pendant 2 s). Ce composant généralise ce pattern pour
// que toute l'app parle le même langage.
//
// ────────────────────────────────────────────────────────────────────────────
// POURQUOI UNE API IMPÉRATIVE
// ────────────────────────────────────────────────────────────────────────────
// Un toast est déclenché depuis un handler (`await Clipboard.setStringAsync()`
// puis confirmer), pas depuis le rendu. Exposer un composant `<Toast visible>`
// obligerait chaque écran à porter un `useState` + un `useEffect` de
// temporisation, soit exactement la friction qui a poussé les auteurs vers
// `Alert.alert()`. Avec `showToast('…')`, remplacer un Alert est une
// substitution d'une ligne.
//
// Le host est monté UNE fois dans App.tsx, au-dessus du NavigationContainer,
// pour que le toast survive à une navigation et se superpose à tout écran.
//
// ────────────────────────────────────────────────────────────────────────────
// ACCESSIBILITÉ
// ────────────────────────────────────────────────────────────────────────────
// `accessibilityLiveRegion="polite"` (Android) et `accessibilityRole="alert"`
// font annoncer le message par TalkBack/VoiceOver sans voler le focus. Un
// toast purement visuel serait invisible pour un lecteur d'écran — c'est
// précisément la régression que provoque le remplacement naïf d'un Alert.
//
// ────────────────────────────────────────────────────────────────────────────
// PRIVACY
// ────────────────────────────────────────────────────────────────────────────
// Le message affiché vient toujours d'une clé i18n de l'appelant. Ne JAMAIS
// y passer de contenu de message, de clé ou de code d'invitation : le toast
// est rendu au-dessus de tout et serait capturé par un screenshot.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from './ThemeContext';
import type { ColorPalette } from './theme';

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastOptions {
  /** Texte affiché. Doit être déjà traduit par l'appelant. */
  message: string;
  /** Détermine l'icône et la couleur d'accent. Défaut : 'success'. */
  variant?: ToastVariant;
  /** Durée d'affichage en ms, hors animations. Défaut : 2000. */
  durationMs?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// BUS IMPÉRATIF
// ────────────────────────────────────────────────────────────────────────────
// PILE de hosts, et non un abonné unique. Le toast est une `View` en
// position absolue : il ne peut recouvrir que ce qui se trouve dans SA
// hiérarchie native. Or un écran déclaré `presentation: 'modal'` est
// présenté par iOS dans un view controller AU-DESSUS de la racine React —
// un toast monté à la racine passerait derrière lui.
//
// D'où la pile : le host monté le plus récemment gagne. Un écran modal qui
// a besoin de toasts monte son propre `<ToastHost />`, reçoit les messages
// tant qu'il est affiché, et rend la main au host racine en se démontant.
// Les écrans normaux (`presentation: 'card'`) n'ont rien à faire.

type Listener = (options: ToastOptions) => void;

const listeners: Listener[] = [];

function registerHost(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.lastIndexOf(listener);
    if (i !== -1) listeners.splice(i, 1);
  };
}

/**
 * Affiche un toast sur le host le plus récemment monté.
 *
 * Sans effet si aucun `<ToastHost />` n'est monté — c'est volontaire : une
 * confirmation cosmétique ne doit jamais faire échouer l'action qu'elle
 * accompagne.
 */
export function showToast(options: ToastOptions | string): void {
  const target = listeners[listeners.length - 1];
  if (!target) {
    if (__DEV__) {
      console.warn('[Toast] showToast() appelé sans <ToastHost /> monté.');
    }
    return;
  }
  target(typeof options === 'string' ? { message: options } : options);
}

// ────────────────────────────────────────────────────────────────────────────
// HOST
// ────────────────────────────────────────────────────────────────────────────

const ENTER_MS = 180;
const EXIT_MS = 220;
const DEFAULT_DURATION_MS = 2000;

export const ToastHost: React.FC = () => {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [current, setCurrent] = useState<ToastOptions | null>(null);

  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;
  // Timer de masquage. Gardé en ref pour qu'un second `showToast()` pendant
  // qu'un toast est visible annule le timer du précédent — sinon le nouveau
  // message disparaîtrait prématurément, au moment prévu pour l'ancien.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: EXIT_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 20,
        duration: EXIT_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      // Ne démonter QUE si l'animation est allée au bout. Si un nouveau
      // toast a démarré entre-temps, il a interrompu celle-ci et démonter
      // ici effacerait un message qui vient tout juste d'apparaître.
      if (finished) setCurrent(null);
    });
  }, [opacity, translateY]);

  useEffect(() => {
    const unregister = registerHost((options: ToastOptions) => {
      clearTimer();
      setCurrent(options);

      opacity.setValue(0);
      translateY.setValue(20);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: ENTER_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: ENTER_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start();

      hideTimer.current = setTimeout(hide, options.durationMs ?? DEFAULT_DURATION_MS);
    });

    return () => {
      unregister();
      clearTimer();
    };
  }, [clearTimer, hide, opacity, translateY]);

  if (!current) return null;

  const variant = current.variant ?? 'success';
  const accent = accentForVariant(variant, colors);
  const iconName = iconForVariant(variant);

  return (
    <Animated.View
      // `pointerEvents="none"` : le toast n'intercepte JAMAIS les taps. Il
      // flotte au-dessus de l'écran ; sans ça, il bloquerait pendant 2 s la
      // zone où se trouve souvent le bouton d'envoi.
      pointerEvents="none"
      style={[
        styles.wrapper,
        { bottom: insets.bottom + 24, opacity, transform: [{ translateY }] },
      ]}
    >
      <View
        style={[
          styles.toast,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
      >
        <Ionicons name={iconName} size={18} color={accent} />
        <Text style={[styles.message, { color: colors.text }]} numberOfLines={2}>
          {current.message}
        </Text>
      </View>
    </Animated.View>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────────

function accentForVariant(variant: ToastVariant, colors: ColorPalette): string {
  if (variant === 'error') return colors.error;
  if (variant === 'info') return colors.info;
  return colors.success;
}

function iconForVariant(variant: ToastVariant): keyof typeof Ionicons.glyphMap {
  if (variant === 'error') return 'alert-circle';
  if (variant === 'info') return 'information-circle';
  return 'checkmark-circle';
}

// Styles indépendants du thème (les couleurs sont appliquées en ligne depuis
// la palette live) — évite un StyleSheet.create par changement de thème.
const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 16,
    right: 16,
    alignItems: 'center',
    // Au-dessus des modales du DS, sous l'overlay de confidentialité
    // d'App.tsx (zIndex 9999) qui doit rester le dernier rempart.
    zIndex: 9000,
    elevation: 9000,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: '100%',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
  },
  message: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '500',
  },
});

export default ToastHost;
