// src/components/CallIndicator.tsx
// Indicateur d'appel en cours pour la liste des conversations
// Version 1.0 - Design moderne style Discord/WhatsApp
//
// FONCTIONNALITÉS:
// - Badge animé avec icône téléphone
// - Pulse vert pour indiquer un appel actif
// - Nombre de participants affiché
// - Intégration fluide dans le design existant
//
// UTILISATION:
// - Placer sur l'avatar de la conversation dans ConversationListScreen
// - S'abonne automatiquement au callHeartbeat pour les mises à jour en temps réel

import React, { useEffect, useState, useRef, memo } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getActiveCall, addCallStateListener, ActiveCallInfo } from '../services/callHeartbeat';
import { useThemedStyles, type ColorPalette } from './ui';

// ============================================
// TYPES
// ============================================

interface CallIndicatorProps {
  conversationId: string;
  size?: 'small' | 'medium' | 'large';
  showParticipantCount?: boolean;
}

// ============================================
// CONSTANTES
// ============================================

const SIZES = {
  small: {
    container: 20,
    icon: 10,
    badge: 14,
    fontSize: 9,
  },
  medium: {
    container: 24,
    icon: 12,
    badge: 16,
    fontSize: 10,
  },
  large: {
    container: 28,
    icon: 14,
    badge: 18,
    fontSize: 11,
  },
};

// ============================================
// COMPOSANT
// ============================================

export const CallIndicator: React.FC<CallIndicatorProps> = memo(({
  conversationId,
  size = 'medium',
  showParticipantCount = true,
}) => {
  const styles = useThemedStyles(makeStyles);
  const [activeCall, setActiveCall] = useState<ActiveCallInfo | null>(() => 
    getActiveCall(conversationId)
  );
  
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const dimensions = SIZES[size];
  
  // Écouter les changements d'état des appels
  useEffect(() => {
    // État initial
    setActiveCall(getActiveCall(conversationId));
    
    // S'abonner aux changements
    const unsubscribe = addCallStateListener((convId, callInfo) => {
      if (convId === conversationId) {
        setActiveCall(callInfo);
      }
    });
    
    return () => unsubscribe();
  }, [conversationId]);
  
  // Animation de pulsation
  useEffect(() => {
    if (activeCall) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [activeCall, pulseAnim]);
  
  // Ne pas rendre si pas d'appel actif
  if (!activeCall) return null;
  
  const participantCount = activeCall.participantTokens.size;
  
  return (
    <Animated.View
      style={[
        styles.container,
        {
          width: dimensions.container,
          height: dimensions.container,
          borderRadius: dimensions.container / 2,
          transform: [{ scale: pulseAnim }],
        },
      ]}
    >
      {/* Cercle de fond avec icône */}
      <View style={[
        styles.iconCircle,
        {
          width: dimensions.container,
          height: dimensions.container,
          borderRadius: dimensions.container / 2,
        }
      ]}>
        <Ionicons 
          name="call" 
          size={dimensions.icon} 
          color="#FFFFFF" 
        />
      </View>
      
      {/* Badge compteur de participants */}
      {showParticipantCount && participantCount > 0 && (
        <View style={[
          styles.badge,
          {
            minWidth: dimensions.badge,
            height: dimensions.badge,
            borderRadius: dimensions.badge / 2,
          }
        ]}>
          <Text style={[styles.badgeText, { fontSize: dimensions.fontSize }]}>
            {participantCount > 9 ? '9+' : participantCount}
          </Text>
        </View>
      )}
    </Animated.View>
  );
});

// ============================================
// COMPOSANT COMPACT (juste un point)
// ============================================

interface CallDotIndicatorProps {
  conversationId: string;
}

export const CallDotIndicator: React.FC<CallDotIndicatorProps> = memo(({
  conversationId,
}) => {
  const styles = useThemedStyles(makeStyles);
  const [hasActiveCall, setHasActiveCall] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  
  // Écouter les changements d'état des appels
  useEffect(() => {
    // État initial
    const call = getActiveCall(conversationId);
    setHasActiveCall(call !== null && call.participantTokens.size > 0);
    
    // S'abonner aux changements
    const unsubscribe = addCallStateListener((convId, callInfo) => {
      if (convId === conversationId) {
        setHasActiveCall(callInfo !== null && callInfo.participantTokens.size > 0);
      }
    });
    
    return () => unsubscribe();
  }, [conversationId]);
  
  // Animation de pulsation
  useEffect(() => {
    if (hasActiveCall) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.3,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [hasActiveCall, pulseAnim]);
  
  if (!hasActiveCall) return null;
  
  return (
    <Animated.View
      style={[
        styles.dotContainer,
        { transform: [{ scale: pulseAnim }] },
      ]}
    >
      <View style={styles.dotOuter}>
        <View style={styles.dotInner} />
      </View>
    </Animated.View>
  );
});

// ============================================
// STYLES
// ============================================

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: -4,
    right: -4,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  iconCircle: {
    backgroundColor: colors.online,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    // borderColor is the cutout against the page — must match the surface
    // the avatar/icon sits on. Was hardcoded to dark bg in v1.
    borderColor: colors.background,
    shadowColor: colors.online,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    elevation: 4,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: colors.error,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.background,
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  
  // Styles pour le point indicateur
  dotContainer: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 10,
  },
  dotOuter: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.online + '4D', // ~30% alpha
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: colors.background,
  },
  dotInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.online,
  },
});

export default CallIndicator;