// src/screens/conversation/MessageWrappers.tsx
//
// PERF FIX (4) : extraction depuis ConversationScreen.tsx.
//
// AVANT : ces deux wrappers étaient définis au niveau module DANS le fichier
//   ConversationScreen.tsx (6300+ lignes). C'est pas une régression de perf
//   en soi (composants déjà au niveau module = stable), mais :
//     1. ça contribue à la taille monolithique du screen → plus dur à mémoïser
//        / re-tester à la pièce ;
//     2. impossible de les utiliser ailleurs sans dupliquer.
//
// APRÈS : fichier dédié, autonome (constantes/styles locaux), exporté avec
//   React.memo. Le composant `SwipeableMessage` reçoit `children` qui change
//   à chaque render parent, donc `React.memo` n'évite pas tous les re-renders ;
//   mais combiné à la stabilisation d'`extraData` côté FlatList (fix 3),
//   le résultat global est : aucune cellule re-rendue tant qu'on touche pas
//   au message lui-même.
//
// Pas de dépendance sur le `Colors` / `Icons` locaux de ConversationScreen :
//   on duplique le minimum nécessaire (la couleur d'accent + l'icône Reply
//   en SVG inline). Volontaire — une dépendance cross-file casserait la
//   self-containedness.

import React, { useRef, useEffect, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Animated,
  PanResponder,
  Easing,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';

// ────────────────────────────────────────────────────────────────────
// Constantes locales
// ────────────────────────────────────────────────────────────────────

// Distance de swipe avant déclenchement du reply.
// Identique à la version précédente (ConversationScreen.tsx ligne 161).
const SWIPE_THRESHOLD = 60;

// Couleur d'accent pour le bouton reply au swipe. Doit matcher Colors.accent.primary
// du screen parent. Si tu changes la palette, mets aussi à jour ici.
const ACCENT_PRIMARY = '#00D9A6';

// ────────────────────────────────────────────────────────────────────
// SwipeableMessage
// ────────────────────────────────────────────────────────────────────

interface SwipeableMessageProps {
  children: React.ReactNode;
  onSwipeRight: () => void;
  isMine: boolean;
  enabled?: boolean;
}

// Icône Reply (SVG inline) — duplique Icons.Reply du screen parent pour éviter
// une dépendance cross-file. Très peu de bytes, négligeable.
const ReplyIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 18,
  color = '#FFFFFF',
}) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M10 9V5L3 12L10 19V14.9C15 14.9 18.5 16.5 21 20C20 15 17 10 10 9Z"
      fill={color}
    />
  </Svg>
);

const SwipeableMessageInner: React.FC<SwipeableMessageProps> = ({
  children,
  onSwipeRight,
  isMine,
  enabled = true,
}) => {
  const translateX = useRef(new Animated.Value(0)).current;
  const replyIconScale = useRef(new Animated.Value(0)).current;
  const replyIconRotate = useRef(new Animated.Value(0)).current;
  const hasTriggeredRef = useRef(false);

  // Reset trigger state when enabled changes
  useEffect(() => {
    hasTriggeredRef.current = false;
  }, [enabled]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => {
      // Only capture horizontal swipes to the right
      return enabled &&
             gestureState.dx > 8 &&
             Math.abs(gestureState.dy) < 15 &&
             Math.abs(gestureState.dx) > Math.abs(gestureState.dy);
    },
    onPanResponderGrant: () => {
      hasTriggeredRef.current = false;
    },
    onPanResponderMove: (_, gestureState) => {
      // Smooth resistance effect - gets harder to pull as you go further
      const resistance = 0.6;
      const rawX = Math.max(0, gestureState.dx);
      const resistedX = rawX < SWIPE_THRESHOLD
        ? rawX
        : SWIPE_THRESHOLD + (rawX - SWIPE_THRESHOLD) * resistance;

      const clampedX = Math.min(resistedX, SWIPE_THRESHOLD + 30);
      translateX.setValue(clampedX);

      // Progress from 0 to 1
      const progress = Math.min(clampedX / SWIPE_THRESHOLD, 1);

      // Scale with slight overshoot at threshold
      const scaleValue = progress < 1
        ? progress
        : 1 + (progress - 1) * 0.3;
      replyIconScale.setValue(scaleValue);

      // Subtle rotation as you swipe
      replyIconRotate.setValue(progress * 0.15);

      // Trigger feedback when threshold is reached (once per swipe)
      if (progress >= 1 && !hasTriggeredRef.current) {
        hasTriggeredRef.current = true;
        // Bounce animation when threshold reached
        Animated.sequence([
          Animated.spring(replyIconScale, {
            toValue: 1.3,
            tension: 400,
            friction: 10,
            useNativeDriver: true,
          }),
          Animated.spring(replyIconScale, {
            toValue: 1,
            tension: 300,
            friction: 10,
            useNativeDriver: true,
          }),
        ]).start();
      }
    },
    onPanResponderRelease: (_, gestureState) => {
      const shouldTrigger = gestureState.dx >= SWIPE_THRESHOLD;

      if (shouldTrigger) {
        // Quick snap back with callback
        Animated.parallel([
          Animated.spring(translateX, {
            toValue: 0,
            tension: 200,
            friction: 20,
            useNativeDriver: true,
          }),
          Animated.timing(replyIconScale, {
            toValue: 0,
            duration: 150,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(replyIconRotate, {
            toValue: 0,
            duration: 150,
            useNativeDriver: true,
          }),
        ]).start(() => {
          onSwipeRight();
        });
      } else {
        // Smooth return to origin
        Animated.parallel([
          Animated.spring(translateX, {
            toValue: 0,
            tension: 180,
            friction: 15,
            useNativeDriver: true,
          }),
          Animated.timing(replyIconScale, {
            toValue: 0,
            duration: 200,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(replyIconRotate, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
          }),
        ]).start();
      }

      hasTriggeredRef.current = false;
    },
    onPanResponderTerminate: () => {
      // If gesture is interrupted, reset smoothly
      Animated.parallel([
        Animated.spring(translateX, {
          toValue: 0,
          tension: 180,
          friction: 15,
          useNativeDriver: true,
        }),
        Animated.timing(replyIconScale, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
      hasTriggeredRef.current = false;
    },
  }), [enabled, onSwipeRight]);

  // Interpolated values for smooth animations
  const iconOpacity = replyIconScale.interpolate({
    inputRange: [0, 0.3, 1],
    outputRange: [0, 0.7, 1],
  });

  const iconTranslateX = replyIconScale.interpolate({
    inputRange: [0, 1],
    outputRange: [-10, 0],
  });

  const rotateZ = replyIconRotate.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '-15deg'],
  });

  return (
    <View style={styles.swipeableContainer}>
      {/* Reply icon with smooth animations */}
      <Animated.View
        style={[
          styles.swipeReplyIcon,
          {
            opacity: iconOpacity,
            transform: [
              { scale: replyIconScale },
              { translateX: iconTranslateX },
              { rotate: rotateZ },
            ],
          },
        ]}
      >
        <ReplyIcon size={18} color="#FFFFFF" />
      </Animated.View>

      {/* Message content with swipe transform */}
      <Animated.View
        {...panResponder.panHandlers}
        style={{ transform: [{ translateX }] }}
      >
        {children}
      </Animated.View>
    </View>
  );
};

// PERF FIX (3+4) : memo. La comparaison shallow par défaut sur `children` ne
// court-circuitera pas les renders quand le parent re-render (children =
// nouveau React.element à chaque fois). C'est ok : le vrai gain de perf vient
// de la stabilisation d'`extraData` côté FlatList (qui empêche la cellule de
// re-rendre du tout). Le memo ici est défensif — au cas où ce composant serait
// utilisé hors FlatList plus tard.
export const SwipeableMessage = React.memo(SwipeableMessageInner);

// ────────────────────────────────────────────────────────────────────
// AnimatedMessage
// ────────────────────────────────────────────────────────────────────

interface AnimatedMessageProps {
  children: React.ReactNode;
  index: number;
  isMine: boolean;
  isNew?: boolean;
}

const AnimatedMessageInner: React.FC<AnimatedMessageProps> = ({
  children,
  index,
  isMine,
  isNew = false,
}) => {
  const animValue = useRef(new Animated.Value(isNew ? 0 : 1)).current;

  useEffect(() => {
    if (isNew) {
      Animated.spring(animValue, {
        toValue: 1,
        tension: 100,
        friction: 12,
        useNativeDriver: true,
      }).start();
    }
  }, [isNew]);

  if (!isNew) {
    return <View>{children}</View>;
  }

  return (
    <Animated.View
      style={{
        opacity: animValue,
        transform: [
          {
            translateY: animValue.interpolate({
              inputRange: [0, 1],
              outputRange: [30, 0],
            }),
          },
          {
            scale: animValue.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: [0.9, 1.02, 1],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
};

export const AnimatedMessage = React.memo(AnimatedMessageInner);

// ────────────────────────────────────────────────────────────────────
// Styles locaux (auto-suffisants)
// ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  swipeableContainer: {
    position: 'relative',
    overflow: 'visible',
  },
  swipeReplyIcon: {
    position: 'absolute',
    left: 6,
    top: '50%',
    marginTop: -16,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: ACCENT_PRIMARY,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: ACCENT_PRIMARY,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
});
