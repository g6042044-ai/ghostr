// src/components/ui/theme.ts
// v2.0 - Premium Dark Theme avec palette moderne
// Compatible avec ConversationScreen v12.0

import { Platform, Dimensions } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Responsive breakpoints
const isSmallDevice = SCREEN_WIDTH < 375;
const isMediumDevice = SCREEN_WIDTH >= 375 && SCREEN_WIDTH < 414;
const isLargeDevice = SCREEN_WIDTH >= 414;

// Scale functions for responsive design
const scale = (size: number) => (SCREEN_WIDTH / 375) * size;
const verticalScale = (size: number) => (SCREEN_HEIGHT / 812) * size;
const moderateScale = (size: number, factor = 0.5) => size + (scale(size) - size) * factor;

export const theme = {
  colors: {
    // Couleurs principales - Style Premium Moderne
    primary: '#00D9A6',           // Accent cyan/turquoise moderne
    primaryDark: '#00B38A',
    primaryLight: '#00F5BD',
    
    // Couleurs secondaires
    secondary: '#00B4D8',         // Bleu secondaire
    accent: '#7B61FF',            // Violet accent
    
    // Arrière-plans - Mode sombre premium
    background: '#0A0F14',        // Fond principal profond
    surface: '#0F161C',           // Surface secondaire
    surfaceLight: '#1A252F',      // Surface élevée
    surfaceElevated: '#243240',   // Éléments surélevés
    
    // Textes
    text: '#F0F4F8',              // Texte principal
    textSecondary: '#8BA4B8',     // Texte secondaire
    textMuted: '#5D7485',         // Texte tertiaire
    textOnPrimary: '#0A0F14',     // Texte sur couleur primaire
    
    // Bordures
    border: 'rgba(139, 164, 184, 0.12)',
    borderLight: 'rgba(139, 164, 184, 0.06)',
    divider: 'rgba(240, 244, 248, 0.06)',
    
    // États
    success: '#00D9A6',
    warning: '#FFB547',
    error: '#FF6B6B',
    info: '#00B4D8',
    
    // Messages
    messageMine: '#005C4B',       // Sent message bubble
    messageTheirs: '#1A252F',     // Received message bubble
    messageMineLight: '#006D5B',
    
    // Spéciaux
    verified: '#00D9A6',
    unverified: '#FFB547',
    online: '#00D9A6',
    typing: '#00D9A6',
    
    // Overlays et glassmorphism
    overlay: 'rgba(10, 15, 20, 0.95)',
    overlayLight: 'rgba(10, 15, 20, 0.8)',
    glass: 'rgba(26, 37, 47, 0.85)',
    glassLight: 'rgba(36, 50, 64, 0.6)',
    
    // Input
    inputBackground: '#1A252F',
    inputBorder: 'rgba(139, 164, 184, 0.12)',
    placeholder: '#5D7485',
    
    // Danger
    danger: '#FF6B6B',
    dangerLight: '#FF8A8A',
    
    // Status indicators pour messages
    statusSent: 'rgba(255,255,255,0.5)',
    statusDelivered: 'rgba(255,255,255,0.75)',
    statusRead: '#00D9A6',
    
    // Réactions
    reactionBg: 'rgba(26, 37, 47, 0.95)',
    reactionBorder: 'rgba(139, 164, 184, 0.15)',
    reactionSelected: 'rgba(0, 217, 166, 0.2)',
    
    // Reply/Quote
    replyBg: 'rgba(0, 217, 166, 0.12)',
    replyBorder: 'rgba(0, 217, 166, 0.4)',
  },
  
  spacing: {
    xxs: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32,
    xxxxl: 48,
  },
  
  borderRadius: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    full: 9999,
    // Message bubbles - modernisés
    messageSent: { topLeft: 20, topRight: 20, bottomLeft: 20, bottomRight: 6 },
    messageReceived: { topLeft: 6, topRight: 20, bottomLeft: 20, bottomRight: 20 },
    // Groupement
    bubble: {
      default: 20,
      grouped: 6,
    },
  },
  
  fontSize: {
    xs: moderateScale(11),
    sm: moderateScale(12),
    md: moderateScale(14),
    base: moderateScale(15),
    lg: moderateScale(16),
    xl: moderateScale(18),
    xxl: moderateScale(22),
    xxxl: moderateScale(28),
    display: moderateScale(34),
  },
  
  fontWeight: {
    normal: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
    heavy: '800' as const,
  },
  
  // Safe area
  safeArea: {
    top: Platform.OS === 'ios' ? 47 : 24,
    bottom: Platform.OS === 'ios' ? 34 : 16,
  },
  
  // Header heights
  header: {
    height: Platform.OS === 'ios' ? 44 : 56,
    paddingTop: Platform.OS === 'ios' ? 47 : 24,
  },
  
  // Input heights
  input: {
    height: 48,
    minHeight: 44,
    maxHeight: 120,
  },
  
  // Button sizes
  button: {
    small: { height: 36, paddingHorizontal: 16 },
    medium: { height: 48, paddingHorizontal: 24 },
    large: { height: 56, paddingHorizontal: 32 },
  },
  
  // Icon sizes
  icon: {
    xs: 16,
    sm: 20,
    md: 24,
    lg: 28,
    xl: 32,
    xxl: 40,
  },
  
  // Avatar sizes
  avatar: {
    xs: 24,
    sm: 32,
    md: 40,
    lg: 52,
    xl: 72,
    xxl: 96,
  },
  
  shadow: {
    none: {},
    sm: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.2,
      shadowRadius: 2,
      elevation: 2,
    },
    md: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.25,
      shadowRadius: 6,
      elevation: 4,
    },
    lg: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.3,
      shadowRadius: 12,
      elevation: 8,
    },
    xl: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.35,
      shadowRadius: 20,
      elevation: 16,
    },
    // Glow effect pour éléments accentués
    glow: {
      shadowColor: '#00D9A6',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.3,
      shadowRadius: 12,
      elevation: 8,
    },
  },
  
  // Animations
  animation: {
    fast: 150,
    normal: 250,
    slow: 350,
    spring: {
      tension: 100,
      friction: 12,
    },
    springBouncy: {
      tension: 200,
      friction: 15,
    },
    springStiff: {
      tension: 400,
      friction: 20,
    },
  },
  
  // Responsive utilities
  responsive: {
    isSmall: isSmallDevice,
    isMedium: isMediumDevice,
    isLarge: isLargeDevice,
    screenWidth: SCREEN_WIDTH,
    screenHeight: SCREEN_HEIGHT,
  },
};

// Utility functions
export const scale_fn = scale;
export const verticalScale_fn = verticalScale;
export const moderateScale_fn = moderateScale;

// Type exports
export type Theme = typeof theme;
export type ThemeColors = typeof theme.colors;

// Couleurs sémantiques pour les messages
export const messageColors = {
  sent: {
    background: theme.colors.messageMine,
    text: '#F0F4F8',
    time: 'rgba(240, 244, 248, 0.6)',
    check: theme.colors.statusRead,
  },
  received: {
    background: theme.colors.messageTheirs,
    text: theme.colors.text,
    time: theme.colors.textMuted,
  },
};

// Palette de couleurs pour avatars (déterministe basée sur token)
export const avatarColors = [
  '#00D9A6', // Turquoise (primary)
  '#FF6B6B', // Rouge corail
  '#00B4D8', // Bleu ciel
  '#7B61FF', // Violet
  '#FFB547', // Orange
  '#45B7D1', // Cyan
  '#96CEB4', // Vert menthe
  '#F7DC6F', // Jaune
  '#BB8FCE', // Lavande
  '#85C1E9', // Bleu poudre
  '#E74C3C', // Rouge vif
  '#00CED1', // Turquoise foncé
];

// Helper pour créer des styles responsifs
export const createResponsiveStyle = <T extends Record<string, any>>(
  base: T,
  small?: Partial<T>,
  medium?: Partial<T>,
  large?: Partial<T>
): T => {
  if (isSmallDevice && small) return { ...base, ...small };
  if (isMediumDevice && medium) return { ...base, ...medium };
  if (isLargeDevice && large) return { ...base, ...large };
  return base;
};

// Helper pour générer une couleur d'avatar à partir d'un token
export const getAvatarColor = (token: string): string => {
  // Protection contre undefined/null
  if (!token) {
    return avatarColors[0];
  }
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return avatarColors[Math.abs(hash) % avatarColors.length];
};

export default theme;