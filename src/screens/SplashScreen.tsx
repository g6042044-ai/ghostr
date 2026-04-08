// src/screens/SplashScreen.tsx
// Premium loading screen — GhostLogo with rings, animated status text, modern bottom branding

import React, { useEffect, useRef, useState, useMemo } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '../components/ui/theme';
import { GhostLogo } from '../components/GhostLogo';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const LOGO_SIZE = Math.min(SCREEN_WIDTH * 0.3, 130);

const INIT_MESSAGES = [
  { text: 'Initialisation du chiffrement', delay: 0 },
  { text: 'Génération des clés de session', delay: 2500 },
  { text: 'Protection post-quantique', delay: 5500 },
  { text: "Vérification de l'intégrité", delay: 8500 },
  { text: 'Presque prêt', delay: 11000 },
];

export interface SplashScreenProps {
  statusMessage?: string;
  statusSubtitle?: string;
  progress?: number;
}

// ── Pulsing dot indicator — single timing, no loops ──
const PulsingDots = () => {
  const clock = useRef(new Animated.Value(0)).current;

  // Pre-compute interpolation tables once
  const cycles = 40; // ~1.5s per cycle over 60s
  const ppc = 8;
  const total = cycles * ppc;

  const makeDot = (phaseOffset: number) => {
    const iR: number[] = [];
    const opOut: number[] = [];
    const scOut: number[] = [];
    for (let i = 0; i <= total; i++) {
      iR.push(Math.min(i / total, 1));
      const sin = Math.sin((2 * Math.PI * i) / ppc + phaseOffset);
      opOut.push(0.65 + 0.35 * sin);   // 0.3 ↔ 1.0
      scOut.push(0.85 + 0.15 * sin);   // 0.7 ↔ 1.0
    }
    return {
      opacity: clock.interpolate({ inputRange: iR, outputRange: opOut }),
      scale: clock.interpolate({ inputRange: iR, outputRange: scOut }),
    };
  };

  const dots = useMemo(() => [
    makeDot(0),
    makeDot(Math.PI * 0.66),
    makeDot(Math.PI * 1.33),
  ], []);

  useEffect(() => {
    Animated.timing(clock, {
      toValue: 1,
      duration: 60000,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <View style={dotStyles.container}>
      {dots.map((dot, i) => (
        <Animated.View
          key={i}
          style={[dotStyles.dot, {
            opacity: dot.opacity,
            transform: [{ scale: dot.scale }],
          }]}
        />
      ))}
    </View>
  );
};

const dotStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 32,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.primary,
  },
});

// ── Main SplashScreen ──
export function SplashScreen({ statusMessage, statusSubtitle, progress }: SplashScreenProps = {}) {
  const insets = useSafeAreaInsets();
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);

  useEffect(() => {
    if (statusMessage) return;
    const timers = INIT_MESSAGES.map((msg, i) =>
      setTimeout(() => setCurrentMessageIndex(i), msg.delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [statusMessage]);

  const displayedMessage = statusMessage || INIT_MESSAGES[currentMessageIndex].text;

  // Text crossfade
  const textOpacity = useRef(new Animated.Value(0)).current;
  const textY = useRef(new Animated.Value(10)).current;
  const prevMsg = useRef(displayedMessage);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(textOpacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(textY, { toValue: 0, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, []);

  useEffect(() => {
    if (prevMsg.current === displayedMessage) return;
    prevMsg.current = displayedMessage;
    Animated.sequence([
      Animated.parallel([
        Animated.timing(textOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
        Animated.timing(textY, { toValue: -8, duration: 180, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(textOpacity, { toValue: 1, duration: 450, useNativeDriver: true }),
        Animated.timing(textY, { toValue: 0, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
    ]).start();
  }, [displayedMessage]);

  // Progress bar
  const progressAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (progress === undefined) return;
    Animated.timing(progressAnim, { toValue: progress, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [progress]);

  // Bottom entrance
  const bottomOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(bottomOpacity, { toValue: 1, duration: 1200, delay: 600, useNativeDriver: true }).start();
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#060A0E" translucent={Platform.OS === 'android'} />

      {/* ═══ Logo + Rings ═══ */}
      <GhostLogo size={LOGO_SIZE} />

      {/* ═══ Status area ═══ */}
      <View style={styles.statusArea}>
        <Animated.Text style={[styles.statusText, { opacity: textOpacity, transform: [{ translateY: textY }] }]}>
          {displayedMessage}
        </Animated.Text>

        {statusSubtitle ? (
          <Text style={styles.statusSubtitle}>{statusSubtitle}</Text>
        ) : null}

        {/* Progress bar OR dots */}
        {progress !== undefined ? (
          <View style={styles.progressContainer}>
            <View style={styles.progressTrack}>
              <Animated.View style={[styles.progressFill, {
                width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
              }]} />
            </View>
            <Text style={styles.progressPercent}>{Math.round((progress || 0) * 100)}%</Text>
          </View>
        ) : (
          <PulsingDots />
        )}
      </View>

      {/* ═══ Bottom branding ═══ */}
      <Animated.View style={[styles.bottom, { paddingBottom: insets.bottom + 24, opacity: bottomOpacity }]}>
        <Text style={styles.bottomTagline}>Chiffrement de bout en bout</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#060A0E',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Status — pushed well below outer ring edge
  statusArea: {
    marginTop: 100,
    alignItems: 'center',
    paddingHorizontal: 40,
    minHeight: 100,
  },
  statusText: {
    fontSize: 17,
    fontWeight: '500',
    color: 'rgba(240, 244, 248, 0.7)',
    textAlign: 'center',
    letterSpacing: 0.2,
    lineHeight: 24,
  },
  statusSubtitle: {
    fontSize: 14,
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginTop: 10,
  },

  // Progress bar
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 32,
    width: 200,
    gap: 12,
  },
  progressTrack: {
    flex: 1,
    height: 3,
    backgroundColor: 'rgba(139, 164, 184, 0.10)',
    borderRadius: 1.5,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: theme.colors.primary,
    borderRadius: 1.5,
  },
  progressPercent: {
    fontSize: 13,
    color: theme.colors.textMuted,
    fontWeight: '600',
    minWidth: 32,
    textAlign: 'right',
  },

  // Bottom
  bottom: {
    position: 'absolute',
    bottom: 0,
    alignItems: 'center',
  },
  bottomBrand: {
    fontSize: 15,
    fontWeight: '600',
    color: 'rgba(240, 244, 248, 0.25)',
    letterSpacing: -0.3,
    marginBottom: 4,
  },
  bottomTagline: {
    fontSize: 12,
    color: 'rgba(240, 244, 248, 0.15)',
    fontWeight: '500',
    letterSpacing: 0.2,
  },
});

export default SplashScreen;