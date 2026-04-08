// src/components/IncomingCallBanner.tsx
// GHOSTR — Incoming Call Banner (In-App)
// v1.0 — Modern persistent banner for incoming calls
//
// DESIGN:
//   - Bannière glassmorphique compacte (pas de modale plein écran)
//   - Apparaît en haut de l'écran avec animation spring
//   - Bouton vert "Répondre" + bouton rouge "Refuser"
//   - Swipe vers le haut = refuser l'appel
//   - Tap sur la bannière = ouvrir l'écran d'appel complet
//   - Indicateur de chiffrement E2E visible
//   - Sonnerie + vibration en boucle (gérées par le parent)
//   - Pulse animé autour de l'avatar pour feedback visuel
//
// SÉCURITÉ:
//   Le nom de l'appelant est déchiffré E2E avant affichage.
//   Hors de l'app, seule une notification générique est montrée.
//   Ce composant n'est rendu QUE quand l'app est au premier plan.

import React, { useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  PanResponder,
  Platform,
  Dimensions,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { theme } from './ui/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ═══════════════════════════════════════
// TYPES
// ═══════════════════════════════════════

interface IncomingCallBannerProps {
  callerName: string;
  callerAvatarBase64?: string;
  onAccept: () => void;
  onDecline: () => void;
  onExpandToFullScreen: () => void;
}

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

function getInitials(name: string): string {
  if (!name.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.trim().substring(0, 2).toUpperCase();
}

function avatarColor(name: string): string {
  const colors = [
    '#00D9A6', '#FF6B6B', '#00B4D8', '#7B61FF', '#FFB547',
    '#45B7D1', '#96CEB4', '#F7DC6F', '#BB8FCE', '#85C1E9',
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}

// ═══════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════

const SWIPE_THRESHOLD = -40;
const BANNER_HEIGHT = 88;

export const IncomingCallBanner: React.FC<IncomingCallBannerProps> = ({
  callerName,
  callerAvatarBase64,
  onAccept,
  onDecline,
  onExpandToFullScreen,
}) => {
  const insets = useSafeAreaInsets();
  const accent = avatarColor(callerName);

  // ── Animations ──
  const translateY = useRef(new Animated.Value(-200)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.92)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const shimmerAnim = useRef(new Animated.Value(0)).current;

  // ── Entrance ──
  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        tension: 60,
        friction: 11,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        tension: 80,
        friction: 10,
        useNativeDriver: true,
      }),
    ]).start();

    // Avatar pulse
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.12,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();

    // Shimmer on the accept button
    const shimmer = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmerAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
        }),
        Animated.timing(shimmerAnim, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    shimmer.start();

    return () => {
      pulse.stop();
      shimmer.stop();
    };
  }, []);

  // ── Exit animation ──
  const animateOut = useCallback((callback: () => void) => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: -200,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: 0.92,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => callback());
  }, []);

  // ── Swipe to decline ──
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 10,
      onPanResponderMove: (_, gs) => {
        if (gs.dy < 0) {
          translateY.setValue(gs.dy);
          opacity.setValue(1 - Math.min(Math.abs(gs.dy) / 120, 0.7));
        }
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy < SWIPE_THRESHOLD) {
          // Swipe up → decline
          animateOut(onDecline);
        } else {
          // Snap back
          Animated.parallel([
            Animated.spring(translateY, {
              toValue: 0,
              tension: 140,
              friction: 12,
              useNativeDriver: true,
            }),
            Animated.timing(opacity, {
              toValue: 1,
              duration: 100,
              useNativeDriver: true,
            }),
          ]).start();
        }
      },
    }),
  ).current;

  // ── Accept ──
  const handleAccept = useCallback(() => {
    animateOut(onAccept);
  }, [onAccept, animateOut]);

  // ── Decline ──
  const handleDecline = useCallback(() => {
    animateOut(onDecline);
  }, [onDecline, animateOut]);

  const topOffset = insets.top + (Platform.OS === 'android' ? 4 : 0);

  return (
    <Animated.View
      style={[
        styles.container,
        {
          top: topOffset,
          transform: [{ translateY }, { scale }],
          opacity,
        },
      ]}
      {...panResponder.panHandlers}
    >
      <BlurView
        intensity={Platform.OS === 'ios' ? 90 : 0}
        tint="dark"
        style={styles.blurWrap}
      >
        {/* ── Main banner content ── */}
        <TouchableOpacity
          activeOpacity={0.95}
          onPress={onExpandToFullScreen}
          style={styles.bannerContent}
        >
          {/* Avatar with pulse ring */}
          <View style={styles.avatarArea}>
            <Animated.View
              style={[
                styles.pulseRing,
                {
                  borderColor: accent,
                  transform: [{ scale: pulseAnim }],
                  opacity: pulseAnim.interpolate({
                    inputRange: [1, 1.12],
                    outputRange: [0.5, 0],
                  }),
                },
              ]}
            />
            <View style={[styles.avatar, { backgroundColor: accent }]}>
              {callerAvatarBase64 ? (
                <Image
                  source={{ uri: callerAvatarBase64 }}
                  style={styles.avatarImage}
                  resizeMode="cover"
                />
              ) : (
                <Text style={styles.avatarText}>{getInitials(callerName)}</Text>
              )}
            </View>
          </View>

          {/* Info */}
          <View style={styles.info}>
            <View style={styles.labelRow}>
              <Ionicons
                name="shield-checkmark"
                size={11}
                color={theme.colors.success}
              />
              <Text style={styles.labelText}>Appel chiffré</Text>
            </View>
            <Text style={styles.callerName} numberOfLines={1}>
              {callerName}
            </Text>
            <Text style={styles.subtitle}>Appel vocal entrant…</Text>
          </View>

          {/* Action buttons */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.declineBtn}
              onPress={handleDecline}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name="close"
                size={20}
                color="#FFF"
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.acceptBtn}
              onPress={handleAccept}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="call" size={20} color="#FFF" />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>

        {/* ── Swipe hint bar ── */}
        <View style={styles.swipeHint}>
          <View style={styles.swipeBar} />
        </View>
      </BlurView>
    </Animated.View>
  );
};

// ═══════════════════════════════════════
// STYLES
// ═══════════════════════════════════════

const BTN_SIZE = 42;

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 8,
    right: 8,
    zIndex: 10000,
    elevation: 1000,
  },
  blurWrap: {
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor:
      Platform.OS === 'android'
        ? 'rgba(14, 22, 28, 0.97)'
        : 'rgba(14, 22, 28, 0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    // Shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.55,
    shadowRadius: 30,
    elevation: 24,
  },
  bannerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 12,
  },
  // Avatar
  avatarArea: {
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 2,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  avatarText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  // Info
  info: {
    flex: 1,
    gap: 1,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 1,
  },
  labelText: {
    fontSize: 10,
    fontWeight: '600',
    color: theme.colors.success,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  callerName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F0F4F8',
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 12,
    color: 'rgba(139, 164, 184, 0.85)',
    letterSpacing: -0.1,
  },
  // Actions
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  declineBtn: {
    width: BTN_SIZE,
    height: BTN_SIZE,
    borderRadius: BTN_SIZE / 2,
    backgroundColor: 'rgba(231, 76, 60, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#E74C3C',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  acceptBtn: {
    width: BTN_SIZE,
    height: BTN_SIZE,
    borderRadius: BTN_SIZE / 2,
    backgroundColor: 'rgba(46, 204, 113, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2ECC71',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  // Swipe hint
  swipeHint: {
    alignItems: 'center',
    paddingBottom: 8,
    paddingTop: 2,
  },
  swipeBar: {
    width: 36,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
});

export default IncomingCallBanner;