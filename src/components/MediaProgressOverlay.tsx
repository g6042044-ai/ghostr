// src/components/MediaProgressOverlay.tsx
// v25.0: Overlays de progression pour les transferts média chunkés
//
// COMPOSANTS:
//   <MediaProgressOverlay />  — Overlay principal avec anneau circulaire (images)
//   <FileProgressBar />       — Barre de progression linéaire (fichiers)
//   <VoiceProgressBar />      — Barre fine (vocaux)
//   <IncomingMediaPlaceholder /> — Placeholder pour média en cours de réception
//
// DESIGN:
//   - Anneau circulaire SVG animé sur fond semi-transparent pour les images
//   - Barre linéaire subtile pour fichiers et vocaux
//   - Animations fluides via React Native Animated
//   - Cohérent avec le thème sombre de Ghostr

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemedStyles, useThemeColors, type ColorPalette } from './ui';

// ============================================
// THÈME — Aligné avec ConversationScreen Colors
// ============================================

// v2.0 — Was a static dark-only constant; now a factory that mirrors the
// same shape from the active palette. Each ProgressColors-consuming
// StyleSheet block has been converted to a `makeStyles` factory below.
//
// Conventions:
//   - `overlayBg` stays dark semi-transparent. It sits ON TOP of photo
//     pixels (not the app surface), so dark-tinted overlay is intentional
//     on both themes for legibility.
//   - `placeholderBg` is the bubble shown while a file is being received
//     and IS on the app surface — it uses `messageTheirs` so it matches
//     the incoming bubble of the current theme.
function makeProgressColors(c: ColorPalette) {
  return {
    // Overlay over media content — dark on both themes by design.
    overlayBg: 'rgba(10, 15, 20, 0.65)',

    // Anneau de progression
    ringTrack: c.textSecondary + '33', // ~20% alpha
    ringFill: c.primary,
    ringFillReceive: c.info,

    // Barre linéaire
    barTrack: c.textSecondary + '26', // ~15% alpha
    barFill: c.primary,
    barFillReceive: c.info,

    // Texte
    percentText: '#FFFFFF',  // over dark overlay — stays white
    phaseText: 'rgba(240, 244, 248, 0.7)',  // over dark overlay

    // Placeholder — palette-driven. The "received-file" bubble shape.
    placeholderBg: c.messageTheirs,
    placeholderBorder: c.primary + '26', // ~15% alpha
    placeholderIcon: c.primary + '66', // ~40% alpha

    // Shimmer
    shimmer: c.primary + '14', // ~8% alpha
  };
}

// Plus de constante `ProgressColors` figée au niveau module : elle était
// construite à partir de `theme.colors`, c'est-à-dire de la palette capturée
// à l'import du module theme.ts. Chaque composant appelle désormais
// `useProgressColors()` et suit donc le thème actif en direct.
//
// Le hook est trivial mais mémoïsé : `useThemeColors()` renvoie toujours la
// MÊME référence d'objet pour un scheme donné, donc `useMemo` ne recalcule
// qu'au changement de thème.
function useProgressColors() {
  const colors = useThemeColors();
  return React.useMemo(() => makeProgressColors(colors), [colors]);
}

// ============================================
// ANNEAU DE PROGRESSION SVG (React Native compatible)
// ============================================

/**
 * Anneau de progression circulaire.
 * Utilise des borders et rotation Animated pour compatibilité RN pure.
 *
 * NOTE: En React Native pur (sans react-native-svg), un vrai arc SVG
 * n'est pas disponible. On utilise une technique de demi-cercles rotatifs.
 */
const ProgressRing: React.FC<{
  size: number;
  strokeWidth: number;
  progress: number;  // 0.0 → 1.0
  color?: string;
}> = ({ size, strokeWidth, progress, color }) => {
  const P = useProgressColors();
  const ringStyles = useThemedStyles(makeRingStyles);
  // `color` ne peut plus avoir de valeur par défaut dans la signature : elle
  // serait évaluée à l'import du module, avant que le thème soit connu.
  const strokeColor = color ?? P.ringFill;
  const animatedProgress = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0.6)).current;
  
  useEffect(() => {
    Animated.timing(animatedProgress, {
      toValue: progress,
      duration: 400,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [progress]);
  
  // Animation de pulsation douce quand en cours
  useEffect(() => {
    if (progress < 1 && progress > 0) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1200,
            easing: Easing.inOut(Easing.sine),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 0.6,
            duration: 1200,
            easing: Easing.inOut(Easing.sine),
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [progress > 0 && progress < 1]);
  
  const innerSize = size - strokeWidth * 2;
  const percentText = `${Math.round(progress * 100)}%`;
  
  // Rotation du premier demi-cercle (0-50%)
  const firstHalfRotation = animatedProgress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['0deg', '180deg', '180deg'],
  });
  
  // Rotation du second demi-cercle (50-100%)
  const secondHalfRotation = animatedProgress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['0deg', '0deg', '180deg'],
  });
  
  // Opacité du second demi-cercle (visible seulement > 50%)
  const secondHalfOpacity = animatedProgress.interpolate({
    inputRange: [0, 0.499, 0.5, 1],
    outputRange: [0, 0, 1, 1],
  });
  
  return (
    <Animated.View style={[{ width: size, height: size }, { opacity: pulseAnim }]}>
      {/* Piste (track) */}
      <View style={[
        ringStyles.track,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: strokeWidth,
          borderColor: P.ringTrack,
        },
      ]} />
      
      {/* Première moitié (0-180°) */}
      <View style={[ringStyles.halfContainer, { width: size, height: size }]}>
        <View style={[ringStyles.halfClip, { width: size / 2, height: size, left: size / 2 }]}>
          <Animated.View style={[
            ringStyles.halfCircle,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: strokeWidth,
              borderColor: strokeColor,
              left: -(size / 2),
              transform: [{ rotate: firstHalfRotation }],
            },
          ]} />
        </View>
      </View>
      
      {/* Seconde moitié (180-360°) */}
      <Animated.View style={[ringStyles.halfContainer, { width: size, height: size, opacity: secondHalfOpacity }]}>
        <View style={[ringStyles.halfClip, { width: size / 2, height: size, left: 0 }]}>
          <Animated.View style={[
            ringStyles.halfCircle,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: strokeWidth,
              borderColor: strokeColor,
              transform: [{ rotate: secondHalfRotation }],
            },
          ]} />
        </View>
      </Animated.View>
      
      {/* Pourcentage au centre */}
      <View style={[ringStyles.center, { width: innerSize, height: innerSize, borderRadius: innerSize / 2, top: strokeWidth, left: strokeWidth }]}>
        <Text style={[ringStyles.percentText, { fontSize: size * 0.22 }]}>
          {percentText}
        </Text>
      </View>
    </Animated.View>
  );
};

const makeRingStyles = (c: ColorPalette) => StyleSheet.create({
  track: {
    position: 'absolute',
  },
  halfContainer: {
    position: 'absolute',
    overflow: 'hidden',
  },
  halfClip: {
    position: 'absolute',
    overflow: 'hidden',
  },
  halfCircle: {
    position: 'absolute',
    borderLeftColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  center: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
  },
  percentText: {
    color: makeProgressColors(c).percentText,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.5,
  },
});

// ============================================
// OVERLAY PRINCIPAL (pour images)
// ============================================

export interface MediaProgressOverlayProps {
  /** Progression 0.0 → 1.0 */
  progress: number;
  
  /** Phase du transfert */
  phase: 'preparing' | 'transferring' | 'assembling' | 'complete' | 'error';
  
  /** Direction (affecte la couleur) */
  direction?: 'send' | 'receive';
  
  /** Taille de l'anneau (défaut: 64) */
  ringSize?: number;
  
  /** Texte de phase personnalisé */
  phaseLabel?: string;
}

/**
 * Overlay semi-transparent avec anneau de progression.
 * Se superpose aux images pendant l'envoi/réception.
 *
 * USAGE:
 *   <View style={{ position: 'relative' }}>
 *     <Image source={...} />
 *     {progress && <MediaProgressOverlay progress={0.42} phase="transferring" />}
 *   </View>
 */
export const MediaProgressOverlay: React.FC<MediaProgressOverlayProps> = ({
  progress,
  phase,
  direction = 'send',
  ringSize = 64,
  phaseLabel,
}) => {
  const { t } = useTranslation();
  const P = useProgressColors();
  const styles = useThemedStyles(makeOverlayStyles);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    if (phase === 'complete') {
      // Fade out quand terminé
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 500,
        delay: 300,
        useNativeDriver: true,
      }).start();
    } else {
      // Fade in au début
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [phase]);
  
  const ringColor = direction === 'receive'
    ? P.ringFillReceive
    : P.ringFill;
  
  const label = phaseLabel || (() => {
    switch (phase) {
      case 'preparing': return t('mediaProgress.preparing');
      case 'transferring': return direction === 'send' ? t('mediaProgress.secureSending') : t('mediaProgress.receiving');
      case 'assembling': return t('mediaProgress.assembling');
      case 'complete': return t('mediaProgress.complete');
      case 'error': return t('mediaProgress.errorLabel');
      default: return '';
    }
  })();
  
  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <View style={styles.backdrop} />
      <View style={styles.content}>
        <ProgressRing
          size={ringSize}
          strokeWidth={3}
          progress={progress}
          color={ringColor}
        />
        <Text style={styles.phaseLabel} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Animated.View>
  );
};

const makeOverlayStyles = (c: ColorPalette) => StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: makeProgressColors(c).overlayBg,
  },
  content: {
    alignItems: 'center',
    gap: 8,
  },
  phaseLabel: {
    color: makeProgressColors(c).phaseText,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.3,
  },
});

// ============================================
// BARRE DE PROGRESSION LINÉAIRE (fichiers)
// ============================================

export interface FileProgressBarProps {
  progress: number;
  direction?: 'send' | 'receive';
  height?: number;
}

/**
 * Barre de progression fine pour les fichiers.
 * S'insère sous l'icône du fichier.
 */
export const FileProgressBar: React.FC<FileProgressBarProps> = ({
  progress,
  direction = 'send',
  height = 3,
}) => {
  const P = useProgressColors();
  const barStyles = useThemedStyles(makeBarStyles);
  const widthAnim = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: progress,
      duration: 350,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [progress]);
  
  const fillColor = direction === 'receive'
    ? P.barFillReceive
    : P.barFill;
  
  return (
    <View style={[barStyles.track, { height }]}>
      <Animated.View
        style={[
          barStyles.fill,
          {
            height,
            backgroundColor: fillColor,
            width: widthAnim.interpolate({
              inputRange: [0, 1],
              outputRange: ['0%', '100%'],
            }),
          },
        ]}
      />
    </View>
  );
};

const makeBarStyles = (c: ColorPalette) => StyleSheet.create({
  track: {
    width: '100%',
    backgroundColor: makeProgressColors(c).barTrack,
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: {
    borderRadius: 2,
  },
});

// ============================================
// BARRE VOCALE (vocaux)
// ============================================

export interface VoiceProgressBarProps {
  progress: number;
  direction?: 'send' | 'receive';
}

/**
 * Barre de progression pour les vocaux.
 * Plus fine, s'insère dans la waveform.
 */
export const VoiceProgressBar: React.FC<VoiceProgressBarProps> = ({
  progress,
  direction = 'send',
}) => {
  return <FileProgressBar progress={progress} direction={direction} height={2} />;
};

// ============================================
// PLACEHOLDER MÉDIA ENTRANT
// ============================================

export interface IncomingMediaPlaceholderProps {
  /** Type de média attendu */
  mediaType?: 'image' | 'file' | 'voice';
  
  /** Progression 0.0 → 1.0 */
  progress: number;
  
  /** Nombre de chunks reçus / total */
  receivedChunks: number;
  totalChunks: number;
  
  /** Dimensions pour les images (optionnel) */
  width?: number;
  height?: number;
}

/**
 * Placeholder affiché pendant la réception d'un média chunké.
 * Apparaît dès le premier chunk reçu, avant l'assemblage complet.
 *
 * - Images: rectangle avec shimmer + anneau
 * - Fichiers: icône fichier + barre de progression
 * - Vocaux: waveform placeholder + barre
 */
export const IncomingMediaPlaceholder: React.FC<IncomingMediaPlaceholderProps> = ({
  mediaType = 'image',
  progress,
  receivedChunks,
  totalChunks,
  width = 200,
  height = 150,
}) => {
  const P = useProgressColors();
  const placeholderStyles = useThemedStyles(makePlaceholderStyles);
  const { t } = useTranslation();
  const shimmerAnim = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    const shimmer = Animated.loop(
      Animated.timing(shimmerAnim, {
        toValue: 1,
        duration: 2000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    shimmer.start();
    return () => shimmer.stop();
  }, []);
  
  const shimmerTranslate = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-width, width],
  });
  
  if (mediaType === 'image') {
    // Clamp les dimensions
    const displayWidth = Math.min(220, width);
    const displayHeight = Math.min(180, height);
    
    return (
      <View style={[
        placeholderStyles.imageContainer,
        { width: displayWidth, height: displayHeight },
      ]}>
        {/* Fond avec shimmer */}
        <View style={StyleSheet.absoluteFill}>
          <View style={[placeholderStyles.imageBg, { width: displayWidth, height: displayHeight }]} />
          <Animated.View
            style={[
              placeholderStyles.shimmer,
              {
                width: displayWidth * 0.6,
                height: displayHeight,
                transform: [{ translateX: shimmerTranslate }],
              },
            ]}
          />
        </View>
        
        {/* Anneau de progression */}
        <View style={placeholderStyles.ringWrapper}>
          <ProgressRing
            size={52}
            strokeWidth={2.5}
            progress={progress}
            color={P.ringFillReceive}
          />
          <Text style={placeholderStyles.chunkText}>
            {receivedChunks}/{totalChunks}
          </Text>
        </View>
      </View>
    );
  }
  
  // Fichier ou vocal
  const iconName = mediaType === 'voice' ? '🎤' : '📎';
  
  return (
    <View style={placeholderStyles.fileContainer}>
      <View style={placeholderStyles.fileIconRow}>
        <Text style={placeholderStyles.fileIcon}>{iconName}</Text>
        <View style={placeholderStyles.fileInfo}>
          <Text style={placeholderStyles.fileLabel}>
            {mediaType === 'voice' ? t('mediaProgress.voiceInProgress') : t('mediaProgress.fileInProgress')}
          </Text>
          <Text style={placeholderStyles.chunkText}>
            {receivedChunks}/{totalChunks} {t('mediaProgress.fragmentsLabel')}
          </Text>
        </View>
      </View>
      <FileProgressBar progress={progress} direction="receive" />
    </View>
  );
};

const makePlaceholderStyles = (c: ColorPalette) => {
  const P = makeProgressColors(c);
  return StyleSheet.create({
  imageContainer: {
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: P.placeholderBg,
    borderWidth: 1,
    borderColor: P.placeholderBorder,
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageBg: {
    backgroundColor: P.placeholderBg,
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    backgroundColor: P.shimmer,
    ...Platform.select({
      ios: {
        shadowColor: P.shimmer,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 40,
      },
      android: {
        opacity: 0.5,
      },
    }),
  },
  ringWrapper: {
    alignItems: 'center',
    gap: 6,
  },
  chunkText: {
    // Inside the placeholder bubble (palette-driven), so text uses the
    // palette's secondary colour rather than over-overlay white.
    color: c.textSecondary,
    fontSize: 10,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  fileContainer: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    minWidth: 180,
  },
  fileIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  fileIcon: {
    fontSize: 24,
  },
  fileInfo: {
    flex: 1,
    gap: 2,
  },
  fileLabel: {
    color: c.text,
    fontSize: 13,
    fontWeight: '500',
  },
  });
};

// ============================================
// SENDING STATUS AVEC PROGRESSION
// ============================================

export interface SendingProgressLabelProps {
  progress: number;
  phase: 'preparing' | 'transferring' | 'assembling' | 'complete' | 'error';
  totalChunks: number;
}

/**
 * Label compact "Envoi 42%" à afficher sous les bulles de texte
 * quand le message est en cours de chunking.
 */
export const SendingProgressLabel: React.FC<SendingProgressLabelProps> = ({
  progress,
  phase,
  totalChunks,
}) => {
  const sendingStyles = useThemedStyles(makeSendingStyles);
  const { t } = useTranslation();
  if (phase === 'complete') return null;
  
  const label = phase === 'preparing'
    ? t('mediaProgress.encrypting')
    : phase === 'error'
    ? t('mediaProgress.sendError')
    : t('mediaProgress.secureSendingProgress', { percent: Math.round(progress * 100) });
  
  return (
    <View style={sendingStyles.container}>
      <Text style={sendingStyles.label}>{label}</Text>
      <FileProgressBar progress={progress} direction="send" height={2} />
    </View>
  );
};

const makeSendingStyles = (c: ColorPalette) => StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingTop: 3,
    paddingBottom: 1,
    gap: 3,
  },
  label: {
    color: c.textSecondary + '99', // ~60% alpha — subtle on both themes
    fontSize: 10,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
});
