// src/components/InAppNotification.tsx
// GHOSTR — In-App Notification Toast
// v4.0 — Modern glassmorphic toast with refined animations
//
// DESIGN:
//   - Glassmorphic card with subtle blur (iOS) / opaque dark (Android)
//   - Avatar with optional verified badge
//   - Spring entrance, opacity swipe-to-dismiss (swipe up)
//   - Auto-dismiss with smooth progress bar
//   - Queue system: notifications stack in order
//   - Notification sound via callTones.playMessageNotification()
//
// SÉCURITÉ:
//   Le contenu affiché est déchiffré E2E côté client.
//   showInAppNotification() est appelé uniquement après déchiffrement.
//   Aucune donnée identifiable ne transite par le système de notifications OS.
//
// CHANGEMENTS v4.0:
//   ✅ Design plus compact et élégant
//   ✅ Meilleure gestion du swipe (seuil adaptatif)
//   ✅ Animation de sortie plus fluide
//   ✅ Support avatarUri (photo base64)
//   ✅ Badge de vérification optionnel
//   ✅ Suppression du son configurable (playSound prop)
//   ✅ Label "Ghostr" discret dans le coin
//   ✅ Accessibilité : labels pour screen readers

import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Animated, TouchableOpacity, PanResponder, Platform, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles, type ColorPalette } from './ui';
import { playMessageNotification } from '../services/callTones';

// ═══════════════════════════════════════
// EVENT SYSTEM (API inchangée)
// ═══════════════════════════════════════

export type NotificationData = {
  id: string;
  title: string;
  body: string;
  avatarInitial: string;
  avatarColor: string;
  avatarUri?: string;
  accentColor?: string;
  showCheckBadge?: boolean;
  playSound?: boolean;
  onPress?: () => void;
  duration?: number;
};

type Listener = (notification: NotificationData) => void;
const listeners = new Set<Listener>();
const suppressedIds = new Set<string>();

export function showInAppNotification(data: NotificationData): void {
  if (suppressedIds.has(data.id)) {
    suppressedIds.delete(data.id);
    return;
  }
  for (const cb of listeners) {
    try { cb(data); } catch (e) { console.error('[InAppNotification] listener error:', e); }
  }
}

export function suppressNotification(id: string): void {
  suppressedIds.add(id);
  setTimeout(() => suppressedIds.delete(id), 5000);
}

function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// ═══════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════

const AUTO_DISMISS_MS = 4000;
const SWIPE_THRESHOLD = -30;

export function InAppNotificationHost() {
  const insets = useSafeAreaInsets();
  // `scheme` est lu car le `BlurView` d'expo-blur attend un `tint` littéral
  // ('light' | 'dark' | 'default'), pas une couleur — on ne peut pas le
  // déduire depuis la palette seule.
  const { scheme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [notification, setNotification] = useState<NotificationData | null>(null);
  const notificationIdRef = useRef<string | null>(null);
  const translateY = useRef(new Animated.Value(-160)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.90)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const dismissTimer = useRef<NodeJS.Timeout | null>(null);
  const progressAnimation = useRef<Animated.CompositeAnimation | null>(null);
  const isVisible = useRef(false);
  const queueRef = useRef<NotificationData[]>([]);

  const dismiss = useCallback(() => {
    if (!isVisible.current) return;
    isVisible.current = false;
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    if (progressAnimation.current) {
      progressAnimation.current.stop();
      progressAnimation.current = null;
    }
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: -160,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true,
      }),
      Animated.timing(scaleAnim, {
        toValue: 0.90,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setNotification(null);
      notificationIdRef.current = null;
      progressAnim.setValue(0);
      if (queueRef.current.length > 0) {
        const next = queueRef.current.shift()!;
        setTimeout(() => showNext(next), 200);
      }
    });
  }, []);

  const showNext = useCallback((data: NotificationData) => {
    setNotification(data);
    notificationIdRef.current = data.id;
    isVisible.current = true;

    // Sound
    if (data.playSound !== false) {
      playMessageNotification().catch(() => {});
    }

    // Reset
    translateY.setValue(-160);
    opacity.setValue(0);
    scaleAnim.setValue(0.90);
    progressAnim.setValue(0);

    // Enter
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        tension: 80,
        friction: 10,
        useNativeDriver: true,
      }),
    ]).start();

    // Progress bar
    const duration = data.duration ?? AUTO_DISMISS_MS;
    const anim = Animated.timing(progressAnim, {
      toValue: 1,
      duration,
      useNativeDriver: false,
    });
    progressAnimation.current = anim;
    anim.start();

    dismissTimer.current = setTimeout(dismiss, duration);
  }, [dismiss]);

  useEffect(() => {
    const unsub = subscribe((data) => {
      if (notificationIdRef.current === data.id) return;
      if (queueRef.current.some(q => q.id === data.id)) return;
      if (isVisible.current) {
        queueRef.current.push(data);
        dismiss();
      } else {
        showNext(data);
      }
    });
    return () => {
      unsub();
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      if (progressAnimation.current) progressAnimation.current.stop();
    };
  }, [showNext, dismiss]);

  // Swipe to dismiss
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 8,
      onPanResponderMove: (_, gs) => {
        if (gs.dy < 0) {
          translateY.setValue(gs.dy);
          opacity.setValue(1 - Math.min(Math.abs(gs.dy) / 100, 0.6));
        }
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy < SWIPE_THRESHOLD) {
          dismiss();
        } else {
          Animated.parallel([
            Animated.spring(translateY, {
              toValue: 0,
              tension: 120,
              friction: 10,
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

  if (!notification) return null;

  const topOffset = insets.top + (Platform.OS === 'android' ? 6 : 2);

  return (
    <Animated.View
      style={[
        styles.container,
        {
          top: topOffset,
          transform: [{ translateY }, { scale: scaleAnim }],
          opacity,
        },
      ]}
      {...panResponder.panHandlers}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`Notification de ${notification.title}: ${notification.body}`}
    >
      <TouchableOpacity
        activeOpacity={0.95}
        onPress={() => {
          dismiss();
          notification.onPress?.();
        }}
        style={styles.touchArea}
      >
        <BlurView
          intensity={Platform.OS === 'ios' ? 80 : 0}
          tint={scheme === 'dark' ? 'dark' : 'light'}
          style={styles.blurWrap}
        >
          <View style={styles.banner}>
            {/* Avatar */}
            <View style={[styles.avatar, { backgroundColor: notification.avatarColor }]}>
              {notification.avatarUri ? (
                <Image
                  source={{ uri: notification.avatarUri }}
                  style={styles.avatarImage}
                  resizeMode="cover"
                />
              ) : (
                <Text style={styles.avatarText}>{notification.avatarInitial}</Text>
              )}
              {notification.showCheckBadge && (
                <View style={styles.checkBadge}>
                  <Ionicons name="checkmark-sharp" size={7} color="#fff" />
                </View>
              )}
            </View>

            {/* Content */}
            <View style={styles.content}>
              <View style={styles.titleRow}>
                <Text style={styles.title} numberOfLines={1}>
                  {notification.title}
                </Text>
                <Text style={styles.appLabel}>Ghostr</Text>
              </View>
              <Text style={styles.body} numberOfLines={2}>
                {notification.body}
              </Text>
            </View>
          </View>

          {/* Progress bar */}
          <View style={styles.progressTrack}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  width: progressAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                },
              ]}
            />
          </View>
        </BlurView>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ═══════════════════════════════════════
// STYLES
// ═══════════════════════════════════════

const makeStyles = (colors: ColorPalette) => {
  // Plate-forme: sur Android le BlurView ne floute pas (intensity=0), il
  // faut donc un fond opaque ; sur iOS on s'appuie sur le blur natif et on
  // pose un fond semi-transparent par-dessus. Dans les deux cas on lit la
  // surface depuis la palette pour suivre le scheme (light/dark).
  //
  // `colors.glass` est tuné par scheme :
  //   - dark  : rgba(26, 37, 47, 0.85)        ≈ ancien rgba(16,26,34,0.75)
  //   - light : rgba(247, 249, 251, 0.85)     ≈ surface near-white
  //
  // Pour Android (pas de blur), on remonte l'alpha pour rester opaque.
  const glassiOS = colors.glass;
  const glassAndroid =
    colors.glass.replace(/,\s*0?\.\d+\)$/, ', 0.97)');

  return ({
  container: {
    position: 'absolute',
    left: 8,
    right: 8,
    zIndex: 9999,
    elevation: 999,
  },
  touchArea: {
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.5,
    shadowRadius: 30,
    elevation: 24,
  },
  blurWrap: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor:
      Platform.OS === 'android' ? glassAndroid : glassiOS,
    borderWidth: 1,
    // Bordure issue de la palette → blanche-transparente en dark,
    // noire-transparente très douce en light.
    borderColor: colors.border,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  // Avatar
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  avatarImage: {
    width: 38,
    height: 38,
    borderRadius: 19,
  },
  checkBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 15,
    height: 15,
    borderRadius: 7.5,
    backgroundColor: '#34D399',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    // La bordure du badge doit "découper" l'avatar par rapport au fond du
    // toast → on prend la surface du toast pour que ça reste cohérent quel
    // que soit le thème.
    borderColor: colors.surface,
  },
  // Content
  content: {
    flex: 1,
    gap: 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: -0.2,
    flex: 1,
  },
  appLabel: {
    fontSize: 10,
    fontWeight: '500',
    // Texte "Ghostr" discret → textMuted suffit, présent dans les deux
    // palettes avec un contraste ≈ 3:1 (acceptable pour un label décoratif).
    color: colors.textMuted,
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  body: {
    fontSize: 13,
    color: colors.textSecondary,
    letterSpacing: -0.1,
    lineHeight: 17,
  },
  // Progress
  progressTrack: {
    height: 2,
    // Track presque invisible — on prend `divider` qui est à la fois
    // perceptible et discret sur les deux thèmes.
    backgroundColor: colors.divider,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
    opacity: 0.4,
  },
  }) as const;
};