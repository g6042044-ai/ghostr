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
import { View, Text, TouchableOpacity, StyleSheet, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles, type ColorPalette } from './ui';
import { hasCompletedNotificationOnboarding, markNotificationOnboardingDone, setPushEnabled } from '../services/pushNotificationService';
import { ensureNotificationPermission } from '../services/permissions';
// PERM FIX : Notifications + suppressLock/releaseLock retirés — gérés par
// ensureNotificationPermission dans le service permissions.

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
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [step, setStep] = useState<Step>('hidden');
  const [loading, setLoading] = useState(false);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

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
    // PERM FIX : ensureNotificationPermission gère :
    //   - suppressLock/releaseLock pendant le dialog OS
    //   - distinction granted/denied/blocked
    //   - sur iOS, l'option provisional est gérée (allowProvisional: false)
    //
    // IMPORTANT : on désactive `showAlertOnFailure` car ce composant a son
    // propre flux UX (animation de fade-out, marquer onboarding done, etc.).
    // Le service ne doit pas pop un Alert par-dessus l'écran onboarding.
    try {
      const perm = await ensureNotificationPermission({ showAlertOnFailure: false });
      if (perm.status === 'granted') {
        // iOS + Android: terminé dès que la permission est accordée.
        // Pas d'étape "bannière persistante" — ce réglage iOS rend
        // TOUTES les notifications persistantes (messages inclus).
        // Les appels entrants utilisent interruptionLevel 'timeSensitive'
        // et categoryIdentifier 'incoming_call' pour se démarquer.
        await markNotificationOnboardingDone();
        _animateOut(() => onComplete(true));
      } else {
        // Permission refusée (denied OU blocked) → fermer et ne plus montrer
        // l'onboarding. L'utilisateur peut toujours réactiver les notifs
        // depuis les paramètres système plus tard. Sur Android, on pourrait
        // re-prompter (canAskAgain=true) mais on respecte le choix initial
        // pour ne pas être harcelant.
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
    borderColor: colors.primary,
    opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
    transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 2.5] }) }],
  });

  if (step === 'hidden') return null;

  // Background gradient: subtle "depth" effect with edges slightly darker
  // than the center. Was hardcoded to dark hex values in v1; now derived
  // from the theme palette so the screen reads correctly in both modes.
  //
  // Implementation: dark theme uses the original three-tone near-black
  // depth stack. Light theme uses a similar subtle stack but inverted —
  // the center is faintly cooler/lighter than the edges, against an
  // overall light substrate, so we preserve the "deep space" feel
  // without literally drawing it in black.
  //
  // The `as const` + `[string, string, string, string, string]` cast is
  // for expo-linear-gradient's strict tuple type — at least 2 string
  // entries are required and our two branches each have exactly 5.
  const gradientStops = (isDark
    ? ['#070A0E', '#0A1018', '#0D1520', '#0A1018', '#070A0E']
    : [colors.background, colors.surface, colors.surfaceLight, colors.surface, colors.background]
  ) as readonly [string, string, string, string, string];

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <LinearGradient
        colors={gradientStops}
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
                color={colors.primary}
              />
            </View>
          </View>
        </Animated.View>

        {/* ── CONTENU (animé par étape) ── */}
        <Animated.View style={[styles.textArea, { opacity: stepFade, transform: [{ translateY: stepSlide }] }]}>

          {step === 'permission' && (
            <>
              <Text style={styles.title}>{t('notificationOnboarding.stayReachable')}</Text>
              <Text style={styles.description}>
                {t('notificationOnboarding.description1')}
                <Text style={styles.highlight}>{t('notificationOnboarding.highlightMessages')}</Text>
                {t('notificationOnboarding.descriptionAnd')}
                <Text style={styles.highlight}>{t('notificationOnboarding.highlightCalls')}</Text>
                {t('notificationOnboarding.description2')}
              </Text>
              <Text style={styles.privacy}>
                <Ionicons name="shield-checkmark" size={13} color={colors.success} />
                {'  '}{t('notificationOnboarding.privacyShort')}
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
                <Ionicons name="notifications" size={20} color={colors.textOnPrimary} />
                <Text style={styles.primaryBtnText}>
                  {loading ? t('common.loading') : t('notificationOnboarding.continue')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.skipBtn} onPress={handleDecline} activeOpacity={0.7}>
                <Text style={styles.skipBtnText}>{t('notificationOnboarding.notNow')}</Text>
              </TouchableOpacity>
            </>
          )}
        </Animated.View>
      </View>
    </Animated.View>
  );
};

// ============================================
// STYLES
// ============================================

const ICON_SIZE = 88;

const makeStyles = (colors: ColorPalette) => ({
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
    color: colors.text,
    letterSpacing: -0.5,
    marginBottom: 14,
    textAlign: 'center',
  },
  description: {
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 16,
  },
  highlight: {
    color: colors.primary,
    fontWeight: '600',
  },
  privacy: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },

  // Steps card (iOS step 2)
  stepsCard: {
    width: '100%',
    backgroundColor: colors.surfaceLight,
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
    backgroundColor: colors.divider,
    marginVertical: 9,
    marginLeft: 34,
  },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeActive: {
    backgroundColor: colors.primary,
  },
  stepNum: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  stepNumActive: {
    color: colors.textOnPrimary,
  },
  stepText: {
    fontSize: 14,
    color: colors.text,
    flex: 1,
  },
  stepTextActive: {
    fontWeight: '600',
    color: colors.primary,
  },

  // Actions
  actions: {
    gap: 8,
  },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  primaryBtnText: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.textOnPrimary,
  },
  doneBtn: {
    backgroundColor: colors.surfaceLight,
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
    color: colors.primary,
  },
  skipBtn: {
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipBtnText: {
    fontSize: 14,
    color: colors.textMuted,
  },
}) as const;

export default NotificationOnboarding;