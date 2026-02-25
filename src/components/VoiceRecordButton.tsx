// src/components/VoiceRecordButton.tsx
// Bouton d'enregistrement vocal style WhatsApp
//
// COMPORTEMENT:
// - Appuyer + maintenir → démarre l'enregistrement
// - Relâcher → envoie le message
// - Glisser gauche → annule
// - Glisser haut → verrouille (mains libres)

import React, { useRef, useCallback, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Animated,
  PanResponder,
  PanResponderGestureState,
  Vibration,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// ============================================
// CONFIGURATION
// ============================================

const CANCEL_THRESHOLD = -80;
const LOCK_THRESHOLD = -60;

// ============================================
// TYPES
// ============================================

interface VoiceRecordButtonProps {
  onRecordStart: () => void;
  onRecordEnd: () => void;
  onRecordCancel: () => void;
  onRecordLock: () => void;
  isRecording: boolean;
  isLocked: boolean;
  isSending: boolean;
  disabled?: boolean;
}

// ============================================
// COLORS
// ============================================

const Colors = {
  primary: '#00D9A6',
  error: '#EA4335',
  bg: {
    elevated: '#243240',
    tertiary: '#1A252F',
  },
  text: {
    secondary: '#8BA4B8',
    tertiary: '#5D7485',
  },
};

// ============================================
// COMPOSANT
// ============================================

export const VoiceRecordButton: React.FC<VoiceRecordButtonProps> = ({
  onRecordStart,
  onRecordEnd,
  onRecordCancel,
  onRecordLock,
  isRecording,
  isLocked,
  isSending,
  disabled = false,
}) => {
  // Refs pour les callbacks
  const callbacksRef = useRef({ onRecordStart, onRecordEnd, onRecordCancel, onRecordLock });
  callbacksRef.current = { onRecordStart, onRecordEnd, onRecordCancel, onRecordLock };
  
  // FIX: Le PanResponder est créé une seule fois (useRef) donc il ne peut pas
  // lire le prop `disabled` directement — il faut un ref.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  
  // État du geste
  const gestureStarted = useRef(false);
  const hasCancelled = useRef(false);
  const hasLocked = useRef(false);
  
  // Animations
  const buttonScale = useRef(new Animated.Value(1)).current;
  const buttonTranslateX = useRef(new Animated.Value(0)).current;
  const buttonTranslateY = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const lockContainerOpacity = useRef(new Animated.Value(0)).current;
  const lockContainerScale = useRef(new Animated.Value(0.5)).current;
  const lockIconScale = useRef(new Animated.Value(1)).current;
  const lockProgress = useRef(new Animated.Value(0)).current; // 0 = pas de progress, 1 = prêt à verrouiller
  
  // Animation de pulsation pendant l'enregistrement
  useEffect(() => {
    if (isRecording && !isLocked) {
      // Animation du bouton
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 500, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
        ])
      );
      pulse.start();
      
      // Afficher le cadenas
      Animated.parallel([
        Animated.spring(lockContainerOpacity, { toValue: 1, friction: 8, useNativeDriver: true }),
        Animated.spring(lockContainerScale, { toValue: 1, friction: 8, useNativeDriver: true }),
      ]).start();
      
      return () => {
        pulse.stop();
      };
    } else {
      pulseAnim.setValue(1);
      // Cacher le cadenas
      Animated.parallel([
        Animated.timing(lockContainerOpacity, { toValue: 0, duration: 150, useNativeDriver: true }),
        Animated.timing(lockContainerScale, { toValue: 0.5, duration: 150, useNativeDriver: true }),
      ]).start();
    }
  }, [isRecording, isLocked]);
  
  // Animation du cadenas quand on approche du seuil
  useEffect(() => {
    const listenerId = lockProgress.addListener(({ value }) => {
      if (value > 0.7) {
        Animated.spring(lockIconScale, { toValue: 1.3, friction: 5, useNativeDriver: true }).start();
      } else {
        Animated.spring(lockIconScale, { toValue: 1, friction: 8, useNativeDriver: true }).start();
      }
    });
    return () => lockProgress.removeListener(listenerId);
  }, []);
  
  // Haptic feedback
  const haptic = useCallback((type: 'light' | 'medium' | 'heavy') => {
    Vibration.vibrate(type === 'heavy' ? 50 : type === 'medium' ? 30 : 10);
  }, []);
  
  // Reset animations
  const resetAnimations = useCallback(() => {
    Animated.parallel([
      Animated.spring(buttonScale, { toValue: 1, friction: 8, useNativeDriver: true }),
      Animated.spring(buttonTranslateX, { toValue: 0, friction: 8, useNativeDriver: true }),
      Animated.spring(buttonTranslateY, { toValue: 0, friction: 8, useNativeDriver: true }),
      Animated.timing(lockProgress, { toValue: 0, duration: 150, useNativeDriver: true }),
    ]).start();
  }, []);
  
  // PanResponder
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabledRef.current,
      onMoveShouldSetPanResponder: () => !disabledRef.current,
      
      // === APPUI ===
      onPanResponderGrant: () => {
        if (disabledRef.current) return;
        gestureStarted.current = true;
        hasCancelled.current = false;
        hasLocked.current = false;
        
        haptic('medium');
        Animated.spring(buttonScale, {
          toValue: 1.3,
          friction: 5,
          tension: 100,
          useNativeDriver: true,
        }).start();
        
        callbacksRef.current.onRecordStart();
      },
      
      // === MOUVEMENT ===
      onPanResponderMove: (_, gesture: PanResponderGestureState) => {
        if (!gestureStarted.current || hasCancelled.current || hasLocked.current) return;
        
        const { dx, dy } = gesture;
        
        // Glisser à gauche → annuler
        if (dx < 0 && Math.abs(dx) > Math.abs(dy)) {
          buttonTranslateX.setValue(Math.max(dx * 0.7, -100));
          lockProgress.setValue(0);
          
          if (dx <= CANCEL_THRESHOLD && !hasCancelled.current) {
            hasCancelled.current = true;
            haptic('heavy');
            callbacksRef.current.onRecordCancel();
            resetAnimations();
          }
        }
        
        // Glisser vers le haut → verrouiller
        if (dy < 0 && Math.abs(dy) > Math.abs(dx) * 0.5) {
          const clampedY = Math.max(dy * 0.6, -80);
          buttonTranslateY.setValue(clampedY);
          
          // Calculer la progression vers le verrouillage (0 à 1)
          const progress = Math.min(1, Math.abs(dy) / Math.abs(LOCK_THRESHOLD));
          lockProgress.setValue(progress);
          
          if (dy <= LOCK_THRESHOLD && !hasLocked.current) {
            hasLocked.current = true;
            gestureStarted.current = false;
            haptic('heavy');
            callbacksRef.current.onRecordLock();
            resetAnimations();
          }
        }
      },
      
      // === RELÂCHEMENT ===
      onPanResponderRelease: () => {
        if (!gestureStarted.current || hasCancelled.current || hasLocked.current) {
          gestureStarted.current = false;
          resetAnimations();
          return;
        }
        
        gestureStarted.current = false;
        haptic('light');
        callbacksRef.current.onRecordEnd();
        resetAnimations();
      },
      
      // === INTERRUPTION ===
      onPanResponderTerminate: () => {
        if (gestureStarted.current && !hasCancelled.current && !hasLocked.current) {
          callbacksRef.current.onRecordCancel();
        }
        gestureStarted.current = false;
        resetAnimations();
      },
    })
  ).current;
  
  // Ne pas afficher si verrouillé
  if (isLocked) return null;
  
  return (
    <View style={styles.wrapper}>
      {/* === ICÔNE CADENAS (au-dessus du bouton) === */}
      <Animated.View
        style={[
          styles.lockContainer,
          {
            opacity: lockContainerOpacity,
            transform: [{ scale: lockContainerScale }],
          },
        ]}
        pointerEvents="none"
      >
        {/* Barre de progression vers le verrouillage */}
        <View style={styles.lockTrack}>
          <Animated.View
            style={[
              styles.lockTrackFill,
              {
                transform: [{
                  scaleY: lockProgress,
                }],
              },
            ]}
          />
        </View>
        
        {/* Icône cadenas */}
        <Animated.View
          style={[
            styles.lockIconContainer,
            {
              transform: [{ scale: lockIconScale }],
              backgroundColor: lockProgress.interpolate({
                inputRange: [0, 0.7, 1],
                outputRange: [Colors.bg.elevated, Colors.bg.elevated, Colors.primary],
              }),
            },
          ]}
        >
          <Ionicons name="lock-closed" size={18} color="#FFF" />
        </Animated.View>
        
        {/* Flèche vers le haut */}
        <View style={styles.lockArrow}>
          <Ionicons name="chevron-up" size={14} color={Colors.text.tertiary} />
        </View>
      </Animated.View>
      
      {/* === BOUTON MICRO === */}
      <View style={styles.container} {...panResponder.panHandlers}>
        <Animated.View
          style={[
            styles.button,
            {
              backgroundColor: isRecording ? Colors.error : Colors.primary,
              transform: [
                { translateX: buttonTranslateX },
                { translateY: buttonTranslateY },
                { scale: isRecording ? Animated.multiply(buttonScale, pulseAnim) : buttonScale },
              ],
            },
          ]}
        >
          {isSending ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Ionicons name="mic" size={22} color="#FFF" />
          )}
        </Animated.View>
        
        {/* Cercle pulsant */}
        {isRecording && (
          <Animated.View
            style={[
              styles.pulse,
              {
                transform: [
                  { translateX: buttonTranslateX },
                  { translateY: buttonTranslateY },
                  { scale: pulseAnim.interpolate({ inputRange: [1, 1.15], outputRange: [1, 1.8] }) },
                ],
                opacity: pulseAnim.interpolate({ inputRange: [1, 1.15], outputRange: [0.4, 0] }),
              },
            ]}
          />
        )}
      </View>
    </View>
  );
};

// ============================================
// STYLES
// ============================================

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  pulse: {
    position: 'absolute',
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.error,
  },
  
  // Lock container
  lockContainer: {
    position: 'absolute',
    bottom: 58,
    alignItems: 'center',
    zIndex: 10,
  },
  lockTrack: {
    width: 28,
    height: 50,
    backgroundColor: Colors.bg.tertiary,
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 6,
  },
  lockTrackFill: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '100%',
    backgroundColor: Colors.primary,
    borderRadius: 14,
    transformOrigin: 'bottom',
  },
  lockIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  lockArrow: {
    marginTop: 4,
    opacity: 0.6,
  },
});

export default VoiceRecordButton;