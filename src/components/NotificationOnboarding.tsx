// src/components/NotificationOnboarding.tsx
// GHOSTR — Notification Onboarding Screen
//
// Écran plein page affiché une seule fois après le premier déverrouillage.
//
// ANDROID + iOS:
//   Étape unique → "Activer les notifications" → permission système → terminé
//
// Si l'utilisateur refuse, l'écran se ferme
// et ne réapparaît JAMAIS. Il peut réactiver dans les Paramètres.
//
// NOTE: Pas d'étape "bannière persistante" sur iOS.
// Ce réglage iOS rend TOUTES les notifications persistantes (messages inclus).
// Les appels entrants utilisent interruptionLevel 'timeSensitive' pour
// se démarquer sans affecter les autres notifications.
//
// USAGE:
//   <NotificationOnboarding onComplete={(accepted) => {
//     if (accepted) initPushNotifications(...)
//   }} />

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform,
  Animated, Easing,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { theme } from './ui/theme';
import {
  hasCompletedNotificationOnboarding,
  markNotificationOnboardingDone,
  setPushEnabled,
} from '../services/pushNotificationService';

// ============================================
// TYPES
// ============================================

interface Props {
  /** Appelé quand l'onboarding est terminé. accepted=true si l'utilisateur a activé les notifications. */
  onComplete: (accepted: boolean) => void;
}

type Step = 'permission' | 'hidden';

// ============================================
// COMPOSANT
// ============================================

export const NotificationOnboarding: React.FC<Props> = ({ onComplete }) => {
  const [step, setStep] = useState<Step>('hidden');
  const [loading, setLoading] = useState(false);
  const insets = useSafeAreaInsets();

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const contentSlide = useRef(new Animated.Value(30)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;

  // Transition entre étapes
  const stepFade = useRef(new Animated.Value(1)).current;
  const stepSlide = useRef(new Animated.Value(0)).current;

  // Vérifier si l'onboarding doit être affiché
  useEffect(() => {
    (async () => {
      const done = await hasCompletedNotificationOnboarding();
      if (!done) {
        setStep('permission');
      } else {
        onComplete(true); // Déjà fait → laisser l'app continuer
      }
    })();
  }, []);

  // Animation d'entrée
  useEffect(() => {
    if (step === 'hidden') return;

    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.timing(contentSlide, {
        toValue: 0, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }),
    ]).start();

    // Pulsing rings
    const pulse = (ring: Animated.Value, delay: number) =>
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.timing(ring, { toValue: 1, duration: 2400, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(ring, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]));
    const a1 = pulse(ring1, 0); const a2 = pulse(ring2, 700); const a3 = pulse(ring3, 1400);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, [step === 'hidden']);

  // ── Accepter les notifications ──
  const handleAccept = useCallback(async () => {
    setLoading(true);
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status === 'granted') {
        // iOS + Android: terminé dès que la permission est accordée.
        // Pas d'étape "bannière persistante" — ce réglage iOS rend
        // TOUTES les notifications persistantes (messages inclus).
        // Les appels entrants utilisent interruptionLevel 'timeSensitive'
        // et categoryIdentifier 'incoming_call' pour se démarquer.
        await markNotificationOnboardingDone();
        _animateOut(() => onComplete(true));
      } else {
        // Permission refusée → fermer et ne plus montrer
        await markNotificationOnboardingDone();
        await setPushEnabled(false);
        _animateOut(() => onComplete(false));
      }
    } catch {
      await markNotificationOnboardingDone();
      _animateOut(() => onComplete(false));
    }
    setLoading(false);
  }, [onComplete]);

  // ── Refuser ──
  const handleDecline = useCallback(async () => {
    await markNotificationOnboardingDone();
    await setPushEnabled(false);
    _animateOut(() => onComplete(false));
  }, [onComplete]);

  const _animateOut = (cb: () => void) => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => {
      setStep('hidden');
      cb();
    });
  };

  // Ring style helper
  const ringStyle = (ring: Animated.Value, size: number) => ({
    position: 'absolute' as const,
    width: size, height: size, borderRadius: size / 2,
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
    opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
    transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 2.5] }) }],
  });

  if (step === 'hidden') return null;

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <LinearGradient
        colors={['#070A0E', '#0A1018', '#0D1520', '#0A1018', '#070A0E']}
        locations={[0, 0.25, 0.5, 0.75, 1]}
        style={StyleSheet.absoluteFillObject}
      />

      <View style={[styles.content, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}>

        {/* ── ICÔNE ANIMÉE ── */}
        <Animated.View style={[styles.iconArea, { transform: [{ translateY: contentSlide }] }]}>
          <View style={styles.iconRingsWrap}>
            <Animated.View style={ringStyle(ring1, ICON_SIZE)} />
            <Animated.View style={ringStyle(ring2, ICON_SIZE)} />
            <Animated.View style={ringStyle(ring3, ICON_SIZE)} />
            <View style={styles.iconCircle}>
              <Ionicons
                name="notifications"
                size={40}
                color={theme.colors.primary}
              />
            </View>
          </View>
        </Animated.View>

        {/* ── CONTENU (animé par étape) ── */}
        <Animated.View style={[styles.textArea, { opacity: stepFade, transform: [{ translateY: stepSlide }] }]}>

          {step === 'permission' && (
            <>
              <Text style={styles.title}>Restez joignable</Text>
              <Text style={styles.description}>
                Activez les notifications pour être alerté des{' '}
                <Text style={styles.highlight}>messages</Text> et{' '}
                <Text style={styles.highlight}>appels entrants</Text>,
                même quand l'application est fermée.
              </Text>
              <Text style={styles.privacy}>
                <Ionicons name="shield-checkmark" size={13} color={theme.colors.success} />
                {'  '}Le contenu reste chiffré et invisible dans les notifications.
              </Text>
            </>
          )}
        </Animated.View>

        {/* ── BOUTONS ── */}
        <Animated.View style={[styles.actions, { opacity: stepFade, transform: [{ translateY: stepSlide }] }]}>

          {step === 'permission' && (
            <>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={handleAccept}
                activeOpacity={0.8}
                disabled={loading}
              >
                <Ionicons name="notifications" size={20} color={theme.colors.textOnPrimary} />
                <Text style={styles.primaryBtnText}>
                  {loading ? 'Chargement…' : 'Activer les notifications'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.skipBtn} onPress={handleDecline} activeOpacity={0.7}>
                <Text style={styles.skipBtnText}>Pas maintenant</Text>
              </TouchableOpacity>
            </>
          )}
        </Animated.View>
      </View>
    </Animated.View>
  );
};

// ============================================
// STEP ITEM (iOS étape 2)
// ============================================

const StepItem: React.FC<{
  num: string; text: string; icon: string; active?: boolean;
}> = ({ num, text, icon, active }) => (
  <View style={styles.stepRow}>
    <View style={[styles.stepBadge, active && styles.stepBadgeActive]}>
      <Text style={[styles.stepNum, active && styles.stepNumActive]}>{num}</Text>
    </View>
    <Text style={[styles.stepText, active && styles.stepTextActive]}>{text}</Text>
    <Ionicons
      name={icon as any}
      size={17}
      color={active ? theme.colors.primary : theme.colors.textMuted}
    />
  </View>
);

// ============================================
// STYLES
// ============================================

const ICON_SIZE = 88;

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 28,
  },

  // Icon
  iconArea: {
    alignItems: 'center',
    paddingTop: 40,
  },
  iconRingsWrap: {
    width: ICON_SIZE * 2.6,
    height: ICON_SIZE * 2.6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircle: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: ICON_SIZE / 2,
    backgroundColor: 'rgba(0, 217, 166, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0, 217, 166, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Text
  textArea: {
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: theme.colors.text,
    letterSpacing: -0.5,
    marginBottom: 14,
    textAlign: 'center',
  },
  description: {
    fontSize: 16,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 16,
  },
  highlight: {
    color: theme.colors.primary,
    fontWeight: '600',
  },
  privacy: {
    fontSize: 13,
    color: theme.colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },

  // Steps card (iOS step 2)
  stepsCard: {
    width: '100%',
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: 14,
    padding: 14,
    marginTop: 8,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 2,
  },
  stepDivider: {
    height: 1,
    backgroundColor: theme.colors.divider,
    marginVertical: 9,
    marginLeft: 34,
  },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeActive: {
    backgroundColor: theme.colors.primary,
  },
  stepNum: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.textSecondary,
  },
  stepNumActive: {
    color: theme.colors.textOnPrimary,
  },
  stepText: {
    fontSize: 14,
    color: theme.colors.text,
    flex: 1,
  },
  stepTextActive: {
    fontWeight: '600',
    color: theme.colors.primary,
  },

  // Actions
  actions: {
    gap: 8,
  },
  primaryBtn: {
    backgroundColor: theme.colors.primary,
    borderRadius: 16,
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  primaryBtnText: {
    fontSize: 17,
    fontWeight: '700',
    color: theme.colors.textOnPrimary,
  },
  doneBtn: {
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: 14,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  doneBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.colors.primary,
  },
  skipBtn: {
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipBtnText: {
    fontSize: 14,
    color: theme.colors.textMuted,
  },
});

export default NotificationOnboarding;