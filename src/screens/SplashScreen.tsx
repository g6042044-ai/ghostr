// src/screens/SplashScreen.tsx
// v7.0 - Reusable loading screen with animated status messages
//
// Used in 3 contexts:
// 1. App initialization (default) — "Préparation de vos clés..."
// 2. App unlock (after password) — "Déverrouillage en cours..."
// 3. Joining a conversation — "Connexion sécurisée..."
//
// Accepts optional props to customize the message shown.
// Falls back to cycling through init messages if no props given.

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Platform,
  StatusBar,
  Dimensions,
  Animated,
  Easing,
} from 'react-native';
import { theme } from '../components/ui/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const LOGO_SIZE = Math.min(SCREEN_WIDTH * 0.38, 170);

// Default init messages that cycle automatically
const INIT_MESSAGES = [
  { text: 'Initialisation du chiffrement…', delay: 0 },
  { text: 'Génération des clés de session…', delay: 2500 },
  { text: 'Préparation de la protection post-quantique…', delay: 5500 },
  { text: 'Vérification de l\'intégrité…', delay: 8500 },
  { text: 'Presque prêt…', delay: 11000 },
];

export interface SplashScreenProps {
  /** Override the status message (e.g. "Déverrouillage en cours...") */
  statusMessage?: string;
  /** Optional subtitle below the status */
  statusSubtitle?: string;
  /** 0-1 progress value. If provided, shows a progress bar. */
  progress?: number;
}

export function SplashScreen({ statusMessage, statusSubtitle, progress }: SplashScreenProps = {}) {
  // Cycling init messages (only when no override)
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);

  useEffect(() => {
    if (statusMessage) return;
    const timers = INIT_MESSAGES.map((msg, i) =>
      setTimeout(() => setCurrentMessageIndex(i), msg.delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [statusMessage]);

  const displayedMessage = statusMessage || INIT_MESSAGES[currentMessageIndex].text;

  // Logo respiration
  const breathScale = useRef(new Animated.Value(1)).current;

  // Rings
  const r1Scale = useRef(new Animated.Value(1)).current;
  const r1Opacity = useRef(new Animated.Value(0.20)).current;
  const r2Scale = useRef(new Animated.Value(1)).current;
  const r2Opacity = useRef(new Animated.Value(0.10)).current;
  const r3Scale = useRef(new Animated.Value(1)).current;
  const r3Opacity = useRef(new Animated.Value(0.05)).current;

  // Status text fade
  const textOpacity = useRef(new Animated.Value(0)).current;
  const textTranslateY = useRef(new Animated.Value(8)).current;
  const prevMessageRef = useRef(displayedMessage);

  // Fade in on mount
  useEffect(() => {
    Animated.parallel([
      Animated.timing(textOpacity, {
        toValue: 1, duration: 600, useNativeDriver: true,
      }),
      Animated.timing(textTranslateY, {
        toValue: 0, duration: 600, easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  // Crossfade on message change
  useEffect(() => {
    if (prevMessageRef.current === displayedMessage) return;
    prevMessageRef.current = displayedMessage;

    Animated.sequence([
      Animated.parallel([
        Animated.timing(textOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(textTranslateY, { toValue: -6, duration: 200, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(textOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
        Animated.timing(textTranslateY, {
          toValue: 0, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, [displayedMessage]);

  // Progress bar animation
  const progressWidth = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (progress === undefined) return;
    Animated.timing(progressWidth, {
      toValue: progress,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [progress]);

  // Ring animations
  useEffect(() => {
    const pulse = (
      scaleVal: Animated.Value, scaleMin: number, scaleMax: number,
      opacityVal: Animated.Value, opacityMin: number, opacityMax: number,
      duration: number,
    ) =>
      Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(scaleVal, {
              toValue: scaleMax, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
            }),
            Animated.timing(opacityVal, {
              toValue: opacityMax, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
            }),
          ]),
          Animated.parallel([
            Animated.timing(scaleVal, {
              toValue: scaleMin, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
            }),
            Animated.timing(opacityVal, {
              toValue: opacityMin, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
            }),
          ]),
        ]),
      );

    Animated.parallel([
      Animated.loop(
        Animated.sequence([
          Animated.timing(breathScale, {
            toValue: 1.03, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
          }),
          Animated.timing(breathScale, {
            toValue: 1, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
          }),
        ]),
      ),
      pulse(r1Scale, 0.97, 1.06, r1Opacity, 0.06, 0.35, 1600),
      pulse(r2Scale, 0.96, 1.05, r2Opacity, 0.03, 0.20, 2000),
      pulse(r3Scale, 0.95, 1.04, r3Opacity, 0.02, 0.12, 2600),
    ]).start();
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="#070B0F"
        translucent={Platform.OS === 'android'}
      />

      <View style={styles.center}>
        <Animated.View style={[styles.ring3, { opacity: r3Opacity, transform: [{ scale: r3Scale }] }]} />
        <Animated.View style={[styles.ring2, { opacity: r2Opacity, transform: [{ scale: r2Scale }] }]} />
        <Animated.View style={[styles.ring1, { opacity: r1Opacity, transform: [{ scale: r1Scale }] }]} />

        <Animated.Image
          source={require('../../assets/icon_nobg.png')}
          style={[styles.logo, { transform: [{ scale: breathScale }] }]}
        />
      </View>

      {/* Status text area */}
      <View style={styles.statusArea}>
        <Animated.Text
          style={[
            styles.statusText,
            { opacity: textOpacity, transform: [{ translateY: textTranslateY }] },
          ]}
        >
          {displayedMessage}
        </Animated.Text>

        {statusSubtitle ? (
          <Text style={styles.statusSubtitle}>{statusSubtitle}</Text>
        ) : null}

        {/* Progress bar (only if progress prop provided) */}
        {progress !== undefined && (
          <View style={styles.progressContainer}>
            <View style={styles.progressTrack}>
              <Animated.View
                style={[
                  styles.progressFill,
                  {
                    width: progressWidth.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0%', '100%'],
                    }),
                  },
                ]}
              />
            </View>
            <Text style={styles.progressPercent}>
              {Math.round((progress || 0) * 100)}%
            </Text>
          </View>
        )}
      </View>

      {/* Bottom branding */}
      <View style={styles.bottomBranding}>
        <View style={styles.brandingBadge}>
          <View style={styles.brandingDot} />
          <Text style={styles.brandingText}>Chiffrement de bout en bout</Text>
        </View>
      </View>
    </View>
  );
}

const R1 = LOGO_SIZE + 40;
const R2 = LOGO_SIZE + 90;
const R3 = LOGO_SIZE + 150;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#070B0F',
    justifyContent: 'center',
    alignItems: 'center',
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  ring1: {
    position: 'absolute',
    width: R1,
    height: R1,
    borderRadius: R1 / 2,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 15,
    backgroundColor: Platform.OS === 'android' ? 'rgba(0, 217, 166, 0.04)' : 'transparent',
  },
  ring2: {
    position: 'absolute',
    width: R2,
    height: R2,
    borderRadius: R2 / 2,
    borderWidth: 0.8,
    borderColor: theme.colors.primary,
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    backgroundColor: Platform.OS === 'android' ? 'rgba(0, 217, 166, 0.02)' : 'transparent',
  },
  ring3: {
    position: 'absolute',
    width: R3,
    height: R3,
    borderRadius: R3 / 2,
    borderWidth: 0.5,
    borderColor: theme.colors.primary,
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 30,
    backgroundColor: Platform.OS === 'android' ? 'rgba(0, 217, 166, 0.01)' : 'transparent',
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    resizeMode: 'contain',
  },
  statusArea: {
    marginTop: 120,
    alignItems: 'center',
    paddingHorizontal: 40,
    minHeight: 80,
  },
  statusText: {
    fontSize: 15,
    fontWeight: '500',
    color: theme.colors.textSecondary,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  statusSubtitle: {
    fontSize: 13,
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginTop: 8,
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    width: 200,
    gap: 12,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    backgroundColor: 'rgba(139, 164, 184, 0.15)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: theme.colors.primary,
    borderRadius: 2,
  },
  progressPercent: {
    fontSize: 12,
    color: theme.colors.textMuted,
    fontWeight: '600',
    minWidth: 32,
    textAlign: 'right',
  },
  bottomBranding: {
    position: 'absolute',
    bottom: 48,
    alignItems: 'center',
  },
  brandingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 217, 166, 0.08)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    gap: 8,
  },
  brandingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.primary,
  },
  brandingText: {
    fontSize: 13,
    color: theme.colors.primary,
    fontWeight: '500',
    opacity: 0.8,
  },
});

export default SplashScreen;
