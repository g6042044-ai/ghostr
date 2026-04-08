// src/components/Avatar.tsx
// Composant Avatar moderne avec support image et initiales
// v2.0 - Style WhatsApp avec images et animations
//
// FONCTIONNALITÉS:
// - Support image base64 (photo de profil)
// - Fallback sur initiales générées
// - Couleur déterministe basée sur senderToken
// - Indicateur de statut (en ligne, typing)
// - Animation de chargement
// - Badge de warning pour changement d'identité

import React, { useState, useEffect } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  ViewStyle, 
  Image,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { generateColorFromToken, generateAvatarInitials, AVATAR_COLORS } from '../services/crypto';
import { Ionicons } from '@expo/vector-icons';

// ============================================
// TYPES
// ============================================

interface AvatarProps {
  // Données de l'utilisateur
  displayName?: string;
  senderToken?: string;
  avatarUri?: string;           // URL ou base64 de l'image
  
  // Style
  size?: 'tiny' | 'small' | 'medium' | 'large' | 'xlarge' | 'call';
  style?: ViewStyle;
  
  // États
  isOnline?: boolean;
  isTyping?: boolean;
  showWarning?: boolean;        // Badge d'alerte (changement d'identité)
  
  // Personnalisation
  backgroundColor?: string;     // Forcer une couleur de fond
  textColor?: string;          // Forcer une couleur de texte
  borderWidth?: number;
  borderColor?: string;
}

// ============================================
// CONSTANTES
// ============================================

const SIZES = {
  tiny: { container: 24, text: 10, badge: 8, onlineBadge: 8, border: 1.5 },
  small: { container: 32, text: 12, badge: 12, onlineBadge: 10, border: 2 },
  medium: { container: 40, text: 15, badge: 14, onlineBadge: 12, border: 2 },
  large: { container: 52, text: 20, badge: 16, onlineBadge: 14, border: 2.5 },
  xlarge: { container: 80, text: 28, badge: 20, onlineBadge: 18, border: 3 },
  call: { container: 110, text: 38, badge: 22, onlineBadge: 20, border: 3 },
};

// Palette WhatsApp-like pour les avatars
const WHATSAPP_AVATAR_COLORS = [
  '#00A884', // WhatsApp teal
  '#FF6B6B', // Rouge corail
  '#4ECDC4', // Turquoise
  '#45B7D1', // Bleu ciel
  '#96CEB4', // Vert menthe
  '#F7DC6F', // Jaune
  '#BB8FCE', // Violet
  '#85C1E9', // Bleu poudre
  '#F8B500', // Ambre
  '#00CED1', // Cyan
  '#E74C3C', // Rouge vif
  '#9B59B6', // Violet foncé
];

// ============================================
// COMPOSANT PRINCIPAL
// ============================================

export function Avatar({
  displayName,
  senderToken,
  avatarUri,
  size = 'medium',
  style,
  isOnline = false,
  isTyping = false,
  showWarning = false,
  backgroundColor,
  textColor = '#FFFFFF',
  borderWidth,
  borderColor,
}: AvatarProps) {
  const dimensions = SIZES[size];
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const pulseAnim = React.useRef(new Animated.Value(1)).current;
  
  // v27.1: Reset l'état d'erreur quand l'URI change.
  // Sans ça, si le chargement précédent échouait, le nouvel avatar
  // ne s'affichait jamais (imageError restait true → fallback initiales).
  //
  // FIX: NE PAS remettre imageLoading=true ici.
  // Pour les data URIs base64, l'image se charge depuis la mémoire (quasi-instant).
  // Le cycle est: mount → Image render → onLoadEnd (sync) → useEffect (async, après paint).
  // Si on met setImageLoading(true) dans useEffect, il s'exécute APRÈS que onLoadEnd
  // ait mis imageLoading=false → le spinner réapparaît et plus rien ne le désactive.
  // onLoadStart gère déjà le passage à true quand une nouvelle image commence à charger.
  useEffect(() => {
    setImageError(false);
  }, [avatarUri]);
  
  // Animation de pulsation pour le typing
  useEffect(() => {
    if (isTyping) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.05,
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
  }, [isTyping]);
  
  // Générer les initiales
  const initials = generateAvatarInitials(displayName, senderToken);
  
  // Générer la couleur à partir du senderToken (déterministe)
  const bgColor = backgroundColor || (senderToken 
    ? generateColorFromToken(senderToken)
    : WHATSAPP_AVATAR_COLORS[0]);
  
  // Vérifier si on a une image valide
  const hasValidImage = avatarUri && !imageError;
  
  const containerStyle: ViewStyle = {
    width: dimensions.container,
    height: dimensions.container,
    borderRadius: dimensions.container / 2,
    backgroundColor: hasValidImage ? 'transparent' : bgColor,
    borderWidth: borderWidth,
    borderColor: borderColor,
  };
  
  return (
    <Animated.View
      style={[
        styles.container,
        containerStyle,
        { transform: [{ scale: pulseAnim }] },
        style,
      ]}
    >
      {/* Image de profil */}
      {avatarUri && !imageError ? (
        <View style={styles.imageContainer}>
          <Image
            source={{ uri: avatarUri }}
            style={[
              styles.image,
              {
                width: '100%',
                height: '100%',
                borderRadius: 9999,
              },
            ]}
            onLoadStart={() => setImageLoading(true)}
            onLoadEnd={() => setImageLoading(false)}
            onError={() => {
              setImageError(true);
              setImageLoading(false);
            }}
            resizeMode="cover"
          />
          {imageLoading && (
            <View style={[styles.loadingOverlay, { borderRadius: dimensions.container / 2 }]}>
              <ActivityIndicator size="small" color="#00A884" />
            </View>
          )}
        </View>
      ) : (
        /* Initiales en fallback */
        <Text
          style={[
            styles.text,
            { 
              fontSize: dimensions.text,
              color: textColor,
            },
          ]}
          numberOfLines={1}
        >
          {initials}
        </Text>
      )}
      
      {/* Indicateur en ligne */}
      {isOnline && !isTyping && (
        <View
          style={[
            styles.onlineBadge,
            {
              width: dimensions.onlineBadge,
              height: dimensions.onlineBadge,
              borderRadius: dimensions.onlineBadge / 2,
              borderWidth: dimensions.border,
            },
          ]}
        />
      )}
      
      {/* Indicateur typing */}
      {isTyping && (
        <View
          style={[
            styles.typingBadge,
            {
              width: dimensions.onlineBadge + 4,
              height: dimensions.onlineBadge + 4,
              borderRadius: (dimensions.onlineBadge + 4) / 2,
              borderWidth: dimensions.border,
            },
          ]}
        >
          <TypingDots size={dimensions.onlineBadge - 4} />
        </View>
      )}
      
      {/* Badge d'alerte */}
      {showWarning && (
        <View
          style={[
            styles.warningBadge,
            {
              width: dimensions.badge,
              height: dimensions.badge,
              borderRadius: dimensions.badge / 2,
            },
          ]}
        >
          <Text style={[styles.warningIcon, { fontSize: dimensions.badge - 4 }]}>!</Text>
        </View>
      )}
    </Animated.View>
  );
}

// ============================================
// COMPOSANT TYPING DOTS
// ============================================

interface TypingDotsProps {
  size: number;
}

const TypingDots: React.FC<TypingDotsProps> = ({ size }) => {
  const dot1 = React.useRef(new Animated.Value(0)).current;
  const dot2 = React.useRef(new Animated.Value(0)).current;
  const dot3 = React.useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    const animateDot = (dot: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, {
            toValue: 1,
            duration: 300,
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }),
        ])
      );
    };
    
    const animations = [
      animateDot(dot1, 0),
      animateDot(dot2, 150),
      animateDot(dot3, 300),
    ];
    
    animations.forEach(a => a.start());
    
    return () => animations.forEach(a => a.stop());
  }, []);
  
  const dotSize = Math.max(2, size / 4);
  
  return (
    <View style={styles.typingDotsContainer}>
      {[dot1, dot2, dot3].map((dot, index) => (
        <Animated.View
          key={index}
          style={[
            styles.typingDot,
            {
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              opacity: dot.interpolate({
                inputRange: [0, 1],
                outputRange: [0.3, 1],
              }),
              transform: [{
                scale: dot.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.8, 1.2],
                }),
              }],
            },
          ]}
        />
      ))}
    </View>
  );
};

// ============================================
// COMPOSANT AVATAR GROUPE
// ============================================


// ============================================
// AVATAR EDITABLE (pour profil)
// ============================================

interface EditableAvatarProps extends AvatarProps {
  onPress?: () => void;
  showEditBadge?: boolean;
}

export function EditableAvatar({
  onPress,
  showEditBadge = true,
  ...props
}: EditableAvatarProps) {
  const dimensions = SIZES[props.size || 'xlarge'];
  
  return (
    <View style={styles.editableContainer}>
      <Avatar {...props} />
      {showEditBadge && (
        <View
          style={[
            styles.editBadge,
            {
              width: dimensions.badge + 8,
              height: dimensions.badge + 8,
              borderRadius: (dimensions.badge + 8) / 2,
            },
          ]}
        >
          <Ionicons name="camera" size={14} color="#FFFFFF" />
        </View>
      )}
    </View>
  );
}

// ============================================
// STYLES
// ============================================

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  
  // Image
  imageContainer: {
    position: 'relative',
    width: '100%',
    height: '100%',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  
  // Text
  text: {
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  
  // Online badge
  onlineBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: '#00A884',
    borderColor: '#111B21',
  },
  
  // Typing badge
  typingBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    backgroundColor: '#1F2C34',
    borderColor: '#111B21',
    alignItems: 'center',
    justifyContent: 'center',
  },
  typingDotsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
  },
  typingDot: {
    backgroundColor: '#00A884',
  },
  
  // Warning badge
  warningBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    backgroundColor: '#FFB300',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 3,
  },
  warningIcon: {
    color: '#000',
    fontWeight: '700',
  },
  
  
  // Editable Avatar
  editableContainer: {
    position: 'relative',
  },
  editBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: '#00A884',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#111B21',
  },
  editIcon: {
    fontSize: 12,
  },
});

export default Avatar;