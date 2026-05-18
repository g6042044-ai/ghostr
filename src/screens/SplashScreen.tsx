// src/screens/SplashScreen.tsx
// Premium loading screen — GhostLogo with rings, animated status text, modern bottom branding
// v2.0 — Full light/dark support via useThemedStyles. The previous version had a hardcoded
// near-black background (#060A0E) which read as "wrong app" on light-mode devices.

import { useEffect, useRef, useState, useMemo } from 'react';
import { View, Text, StyleSheet, Platform, StatusBar, Dimensions, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import { GhostLogo } from '../components/GhostLogo';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const LOGO_SIZE = Math.min(SCREEN_WIDTH * 0.3, 130);

const INIT_MESSAGE_KEYS = [
  { key: 'splash.initEncryption', delay: 0 },
  { key: 'splash.generatingKeys', delay: 2500 },
  { key: 'splash.pqProtection', delay: 5500 },
  { key: 'splash.integrityCheck', delay: 8500 },
  { key: 'splash.almostReady', delay: 11000 },
] as const;

export interface SplashScreenProps {
  statusMessage?: string;
  statusSubtitle?: string;
  progress?: number;
  instant?: boolean;
}

// ── Pulsing dot indicator — single timing, no loops ──
const PulsingDots = () => {
  const { colors } = useTheme();
  const clock = useRef(new Animated.Value(0)).current;

  const cycles = 40;
  const ppc = 8;
  const total = cycles * ppc;

  const makeDot = (phaseOffset: number) => {
    const iR: number[] = [];
    const opOut: number[] = [];
    const scOut: number[] = [];
    for (let i = 0; i <= total; i++) {
      iR.push(Math.min(i / total, 1));
      const sin = Math.sin((2 * Math.PI * i) / ppc + phaseOffset);
      opOut.push(0.65 + 0.35 * sin);
      scOut.push(0.85 + 0.15 * sin);
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
    <View style={dotStaticStyles.container}>
      {dots.map((dot, i) => (
        <Animated.View
          key={i}
          style={[dotStaticStyles.dot, {
            backgroundColor: colors.primary,
            opacity: dot.opacity,
            transform: [{ scale: dot.scale }],
          }]}
        />
      ))}
    </View>
  );
};

const dotStaticStyles = StyleSheet.create({
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
  },
});

// ── Main SplashScreen ──
export function SplashScreen({ statusMessage, statusSubtitle, progress, instant = false }: SplashScreenProps = {}) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);

  useEffect(() => {
    if (statusMessage) return;
    const timers = INIT_MESSAGE_KEYS.map((msg, i) =>
      setTimeout(() => setCurrentMessageIndex(i), msg.delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [statusMessage]);

  const displayedMessage = statusMessage || t(INIT_MESSAGE_KEYS[currentMessageIndex].key as any);

  const textOpacity = useRef(new Animated.Value(instant ? 1 : 0)).current;
  const textY = useRef(new Animated.Value(instant ? 0 : 10)).current;
  const prevMsg = useRef(displayedMessage);

  useEffect(() => {
    if (instant) return;
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

  const progressAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (progress === undefined) return;
    Animated.timing(progressAnim, { toValue: progress, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [progress]);

  const bottomOpacity = useRef(new Animated.Value(instant ? 1 : 0)).current;
  useEffect(() => {
    if (instant) return;
    Animated.timing(bottomOpacity, { toValue: 1, duration: 1200, delay: 600, useNativeDriver: true }).start();
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={colors.background}
        translucent={Platform.OS === 'android'}
      />

      <GhostLogo size={LOGO_SIZE} instant={instant} />

      <View style={styles.statusArea}>
        <Animated.Text style={[styles.statusText, { opacity: textOpacity, transform: [{ translateY: textY }] }]}>
          {displayedMessage}
        </Animated.Text>

        {statusSubtitle ? (
          <Text style={styles.statusSubtitle}>{statusSubtitle}</Text>
        ) : null}

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

      <Animated.View style={[styles.bottom, { paddingBottom: insets.bottom + 24, opacity: bottomOpacity }]}>
        <Text style={styles.bottomTagline}>{t('splash.bottomTagline')}</Text>
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  statusArea: {
    marginTop: 100,
    alignItems: 'center' as const,
    paddingHorizontal: 40,
    minHeight: 100,
  },
  statusText: {
    fontSize: 17,
    fontWeight: '500' as const,
    color: colors.textSecondary,
    textAlign: 'center' as const,
    letterSpacing: 0.2,
    lineHeight: 24,
  },
  statusSubtitle: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center' as const,
    marginTop: 10,
  },
  progressContainer: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    marginTop: 32,
    width: 200,
    gap: 12,
  },
  progressTrack: {
    flex: 1,
    height: 3,
    backgroundColor: colors.surfaceLight,
    borderRadius: 1.5,
    overflow: 'hidden' as const,
  },
  progressFill: {
    height: '100%' as const,
    backgroundColor: colors.primary,
    borderRadius: 1.5,
  },
  progressPercent: {
    fontSize: 13,
    color: colors.textMuted,
    fontWeight: '600' as const,
    minWidth: 32,
    textAlign: 'right' as const,
  },
  bottom: {
    position: 'absolute' as const,
    bottom: 0,
    alignItems: 'center' as const,
  },
  bottomTagline: {
    fontSize: 12,
    color: colors.textMuted,
    opacity: 0.5,
    fontWeight: '500' as const,
    letterSpacing: 0.2,
  },
});

export default SplashScreen;
