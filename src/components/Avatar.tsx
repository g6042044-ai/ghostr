// src/components/Avatar.tsx
// Composant Avatar moderne avec support image et initiales
// v2.0 - Style WhatsApp avec images et animations
//
// FONCTIONNALITÉS:
// - Support image base64 (photo de profil)
// - Fallback sur initiales générées
// - Couleur déterministe basée sur senderToken
// - Indicateur de statut (en ligne)
// - Animation de chargement
// - Badge de warning pour changement d'identité

import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ViewStyle, Image, ActivityIndicator } from 'react-native';
import { generateAvatarInitials } from '../services/crypto';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, getAvatarColor, type ColorPalette } from './ui';

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

// La palette locale `WHATSAPP_AVATAR_COLORS` a été supprimée : elle était
// l'une des trois palettes d'avatars concurrentes du projet. La couleur vient
// désormais de `getAvatarColor` (design system), commune à tous les écrans.

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
  showWarning = false,
  backgroundColor,
  textColor = '#FFFFFF',
  borderWidth,
  borderColor,
}: AvatarProps) {
  const styles = useThemedStyles(makeStyles);
  const dimensions = SIZES[size];
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  
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
  
  // Générer les initiales
  const initials = generateAvatarInitials(displayName, senderToken);
  
  // Couleur déterministe issue du senderToken. `getAvatarColor` gère déjà le
  // cas de la chaîne vide en renvoyant la première teinte de la palette, donc
  // pas besoin de branche de repli ici.
  const bgColor = backgroundColor || getAvatarColor(senderToken || '');
  
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
    <View
      style={[
        styles.container,
        containerStyle,
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
      {isOnline && (
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
    </View>
  );
}

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
  const styles = useThemedStyles(makeStyles);
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

const makeStyles = (colors: ColorPalette) => ({
  container: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
  },

  // Image
  imageContainer: {
    position: 'relative' as const,
    width: '100%' as const,
    height: '100%' as const,
  },
  image: {
    width: '100%' as const,
    height: '100%' as const,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },

  // Text
  text: {
    fontWeight: '600' as const,
    letterSpacing: 0.5,
  },

  // Online badge — the borderColor is the cutout against the page, so it
  // must match the surface the avatar sits on. Was hardcoded to `#111B21`
  // (dark bg) in v1; now uses `colors.background` so the cutout reads
  // correctly on both themes.
  onlineBadge: {
    position: 'absolute' as const,
    bottom: 0,
    right: 0,
    backgroundColor: colors.online,
    borderColor: colors.background,
  },

  // Warning badge — state colour (warning yellow). Stays yellow on both
  // themes since it's a semantic alert colour, not a surface colour.
  warningBadge: {
    position: 'absolute' as const,
    top: -2,
    right: -2,
    backgroundColor: colors.warning,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 3,
  },
  warningIcon: {
    color: '#000',
    fontWeight: '700' as const,
  },


  // Editable Avatar
  editableContainer: {
    position: 'relative' as const,
  },
  editBadge: {
    position: 'absolute' as const,
    bottom: 0,
    right: 0,
    backgroundColor: colors.primary,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderWidth: 2,
    borderColor: colors.background,
  },
  editIcon: {
    fontSize: 12,
  },
}) as const;

export default Avatar;