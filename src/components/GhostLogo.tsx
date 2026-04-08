// src/components/GhostLogo.tsx
// Premium animated logo — organic ring breathing with staggered entrance
//
// ARCHITECTURE: Single native timing + interpolation = zero JS during animation
// ──────────────────────────────────────────────────────────────────────────────
// Problem: ALL Animated.loop/sequence combos require JS callbacks between steps.
// When crypto blocks JS, every looping animation freezes — period.
//
// Solution: ONE Animated.timing (0→1 over 60s, linear, useNativeDriver).
// All oscillations (scale, opacity, rotation) derived via .interpolate()
// which is computed ENTIRELY on the native side. Zero loops, zero sequences,
// zero callbacks. The native animation module drives everything autonomously.
//
// Ring entrances use separate one-shot Animated.timing with native `delay`.
// Combined via Animated.multiply (also native).

import React, { useEffect, useRef, useMemo } from 'react';
import { View, StyleSheet, Platform, Animated, Easing } from 'react-native';
import { theme } from './ui/theme';

const ACCENT = theme.colors.primary;
const CLOCK_DURATION = 60000; // 60s — covers any splash duration

// ── Generate sine-wave oscillation points for .interpolate() ──
// 8 samples per cycle → smooth sine approximation via piecewise linear
function sineWave(
  cycles: number,
  min: number,
  max: number,
): { inputRange: number[]; outputRange: number[] } {
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  const mid = (min + max) / 2;
  const amp = (max - min) / 2;
  const samplesPerCycle = 8;
  const total = cycles * samplesPerCycle;
  for (let i = 0; i <= total; i++) {
    inputRange.push(Math.min(i / total, 1));
    outputRange.push(mid + amp * Math.sin((2 * Math.PI * i) / samplesPerCycle));
  }
  return { inputRange, outputRange };
}

// Degrees version for rotation
function sineWaveDeg(
  cycles: number,
  maxDeg: number,
): { inputRange: number[]; outputRange: string[] } {
  const inputRange: number[] = [];
  const outputRange: string[] = [];
  const samplesPerCycle = 8;
  const total = cycles * samplesPerCycle;
  for (let i = 0; i <= total; i++) {
    inputRange.push(Math.min(i / total, 1));
    const deg = maxDeg * Math.sin((2 * Math.PI * i) / samplesPerCycle);
    outputRange.push(`${deg}deg`);
  }
  return { inputRange, outputRange };
}

export interface GhostLogoProps {
  size?: number;
}

export function GhostLogo({ size = 150 }: GhostLogoProps) {
  const R1 = size + 36;
  const R2 = size + 80;
  const R3 = size + 130;

  // ── Master clock: single linear timing 0→1 over 60s ──
  const clock = useRef(new Animated.Value(0)).current;

  // ── Entrance values (one-shot, not looped) ──
  const entranceOpacity = useRef(new Animated.Value(0)).current;
  const entranceScale = useRef(new Animated.Value(0.85)).current;
  const r1Entrance = useRef(new Animated.Value(0)).current;
  const r2Entrance = useRef(new Animated.Value(0)).current;
  const r3Entrance = useRef(new Animated.Value(0)).current;

  // ── Derived oscillations from master clock via interpolate (100% native) ──
  // Cycle counts = CLOCK_DURATION / period
  // Logo: breath 4800ms → 12 cycles, float 6000ms → 10 cycles
  const logoBreathScale = useMemo(() => clock.interpolate(sineWave(12, 1, 1.04)), []);
  const logoFloatY = useMemo(() => clock.interpolate(sineWave(10, -5, 5)), []);

  // Ring 1 (inner, fastest): scale 5.2s→11cy, opacity 5.2s→11cy, rotation 10.4s→6cy
  const r1BreathScale = useMemo(() => clock.interpolate(sineWave(11, 0.96, 1.07)), []);
  const r1BreathOp = useMemo(() => clock.interpolate(sineWave(11, 0.08, 0.32)), []);
  const r1RotateStr = useMemo(() => clock.interpolate(sineWaveDeg(6, 3)), []);

  // Ring 2 (middle): scale 8.4s→7cy, opacity 8.4s→7cy, rotation 16.8s→4cy
  const r2BreathScale = useMemo(() => clock.interpolate(sineWave(7, 0.95, 1.06)), []);
  const r2BreathOp = useMemo(() => clock.interpolate(sineWave(7, 0.04, 0.18)), []);
  const r2RotateStr = useMemo(() => clock.interpolate(sineWaveDeg(4, 2)), []);

  // Ring 3 (outer, slowest): scale 13.6s→4cy, opacity 13.6s→4cy, rotation 27.2s→2cy
  const r3BreathScale = useMemo(() => clock.interpolate(sineWave(4, 0.94, 1.05)), []);
  const r3BreathOp = useMemo(() => clock.interpolate(sineWave(4, 0.02, 0.10)), []);
  const r3RotateStr = useMemo(() => clock.interpolate(sineWaveDeg(2, 1.5)), []);

  // ── Combined: entrance × breathing (Animated.multiply = native) ──
  const r1FinalScale = useMemo(() => Animated.multiply(r1Entrance, r1BreathScale), []);
  const r1FinalOp = useMemo(() => Animated.multiply(r1Entrance, r1BreathOp), []);
  const r2FinalScale = useMemo(() => Animated.multiply(r2Entrance, r2BreathScale), []);
  const r2FinalOp = useMemo(() => Animated.multiply(r2Entrance, r2BreathOp), []);
  const r3FinalScale = useMemo(() => Animated.multiply(r3Entrance, r3BreathScale), []);
  const r3FinalOp = useMemo(() => Animated.multiply(r3Entrance, r3BreathOp), []);

  useEffect(() => {
    // ═══ ONE master timing — drives ALL oscillations via interpolation ═══
    // This is the ONLY long-running animation. It's a single Animated.timing
    // with useNativeDriver:true. No loops, no sequences, no JS callbacks.
    Animated.timing(clock, {
      toValue: 1,
      duration: CLOCK_DURATION,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();

    // ═══ ENTRANCE — one-shot timings with native delay, fire-and-forget ═══
    Animated.timing(entranceOpacity, {
      toValue: 1, duration: 800, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
    Animated.timing(entranceScale, {
      toValue: 1, duration: 800, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();

    // Staggered ring entrances: 0→1 with native delay
    Animated.timing(r1Entrance, {
      toValue: 1, duration: 600, delay: 0, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
    Animated.timing(r2Entrance, {
      toValue: 1, duration: 700, delay: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
    Animated.timing(r3Entrance, {
      toValue: 1, duration: 800, delay: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  }, []);

  // ── Ring style helper ──
  const ringStyle = (diameter: number, borderW: number) => ({
    position: 'absolute' as const,
    width: diameter,
    height: diameter,
    borderRadius: diameter / 2,
    borderWidth: borderW,
    borderColor: ACCENT,
    backgroundColor: Platform.OS === 'android' ? 'rgba(0, 217, 166, 0.02)' : 'transparent',
  });

  return (
    <Animated.View style={[styles.container, {
      opacity: entranceOpacity,
      transform: [{ scale: entranceScale }],
    }]}>
      {/* Ring 3 — outer, slowest */}
      <Animated.View style={[
        ringStyle(R3, 0.5),
        {
          opacity: r3FinalOp,
          transform: [{ scale: r3FinalScale }, { rotate: r3RotateStr }],
          shadowColor: ACCENT, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.08, shadowRadius: 30,
        },
      ]} />

      {/* Ring 2 — middle */}
      <Animated.View style={[
        ringStyle(R2, 0.8),
        {
          opacity: r2FinalOp,
          transform: [{ scale: r2FinalScale }, { rotate: r2RotateStr }],
          shadowColor: ACCENT, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.15, shadowRadius: 20,
        },
      ]} />

      {/* Ring 1 — inner, fastest */}
      <Animated.View style={[
        ringStyle(R1, 1),
        {
          opacity: r1FinalOp,
          transform: [{ scale: r1FinalScale }, { rotate: r1RotateStr }],
          shadowColor: ACCENT, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.3, shadowRadius: 15,
        },
      ]} />

      {/* Logo image */}
      <Animated.Image
        source={require('../../assets/icon_nobg.png')}
        style={{
          width: size,
          height: size,
          resizeMode: 'contain',
          transform: [{ scale: logoBreathScale }, { translateY: logoFloatY }],
        }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default GhostLogo;