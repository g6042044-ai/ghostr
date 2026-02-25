// src/components/InAppNotification.tsx
// v3.0 - Modern glassmorphic toast with blur, progress timer, scale animation

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  PanResponder,
  Platform,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { theme } from './ui';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ═══════════════════════════════════════
// EVENT SYSTEM
// ═══════════════════════════════════════

export type NotificationData = {
  id: string;
  title: string;
  body: string;
  avatarInitial: string;
  avatarColor: string;
  accentColor?: string;
  showCheckBadge?: boolean;
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

const AUTO_DISMISS_MS = 4500;
const SWIPE_THRESHOLD = -25;

export function InAppNotificationHost() {
  const insets = useSafeAreaInsets();
  const [notification, setNotification] = useState<NotificationData | null>(null);
  const notificationIdRef = useRef<string | null>(null);
  const translateY = useRef(new Animated.Value(-160)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scaleX = useRef(new Animated.Value(0.88)).current;
  const scaleY = useRef(new Animated.Value(0.88)).current;
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
        toValue: -160, duration: 250, useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0, duration: 180, useNativeDriver: true,
      }),
      Animated.timing(scaleX, {
        toValue: 0.88, duration: 200, useNativeDriver: true,
      }),
      Animated.timing(scaleY, {
        toValue: 0.88, duration: 200, useNativeDriver: true,
      }),
    ]).start(() => {
      setNotification(null);
      notificationIdRef.current = null;
      progressAnim.setValue(0);
      if (queueRef.current.length > 0) {
        const next = queueRef.current.shift()!;
        setTimeout(() => showNext(next), 250);
      }
    });
  }, []);

  const showNext = useCallback((data: NotificationData) => {
    setNotification(data);
    notificationIdRef.current = data.id;
    isVisible.current = true;

    translateY.setValue(-160);
    opacity.setValue(0);
    scaleX.setValue(0.88);
    scaleY.setValue(0.88);
    progressAnim.setValue(0);

    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0, tension: 55, friction: 10, useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1, duration: 280, useNativeDriver: true,
      }),
      Animated.spring(scaleX, {
        toValue: 1, tension: 65, friction: 9, useNativeDriver: true,
      }),
      Animated.spring(scaleY, {
        toValue: 1, tension: 65, friction: 9, useNativeDriver: true,
      }),
    ]).start();

    // Progress bar countdown
    const duration = data.duration ?? AUTO_DISMISS_MS;
    const anim = Animated.timing(progressAnim, {
      toValue: 1, duration, useNativeDriver: false,
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
              toValue: 0, tension: 120, friction: 10, useNativeDriver: true,
            }),
            Animated.timing(opacity, {
              toValue: 1, duration: 120, useNativeDriver: true,
            }),
          ]).start();
        }
      },
    })
  ).current;

  if (!notification) return null;

  const topOffset = insets.top + (Platform.OS === 'android' ? 6 : 2);

  return (
    <Animated.View
      style={[
        styles.container,
        {
          top: topOffset,
          transform: [{ translateY }, { scaleX }, { scaleY }],
          opacity,
        },
      ]}
      {...panResponder.panHandlers}
    >
      <TouchableOpacity
        activeOpacity={0.95}
        onPress={() => { dismiss(); notification.onPress?.(); }}
        style={styles.touchArea}
      >
        <BlurView intensity={Platform.OS === 'ios' ? 80 : 0} tint="dark" style={styles.blurWrap}>
          <View style={styles.banner}>
            {/* Avatar */}
            <View style={[styles.avatar, { backgroundColor: notification.avatarColor }]}>
              <Text style={styles.avatarText}>{notification.avatarInitial}</Text>
              {notification.showCheckBadge && (
                <View style={styles.checkBadge}>
                  <Ionicons name="checkmark-sharp" size={7} color="#fff" />
                </View>
              )}
            </View>

            {/* Content */}
            <View style={styles.content}>
              <Text style={styles.title} numberOfLines={1}>{notification.title}</Text>
              <Text style={styles.body} numberOfLines={1}>{notification.body}</Text>
            </View>
          </View>

          {/* Timer progress bar */}
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

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 8,
    right: 8,
    zIndex: 9999,
    elevation: 999,
  },
  touchArea: {
    borderRadius: 24,
    overflow: 'hidden',
    // Shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.6,
    shadowRadius: 40,
    elevation: 28,
  },
  blurWrap: {
    borderRadius: 24,
    overflow: 'hidden',
    // Fallback bg for Android (no blur)
    backgroundColor: Platform.OS === 'android' ? 'rgba(20, 30, 40, 0.97)' : 'rgba(20, 30, 40, 0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 14,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  checkBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#34D399',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(20, 30, 40, 0.9)',
  },
  content: {
    flex: 1,
    gap: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: '#F0F4F8',
    letterSpacing: -0.3,
  },
  body: {
    fontSize: 13,
    color: 'rgba(139, 164, 184, 0.9)',
    letterSpacing: -0.1,
  },
  // Timer progress
  progressTrack: {
    height: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: theme.colors.primary,
    opacity: 0.5,
  },
});
