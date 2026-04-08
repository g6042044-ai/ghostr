// src/screens/ConversationScreen.tsx
// 
// VERSION 14.0 - Conversations 1-à-1 uniquement avec Double Ratchet (Signal Protocol)
// 
// NOUVEAUTÉS v14.0:
// ✅ Double Ratchet (Signal Protocol) pour tous les messages
// ✅ Forward Secrecy et Break-in Recovery intégrés
// ✅ Identification correcte du sender via fingerprint
// ✅ Pas de transit de clés - échange via QR code ou code manuel
//
// 
// MODIFICATIONS v12.1:
// ✅ Cohérence des couleurs avec le thème global (theme.ts)
// ✅ Espacement amélioré en bas de la liste des messages
// ✅ Meilleure respiration visuelle entre les messages et l'input
//
// FONCTIONNALITÉS:
// ✅ Swipe-to-Reply - Glissez pour répondre à un message
// ✅ Réactions emoji - Double-tap ou long-press pour réagir
// ✅ Messages cités - Aperçu élégant du message référencé
// ✅ Indicateur de frappe - Animation moderne "typing"
// ✅ Animations avancées - Micro-interactions fluides
// ✅ Glassmorphism subtil - Effets visuels modernes
// ✅ Input bar redesigné - Transitions fluides
// ✅ Empty state animé - Design engageant
// ✅ Accusés de lecture (Vu) - Statuts dynamiques des messages
// ✅ Réactions synchronisées - Chiffrées E2E
//
// DESIGN PRINCIPLES:
// - Telegram-style swipe gestures
// - iMessage-inspired reactions
// - Signal-level attention to detail
// - Modern glassmorphism effects
// - Fluid spring animations
// - Haptic feedback ready

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
  Animated,
  Keyboard,
  Alert,
  Modal,
  Image,
  Pressable,
  useWindowDimensions,
  ScrollView,
  PanResponder,
  Easing,
  LayoutAnimation,
  UIManager,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import Svg, { Path, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { suppressLock, releaseLock } from '../services/lockGuard';
import { useUnifiedMessages, UnifiedMessage, ConversationInfo } from '../hooks/useUnifiedMessages';
import { MessageStatus } from '../services/messageStatus';
import { LocalMessage, getConversation, StoredConversation, getConversationKeys, getMasterKey } from '../services/storage';

// Type alias pour compatibilité avec l'ancien code
type MessageWithStatus = UnifiedMessage;
// v6.1 - Import sessionService pour les changements de profil en temps réel
import { sessionService } from '../services/tripleRatchet';
// v15.0 - Utiliser les nouvelles fonctions média pour Triple Ratchet
import { 
  sendImageMessage1to1, 
  sendFileMessage1to1, 
  sendVoiceMessage1to1,
  base64ToTempUri,
  downloadMediaBlob,
} from '../services/media1to1';
import { 
  getCachedThumbnail, 
  getCachedImage,
  getCachedFile,
  pickFile,
  validateFileSize,
  getFileIcon,
  formatFileSize,
  getMediaPublicUrl,
} from '../services/mediaService';
import {
  initializeVoiceService,
  startRecording,
  stopRecording,
  cancelRecording,
  isRecording as isVoiceRecording,
  playVoice,
  pauseVoice,
  stopVoice,
  seekVoice,
  setPlaybackRate,
  getCurrentPlayingId,
  getCachedVoice,
  getVoicePublicUrl,
  formatVoiceDuration,
  cleanupVoiceService,
  VoiceMessagePayload,
  isRecording as isRecordingActive,
} from '../services/voiceMessageService';
import * as Sharing from 'expo-sharing';
import { resolveImageUri, resolveMediaToBase64, isMediaRef } from '../services/mediaFileStore';
import {
  theme,
  ChatHeader,
  SelectionHeader,
  ActionSheet,
  AlertModal,
} from '../components/ui';
import { generateColorFromToken } from '../services/crypto';
import { InviteModal } from '../components/InviteModal';
import { CallButton1to1 } from '../components/CallButton1to1';
import { useCall1to1 } from '../hooks/useCall1to1';
import { Avatar } from '../components/Avatar';
import {
  isCallMessage,
  getCallPayload,
  formatCallDuration,
  getCallStatusText,
  CallMessagePayload,
} from '../services/callMessages';
import { VoiceRecordButton } from '../components/VoiceRecordButton';
import { useChunkingProgress } from '../hooks/useChunkingProgress';
import {
  MediaProgressOverlay,
  FileProgressBar,
  VoiceProgressBar,
  IncomingMediaPlaceholder,
  SendingProgressLabel,
} from '../components/MediaProgressOverlay';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ============================================
// DESIGN SYSTEM - Modern Premium Dark Theme
// ============================================

const MAX_FILE_SIZE_MB = 20;
const MESSAGE_AVATAR_SIZE = 28;
const SWIPE_THRESHOLD = 60; // Distance to trigger reply
const REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

// Premium Color Palette - ALIGNED WITH GLOBAL THEME (theme.ts)
// v12.1 - Cohérence visuelle avec le reste de l'application
const Colors = {
  // Backgrounds - Alignés avec theme.colors
  bg: {
    primary: '#0A0F14',      // theme.colors.background
    secondary: '#0F161C',    // theme.colors.surface
    tertiary: '#1A252F',     // theme.colors.surfaceLight
    elevated: '#243240',     // theme.colors.surfaceElevated
    hover: 'rgba(139, 164, 184, 0.12)',  // theme.colors.border
    glass: 'rgba(26, 37, 47, 0.85)',     // theme.colors.glass
    glassLight: 'rgba(36, 50, 64, 0.6)', // theme.colors.glassLight
  },
  
  // Message bubbles - Alignés avec theme.colors
  bubble: {
    outgoing: '#005C4B',                 // theme.colors.messageMine
    outgoingGradientStart: '#006D5B',    // theme.colors.messageMineLight
    outgoingGradientEnd: '#004D3F',
    outgoingPressed: '#004A3D',
    incoming: '#1A252F',                 // theme.colors.messageTheirs (surfaceLight)
    incomingGradientStart: '#243240',    // theme.colors.surfaceElevated
    incomingGradientEnd: '#1A252F',      // theme.colors.surfaceLight
    incomingPressed: '#0F161C',          // theme.colors.surface
    reply: 'rgba(0, 217, 166, 0.12)',    // theme.colors.replyBg
    replyBorder: 'rgba(0, 217, 166, 0.4)', // theme.colors.replyBorder
  },
  
  // Accent colors - Alignés avec theme.colors
  accent: {
    primary: '#00D9A6',                  // theme.colors.primary
    primaryMuted: 'rgba(0, 217, 166, 0.15)',
    secondary: '#00B4D8',                // theme.colors.secondary/info
    tertiary: '#00B38A',                 // theme.colors.primaryDark
    warning: '#FFB547',                  // theme.colors.warning
    error: '#FF6B6B',                    // theme.colors.error
    success: '#00D9A6',                  // theme.colors.success
  },
  
  // Text hierarchy - Alignés avec theme.colors
  text: {
    primary: '#F0F4F8',                  // theme.colors.text
    secondary: '#8BA4B8',                // theme.colors.textSecondary
    tertiary: '#5D7485',                 // theme.colors.textMuted
    inverse: '#FFFFFF',
    link: '#00B4D8',                     // theme.colors.info
    onBubbleMine: '#FFFFFF',
    onBubbleTheirs: '#F0F4F8',           // theme.colors.text
    quoted: '#00D9A6',                   // theme.colors.primary
  },
  
  // Status indicators - WhatsApp style
  status: {
    sent: 'rgba(255,255,255,0.5)',       // 1 check gris
    delivered: 'rgba(255,255,255,0.75)', // 2 checks gris  
    read: '#53BDEB',                     // 2 checks BLEU (WhatsApp style)
  },
  
  // UI elements - Alignés avec theme.colors
  ui: {
    border: 'rgba(139, 164, 184, 0.12)', // theme.colors.border
    borderLight: 'rgba(139, 164, 184, 0.06)', // theme.colors.borderLight
    divider: 'rgba(240, 244, 248, 0.06)', // theme.colors.divider
    overlay: 'rgba(10, 15, 20, 0.95)',   // theme.colors.overlay
    shadow: 'rgba(0, 0, 0, 0.4)',
    glow: 'rgba(0, 217, 166, 0.3)',
  },
  
  // Reactions - Alignés avec theme.colors
  reaction: {
    bg: 'rgba(26, 37, 47, 0.95)',        // theme.colors.reactionBg
    border: 'rgba(139, 164, 184, 0.15)', // theme.colors.reactionBorder
    selected: 'rgba(0, 217, 166, 0.2)',  // theme.colors.reactionSelected
  },
};

// Spacing scale (4px base unit)
const Space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  xxxxl: 48,
};

// Typography scale
const Type = {
  size: {
    xs: 11,
    sm: 12,
    md: 14,
    base: 15,
    lg: 16,
    xl: 18,
    xxl: 22,
  },
  weight: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
  lineHeight: {
    tight: 1.2,
    normal: 1.4,
    relaxed: 1.5,
  },
};

// Border radius - Modern bubble design
const Radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 18,
  xl: 22,
  xxl: 24,
  full: 9999,
  bubble: {
    default: 20,
    grouped: 6,
  },
};

// ============================================
// HELPERS
// ============================================

function getDiscriminator(commitment: string | undefined): string {
  if (!commitment || commitment.length < 4) return '????';
  return commitment.substring(0, 4).toUpperCase();
}

function getDisplayNameWithDiscriminator(
  displayName: string | undefined,
  commitment: string | undefined,
  participantsByName: Map<string, string[]>,
): string {
  if (!displayName) return 'Anonyme';
  const sameNameTokens = participantsByName.get(displayName.toLowerCase()) || [];
  if (sameNameTokens.length <= 1) return displayName;
  return `${displayName}#${getDiscriminator(commitment)}`;
}

// ============================================
// TYPES
// ============================================

type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { 
    conversationId: string; 
    conversationName: string;
    searchMode?: boolean; // v21.0: Mode recherche dans la conversation
  };
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Conversation'>;
type ConversationRouteProp = RouteProp<RootStackParamList, 'Conversation'>;

interface ImagePayload {
  type: 'image';
  fileId: string;
  storagePath?: string;
  fileKeyEncrypted: string;
  fileNonce: string;
  thumbKeyEncrypted: string;
  thumbNonce: string;
  metadata: { width: number; height: number; size: number };
}

interface FilePayload {
  type: 'file';
  fileId: string;
  storagePath?: string;
  fileKeyEncrypted: string;
  fileNonce: string;
  metadata: { name: string; size: number; mimeType: string; extension: string };
}

interface ReplyTo {
  id: string;
  content: string;
  senderName: string;
  isMine: boolean;
}

interface MessageReaction {
  emoji: string;
  count: number;
  userReacted: boolean;
}

// ============================================
// ICONS - Premium SVG Icons
// ============================================

const Icons = {
  Send: ({ size = 20, color = Colors.text.inverse }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path 
        d="M22 2L11 13" 
        stroke={color} 
        strokeWidth={2} 
        strokeLinecap="round" 
        strokeLinejoin="round"
      />
      <Path 
        d="M22 2L15 22L11 13L2 9L22 2Z" 
        stroke={color} 
        strokeWidth={2} 
        strokeLinecap="round" 
        strokeLinejoin="round"
        fill={color}
      />
    </Svg>
  ),
  
  Attach: ({ size = 24, color = Colors.text.secondary }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21.44 11.05L12.25 20.24C10.45 22.04 7.51 22.04 5.71 20.24C3.91 18.44 3.91 15.5 5.71 13.7L14.9 4.51C16.04 3.37 17.89 3.37 19.03 4.51C20.17 5.65 20.17 7.5 19.03 8.64L9.84 17.83C9.27 18.4 8.35 18.4 7.78 17.83C7.21 17.26 7.21 16.34 7.78 15.77L16.97 6.58"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  ),
  
  Image: ({ size = 22, color = Colors.text.inverse }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM13.96 12.29L11.21 15.83L9.25 13.47L6.5 17H17.5L13.96 12.29Z" fill={color} />
    </Svg>
  ),
  
  Camera: ({ size = 22, color = Colors.text.inverse }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 15.2C13.7673 15.2 15.2 13.7673 15.2 12C15.2 10.2327 13.7673 8.8 12 8.8C10.2327 8.8 8.8 10.2327 8.8 12C8.8 13.7673 10.2327 15.2 12 15.2Z" fill={color} />
      <Path d="M9 2L7.17 4H4C2.9 4 2 4.9 2 6V18C2 19.1 2.9 20 4 20H20C21.1 20 22 19.1 22 18V6C22 4.9 21.1 4 20 4H16.83L15 2H9ZM12 17C9.24 17 7 14.76 7 12C7 9.24 9.24 7 12 7C14.76 7 17 9.24 17 12C17 14.76 14.76 17 12 17Z" fill={color} />
    </Svg>
  ),
  
  File: ({ size = 22, color = Colors.text.inverse }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.89 22 5.99 22H18C19.1 22 20 21.1 20 20V8L14 2ZM16 18H8V16H16V18ZM16 14H8V12H16V14ZM13 9V3.5L18.5 9H13Z" fill={color} />
    </Svg>
  ),
  
  Mic: ({ size = 24, color = Colors.text.secondary }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M12 14C13.66 14 14.99 12.66 14.99 11L15 5C15 3.34 13.66 2 12 2C10.34 2 9 3.34 9 5V11C9 12.66 10.34 14 12 14ZM17.3 11C17.3 14 14.76 16.1 12 16.1C9.24 16.1 6.7 14 6.7 11H5C5 14.41 7.72 17.23 11 17.72V21H13V17.72C16.28 17.24 19 14.42 19 11H17.3Z" />
    </Svg>
  ),
  
  Close: ({ size = 24, color = Colors.text.primary }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z" />
    </Svg>
  ),
  
  Download: ({ size = 20, color = Colors.text.primary }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M19 9H15V3H9V9H5L12 16L19 9ZM5 18V20H19V18H5Z" />
    </Svg>
  ),
  
  Emoji: ({ size = 24, color = Colors.text.secondary }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="10" stroke={color} strokeWidth={1.8} />
      <Path d="M8 14C8.5 15.5 10 17 12 17C14 17 15.5 15.5 16 14" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Circle cx="9" cy="9.5" r="1.5" fill={color} />
      <Circle cx="15" cy="9.5" r="1.5" fill={color} />
    </Svg>
  ),
  
  Reply: ({ size = 18, color = Colors.accent.primary }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path 
        d="M10 9V5L3 12L10 19V14.9C15 14.9 18.5 16.5 21 20C20 15 17 10 10 9Z" 
        fill={color}
      />
    </Svg>
  ),
  
  DoubleCheck: ({ size = 16, color = Colors.status.sent }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path
        d="M1.5 8.5L4.5 11.5L11 5"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M5.5 8.5L8.5 11.5L15 5"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  ),
  
  SingleCheck: ({ size = 16, color = Colors.status.sent }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path
        d="M3 8L6.5 11.5L13 5"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  ),
  
  Keyboard: ({ size = 24, color = Colors.text.secondary }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M20 5H4C2.9 5 2 5.9 2 7V17C2 18.1 2.9 19 4 19H20C21.1 19 22 18.1 22 17V7C22 5.9 21.1 5 20 5ZM11 8H13V10H11V8ZM11 11H13V13H11V11ZM8 8H10V10H8V8ZM8 11H10V13H8V11ZM7 13H5V11H7V13ZM7 10H5V8H7V10ZM16 17H8V15H16V17ZM16 13H14V11H16V13ZM16 10H14V8H16V10ZM19 13H17V11H19V13ZM19 10H17V8H19V10Z" fill={color} />
    </Svg>
  ),
  
  StatusClock: ({ size = 14, color = Colors.status.sent }: { size?: number; color?: string }) => (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth={1.5} />
      <Path
        d="M8 4.5V8L10.5 9.5"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  ),
};


// ============================================
// MESSAGE STATUS ICON COMPONENT
// ============================================

interface MessageStatusIconProps {
  status: MessageStatus | undefined;
  isMine: boolean;
}

const MessageStatusIcon: React.FC<MessageStatusIconProps> = ({ status, isMine }) => {
  if (!isMine) return null;
  
  switch (status) {
    case 'sending':
      return <Icons.StatusClock size={14} color={Colors.status.sent} />;
    case 'sent':
      return <Icons.SingleCheck size={14} color={Colors.status.sent} />;
    case 'delivered':
      return <Icons.DoubleCheck size={14} color={Colors.status.delivered} />;
    case 'read':
      return <Icons.DoubleCheck size={14} color={Colors.status.read} />;
    case 'failed':
      return <Ionicons name="alert-circle" size={14} color="#E74C3C" />;
    default:
      return <Icons.DoubleCheck size={14} color={Colors.status.read} />;
  }
};

// ============================================
// TYPING INDICATOR COMPONENT
// ============================================

const TypingIndicator: React.FC<{ senderName?: string }> = ({ senderName }) => {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    const animateDots = () => {
      const createDotAnimation = (dot: Animated.Value, delay: number) => {
        return Animated.loop(
          Animated.sequence([
            Animated.delay(delay),
            Animated.timing(dot, {
              toValue: 1,
              duration: 300,
              easing: Easing.bezier(0.4, 0, 0.2, 1),
              useNativeDriver: true,
            }),
            Animated.timing(dot, {
              toValue: 0,
              duration: 300,
              easing: Easing.bezier(0.4, 0, 0.2, 1),
              useNativeDriver: true,
            }),
          ])
        );
      };
      
      Animated.parallel([
        createDotAnimation(dot1, 0),
        createDotAnimation(dot2, 150),
        createDotAnimation(dot3, 300),
      ]).start();
    };
    
    animateDots();
    return () => {
      dot1.setValue(0);
      dot2.setValue(0);
      dot3.setValue(0);
    };
  }, []);
  
  const renderDot = (anim: Animated.Value, index: number) => (
    <Animated.View
      key={index}
      style={[
        styles.typingDot,
        {
          opacity: anim.interpolate({
            inputRange: [0, 1],
            outputRange: [0.4, 1],
          }),
          transform: [{
            translateY: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [0, -4],
            }),
          }],
        },
      ]}
    />
  );
  
  return (
    <View style={styles.typingContainer}>
      <View style={styles.typingBubble}>
        <View style={styles.typingDotsRow}>
          {[dot1, dot2, dot3].map(renderDot)}
        </View>
      </View>
      {senderName && (
        <Text style={styles.typingText}>{senderName} écrit...</Text>
      )}
    </View>
  );
};

// ============================================
// REACTION PICKER COMPONENT - Messenger Style
// ============================================

interface ReactionPickerProps {
  visible: boolean;
  position: { x: number; y: number };
  onSelect: (emoji: string) => void;
  onClose: () => void;
  selectedEmojis?: string[]; // Emojis déjà sélectionnés par l'utilisateur
}

const ReactionPicker: React.FC<ReactionPickerProps> = ({ 
  visible, 
  position, 
  onSelect, 
  onClose,
  selectedEmojis = [],
}) => {
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  
  // Dimensions compactes et responsives
  const EMOJI_SIZE = 36;
  const EMOJI_COUNT = REACTION_EMOJIS.length; // 6
  const HORIZONTAL_PADDING = 8;
  const PICKER_WIDTH = (EMOJI_SIZE * EMOJI_COUNT) + (HORIZONTAL_PADDING * 2);
  const PICKER_HEIGHT = EMOJI_SIZE + 12;
  const SAFE_MARGIN = 16;
  
  // Limites de l'écran (avec safe areas)
  const safeTop = insets.top + SAFE_MARGIN;
  const safeBottom = screenHeight - insets.bottom - SAFE_MARGIN;
  const safeLeft = SAFE_MARGIN;
  const safeRight = screenWidth - SAFE_MARGIN;
  
  // Position X: centrer sur l'écran si le picker est trop large, sinon centrer sur le tap
  let left: number;
  if (PICKER_WIDTH > screenWidth - (SAFE_MARGIN * 2)) {
    // Picker plus large que l'écran disponible: centrer
    left = (screenWidth - PICKER_WIDTH) / 2;
  } else {
    // Centrer sur le tap, mais rester dans les limites
    left = position.x - (PICKER_WIDTH / 2);
    left = Math.max(safeLeft, Math.min(left, safeRight - PICKER_WIDTH));
  }
  
  // Position Y: au-dessus du tap, ou en dessous si pas de place
  let top: number;
  const preferredTop = position.y - PICKER_HEIGHT - 12;
  
  if (preferredTop >= safeTop) {
    top = preferredTop;
  } else {
    // Pas de place en haut, essayer en dessous
    top = position.y + 12;
  }
  
  // Contraindre dans les limites verticales
  top = Math.max(safeTop, Math.min(top, safeBottom - PICKER_HEIGHT));
  
  useEffect(() => {
    if (visible) {
      scaleAnim.setValue(0);
      Animated.spring(scaleAnim, {
        toValue: 1,
        tension: 400,
        friction: 25,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);
  
  if (!visible) return null;
  
  return (
    <Modal transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.reactionOverlay} onPress={onClose}>
        <Animated.View
          style={[
            styles.reactionPicker,
            {
              top,
              left,
              opacity: scaleAnim,
              transform: [{ 
                scale: scaleAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.85, 1],
                })
              }],
            },
          ]}
        >
          {REACTION_EMOJIS.map((emoji) => {
            const isSelected = selectedEmojis.includes(emoji);
            return (
              <TouchableOpacity
                key={emoji}
                style={[
                  styles.reactionPickerEmoji,
                  isSelected && styles.reactionPickerEmojiSelected,
                ]}
                onPress={() => {
                  onSelect(emoji);
                  onClose();
                }}
                activeOpacity={0.7}
              >
                <Text style={[
                  styles.reactionPickerEmojiText,
                  isSelected && styles.reactionPickerEmojiTextSelected,
                ]}>
                  {emoji}
                </Text>
              </TouchableOpacity>
            );
          })}
        </Animated.View>
      </Pressable>
    </Modal>
  );
};

// ============================================
// QUOTED MESSAGE COMPONENT
// ============================================

interface QuotedMessageProps {
  replyTo: ReplyTo;
  onPress?: () => void;
  compact?: boolean;
}

const QuotedMessage: React.FC<QuotedMessageProps> = ({ replyTo, onPress, compact }) => {
  const isImage = replyTo.content.includes('"type":"image"');
  const isFile = replyTo.content.includes('"type":"file"');
  
  const getPreviewContent = () => {
    if (isImage) return '📷 Photo';
    if (isFile) return '📎 Fichier';
    return replyTo.content.length > 50 
      ? replyTo.content.substring(0, 50) + '...' 
      : replyTo.content;
  };
  
  return (
    <TouchableOpacity 
      style={[
        styles.quotedMessage,
        compact && styles.quotedMessageCompact,
        replyTo.isMine && styles.quotedMessageMine,
      ]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <View style={[
        styles.quotedBorder,
        replyTo.isMine && styles.quotedBorderMine,
      ]} />
      <View style={styles.quotedContent}>
        <Text style={[
          styles.quotedSender,
          replyTo.isMine && styles.quotedSenderMine,
        ]}>
          {replyTo.isMine ? 'Vous' : replyTo.senderName}
        </Text>
        <Text style={styles.quotedText} numberOfLines={1}>
          {getPreviewContent()}
        </Text>
      </View>
    </TouchableOpacity>
  );
};

// ============================================
// REPLY INPUT BAR COMPONENT - Fluid Animation
// ============================================

interface ReplyBarProps {
  replyTo: ReplyTo | null;
  onCancel: () => void;
}

const ReplyBar: React.FC<ReplyBarProps> = ({ replyTo, onCancel }) => {
  const slideAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;
  const borderAnim = useRef(new Animated.Value(0)).current;
  const [isVisible, setIsVisible] = useState(false);
  
  useEffect(() => {
    if (replyTo) {
      setIsVisible(true);
      // Staggered entrance animation
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 1,
          tension: 120,
          friction: 14,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 150,
          friction: 12,
          useNativeDriver: true,
        }),
        Animated.timing(borderAnim, {
          toValue: 1,
          duration: 300,
          easing: Easing.out(Easing.ease),
          useNativeDriver: false,
        }),
      ]).start();
    } else {
      // Exit animation
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 200,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 0.95,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(borderAnim, {
          toValue: 0,
          duration: 150,
          useNativeDriver: false,
        }),
      ]).start(() => {
        setIsVisible(false);
      });
    }
  }, [replyTo]);
  
  // Get preview content with media detection
  const getPreviewContent = () => {
    if (!replyTo) return '';
    try {
      const parsed = JSON.parse(replyTo.content);
      if (parsed.type === 'image') return '📷 Photo';
      if (parsed.type === 'file') return `📎 ${parsed.metadata?.name || 'Fichier'}`;
    } catch {}
    return replyTo.content.length > 50 
      ? replyTo.content.substring(0, 50) + '...' 
      : replyTo.content;
  };
  
  if (!isVisible) return null;
  
  const borderColor = borderAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [Colors.ui.borderLight, Colors.accent.primary],
  });
  
  return (
    <Animated.View
      style={[
        styles.replyBar,
        {
          opacity: slideAnim,
          transform: [
            {
              translateY: slideAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [20, 0],
              }),
            },
            { scale: scaleAnim },
          ],
        },
      ]}
    >
      <Animated.View style={[styles.replyBarBorder, { backgroundColor: borderColor }]} />
      
      <View style={styles.replyBarContent}>
        <Animated.View 
          style={[
            styles.replyBarIcon,
            {
              transform: [{
                rotate: slideAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['-45deg', '0deg'],
                }),
              }],
            },
          ]}
        >
          <Icons.Reply size={16} color={Colors.accent.primary} />
        </Animated.View>
        
        <View style={styles.replyBarText}>
          <Text style={styles.replyBarSender}>
            {replyTo?.isMine ? 'Vous' : replyTo?.senderName}
          </Text>
          <Text style={styles.replyBarPreview} numberOfLines={1}>
            {getPreviewContent()}
          </Text>
        </View>
      </View>
      
      <TouchableOpacity 
        style={styles.replyBarClose} 
        onPress={onCancel}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Icons.Close size={18} color={Colors.text.tertiary} />
      </TouchableOpacity>
    </Animated.View>
  );
};

// ============================================
// MESSAGE REACTIONS DISPLAY - Messenger Style
// ============================================

interface ReactionsDisplayProps {
  reactions: MessageReaction[];
  onPress: (event: any) => void;
  isMine: boolean;
}

const ReactionsDisplay: React.FC<ReactionsDisplayProps> = ({ 
  reactions, 
  onPress, 
  isMine 
}) => {
  if (reactions.length === 0) return null;
  
  // Calculer le nombre total de réactions
  const totalCount = reactions.reduce((sum, r) => sum + r.count, 0);
  const hasUserReaction = reactions.some(r => r.userReacted);
  
  return (
    <TouchableOpacity 
      style={[
        styles.reactionsContainer,
        isMine && styles.reactionsContainerMine,
        hasUserReaction && styles.reactionsContainerSelected,
      ]}
      onPress={onPress}
      onLongPress={onPress}
      activeOpacity={0.8}
    >
      {/* Emojis */}
      <View style={styles.reactionsEmojis}>
        {reactions.slice(0, 3).map((reaction, index) => (
          <Text 
            key={index} 
            style={[
              styles.reactionEmoji,
              index > 0 && styles.reactionEmojiOverlap,
            ]}
          >
            {reaction.emoji}
          </Text>
        ))}
      </View>
      {/* Count */}
      {totalCount > 1 && (
        <Text style={styles.reactionsCount}>{totalCount}</Text>
      )}
    </TouchableOpacity>
  );
};

// ============================================
// SWIPEABLE MESSAGE WRAPPER - Ultra Fluid
// ============================================

interface SwipeableMessageProps {
  children: React.ReactNode;
  onSwipeRight: () => void;
  isMine: boolean;
  enabled?: boolean;
}

const SwipeableMessage: React.FC<SwipeableMessageProps> = ({ 
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
        <Icons.Reply size={18} color="#FFFFFF" />
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

// ============================================
// ANIMATED MESSAGE WRAPPER
// ============================================

interface AnimatedMessageProps {
  children: React.ReactNode;
  index: number;
  isMine: boolean;
  isNew?: boolean;
}

const AnimatedMessage: React.FC<AnimatedMessageProps> = ({ children, index, isMine, isNew = false }) => {
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

// ============================================
// EMPTY STATE COMPONENT
// ============================================

const EmptyState: React.FC<{ onInvite: () => void }> = ({ onInvite }) => {
  const iconAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    Animated.parallel([
      Animated.spring(iconAnim, {
        toValue: 1,
        tension: 50,
        friction: 8,
        useNativeDriver: true,
      }),
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 600,
        delay: 200,
        useNativeDriver: true,
      }),
    ]).start();
    
    // Floating animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(iconAnim, {
          toValue: 1.05,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(iconAnim, {
          toValue: 1,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, []);
  
  return (
    <View style={styles.emptyState}>
      <Animated.View
        style={[
          styles.emptyIconWrap,
          {
            transform: [{ scale: iconAnim }],
          },
        ]}
      >
        <View style={styles.emptyIconGlow} />
        <Text style={styles.emptyIcon}>💬</Text>
      </Animated.View>
      
      <Animated.View style={{ opacity: fadeAnim }}>
        <Text style={styles.emptyTitle}>Commencez à discuter</Text>
        <Text style={styles.emptySubtitle}>
          Vos messages sont chiffrés sur votre appareil.{'\n'}
          Personne ne peut les lire, pas même le serveur.
        </Text>
        
        <TouchableOpacity 
          style={styles.emptyBtn} 
          onPress={onInvite}
          activeOpacity={0.8}
        >
          <View style={styles.emptyBtnGlow} />
          <Text style={styles.emptyBtnText}>Inviter quelqu'un</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
};

// ============================================
// MAIN COMPONENT
// ============================================

export function ConversationScreen() {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ConversationRouteProp>();
  const { conversationId, conversationName, searchMode: initialSearchMode } = route.params;
  const insets = useSafeAreaInsets();
  
  // Responsive dimensions
  const { width: screenWidth } = useWindowDimensions();
  const maxBubbleWidth = screenWidth * 0.78;
  const maxImageWidth = screenWidth * 0.68;
  const maxImageHeight = 280;
  
  // State
  const [conversation, setConversation] = useState<StoredConversation | null>(null);
  const [inputText, setInputText] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareMasterKey, setShareMasterKey] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [sendingImage, setSendingImage] = useState(false);
  const [imageProgress, setImageProgress] = useState('');
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{ uri: string; name: string; size: number; mimeType: string } | null>(null);
  const [sendingFile, setSendingFile] = useState(false);
  const [fileProgress, setFileProgress] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  
  // Voice recording state
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingWaveform, setRecordingWaveform] = useState<number[]>([]);
  const [sendingVoice, setSendingVoice] = useState(false);
  const [voiceProgress, setVoiceProgress] = useState('');
  const [recordingLocked, setRecordingLocked] = useState(false);
  
  // Voice playback state (for tracking which voice message is playing)
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [voicePlaybackPosition, setVoicePlaybackPosition] = useState(0);
  const [voicePlaybackDuration, setVoicePlaybackDuration] = useState(0);
  const [isVoicePlaying, setIsVoicePlaying] = useState(false);
  
  // Reply state
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  
  // Reaction state
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [reactionPosition, setReactionPosition] = useState({ x: 0, y: 0 });
  const [reactionMessageId, setReactionMessageId] = useState<string | null>(null);
  
  // Typing indicator state (would be connected to real-time in production)
  const [isTyping, setIsTyping] = useState(false);
  const [typingUser, setTypingUser] = useState<string | null>(null);
  
  // Selection mode
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  
  // v21.0: Search mode
  const [isSearchMode, setIsSearchMode] = useState(initialSearchMode || false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<string[]>([]); // IDs des messages correspondants
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const searchInputRef = React.useRef<TextInput>(null);
  
  // Profile modal state
  const [profileModalVisible, setProfileModalVisible] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<{
    displayName: string;
    senderToken: string;
    avatarBase64?: string;
    color: string;
  } | null>(null);
  
  // Track new messages for animation
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(new Set());
  const prevMessageCount = useRef(0);
  
  // v6.1: Mon avatar actuel (mis à jour en temps réel quand je le change)
  const [myCurrentAvatar, setMyCurrentAvatar] = useState<string | undefined>(
    () => sessionService.getMyProfile().avatarBase64
  );
  
  // v6.1: S'abonner aux changements de profil pour mettre à jour l'avatar en temps réel
  useEffect(() => {
    const unsubscribe = sessionService.onProfileChange((profile) => {
      console.log('[ConversationScreen] 🖼️ Profile changed, updating myCurrentAvatar');
      setMyCurrentAvatar(profile.avatarBase64);
    });
    
    return () => {
      unsubscribe();
    };
  }, []);
  
  // Refs
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);
  
  // Animations
  const attachMenuAnim = useRef(new Animated.Value(0)).current;
  const sendButtonScale = useRef(new Animated.Value(1)).current;
  const inputFocusAnim = useRef(new Animated.Value(0)).current;
  const emojiPickerAnim = useRef(new Animated.Value(0)).current;
  
  // Voice recording animations
  const recordingAnim = useRef(new Animated.Value(0)).current;
  const recordingPulse = useRef(new Animated.Value(1)).current;
  const recordingSlideX = useRef(new Animated.Value(0)).current;
  
  // FIX: Détection de fin d'appel pour Android.
  // Sur Android, quand le <Modal> d'appel se ferme, le TextInput natif
  // peut perdre son contenu (bug React Native connu). De plus,
  // cleanupAudio() remet le mode audio en "lecture seule" ce qui casse
  // le mode "prêt à enregistrer" configuré par initializeVoiceService().
  const { isInCall } = useCall1to1();
  const wasInCallRef = useRef(false);
  const draftTextRef = useRef('');
  
  // FIX: Cooldown anti-touch-fantôme.
  // Quand le Modal d'appel se ferme, Android propage un touch event
  // au VoiceRecordButton qui se trouve dessous → démarre un enregistrement.
  // Ce timestamp bloque handleStartRecording pendant 1s après la fin d'un appel.
  const callEndedAtRef = useRef(0);
  const [voiceDisabledByCall, setVoiceDisabledByCall] = useState(false);

  // FIX: Ne plus sauvegarder le draft en continu. L'ancien useEffect sauvegardait
  // à chaque changement de inputText, ce qui signifie que si l'utilisateur tapait
  // "salut", envoyait (input vidé), puis faisait un appel, draftTextRef contenait
  // encore "salut" et le restaurait à tort après l'appel.
  // On capture maintenant UNIQUEMENT au moment d'entrer dans un appel.

  // Quand un appel démarre OU se termine → gérer le draft
  useEffect(() => {
    if (!wasInCallRef.current && isInCall) {
      // Transition → ENTRÉ en appel : capturer le texte actuel
      draftTextRef.current = inputText;
      __DEV__ && console.log('[ConversationScreen] 📞 Call started, saved draft:', inputText.substring(0, 20) || '(empty)');
    } else if (wasInCallRef.current && !isInCall) {
      __DEV__ && console.log('[ConversationScreen] 📞→✅ Call ended, restoring input state');

      // FIX: Marquer le timestamp de fin d'appel pour bloquer les phantom touches
      callEndedAtRef.current = Date.now();
      setVoiceDisabledByCall(true);
      // Auto-réactiver après 1s
      setTimeout(() => setVoiceDisabledByCall(false), 1000);

      // 1. Restaurer le texte perdu par le dismiss du Modal Android
      if (draftTextRef.current && inputText === '') {
        __DEV__ && console.log('[ConversationScreen] Restoring draft text:', draftTextRef.current.substring(0, 20));
        setInputText(draftTextRef.current);
      }
      // Nettoyer le draft pour ne pas le restaurer à tort lors d'un prochain appel
      draftTextRef.current = '';

      // 2. Force-cancel tout enregistrement qui pourrait traîner
      // (cas: l'user enregistrait un vocal quand un appel entrant est arrivé)
      cancelRecording().catch(() => {});
      setIsRecordingVoice(false);
      setRecordingLocked(false);

      // 3. Re-initialiser le service vocal (remet le mode audio en lecture seule).
      initializeVoiceService();
    }
    wasInCallRef.current = isInCall;
  }, [isInCall]);

  // Keyboard handling
  const keyboardHeight = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onKeyboardShow = (event: any) => {
      const height = event.endCoordinates.height;
      const adjustedHeight = Platform.OS === 'ios' 
        ? height - insets.bottom 
        : height;

      Animated.timing(keyboardHeight, {
        toValue: Math.max(0, adjustedHeight),
        duration: Platform.OS === 'ios' ? event.duration : 250,
        useNativeDriver: false,
      }).start();
    };

    const onKeyboardHide = () => {
      Animated.timing(keyboardHeight, {
        toValue: 0,
        duration: 250,
        useNativeDriver: false,
      }).start();
    };

    const showSub = Keyboard.addListener(showEvent, onKeyboardShow);
    const hideSub = Keyboard.addListener(hideEvent, onKeyboardHide);

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [insets.bottom]);
  
  
  const {
    messages,
    loading,
    sending,
    sendMessage: sendMessageHook,
    sendImage: sendImageHook,
    sendFile: sendFileHook,
    sendVoice: sendVoiceHook,
    addMessage,
    updateMessage,
    deleteMessages,
    deleteAllMessages,
    toggleReaction,
    markAsRead,
    retryMessage,
    deleteFailedMessage,
    conversationInfo,
  } = useUnifiedMessages(conversationId);
  
  // v25.0: Progression du media chunking (envoi/réception)
  const { getSendProgress, receiveEntries, hasActiveTransfers } = useChunkingProgress(conversationId);
  
  
  // Track new messages for animation
  useEffect(() => {
    if (!messages || !Array.isArray(messages)) return;
    if (messages.length > prevMessageCount.current) {
      const newIds = new Set<string>();
      for (let i = prevMessageCount.current; i < messages.length; i++) {
        if (messages[i]) {
          newIds.add(messages[i].id);
        }
      }
      setNewMessageIds(prev => new Set([...prev, ...newIds]));
      
      setTimeout(() => {
        setNewMessageIds(new Set());
      }, 500);
    }
    prevMessageCount.current = messages.length;
  }, [messages]);

  // v21.0: Recherche dans les messages
  useEffect(() => {
    if (!searchQuery.trim() || !messages || !Array.isArray(messages)) {
      setSearchResults([]);
      setCurrentSearchIndex(0);
      return;
    }
    
    const query = searchQuery.toLowerCase().trim();
    const results = messages
      .filter(msg => msg.content && msg.content.toLowerCase().includes(query))
      .map(msg => msg.id)
      .reverse(); // Plus récents d'abord
    
    setSearchResults(results);
    setCurrentSearchIndex(0);
    
    // Scroller vers le premier résultat
    if (results.length > 0 && flatListRef.current) {
      const firstResultIndex = messages.findIndex(m => m.id === results[0]);
      if (firstResultIndex >= 0) {
        try {
          flatListRef.current.scrollToIndex({ 
            index: firstResultIndex, 
            animated: true,
            viewPosition: 0.5 
          });
        } catch (error) {
          console.warn('[ConversationScreen] Initial scroll failed:', error);
        }
      }
    }
  }, [searchQuery, messages]);

  // v21.0: Focus sur l'input de recherche au montage en mode recherche
  useEffect(() => {
    if (initialSearchMode && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 300);
    }
  }, [initialSearchMode]);

  // v21.0: Naviguer vers le résultat de recherche courant
  const scrollToSearchResult = useCallback((index: number) => {
    if (!searchResults.length || !flatListRef.current || !messages) return;
    
    const resultId = searchResults[index];
    const messageIndex = messages.findIndex(m => m.id === resultId);
    
    if (messageIndex >= 0) {
      try {
        flatListRef.current.scrollToIndex({ 
          index: messageIndex, 
          animated: true,
          viewPosition: 0.5 
        });
      } catch (error) {
        console.warn('[ConversationScreen] scrollToIndex failed:', error);
      }
    }
  }, [searchResults, messages]);

  const handleNextSearchResult = useCallback(() => {
    if (!searchResults.length) return;
    const newIndex = (currentSearchIndex + 1) % searchResults.length;
    setCurrentSearchIndex(newIndex);
    scrollToSearchResult(newIndex);
  }, [currentSearchIndex, searchResults, scrollToSearchResult]);

  const handlePrevSearchResult = useCallback(() => {
    if (!searchResults.length) return;
    const newIndex = (currentSearchIndex - 1 + searchResults.length) % searchResults.length;
    setCurrentSearchIndex(newIndex);
    scrollToSearchResult(newIndex);
  }, [currentSearchIndex, searchResults, scrollToSearchResult]);

  const closeSearch = useCallback(() => {
    setIsSearchMode(false);
    setSearchQuery('');
    setSearchResults([]);
    setCurrentSearchIndex(0);
  }, []);
  
  // Participants map for disambiguation
  const participantsByName = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!messages || !Array.isArray(messages)) return map;
    for (const msg of messages) {
      if (msg.isMine || !msg.displayName) continue;
      const nameLower = msg.displayName.toLowerCase();
      const tokens = map.get(nameLower) || [];
      if (!tokens.includes(msg.senderToken)) {
        tokens.push(msg.senderToken);
        map.set(nameLower, tokens);
      }
    }
    return map;
  }, [messages]);

  // Mapping senderToken → dernier avatar connu
  // Permet d'afficher le même avatar pour tous les messages d'un utilisateur
  const latestAvatarByUser = useMemo(() => {
    const map = new Map<string, string>();
    if (!messages || !Array.isArray(messages)) return map;
    // Parcourir du plus ancien au plus récent pour que le dernier avatar écrase les précédents
    for (const msg of messages) {
      if (msg.avatarBase64 && msg.senderToken) {
        map.set(msg.senderToken, msg.avatarBase64);
      }
    }
    return map;
  }, [messages]);

  // Helper pour obtenir l'avatar d'un message (utilise le dernier connu)
  // v6.1: Pour mes propres messages, utiliser mon avatar actuel (pas celui stocké dans le message)
  const getAvatarForMessage = useCallback((msg: LocalMessage): string | undefined => {
    // v6.1: Si c'est mon message, utiliser mon avatar actuel (permet mise à jour temps réel)
    if (msg.isMine) {
      return myCurrentAvatar;
    }
    // Pour les autres, priorité : avatar du mapping (le plus récent), sinon l'avatar du message,
    // sinon le profil de session (fallback nécessaire car avatar-on-change strip l'avatar de 99% des messages)
    return latestAvatarByUser.get(msg.senderToken) || msg.avatarBase64 || conversationInfo?.avatarBase64;
  }, [latestAvatarByUser, myCurrentAvatar, conversationInfo]);

  // Effects
  useEffect(() => {
    getConversation(conversationId).then(setConversation);
  }, [conversationId]);


  useEffect(() => {
    // v21.0: Ne pas scrollToEnd automatiquement en mode recherche
    if (messages && Array.isArray(messages) && messages.length > 0 && !isSelectionMode && !isSearchMode) {
      const timer = setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [messages, isSelectionMode, isSearchMode]);

  // Ref pour tracker les messages déjà marqués comme lus
  const markedAsReadRef = useRef<Set<string>>(new Set());

  // v15.0: Marquer automatiquement les messages reçus comme lus
  useEffect(() => {
    if (!messages || !Array.isArray(messages) || messages.length === 0) return;
    if (!markAsRead) return;
    
    // Trouver les messages de l'autre personne qu'on n'a pas encore marqués comme lus
    const unreadMessageIds = messages
      .filter(msg => !msg.isMine && !markedAsReadRef.current.has(msg.id))
      .map(msg => msg.id);
    
    if (unreadMessageIds.length > 0) {
      console.log(`[ConversationScreen] 📬 Marking ${unreadMessageIds.length} messages as read`);
      
      // Marquer comme traités immédiatement pour éviter les doublons
      unreadMessageIds.forEach(id => markedAsReadRef.current.add(id));
      
      // Envoyer l'accusé de lecture avec un petit délai
      const timer = setTimeout(() => {
        markAsRead(unreadMessageIds)
          .then(success => {
            if (success) {
              console.log(`[ConversationScreen] ✅ Read receipts sent for ${unreadMessageIds.length} messages`);
            } else {
              console.warn('[ConversationScreen] ⚠️ Failed to send read receipts');
              // Retirer des traités pour réessayer plus tard
              unreadMessageIds.forEach(id => markedAsReadRef.current.delete(id));
            }
          })
          .catch(err => {
            console.warn('[ConversationScreen] ❌ Read receipt error:', err);
            unreadMessageIds.forEach(id => markedAsReadRef.current.delete(id));
          });
      }, 500);
      
      return () => clearTimeout(timer);
    }
  }, [messages, markAsRead]);

  useEffect(() => {
    Animated.spring(attachMenuAnim, {
      toValue: showAttachMenu ? 1 : 0,
      useNativeDriver: true,
      tension: 80,
      friction: 12,
    }).start();
  }, [showAttachMenu]);

  useEffect(() => {
    Animated.spring(emojiPickerAnim, {
      toValue: showEmojiPicker ? 1 : 0,
      useNativeDriver: true,
      tension: 80,
      friction: 12,
    }).start();
  }, [showEmojiPicker]);

  // Initialize voice service
  useEffect(() => {
    initializeVoiceService();
    return () => {
      cleanupVoiceService();
    };
  }, []);

  // Recording animation
  useEffect(() => {
    if (isRecordingVoice) {
      // Fade in recording UI
      Animated.spring(recordingAnim, {
        toValue: 1,
        useNativeDriver: true,
        tension: 80,
        friction: 12,
      }).start();

      // Pulsing animation for the record button
      const pulseAnimation = Animated.loop(
        Animated.sequence([
          Animated.timing(recordingPulse, {
            toValue: 1.2,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(recordingPulse, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      );
      pulseAnimation.start();

      return () => {
        pulseAnimation.stop();
      };
    } else {
      Animated.spring(recordingAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 80,
        friction: 12,
      }).start();
      recordingPulse.setValue(1);
    }
  }, [isRecordingVoice]);

  // Helpers
  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString('fr-FR', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
  };

  const formatDateSeparator = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (date.toDateString() === now.toDateString()) return "Aujourd'hui";
    if (date.toDateString() === yesterday.toDateString()) return 'Hier';
    
    return date.toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  };

  const shouldShowDateSeparator = (index: number): boolean => {
    if (!messages || !Array.isArray(messages) || messages.length === 0) return false;
    if (index === 0) return true;
    if (index >= messages.length) return false;
    const currentDate = new Date(messages[index].timestamp).toDateString();
    const prevDate = new Date(messages[index - 1].timestamp).toDateString();
    return currentDate !== prevDate;
  };

  // v21.0: Fonction pour rendre le texte avec surlignage des résultats de recherche
  const renderHighlightedText = (text: string, isMine: boolean): React.ReactNode => {
    if (!isSearchMode || !searchQuery.trim() || !text) {
      return text;
    }
    
    const query = searchQuery.toLowerCase();
    const lowerText = text.toLowerCase();
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let matchIndex = lowerText.indexOf(query, lastIndex);
    let keyIndex = 0;
    
    while (matchIndex !== -1) {
      // Texte avant le match
      if (matchIndex > lastIndex) {
        parts.push(
          <Text key={`text-${keyIndex++}`}>
            {text.slice(lastIndex, matchIndex)}
          </Text>
        );
      }
      
      // Le match surligné
      parts.push(
        <Text 
          key={`highlight-${keyIndex++}`} 
          style={[
            styles.searchHighlightText,
            isMine ? styles.searchHighlightTextMine : styles.searchHighlightTextTheirs,
          ]}
        >
          {text.slice(matchIndex, matchIndex + query.length)}
        </Text>
      );
      
      lastIndex = matchIndex + query.length;
      matchIndex = lowerText.indexOf(query, lastIndex);
    }
    
    // Texte restant après le dernier match
    if (lastIndex < text.length) {
      parts.push(
        <Text key={`text-${keyIndex++}`}>
          {text.slice(lastIndex)}
        </Text>
      );
    }
    
    return parts.length > 0 ? parts : text;
  };

  // v21.0: Vérifier si un message est le résultat de recherche actuellement sélectionné
  const isCurrentSearchResult = (messageId: string): boolean => {
    if (!isSearchMode || !searchResults.length) return false;
    return searchResults[currentSearchIndex] === messageId;
  };

  // v21.0: Vérifier si un message fait partie des résultats de recherche
  const isSearchResult = (messageId: string): boolean => {
    if (!isSearchMode || !searchResults.length) return false;
    return searchResults.includes(messageId);
  };

  // v16.0: Fonctions de détection de type de message
  // Support de l'ancien système (content JSON) ET du nouveau système 1-à-1 (messageType + données inline)
  // v16.0: Fonctions de détection de type de message
  // Support du système unifié (messageType + données inline)
  const isImageMessage = (item: MessageWithStatus): boolean => {
    // v26.0: messageType seul suffit — les blob refs n'ont pas d'imageData,
    // les mfs:// refs sont résolues async. Le rendering gère les 3 cas:
    //   1. imageData present → InlineImageBubble
    //   2. blobId+blobKey present → BlobMediaPlaceholder (download on tap)
    //   3. Legacy JSON content → ancien système
    if (item.messageType === 'image') return true;
    // Ancien système: content JSON
    try { return JSON.parse(item.content).type === 'image'; } catch { return false; }
  };

  const isFileMessage = (item: MessageWithStatus): boolean => {
    if (item.messageType === 'file') return true;
    try { return JSON.parse(item.content).type === 'file'; } catch { return false; }
  };

  const isVoiceMessage = (item: MessageWithStatus): boolean => {
    if (item.messageType === 'voice') return true;
    try { return JSON.parse(item.content).type === 'voice'; } catch { return false; }
  };

  const getImagePayload = (item: MessageWithStatus): ImagePayload | null => {
    // Pour l'ancien système uniquement
    try { return JSON.parse(item.content); } catch { return null; }
  };

  const getFilePayload = (item: MessageWithStatus): FilePayload | null => {
    try { return JSON.parse(item.content); } catch { return null; }
  };

  const getVoicePayload = (item: MessageWithStatus): VoiceMessagePayload | null => {
    try { return JSON.parse(item.content); } catch { return null; }
  };

  // Actions
  const handleSend = async () => {
    if (!inputText.trim() || sending) return;
    
    Animated.sequence([
      Animated.timing(sendButtonScale, { toValue: 0.85, duration: 80, useNativeDriver: true }),
      Animated.spring(sendButtonScale, { toValue: 1, tension: 400, friction: 12, useNativeDriver: true }),
    ]).start();
    
    const textToSend = inputText.trim();
    setInputText('');
    
    // Préparer le reply si présent
    const replyData = replyTo ? {
      id: replyTo.id,
      content: replyTo.content,
      sender: replyTo.senderName,
    } : undefined;
    
    setReplyTo(null); // Clear reply
    
    const success = await sendMessageHook(textToSend, replyData);
    if (!success) {
      Alert.alert('Erreur', 'Impossible d\'envoyer le message');
    }
  };

  const handleReply = (message: LocalMessage) => {
    setReplyTo({
      id: message.id,
      content: message.content,
      senderName: message.displayName || 'Anonyme',
      isMine: message.isMine,
    });
    inputRef.current?.focus();
  };

  const handleReaction = async (messageId: string, emoji: string) => {
    setShowReactionPicker(false);
    await toggleReaction(messageId, emoji);
  };

  const handleLongPressMessage = (messageId: string, event: any) => {
    setReactionMessageId(messageId);
    setReactionPosition({ 
      x: event.nativeEvent.pageX, 
      y: event.nativeEvent.pageY 
    });
    setShowReactionPicker(true);
  };

  const handleInputFocus = () => {
    setShowAttachMenu(false);
    setShowEmojiPicker(false);
    Animated.timing(inputFocusAnim, {
      toValue: 1,
      duration: 200,
      useNativeDriver: false,
    }).start();
  };
  
  const handleInputBlur = () => {
    Animated.timing(inputFocusAnim, {
      toValue: 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  };

  const toggleAttachMenu = () => {
    Keyboard.dismiss();
    setShowEmojiPicker(false);
    setShowAttachMenu(!showAttachMenu);
  };

  const toggleEmojiPicker = () => {
    if (showEmojiPicker) {
      setShowEmojiPicker(false);
      inputRef.current?.focus();
    } else {
      Keyboard.dismiss();
      setShowAttachMenu(false);
      setShowEmojiPicker(true);
    }
  };

  const handleEmojiSelect = (emoji: string) => {
    setInputText(prev => prev + emoji);
  };

  const handleCameraPress = async () => {
    setShowEmojiPicker(false);
    setShowAttachMenu(false);
    suppressLock();
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'Ghostr a besoin d\'accéder à votre caméra.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      if (!result.canceled && result.assets[0]) {
        setSelectedImage(result.assets[0].uri);
      }
    } catch (error) {
      Alert.alert('Erreur', 'Impossible de prendre la photo.');
    } finally {
      releaseLock();
    }
  };

  const handlePickGallery = async () => {
    setShowAttachMenu(false);
    suppressLock();
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'Ghostr a besoin d\'accéder à votre galerie.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        setSelectedImage(result.assets[0].uri);
      }
    } catch (error) {
      Alert.alert('Erreur', 'Impossible de sélectionner l\'image.');
    } finally {
      releaseLock();
    }
  };

  const handlePickCamera = async () => {
    setShowAttachMenu(false);
    suppressLock();
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'Ghostr a besoin d\'accéder à votre caméra.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      if (!result.canceled && result.assets[0]) {
        setSelectedImage(result.assets[0].uri);
      }
    } catch (error) {
      Alert.alert('Erreur', 'Impossible de prendre la photo.');
    } finally {
      releaseLock();
    }
  };

  const handlePickFile = async () => {
    setShowAttachMenu(false);
    suppressLock();
    try {
      const file = await pickFile();
      if (file) {
        // validateFileSize est async - il faut await!
        const validation = await validateFileSize(file.size);
        if (!validation.valid) {
          Alert.alert('Fichier trop volumineux', validation.error || 'Le fichier dépasse la limite autorisée.');
          return;
        }
        setSelectedFile(file);
      }
    } catch (error) {
      Alert.alert('Erreur', 'Impossible de sélectionner le fichier.');
    } finally {
      releaseLock();
    }
  };

  const handleSendImage = async () => {
    if (!selectedImage || sendingImage) return;
    
    // v26.1: Fermer le modal IMMÉDIATEMENT — l'image apparaît dans la conversation
    // avec un spinner pendant l'upload (comme WhatsApp/Signal)
    const imageToSend = selectedImage;
    setSelectedImage(null);
    setSendingImage(false);
    setImageProgress('');
    
    // L'envoi optimiste ajoute un temp message et lance l'upload en background
    sendImageHook(imageToSend);
    
    // Scroll vers le bas pour voir le nouveau message
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 150);
  };

  const handleSendFile = async () => {
    if (!selectedFile || sendingFile) return;
    
    // v26.1: Fermer le modal IMMÉDIATEMENT
    const fileToSend = { ...selectedFile };
    setSelectedFile(null);
    setSendingFile(false);
    setFileProgress('');
    
    sendFileHook(
      fileToSend.uri,
      fileToSend.name,
      fileToSend.size,
      fileToSend.mimeType
    );
    
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 150);
  };

  // ============================================
  // VOICE RECORDING HANDLERS
  // ============================================

  const handleStartRecording = async (): Promise<boolean> => {
    // FIX: Bloquer les phantom touches Android après fermeture du Modal d'appel.
    // Quand le <Modal> d'appel disparaît, Android peut propager un touch au
    // VoiceRecordButton situé en dessous. Ce guard rejette l'événement.
    const msSinceCallEnded = Date.now() - callEndedAtRef.current;
    if (msSinceCallEnded < 1000) {
      __DEV__ && console.log('[ConversationScreen] 🛡️ Blocked phantom recording start (call ended', msSinceCallEnded, 'ms ago)');
      return false;
    }

    // Fermer les menus
    setShowAttachMenu(false);
    setShowEmojiPicker(false);
    Keyboard.dismiss();

    const success = await startRecording((duration, waveform) => {
      setRecordingDuration(duration);
      setRecordingWaveform(waveform);
    });

    if (success) {
      setIsRecordingVoice(true);
      setRecordingLocked(false);
      return true;
    } else {
      Alert.alert('Erreur', 'Impossible de démarrer l\'enregistrement. Vérifiez les permissions du microphone.');
      return false;
    }
  };

  const handleStopRecording = async () => {
    // Vérifier l'état réel de l'enregistrement (pas seulement le state React)
    if (!isRecordingVoice && !isRecordingActive()) return;

    const result = await stopRecording();
    setIsRecordingVoice(false);
    setRecordingLocked(false);

    if (!result) {
      setRecordingDuration(0);
      setRecordingWaveform([]);
      return;
    }

    // Envoyer le vocal si durée > 1 seconde
    if (result.duration < 1000) {
      Alert.alert('Message trop court', 'L\'enregistrement doit durer au moins 1 seconde.');
      setRecordingDuration(0);
      setRecordingWaveform([]);
      return;
    }

    // Envoyer le vocal
    await handleSendVoice(result.uri, result.duration, result.waveform);
    setRecordingDuration(0);
    setRecordingWaveform([]);
  };

  const handleCancelRecording = async () => {
    await cancelRecording();
    setIsRecordingVoice(false);
    setRecordingLocked(false);
    setRecordingDuration(0);
    setRecordingWaveform([]);
  };

  const handleLockRecording = () => {
    setRecordingLocked(true);
  };

  const handleSendVoice = async (uri: string, duration: number, waveform: number[]) => {
    if (sendingVoice) return;
    
    setSendingVoice(true);
    setVoiceProgress('Envoi...');
    
    try {
      const success = await sendVoiceHook(uri, duration, waveform);

      if (!success) throw new Error('Échec de l\'envoi du message vocal');

      // Scroll vers le bas
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 150);

    } catch (error: any) {
      Alert.alert('Erreur', error.message || 'Impossible d\'envoyer le message vocal.');
    } finally {
      setSendingVoice(false);
      setVoiceProgress('');
    }
  };

  // Voice playback handler
  const handlePlayVoice = async (
    voiceId: string,
    payload: VoiceMessagePayload
  ) => {
    try {
      // Si c'est le même vocal, toggle play/pause ou rejouer
      if (playingVoiceId === voiceId) {
        if (isVoicePlaying) {
          // En cours de lecture -> pause
          await pauseVoice();
          setIsVoicePlaying(false);
        } else {
          // En pause ou terminé -> reprendre/rejouer
          const keys = await getConversationKeys(conversationId);
          if (!keys) return;
          
          const storagePath = payload.storagePath || conversationId;
          const voiceUrl = getVoicePublicUrl(storagePath, payload.fileId);
          
          const localUri = await getCachedVoice(
            payload.fileId,
            voiceUrl,
            payload.fileKeyEncrypted,
            payload.fileNonce,
            keys.e2eKey
          );

          await playVoice(voiceId, localUri, (position, duration, playing) => {
            setVoicePlaybackPosition(position);
            setVoicePlaybackDuration(duration);
            setIsVoicePlaying(playing);
            
            // NE PAS réinitialiser playingVoiceId quand la lecture se termine
            // Cela permet de cliquer à nouveau pour rejouer
          });
          setIsVoicePlaying(true);
        }
        return;
      }

      // Arrêter le vocal précédent si différent
      if (playingVoiceId) {
        await stopVoice();
        setPlayingVoiceId(null);
      }

      // Charger et jouer le nouveau vocal
      setPlayingVoiceId(voiceId);
      setVoicePlaybackPosition(0);
      setVoicePlaybackDuration(payload.metadata.duration);
      setIsVoicePlaying(true);

      const keys = await getConversationKeys(conversationId);
      if (!keys) {
        setPlayingVoiceId(null);
        setIsVoicePlaying(false);
        return;
      }

      const storagePath = payload.storagePath || conversationId;
      const voiceUrl = getVoicePublicUrl(storagePath, payload.fileId);

      const localUri = await getCachedVoice(
        payload.fileId,
        voiceUrl,
        payload.fileKeyEncrypted,
        payload.fileNonce,
        keys.e2eKey
      );

      await playVoice(voiceId, localUri, (position, duration, playing) => {
        setVoicePlaybackPosition(position);
        setVoicePlaybackDuration(duration);
        setIsVoicePlaying(playing);
        
        // NE PAS réinitialiser playingVoiceId quand la lecture se termine
        // Cela permet de cliquer à nouveau pour rejouer
      });
    } catch (error) {
      console.error('Error playing voice:', error);
      Alert.alert('Erreur', 'Impossible de lire le message vocal.');
      setPlayingVoiceId(null);
      setIsVoicePlaying(false);
    }
  };

  const handleLongPress = (messageId: string) => {
    if (!isSelectionMode) {
      setIsSelectionMode(true);
      setSelectedIds(new Set([messageId]));
    }
  };

  const toggleMessageSelection = (messageId: string) => {
    const newSelection = new Set(selectedIds);
    if (newSelection.has(messageId)) {
      newSelection.delete(messageId);
      if (newSelection.size === 0) setIsSelectionMode(false);
    } else {
      newSelection.add(messageId);
    }
    setSelectedIds(newSelection);
  };

  const exitSelectionMode = () => {
    setIsSelectionMode(false);
    setSelectedIds(new Set());
  };

  const handleDeleteSelected = async () => {
    setDeleteLoading(true);
    try {
      const success = await deleteMessages(Array.from(selectedIds));
      if (success) {
        exitSelectionMode();
      } else {
        Alert.alert('Erreur', 'Échec de la suppression');
      }
    } finally {
      setDeleteLoading(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleDeleteAll = async () => {
    setDeleteLoading(true);
    try {
      const success = await deleteAllMessages();
      if (!success) {
        Alert.alert('Erreur', 'Échec de la suppression');
      }
    } finally {
      setDeleteLoading(false);
      setShowDeleteAllConfirm(false);
    }
  };

  const handleOpenShare = async () => {
    try {
      const masterKey = await getMasterKey(conversationId);
      if (masterKey) {
        setShareMasterKey(masterKey);
        setShowShareModal(true);
      } else {
        Alert.alert('Erreur', 'Impossible de récupérer la clé.');
      }
    } catch (error) {
      Alert.alert('Erreur', 'Impossible de récupérer la clé.');
    }
  };

  // ============================================
  // IMAGE MESSAGE BUBBLE
  // ============================================
  
  const ImageMessageBubble: React.FC<{ 
    payload: ImagePayload; 
    isMine: boolean;
    isFirstOfGroup: boolean;
    isLastOfGroup: boolean;
    timestamp: number;
    status?: MessageStatus;
  }> = ({ payload, isMine, isFirstOfGroup, isLastOfGroup, timestamp, status }) => {
    const [thumbnail, setThumbnail] = useState<string | null>(null);
    const [loadingThumb, setLoadingThumb] = useState(true);
    const [error, setError] = useState(false);
    
    useEffect(() => { loadThumbnail(); }, []);
    
    const loadThumbnail = async () => {
      try {
        const keys = await getConversationKeys(conversationId);
        if (!keys) throw new Error('Clés non trouvées');
        const storagePath = payload.storagePath || conversationId;
        // Construire l'URL publique pour la miniature
        const thumbUrl = getMediaPublicUrl(storagePath, payload.fileId, '_thumb');
        const cached = await getCachedThumbnail(
          payload.fileId,           // fileId pour le cache
          thumbUrl,                 // URL publique
          payload.thumbKeyEncrypted, // clé chiffrée
          payload.thumbNonce,        // nonce
          keys.e2eKey               // clé E2E pour déchiffrer
        );
        if (cached) setThumbnail(cached);
        else setError(true);
      } catch (e) {
        console.error('❌ loadThumbnail error:', e);
        setError(true);
      } finally {
        setLoadingThumb(false);
      }
    };
    
    const handlePress = async () => {
      try {
        const keys = await getConversationKeys(conversationId);
        if (!keys) return;
        const storagePath = payload.storagePath || conversationId;
        // Construire l'URL publique pour l'image complète
        const imageUrl = getMediaPublicUrl(storagePath, payload.fileId, '');
        const fullImage = await getCachedImage(
          payload.fileId,          // fileId pour le cache
          imageUrl,                // URL publique
          payload.fileKeyEncrypted, // clé chiffrée
          payload.fileNonce,        // nonce
          keys.e2eKey              // clé E2E pour déchiffrer
        );
        if (fullImage) setViewerImage(fullImage);
      } catch (e) {
        console.error('❌ handlePress (image) error:', e);
        Alert.alert('Erreur', 'Impossible de charger l\'image.');
      }
    };
    
    const { width: imgWidth, height: imgHeight } = payload.metadata;
    const aspectRatio = imgWidth / imgHeight;
    let displayWidth = Math.min(maxImageWidth, imgWidth);
    let displayHeight = displayWidth / aspectRatio;
    if (displayHeight > maxImageHeight) {
      displayHeight = maxImageHeight;
      displayWidth = displayHeight * aspectRatio;
    }
    
    const getBorderRadius = () => {
      const r = Radius.bubble.default;
      const g = Radius.bubble.grouped;
      
      if (isMine) {
        return {
          borderTopLeftRadius: r,
          borderTopRightRadius: isFirstOfGroup ? r : g,
          borderBottomLeftRadius: r,
          borderBottomRightRadius: isLastOfGroup ? r : g,
        };
      }
      return {
        borderTopLeftRadius: isFirstOfGroup ? r : g,
        borderTopRightRadius: r,
        borderBottomLeftRadius: isLastOfGroup ? r : g,
        borderBottomRightRadius: r,
      };
    };
    
    return (
      <TouchableOpacity onPress={handlePress} activeOpacity={0.9} disabled={loadingThumb || error}>
        <View style={[
          styles.imageBubble, 
          { width: displayWidth, height: displayHeight }, 
          getBorderRadius(),
        ]}>
          {loadingThumb ? (
            <ActivityIndicator size="small" color={Colors.accent.primary} />
          ) : error ? (
            <View style={styles.imageError}>
              <Text style={styles.imageErrorIcon}>🖼️</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={loadThumbnail}>
                <Text style={styles.retryText}>Réessayer</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Image source={{ uri: thumbnail! }} style={styles.thumbnailImage} resizeMode="cover" />
              <View style={styles.imageMetaGradient}>
                <View style={styles.imageMetaRow}>
                  <Text style={styles.imageMetaText}>{formatTime(timestamp)}</Text>
                  {isMine && (
                    <View style={styles.imageMetaCheck}>
                      {status === 'sending' && <Icons.StatusClock size={14} color="rgba(255,255,255,0.7)" />}
                      {status === 'sent' && <Icons.SingleCheck size={14} color="rgba(255,255,255,0.7)" />}
                      {status === 'delivered' && <Icons.DoubleCheck size={14} color="rgba(255,255,255,0.85)" />}
                      {(status === 'read' || !status) && <Icons.DoubleCheck size={14} color="#53BDEB" />}
                    </View>
                  )}
                </View>
              </View>
            </>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  // ============================================
  // v26.0: BLOB MEDIA PLACEHOLDER — Média non encore téléchargé
  // Affiche la preview (thumbnail/metadata) + bouton download.
  // Au tap, télécharge le blob chiffré via le relay et déchiffre.
  // ============================================
  
  const BlobMediaPlaceholder: React.FC<{
    message: UnifiedMessage;
    isMine: boolean;
    isFirstOfGroup: boolean;
    isLastOfGroup: boolean;
    timestamp: number;
    status?: MessageStatus;
  }> = ({ message, isMine, isFirstOfGroup, isLastOfGroup, timestamp, status }) => {
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    
    // v26.0: Résolution async du thumbnail mfs:// (doit être au top level — règles des hooks)
    const [thumbUri, setThumbUri] = useState<string>(() => {
      if (message.thumbnailData && !isMediaRef(message.thumbnailData)) {
        return resolveImageUri(message.thumbnailData) || '';
      }
      return '';
    });
    React.useEffect(() => {
      if (!message.thumbnailData) return;
      if (isMediaRef(message.thumbnailData)) {
        let m = true;
        resolveMediaToBase64(message.thumbnailData).then(b64 => {
          if (m && b64) setThumbUri(`data:image/jpeg;base64,${b64}`);
        }).catch(() => {});
        return () => { m = false; };
      } else {
        setThumbUri(resolveImageUri(message.thumbnailData) || '');
      }
    }, [message.thumbnailData]);
    
    // v26.0: AUTO-DOWNLOAD — télécharger le blob automatiquement à l'affichage
    // Plus besoin de tap : le thumbnail s'affiche immédiatement pendant le download
    const autoDownloadTriggered = React.useRef(false);
    React.useEffect(() => {
      if (!autoDownloadTriggered.current && message.blobId && message.blobKey && !downloading) {
        autoDownloadTriggered.current = true;
        // Petit délai pour laisser le thumbnail s'afficher d'abord
        const timer = setTimeout(() => handleDownload(), 300);
        return () => clearTimeout(timer);
      }
    }, [message.blobId, message.blobKey]);
    
    const handleDownload = async () => {
      if (downloading) return;
      setDownloading(true);
      setError(null);
      try {
        // Reconstruire un objet minimal pour downloadMediaBlob
        const sessionId = message.sessionId || message.conversationId;
        const msg1to1 = {
          id: message.id,
          sessionId,
          content: message.content,
          timestamp: message.timestamp,
          isMine: message.isMine,
          displayName: message.displayName,
          messageType: message.messageType,
          blobId: message.blobId,
          blobKey: message.blobKey,
          blobNonce: message.blobNonce,
          blobSize: message.blobSize,
          blobMediaType: message.blobMediaType,
          thumbnailData: message.thumbnailData,
          imageWidth: message.imageWidth,
          imageHeight: message.imageHeight,
          fileName: message.fileName,
          fileSize: message.fileSize,
          fileMimeType: message.fileMimeType,
          voiceDuration: message.voiceDuration,
        } as any;
        const result = await downloadMediaBlob(sessionId, msg1to1);
        if (!result.success) {
          setError(result.error || 'Échec du téléchargement');
        } else if (result.base64Data) {
          // v26.0: Mettre à jour le state React pour trigger un re-render
          // Le message passera de BlobMediaPlaceholder à InlineImageBubble/etc.
          const mediaUpdates: Partial<UnifiedMessage> = {};
          switch (message.blobMediaType) {
            case 'image': mediaUpdates.imageData = result.base64Data; break;
            case 'file':  mediaUpdates.fileData = result.base64Data; break;
            case 'voice': mediaUpdates.voiceData = result.base64Data; break;
          }
          // Supprimer les refs blob → le message sort de la branche BlobMediaPlaceholder
          mediaUpdates.blobId = undefined;
          mediaUpdates.blobKey = undefined;
          mediaUpdates.blobNonce = undefined;
          mediaUpdates.blobSize = undefined;
          updateMessage(message.id, mediaUpdates);
        }
      } catch (e: any) {
        setError(e.message || 'Erreur réseau');
      } finally {
        setDownloading(false);
      }
    };
    
    const mediaType = message.blobMediaType || 'file';
    
    const getBorderRadius = () => {
      const r = Radius.bubble.default;
      const g = Radius.bubble.grouped;
      if (isMine) {
        return {
          borderTopLeftRadius: r, borderTopRightRadius: isFirstOfGroup ? r : g,
          borderBottomLeftRadius: r, borderBottomRightRadius: isLastOfGroup ? r : g,
        };
      }
      return {
        borderTopLeftRadius: isFirstOfGroup ? r : g, borderTopRightRadius: r,
        borderBottomLeftRadius: isLastOfGroup ? r : g, borderBottomRightRadius: r,
      };
    };
    
    // IMAGE: thumbnail avec overlay de téléchargement
    if (mediaType === 'image' && message.thumbnailData) {
      const aspectRatio = (message.imageWidth || 200) / (message.imageHeight || 200);
      let displayWidth = Math.min(maxImageWidth, message.imageWidth || 200);
      let displayHeight = displayWidth / aspectRatio;
      if (displayHeight > maxImageHeight) {
        displayHeight = maxImageHeight;
        displayWidth = displayHeight * aspectRatio;
      }
      
      return (
        <TouchableOpacity onPress={handleDownload} activeOpacity={0.7}>
          <View style={[
            styles.imageBubble,
            { width: displayWidth, height: displayHeight },
            getBorderRadius(),
            { overflow: 'hidden' },
          ]}>
            {thumbUri ? (
              <Image 
                source={{ uri: thumbUri }} 
                style={{ width: '100%', height: '100%', opacity: 0.6 }} 
                resizeMode="cover"
                blurRadius={2}
              />
            ) : (
              <View style={{ width: '100%', height: '100%', backgroundColor: isMine ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }} />
            )}
            <View style={{
              ...StyleSheet.absoluteFillObject,
              justifyContent: 'center', alignItems: 'center',
              backgroundColor: 'rgba(0,0,0,0.3)',
            }}>
              {downloading ? (
                <ActivityIndicator size="large" color="#fff" />
              ) : (
                <View style={{ alignItems: 'center' }}>
                  <Ionicons name="cloud-download-outline" size={36} color="#fff" />
                  {error && <Text style={{ color: '#ff6b6b', fontSize: 11, marginTop: 4 }}>{error}</Text>}
                </View>
              )}
            </View>
            <View style={styles.imageMetaGradient}>
              <View style={styles.imageMetaRow}>
                <Text style={styles.imageMetaText}>{formatTime(timestamp)}</Text>
                {isMine && status && (
                  <View style={styles.imageMetaCheck}>
                    {status === 'sending' && <Icons.StatusClock size={14} color="rgba(255,255,255,0.7)" />}
                    {status === 'sent' && <Icons.SingleCheck size={14} color="rgba(255,255,255,0.7)" />}
                    {(status === 'delivered' || status === 'read' || !status) && <Icons.DoubleCheck size={14} color="#53BDEB" />}
                  </View>
                )}
              </View>
            </View>
          </View>
        </TouchableOpacity>
      );
    }
    
    // FILE / VOICE / IMAGE sans thumbnail: bulle avec metadata + download
    const fileSize = message.fileSize ? 
      (message.fileSize > 1024 * 1024 
        ? `${(message.fileSize / 1024 / 1024).toFixed(1)} MB`
        : `${Math.round(message.fileSize / 1024)} KB`)
      : '';
    
    const label = mediaType === 'voice'
      ? `Message vocal ${message.voiceDuration ? Math.round(message.voiceDuration) + 's' : ''}`
      : mediaType === 'file'
        ? (message.fileName || 'Fichier')
        : 'Image';
    
    const icon = mediaType === 'voice' ? 'mic-outline' : mediaType === 'file' ? 'document-outline' : 'image-outline';
    
    return (
      <TouchableOpacity onPress={handleDownload} activeOpacity={0.7}>
        <View style={[
          styles.bubble,
          isMine ? styles.bubbleMine : styles.bubbleTheirs,
          getBorderRadius(),
          { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, gap: 10 },
        ]}>
          <View style={{
            width: 42, height: 42, borderRadius: 21,
            backgroundColor: isMine ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.08)',
            justifyContent: 'center', alignItems: 'center',
          }}>
            {downloading ? (
              <ActivityIndicator size="small" color={isMine ? '#fff' : '#007AFF'} />
            ) : (
              <Ionicons name={icon as any} size={20} color={isMine ? '#fff' : '#007AFF'} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[
              { fontSize: 14, fontWeight: '500' },
              isMine ? styles.messageTextMine : styles.messageTextTheirs,
            ]} numberOfLines={1}>
              {label}
            </Text>
            <Text style={{
              fontSize: 11,
              color: isMine ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.4)',
              marginTop: 2,
            }}>
              {downloading ? 'Téléchargement...' : error || (fileSize ? `${fileSize} — Tap pour télécharger` : 'Tap pour télécharger')}
            </Text>
          </View>
          {!downloading && (
            <Ionicons name="cloud-download-outline" size={18} color={isMine ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.3)'} />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  // ============================================
  // v16.0: INLINE IMAGE BUBBLE (pour 1-à-1)
  // ============================================
  
  const InlineImageBubble: React.FC<{ 
    imageData: string;
    thumbnailData?: string;
    width: number;
    height: number;
    isMine: boolean;
    isFirstOfGroup: boolean;
    isLastOfGroup: boolean;
    timestamp: number;
    status?: MessageStatus;
  }> = ({ imageData, thumbnailData, width, height, isMine, isFirstOfGroup, isLastOfGroup, timestamp, status }) => {
    const [showFull, setShowFull] = useState(false);
    
    // Calculer les dimensions d'affichage
    const aspectRatio = width / height;
    let displayWidth = Math.min(maxImageWidth, width);
    let displayHeight = displayWidth / aspectRatio;
    if (displayHeight > maxImageHeight) {
      displayHeight = maxImageHeight;
      displayWidth = displayHeight * aspectRatio;
    }
    
    const getBorderRadius = () => {
      const r = Radius.bubble.default;
      const g = Radius.bubble.grouped;
      
      if (isMine) {
        return {
          borderTopLeftRadius: r,
          borderTopRightRadius: isFirstOfGroup ? r : g,
          borderBottomLeftRadius: r,
          borderBottomRightRadius: isLastOfGroup ? r : g,
        };
      }
      return {
        borderTopLeftRadius: isFirstOfGroup ? r : g,
        borderTopRightRadius: r,
        borderBottomLeftRadius: isLastOfGroup ? r : g,
        borderBottomRightRadius: r,
      };
    };
    
    const handlePress = () => {
      // Afficher l'image en plein écran — utiliser l'URI résolu
      if (resolvedUri) setViewerImage(resolvedUri);
    };
    
    // v26.1: Résolution des URIs d'image
    // 3 cas: file:// (optimistic local), mfs:// (externalisé), base64 (inline)
    const [resolvedUri, setResolvedUri] = useState<string>(() => {
      if (!imageData) return '';
      // file:// ou content:// URIs → utilisables directement par <Image>
      if (imageData.startsWith('file://') || imageData.startsWith('content://')) {
        return imageData;
      }
      // mfs:// → résolution async (sera faite dans useEffect)
      if (isMediaRef(imageData)) return '';
      // base64 inline
      return `data:image/jpeg;base64,${imageData}`;
    });
    
    React.useEffect(() => {
      if (!imageData) { setResolvedUri(''); return; }
      if (imageData.startsWith('file://') || imageData.startsWith('content://')) {
        setResolvedUri(imageData);
        return;
      }
      if (isMediaRef(imageData)) {
        let mounted = true;
        resolveMediaToBase64(imageData).then(base64 => {
          if (mounted && base64) {
            setResolvedUri(`data:image/jpeg;base64,${base64}`);
          }
        }).catch(() => {});
        return () => { mounted = false; };
      } else {
        setResolvedUri(resolveImageUri(imageData) || '');
      }
    }, [imageData]);
    
    return (
      <TouchableOpacity onPress={handlePress} activeOpacity={0.9}>
        <View style={[
          styles.imageBubble, 
          { width: displayWidth, height: displayHeight }, 
          getBorderRadius(),
          { overflow: 'hidden' },
        ]}>
          {resolvedUri ? (
            <Image 
              source={{ uri: resolvedUri }} 
              style={{ width: '100%', height: '100%' }} 
              resizeMode="cover" 
            />
          ) : (
            <View style={{ width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.05)', justifyContent: 'center', alignItems: 'center' }}>
              <ActivityIndicator size="small" color="#999" />
            </View>
          )}
          {/* v26.1: Overlay de progression pendant l'upload */}
          {isMine && status === 'sending' && (
            <View style={{
              ...StyleSheet.absoluteFillObject,
              justifyContent: 'center', alignItems: 'center',
              backgroundColor: 'rgba(0,0,0,0.35)',
            }}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={{ color: '#fff', fontSize: 11, marginTop: 6, fontWeight: '500' }}>Envoi chiffré...</Text>
            </View>
          )}
          <View style={styles.imageMetaGradient}>
            <View style={styles.imageMetaRow}>
              <Text style={styles.imageMetaText}>{formatTime(timestamp)}</Text>
              {isMine && (
                <View style={styles.imageMetaCheck}>
                  {status === 'sending' && <Icons.StatusClock size={14} color="rgba(255,255,255,0.7)" />}
                  {status === 'sent' && <Icons.SingleCheck size={14} color="rgba(255,255,255,0.7)" />}
                  {status === 'delivered' && <Icons.DoubleCheck size={14} color="rgba(255,255,255,0.85)" />}
                  {(status === 'read' || !status) && <Icons.DoubleCheck size={14} color="#53BDEB" />}
                </View>
              )}
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // ============================================
  // v16.0: INLINE FILE BUBBLE (pour 1-à-1)
  // ============================================
  
  const InlineFileBubble: React.FC<{ 
    fileData: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    isMine: boolean;
    isFirstOfGroup: boolean;
    isLastOfGroup: boolean;
    timestamp: number;
    status?: MessageStatus;
  }> = ({ fileData, fileName, fileSize, mimeType, isMine, isFirstOfGroup, isLastOfGroup, timestamp, status }) => {
    const [downloading, setDownloading] = useState(false);
    
    const handlePress = async () => {
      if (!fileData || status === 'sending') return;
      setDownloading(true);
      try {
        // v25.2: Résoudre les refs fichier (base64 inline ou mfs:// ref)
        const resolvedData = await resolveMediaToBase64(fileData);
        // Sauvegarder le fichier temporairement
        const tempPath = `${FileSystem.cacheDirectory}${fileName}`;
        await FileSystem.writeAsStringAsync(tempPath, resolvedData, {
          encoding: FileSystem.EncodingType.Base64,
        });
        
        // Partager le fichier
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(tempPath, { mimeType, dialogTitle: fileName });
        }
      } catch (e) {
        console.error('❌ InlineFileBubble error:', e);
        Alert.alert('Erreur', 'Impossible d\'ouvrir le fichier.');
      } finally {
        setDownloading(false);
      }
    };
    
    const extension = fileName.split('.').pop() || '';
    const icon = getFileIcon(extension);
    
    const getBorderRadius = () => {
      const r = Radius.bubble.default;
      const g = Radius.bubble.grouped;
      
      if (isMine) {
        return {
          borderTopLeftRadius: r,
          borderTopRightRadius: isFirstOfGroup ? r : g,
          borderBottomLeftRadius: r,
          borderBottomRightRadius: isLastOfGroup ? r : g,
        };
      }
      return {
        borderTopLeftRadius: isFirstOfGroup ? r : g,
        borderTopRightRadius: r,
        borderBottomLeftRadius: isLastOfGroup ? r : g,
        borderBottomRightRadius: r,
      };
    };
    
    // v26.1: Layout restructuré — nom tronqué, metadata toujours visible
    // ┌──────────────────────────────┐
    // │ 📄  filename_trunca...pdf    │
    // │     256 KB     15:30  ✓✓     │
    // └──────────────────────────────┘
    return (
      <TouchableOpacity onPress={handlePress} activeOpacity={0.7} disabled={downloading}>
        <View style={[
          styles.fileBubble, 
          isMine ? styles.fileBubbleMine : styles.fileBubbleTheirs,
          getBorderRadius(),
        ]}>
          <View style={[styles.fileIconWrap, isMine ? styles.fileIconWrapMine : styles.fileIconWrapTheirs]}>
            {downloading ? (
              <ActivityIndicator size="small" color={isMine ? Colors.text.inverse : Colors.accent.primary} />
            ) : status === 'sending' ? (
              <ActivityIndicator size="small" color={isMine ? Colors.text.inverse : Colors.accent.primary} />
            ) : (
              <Text style={styles.fileIconText}>{icon}</Text>
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text 
              style={[styles.fileName, isMine ? { color: Colors.text.inverse } : { color: Colors.text.primary }]} 
              numberOfLines={1} 
              ellipsizeMode="middle"
            >
              {fileName}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3 }}>
              <Text style={{ fontSize: 12, color: isMine ? 'rgba(255,255,255,0.6)' : Colors.text.secondary }}>
                {status === 'sending' ? 'Envoi chiffré...' : formatFileSize(fileSize)}
              </Text>
              <View style={{ flex: 1 }} />
              <Text style={{ fontSize: 11, color: isMine ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.4)', marginRight: 4 }}>
                {formatTime(timestamp)}
              </Text>
              {isMine && (
                <View>
                  {status === 'sending' && <Icons.StatusClock size={14} color={isMine ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.4)'} />}
                  {status === 'sent' && <Icons.SingleCheck size={14} color={isMine ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)'} />}
                  {status === 'delivered' && <Icons.DoubleCheck size={14} color={isMine ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.6)'} />}
                  {(status === 'read' || !status) && <Icons.DoubleCheck size={14} color="#53BDEB" />}
                </View>
              )}
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // ============================================
  // v16.0: INLINE VOICE BUBBLE (pour 1-à-1)
  // ============================================
  
  const InlineVoiceBubble: React.FC<{ 
    voiceData: string;
    duration: number;
    messageId: string;
    isMine: boolean;
    isFirstOfGroup: boolean;
    isLastOfGroup: boolean;
    timestamp: number;
    status?: MessageStatus;
  }> = ({ voiceData, duration, messageId, isMine, isFirstOfGroup, isLastOfGroup, timestamp, status }) => {
    const [isPlaying, setIsPlaying] = useState(false);
    const [progress, setProgress] = useState(0);
    const [loading, setLoading] = useState(false);
    
    const handlePlay = async () => {
      if (loading) return;
      
      if (isPlaying) {
        // Pause
        await pauseVoice();
        setIsPlaying(false);
        return;
      }
      
      setLoading(true);
      try {
        // v25.2: Résoudre les refs fichier
        const resolvedVoice = await resolveMediaToBase64(voiceData);
        // Sauvegarder temporairement le fichier audio
        const tempPath = `${FileSystem.cacheDirectory}voice_${messageId}.m4a`;
        await FileSystem.writeAsStringAsync(tempPath, resolvedVoice, {
          encoding: FileSystem.EncodingType.Base64,
        });
        
        // Jouer
        await playVoice(messageId, tempPath, (position, totalDuration, playing) => {
          setProgress(position / totalDuration);
          setIsPlaying(playing);
          if (!playing && position >= totalDuration * 0.99) {
            setProgress(0);
          }
        });
        
        setIsPlaying(true);
      } catch (e) {
        console.error('❌ InlineVoiceBubble play error:', e);
        Alert.alert('Erreur', 'Impossible de lire le message vocal.');
      } finally {
        setLoading(false);
      }
    };
    
    const formatDuration = (seconds: number) => {
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    const getBorderRadius = () => {
      const r = Radius.bubble.default;
      const g = Radius.bubble.grouped;
      
      if (isMine) {
        return {
          borderTopLeftRadius: r,
          borderTopRightRadius: isFirstOfGroup ? r : g,
          borderBottomLeftRadius: r,
          borderBottomRightRadius: isLastOfGroup ? r : g,
        };
      }
      return {
        borderTopLeftRadius: isFirstOfGroup ? r : g,
        borderTopRightRadius: r,
        borderBottomLeftRadius: isLastOfGroup ? r : g,
        borderBottomRightRadius: r,
      };
    };
    
    return (
      <View style={[
        voiceStyles.voiceBubble,
        isMine ? voiceStyles.voiceBubbleMine : voiceStyles.voiceBubbleTheirs,
        getBorderRadius(),
      ]}>
        <TouchableOpacity 
          onPress={handlePlay} 
          style={[voiceStyles.playButton, isMine ? voiceStyles.playButtonMine : voiceStyles.playButtonTheirs]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={isMine ? Colors.text.inverse : Colors.accent.primary} />
          ) : (
            <Ionicons 
              name={isPlaying ? 'pause' : 'play'} 
              size={20} 
              color={isMine ? Colors.text.inverse : Colors.accent.primary} 
            />
          )}
        </TouchableOpacity>
        
        <View style={voiceStyles.voiceContent}>
          {/* Barre de progression simple */}
          <View style={[voiceStyles.waveformContainer, { backgroundColor: isMine ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)', borderRadius: 4 }]}>
            <View 
              style={{
                height: '100%',
                width: `${progress * 100}%`,
                backgroundColor: isMine ? 'rgba(255,255,255,0.5)' : Colors.accent.primary,
                borderRadius: 4,
              }} 
            />
          </View>
          
          <View style={voiceStyles.voiceMetaRow}>
            <Text style={[voiceStyles.voiceDuration, isMine && voiceStyles.voiceDurationMine]}>
              {formatDuration(duration)}
            </Text>
            <Text style={[voiceStyles.voiceTime, isMine && voiceStyles.voiceTimeMine]}>
              {formatTime(timestamp)}
            </Text>
            {isMine && (
              <View style={voiceStyles.voiceStatus}>
                {status === 'sending' && <Icons.StatusClock size={12} color="rgba(255,255,255,0.6)" />}
                {status === 'sent' && <Icons.SingleCheck size={12} color="rgba(255,255,255,0.7)" />}
                {status === 'delivered' && <Icons.DoubleCheck size={12} color="rgba(255,255,255,0.85)" />}
                {(status === 'read' || !status) && <Icons.DoubleCheck size={12} color="#53BDEB" />}
              </View>
            )}
          </View>
        </View>
      </View>
    );
  };

  // ============================================
  // FILE MESSAGE BUBBLE
  // ============================================
  
  const FileMessageBubble: React.FC<{ 
    payload: FilePayload; 
    isMine: boolean;
    isFirstOfGroup: boolean;
    isLastOfGroup: boolean;
    timestamp: number;
    status?: MessageStatus;
  }> = ({ payload, isMine, isFirstOfGroup, isLastOfGroup, timestamp, status }) => {
    const [downloading, setDownloading] = useState(false);
    
    const handlePress = async () => {
      setDownloading(true);
      try {
        const keys = await getConversationKeys(conversationId);
        if (!keys) throw new Error('Clés non trouvées');
        const storagePath = payload.storagePath || conversationId;
        // Construire l'URL publique pour le fichier
        const fileUrl = getMediaPublicUrl(storagePath, payload.fileId, '');
        const localPath = await getCachedFile(
          payload.fileId,            // fileId pour le cache
          fileUrl,                   // URL publique
          payload.fileKeyEncrypted,  // clé chiffrée
          payload.fileNonce,         // nonce
          keys.e2eKey,              // clé E2E pour déchiffrer
          payload.metadata.name      // nom du fichier
        );
        if (localPath) {
          const canShare = await Sharing.isAvailableAsync();
          if (canShare) await Sharing.shareAsync(localPath, { mimeType: payload.metadata.mimeType, dialogTitle: payload.metadata.name });
        }
      } catch (e) {
        console.error('❌ handlePress (file) error:', e);
        Alert.alert('Erreur', 'Impossible d\'ouvrir le fichier.');
      } finally {
        setDownloading(false);
      }
    };

    const icon = getFileIcon(payload.metadata?.extension || '');
    
    const getBorderRadius = () => {
      const r = Radius.bubble.default;
      const g = Radius.bubble.grouped;
      
      if (isMine) {
        return {
          borderTopLeftRadius: r,
          borderTopRightRadius: isFirstOfGroup ? r : g,
          borderBottomLeftRadius: r,
          borderBottomRightRadius: isLastOfGroup ? r : g,
        };
      }
      return {
        borderTopLeftRadius: isFirstOfGroup ? r : g,
        borderTopRightRadius: r,
        borderBottomLeftRadius: isLastOfGroup ? r : g,
        borderBottomRightRadius: r,
      };
    };
    
    return (
      <TouchableOpacity onPress={handlePress} activeOpacity={0.7} disabled={downloading}>
        <View style={[
          styles.fileBubble, 
          isMine ? styles.fileBubbleMine : styles.fileBubbleTheirs,
          getBorderRadius(),
        ]}>
          <View style={[styles.fileIconWrap, isMine ? styles.fileIconWrapMine : styles.fileIconWrapTheirs]}>
            {downloading ? (
              <ActivityIndicator size="small" color={isMine ? Colors.text.inverse : Colors.accent.primary} />
            ) : (
              <Text style={styles.fileIconEmoji}>{icon}</Text>
            )}
          </View>
          <View style={styles.fileDetails}>
            <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">
              {payload.metadata?.name || 'Fichier'}
            </Text>
            <View style={styles.fileMetaRow}>
              <Text style={[styles.fileSize, isMine && styles.fileSizeMine]}>
                {formatFileSize(payload.metadata?.size || 0)}
              </Text>
              <Text style={[styles.fileTime, isMine && styles.fileTimeMine]}>
                {formatTime(timestamp)}
              </Text>
              {isMine && (
                <>
                  {status === 'sending' && <Icons.StatusClock size={14} color={Colors.status.sent} />}
                  {status === 'sent' && <Icons.SingleCheck size={14} color={Colors.status.sent} />}
                  {status === 'delivered' && <Icons.DoubleCheck size={14} color={Colors.status.delivered} />}
                  {(status === 'read' || !status) && <Icons.DoubleCheck size={14} color={Colors.status.read} />}
                </>
              )}
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // ============================================
  // VOICE MESSAGE BUBBLE
  // ============================================
  
  const VoiceMessageBubble: React.FC<{ 
    payload: VoiceMessagePayload;
    messageId: string;
    isMine: boolean;
    isFirstOfGroup: boolean;
    isLastOfGroup: boolean;
    timestamp: number;
    status?: MessageStatus;
  }> = ({ payload, messageId, isMine, isFirstOfGroup, isLastOfGroup, timestamp, status }) => {
    const [loading, setLoading] = useState(false);
    const isThisPlaying = playingVoiceId === messageId;
    const isPlaying = isThisPlaying && isVoicePlaying;
    
    // Animation pour la barre de progression
    const progressAnim = useRef(new Animated.Value(0)).current;
    
    useEffect(() => {
      if (isThisPlaying && voicePlaybackDuration > 0) {
        const progress = voicePlaybackPosition / voicePlaybackDuration;
        Animated.timing(progressAnim, {
          toValue: progress,
          duration: 100,
          useNativeDriver: false,
        }).start();
      } else if (!isThisPlaying) {
        progressAnim.setValue(0);
      }
    }, [voicePlaybackPosition, voicePlaybackDuration, isThisPlaying]);
    
    const handlePress = async () => {
      setLoading(true);
      try {
        await handlePlayVoice(messageId, payload);
      } finally {
        setLoading(false);
      }
    };
    
    const getBorderRadius = () => {
      const r = Radius.bubble.default;
      const g = Radius.bubble.grouped;
      
      if (isMine) {
        return {
          borderTopLeftRadius: r,
          borderTopRightRadius: isFirstOfGroup ? r : g,
          borderBottomLeftRadius: r,
          borderBottomRightRadius: isLastOfGroup ? r : g,
        };
      }
      return {
        borderTopLeftRadius: isFirstOfGroup ? r : g,
        borderTopRightRadius: r,
        borderBottomLeftRadius: isLastOfGroup ? r : g,
        borderBottomRightRadius: r,
      };
    };
    
    // Waveform visualization
    const renderWaveform = () => {
      const waveform = payload.metadata?.waveform || [];
      const barCount = Math.min(waveform.length, 40);
      const barWidth = 3;
      const barGap = 2;
      
      return (
        <View style={voiceStyles.waveformContainer}>
          {Array.from({ length: barCount }).map((_, i) => {
            const height = Math.max(4, (waveform[Math.floor(i * waveform.length / barCount)] || 0.2) * 24);
            const isPlayed = isThisPlaying && voicePlaybackDuration > 0 
              ? (i / barCount) <= (voicePlaybackPosition / voicePlaybackDuration)
              : false;
            
            return (
              <View
                key={i}
                style={[
                  voiceStyles.waveformBar,
                  {
                    width: barWidth,
                    height,
                    marginHorizontal: barGap / 2,
                    backgroundColor: isPlayed
                      ? (isMine ? 'rgba(255,255,255,0.9)' : Colors.accent.primary)
                      : (isMine ? 'rgba(255,255,255,0.4)' : 'rgba(139, 164, 184, 0.4)'),
                  },
                ]}
              />
            );
          })}
        </View>
      );
    };
    
    // Affichage de la durée :
    // - Si en cours de lecture : afficher la position actuelle
    // - Si la lecture est terminée (position >= duration) : afficher la durée totale
    // - Sinon : afficher la durée totale du message
    const isFinished = isThisPlaying && !isPlaying && voicePlaybackPosition >= voicePlaybackDuration - 100;
    const displayDuration = isThisPlaying && isPlaying && voicePlaybackDuration > 0
      ? formatVoiceDuration(voicePlaybackPosition)
      : formatVoiceDuration(payload.metadata?.duration || 0);
    
    return (
      <TouchableOpacity onPress={handlePress} activeOpacity={0.7} disabled={loading}>
        <View style={[
          voiceStyles.voiceBubble,
          isMine ? voiceStyles.voiceBubbleMine : voiceStyles.voiceBubbleTheirs,
          getBorderRadius(),
        ]}>
          {/* Play/Pause Button */}
          <View style={[
            voiceStyles.playButton,
            isMine ? voiceStyles.playButtonMine : voiceStyles.playButtonTheirs,
          ]}>
            {loading ? (
              <ActivityIndicator size="small" color={isMine ? Colors.bubble.outgoing : Colors.accent.primary} />
            ) : (
              <Ionicons
                name={isPlaying ? 'pause' : 'play'}
                size={22}
                color={isMine ? Colors.bubble.outgoing : Colors.accent.primary}
              />
            )}
          </View>
          
          {/* Waveform + Duration */}
          <View style={voiceStyles.voiceContent}>
            {renderWaveform()}
            
            <View style={voiceStyles.voiceMetaRow}>
              <Text style={[
                voiceStyles.voiceDuration,
                isMine && voiceStyles.voiceDurationMine,
              ]}>
                {displayDuration}
              </Text>
              <Text style={[
                voiceStyles.voiceTime,
                isMine && voiceStyles.voiceTimeMine,
              ]}>
                {formatTime(timestamp)}
              </Text>
              {isMine && (
                <View style={voiceStyles.voiceStatus}>
                  {status === 'sending' && <Icons.StatusClock size={14} color={Colors.status.sent} />}
                  {status === 'sent' && <Icons.SingleCheck size={14} color={Colors.status.sent} />}
                  {status === 'delivered' && <Icons.DoubleCheck size={14} color={Colors.status.delivered} />}
                  {(status === 'read' || !status) && <Icons.DoubleCheck size={14} color={Colors.status.read} />}
                </View>
              )}
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // ============================================
  // CALL MESSAGE BUBBLE
  // v15.2: Affiche les messages d'appel terminé
  // v16.0: Simplifié avec "Appel manqué de XXX"
  // ============================================
  
  const CallMessageBubble: React.FC<{ 
    payload: CallMessagePayload;
    timestamp: number;
    isMine?: boolean;
    callerName?: string;
  }> = ({ payload, timestamp, isMine, callerName }) => {
    const statusText = getCallStatusText(payload.status, isMine, callerName);
    const durationText = payload.duration > 0 ? formatCallDuration(payload.duration) : '';
    
    // Icône selon le statut: vert si abouti, rouge sinon
    const isSuccessful = payload.status === 'ended';
    
    const getIcon = () => {
      if (isSuccessful) {
        // Appel terminé normalement - vert
        return (
          <View style={[callStyles.iconContainer, { backgroundColor: 'rgba(0, 168, 132, 0.15)' }]}>
            <Ionicons name="call" size={18} color="#00A884" />
          </View>
        );
      } else {
        // Appel manqué (missed, declined, cancelled) - rouge avec flèche entrante
        return (
          <View style={[callStyles.iconContainer, { backgroundColor: 'rgba(234, 67, 53, 0.15)' }]}>
            <Ionicons 
              name={isMine ? "call" : "arrow-down-circle"} 
              size={18} 
              color="#EA4335" 
            />
          </View>
        );
      }
    };
    
    return (
      <View style={callStyles.container}>
        <View style={callStyles.bubble}>
          {getIcon()}
          <View style={callStyles.textContainer}>
            <Text style={callStyles.statusText}>{statusText}</Text>
            {durationText ? (
              <Text style={callStyles.durationText}>{durationText}</Text>
            ) : null}
          </View>
          <Text style={callStyles.timeText}>{formatTime(timestamp)}</Text>
        </View>
      </View>
    );
  };
  
  // Styles pour les messages d'appel
  const callStyles = StyleSheet.create({
    container: {
      alignItems: 'center',
      marginVertical: Space.sm,
    },
    bubble: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: Colors.bg.tertiary,
      paddingVertical: Space.sm,
      paddingHorizontal: Space.md,
      borderRadius: Radius.bubble.default,
      gap: Space.sm,
    },
    iconContainer: {
      width: 32,
      height: 32,
      borderRadius: 16,
      justifyContent: 'center',
      alignItems: 'center',
    },
    textContainer: {
      flexDirection: 'column',
    },
    statusText: {
      color: Colors.text.primary,
      fontSize: 14,
      fontWeight: '500',
    },
    durationText: {
      color: Colors.text.secondary,
      fontSize: 12,
      marginTop: 1,
    },
    timeText: {
      color: Colors.text.tertiary,
      fontSize: 11,
      marginLeft: Space.xs,
    },
  });

  // ============================================
  // RENDER MESSAGE
  // ============================================
  
  const renderMessage = ({ item, index }: { item: MessageWithStatus; index: number }) => {
    if (!messages || !Array.isArray(messages)) return null;
    
    const isSelected = selectedIds.has(item.id);
    const showDate = shouldShowDateSeparator(index);
    const isImage = isImageMessage(item);  // v16.0: Passer l'item complet
    const isFile = isFileMessage(item);    // v16.0: Passer l'item complet
    const isVoice = isVoiceMessage(item);  // v16.0: Passer l'item complet
    const isCall = isCallMessage(item.content);  // v15.2: Détecter les messages d'appel
    const imagePayload = isImage && !item.imageData ? getImagePayload(item) : null;  // Ancien système uniquement
    const filePayload = isFile && !item.fileData ? getFilePayload(item) : null;
    const voicePayload = isVoice && !item.voiceData ? getVoicePayload(item) : null;
    const callPayload = isCall ? getCallPayload(item.content) : null;  // v15.2
    const isNew = newMessageIds.has(item.id);
    
    // v15.2: Les messages d'appel sont centrés et n'ont pas de groupement
    if (isCall && callPayload) {
      return (
        <View>
          {showDate && (
            <View style={styles.dateSeparator}>
              <View style={styles.dateLine} />
              <Text style={styles.dateText}>{formatDateSeparator(item.timestamp)}</Text>
              <View style={styles.dateLine} />
            </View>
          )}
          <CallMessageBubble 
            payload={callPayload} 
            timestamp={item.timestamp}
            isMine={item.isMine}
            callerName={item.displayName}
          />
        </View>
      );
    }
    
    // v15.2: Helper pour trouver le message précédent/suivant en ignorant les messages d'appel
    // Les messages d'appel ne doivent pas affecter le groupement des autres messages
    const findPrevNonCallMessage = (idx: number): LocalMessage | null => {
      for (let i = idx - 1; i >= 0; i--) {
        if (!isCallMessage(messages[i].content)) {
          return messages[i];
        }
      }
      return null;
    };
    
    const findNextNonCallMessage = (idx: number): LocalMessage | null => {
      for (let i = idx + 1; i < messages.length; i++) {
        if (!isCallMessage(messages[i].content)) {
          return messages[i];
        }
      }
      return null;
    };
    
    // Grouping logic - with safety checks
    // v15.2: Ignorer les messages d'appel dans le groupement
    const prevMsg = findPrevNonCallMessage(index);
    const nextMsg = findNextNonCallMessage(index);
    
    const isFirstOfGroup = !prevMsg || 
      prevMsg.isMine !== item.isMine || 
      prevMsg.senderToken !== item.senderToken || 
      shouldShowDateSeparator(index) ||
      (item.timestamp - prevMsg.timestamp > 60000);
    
    const isLastOfGroup = !nextMsg || 
      nextMsg.isMine !== item.isMine || 
      nextMsg.senderToken !== item.senderToken || 
      (index < messages.length - 1 && shouldShowDateSeparator(index + 1)) ||
      (nextMsg && nextMsg.timestamp - item.timestamp > 60000);
    
    const showAvatar = isLastOfGroup;
    const senderColor = generateColorFromToken(item.senderToken);
    
    const fullDisplayName = getDisplayNameWithDiscriminator(
      item.displayName, 
      item.identityCommitment, 
      participantsByName
    );
    
    const handleAvatarPress = () => {
      setSelectedProfile({
        displayName: fullDisplayName,
        senderToken: item.senderToken,
        avatarBase64: getAvatarForMessage(item),
        color: senderColor,
      });
      setProfileModalVisible(true);
    };
    
    const getBubbleRadius = () => {
      const r = Radius.bubble.default;
      const g = Radius.bubble.grouped;
      
      if (item.isMine) {
        return {
          borderTopLeftRadius: r,
          borderTopRightRadius: isFirstOfGroup ? r : g,
          borderBottomLeftRadius: r,
          borderBottomRightRadius: isLastOfGroup ? r : g,
        };
      }
      return {
        borderTopLeftRadius: isFirstOfGroup ? r : g,
        borderTopRightRadius: r,
        borderBottomLeftRadius: isLastOfGroup ? r : g,
        borderBottomRightRadius: r,
      };
    };
    
    const getMessageSpacing = () => {
      if (isFirstOfGroup) return Space.md;
      return 3;
    };
    
    // Vérifier si le message a des réactions
    const hasReactions = (item as MessageWithStatus).reactions && (item as MessageWithStatus).reactions!.length > 0;
    
    const messageContent = (
      <View style={styles.messageWithReactionsWrapper}>
        {/* Message Row */}
        <Pressable
          style={({ pressed }) => [
            styles.messageRow,
            item.isMine ? styles.messageRowMine : styles.messageRowTheirs,
            { marginTop: getMessageSpacing() },
            pressed && isSelectionMode && { opacity: 0.7 },
          ]}
          onPress={() => isSelectionMode && toggleMessageSelection(item.id)}
          onLongPress={(e) => {
            if (isSelectionMode) {
              handleLongPress(item.id);
            } else {
              handleLongPressMessage(item.id, e);
            }
          }}
          delayLongPress={400}
        >
          {isSelectionMode && (
            <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
              {isSelected && <Text style={styles.checkmark}>✓</Text>}
            </View>
          )}
          
          {!item.isMine && (
            <TouchableOpacity 
              style={styles.avatarSpaceLeft}
              onPress={handleAvatarPress}
              activeOpacity={0.7}
            >
              {showAvatar && (
                <Avatar
                  displayName={item.displayName}
                  senderToken={item.senderToken}
                  avatarUri={getAvatarForMessage(item)}
                  size="small"
                  showWarning={item.identityWarning}
                />
              )}
            </TouchableOpacity>
          )}
          
          {isImage && item.imageData ? (
            /* v16.0+v25.0: Image inline avec overlay de progression */
            <View style={[styles.mediaContainer, item.isMine && styles.mediaContainerMine]}>
              {(() => {
                const sendProg = item.isMine ? getSendProgress(item.id) : null;
                if (sendProg && sendProg.phase !== 'complete') {
                  return (
                    <View style={{ position: 'relative' }}>
                      <InlineImageBubble 
                        imageData={item.imageData}
                        thumbnailData={item.thumbnailData}
                        width={item.imageWidth || 200}
                        height={item.imageHeight || 200}
                        isMine={item.isMine}
                        isFirstOfGroup={isFirstOfGroup}
                        isLastOfGroup={isLastOfGroup}
                        timestamp={item.timestamp}
                        status={(item as MessageWithStatus).status}
                      />
                      <MediaProgressOverlay
                        progress={sendProg.progress}
                        phase={sendProg.phase}
                        direction="send"
                      />
                    </View>
                  );
                }
                return (
                  <InlineImageBubble 
                    imageData={item.imageData}
                    thumbnailData={item.thumbnailData}
                    width={item.imageWidth || 200}
                    height={item.imageHeight || 200}
                    isMine={item.isMine}
                    isFirstOfGroup={isFirstOfGroup}
                    isLastOfGroup={isLastOfGroup}
                    timestamp={item.timestamp}
                    status={(item as MessageWithStatus).status}
                  />
                );
              })()}
            </View>
          ) : isImage && item.blobId && item.blobKey ? (
            /* v26.0: Image blob non téléchargé — affiche thumbnail + download */
            <View style={[styles.mediaContainer, item.isMine && styles.mediaContainerMine]}>
              <BlobMediaPlaceholder
                message={item}
                isMine={item.isMine}
                isFirstOfGroup={isFirstOfGroup}
                isLastOfGroup={isLastOfGroup}
                timestamp={item.timestamp}
                status={(item as MessageWithStatus).status}
              />
            </View>
          ) : isImage && imagePayload ? (
            /* Ancien système - Image sur serveur distant */
            <View style={[styles.mediaContainer, item.isMine && styles.mediaContainerMine]}>
              <ImageMessageBubble 
                payload={imagePayload} 
                isMine={item.isMine}
                isFirstOfGroup={isFirstOfGroup}
                isLastOfGroup={isLastOfGroup}
                timestamp={item.timestamp}
                status={(item as MessageWithStatus).status}
              />
            </View>
          ) : isFile && item.fileData ? (
            /* v16.0+v25.0: Fichier inline avec barre de progression */
            <View style={[styles.mediaContainer, item.isMine && styles.mediaContainerMine]}>
              <InlineFileBubble 
                fileData={item.fileData}
                fileName={item.fileName || 'fichier'}
                fileSize={item.fileSize || 0}
                mimeType={item.fileMimeType || 'application/octet-stream'}
                isMine={item.isMine}
                isFirstOfGroup={isFirstOfGroup}
                isLastOfGroup={isLastOfGroup}
                timestamp={item.timestamp}
                status={(item as MessageWithStatus).status}
              />
              {/* v25.0: Barre de progression sous le fichier */}
              {(() => {
                const sendProg = item.isMine ? getSendProgress(item.id) : null;
                if (sendProg && sendProg.phase !== 'complete') {
                  return (
                    <View style={{ paddingHorizontal: 12, paddingBottom: 6 }}>
                      <FileProgressBar progress={sendProg.progress} direction="send" />
                    </View>
                  );
                }
                return null;
              })()}
            </View>
          ) : isFile && item.blobId && item.blobKey ? (
            /* v26.0: Fichier blob non téléchargé — affiche metadata + download */
            <View style={[styles.mediaContainer, item.isMine && styles.mediaContainerMine]}>
              <BlobMediaPlaceholder
                message={item}
                isMine={item.isMine}
                isFirstOfGroup={isFirstOfGroup}
                isLastOfGroup={isLastOfGroup}
                timestamp={item.timestamp}
                status={(item as MessageWithStatus).status}
              />
            </View>
          ) : isFile && item.isMine && !item.fileData && !item.blobId && item.fileName ? (
            /* v26.1: Fichier en cours d'upload (optimistic) — affiche nom + spinner */
            <View style={[styles.mediaContainer, item.isMine && styles.mediaContainerMine]}>
              <InlineFileBubble
                fileData=""
                fileName={item.fileName || 'fichier'}
                fileSize={item.fileSize || 0}
                mimeType={item.fileMimeType || 'application/octet-stream'}
                isMine={item.isMine}
                isFirstOfGroup={isFirstOfGroup}
                isLastOfGroup={isLastOfGroup}
                timestamp={item.timestamp}
                status={'sending'}
              />
            </View>
          ) : isFile && filePayload ? (
            /* Ancien système - Fichier sur serveur distant */
            <View style={[styles.mediaContainer, item.isMine && styles.mediaContainerMine]}>
              <FileMessageBubble 
                payload={filePayload} 
                isMine={item.isMine}
                isFirstOfGroup={isFirstOfGroup}
                isLastOfGroup={isLastOfGroup}
                timestamp={item.timestamp}
                status={(item as MessageWithStatus).status}
              />
            </View>
          ) : isVoice && item.voiceData ? (
            /* v16.0+v25.0: Vocal inline avec barre de progression */
            <View style={[styles.mediaContainer, item.isMine && styles.mediaContainerMine]}>
              <InlineVoiceBubble 
                voiceData={item.voiceData}
                duration={item.voiceDuration || 0}
                messageId={item.id}
                isMine={item.isMine}
                isFirstOfGroup={isFirstOfGroup}
                isLastOfGroup={isLastOfGroup}
                timestamp={item.timestamp}
                status={(item as MessageWithStatus).status}
              />
              {/* v25.0: Barre de progression sous le vocal */}
              {(() => {
                const sendProg = item.isMine ? getSendProgress(item.id) : null;
                if (sendProg && sendProg.phase !== 'complete') {
                  return (
                    <View style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
                      <VoiceProgressBar progress={sendProg.progress} direction="send" />
                    </View>
                  );
                }
                return null;
              })()}
            </View>
          ) : isVoice && item.blobId && item.blobKey ? (
            /* v26.0: Vocal blob non téléchargé — affiche metadata + download */
            <View style={[styles.mediaContainer, item.isMine && styles.mediaContainerMine]}>
              <BlobMediaPlaceholder
                message={item}
                isMine={item.isMine}
                isFirstOfGroup={isFirstOfGroup}
                isLastOfGroup={isLastOfGroup}
                timestamp={item.timestamp}
                status={(item as MessageWithStatus).status}
              />
            </View>
          ) : isVoice && voicePayload ? (
            /* Ancien système - Vocal sur serveur distant */
            <View style={[styles.mediaContainer, item.isMine && styles.mediaContainerMine]}>
              <VoiceMessageBubble 
                payload={voicePayload}
                messageId={item.id}
                isMine={item.isMine}
                isFirstOfGroup={isFirstOfGroup}
                isLastOfGroup={isLastOfGroup}
                timestamp={item.timestamp}
                status={(item as MessageWithStatus).status}
              />
            </View>
          ) : (
            <View style={[
              styles.bubbleWrapper,
              item.isMine ? styles.bubbleWrapperMine : styles.bubbleWrapperTheirs,
              { maxWidth: maxBubbleWidth },
            ]}>
              {/* v21.0: Indicateur de résultat de recherche actuel */}
              {isCurrentSearchResult(item.id) && (
                <View style={[
                  styles.searchResultIndicator,
                  item.isMine ? styles.searchResultIndicatorMine : styles.searchResultIndicatorTheirs,
                ]} />
              )}
              <View style={[
                styles.bubble, 
                item.isMine ? styles.bubbleMine : styles.bubbleTheirs, 
                getBubbleRadius(),
                isSelected && styles.bubbleSelected,
                // v21.0: Style spécial pour le résultat de recherche actuel
                isCurrentSearchResult(item.id) && styles.bubbleSearchActive,
                isSearchResult(item.id) && !isCurrentSearchResult(item.id) && styles.bubbleSearchMatch,
              ]}>
                {/* Quoted message if replying */}
                {/* In production, check if item has replyToId and render QuotedMessage */}
                
                <Text style={[
                  styles.messageText,
                  item.isMine ? styles.messageTextMine : styles.messageTextTheirs,
                ]}>
                  {renderHighlightedText(item.content, item.isMine)}
                </Text>
                
                <View style={styles.messageFooter}>
                  <Text style={[
                    styles.timestamp,
                    item.isMine ? styles.timestampMine : styles.timestampTheirs,
                  ]}>
                    {formatTime(item.timestamp)}
                  </Text>
                  <MessageStatusIcon status={(item as MessageWithStatus).status} isMine={item.isMine} />
                </View>
              </View>
            </View>
          )}
          
          {item.isMine && (
            <TouchableOpacity 
              style={styles.avatarSpaceRight}
              onPress={handleAvatarPress}
              activeOpacity={0.7}
            >
              {showAvatar && (
                <Avatar
                  displayName={item.displayName}
                  senderToken={item.senderToken}
                  avatarUri={getAvatarForMessage(item)}
                  size="small"
                />
              )}
            </TouchableOpacity>
          )}
        </Pressable>
        
        {/* P7 FIX: Actions pour messages échoués (tous types: texte, image, fichier, vocal) */}
        {item.isMine && (item as MessageWithStatus).status === 'failed' && (
          <View style={[styles.failedActionsRow, { alignSelf: 'flex-end', marginRight: 44 }]}>
            <TouchableOpacity 
              style={styles.failedActionBtn} 
              onPress={() => retryMessage(item.id)}
              activeOpacity={0.7}
            >
              <Ionicons name="refresh" size={13} color="#E74C3C" />
              <Text style={styles.failedActionText}>Réessayer</Text>
            </TouchableOpacity>
            <View style={styles.failedActionSep} />
            <TouchableOpacity 
              style={styles.failedActionBtn} 
              onPress={() => deleteFailedMessage(item.id)}
              activeOpacity={0.7}
            >
              <Ionicons name="trash-outline" size={13} color="rgba(255,255,255,0.4)" />
              <Text style={[styles.failedActionText, { color: 'rgba(255,255,255,0.4)' }]}>Supprimer</Text>
            </TouchableOpacity>
          </View>
        )}
        
        {/* Réactions - EN DESSOUS du message (hors du Pressable row) */}
        {hasReactions && (
          <View style={[
            styles.reactionsRow,
            item.isMine ? styles.reactionsRowMine : styles.reactionsRowTheirs,
          ]}>
            <ReactionsDisplay
              reactions={(item as MessageWithStatus).reactions!}
              onPress={(e) => handleLongPressMessage(item.id, e)}
              isMine={item.isMine}
            />
          </View>
        )}
      </View>
    );
    
    return (
      <View key={item.id}>
        {showDate && (
          <View style={styles.dateSeparator}>
            <View style={styles.datePill}>
              <Text style={styles.dateText}>{formatDateSeparator(item.timestamp)}</Text>
            </View>
          </View>
        )}
        
        <AnimatedMessage index={index} isMine={item.isMine} isNew={isNew}>
          <SwipeableMessage 
            isMine={item.isMine}
            onSwipeRight={() => handleReply(item)}
            enabled={!isSelectionMode && !isImage && !isFile}
          >
            {messageContent}
          </SwipeableMessage>
        </AnimatedMessage>
      </View>
    );
  };

  // ============================================
  // MAIN RENDER
  // ============================================
  
  const canSend = inputText.trim().length > 0 && !sending && !sendingImage;
  const selectedFileIcon = selectedFile ? getFileIcon(selectedFile.name.split('.').pop()?.toLowerCase() || '') : '';

  return (
    <View style={styles.container}>
      {/* v21.0: Search Bar */}
      {isSearchMode && (
        <View style={styles.searchBar}>
          <SafeAreaView edges={['top']} style={styles.searchBarSafe}>
            <View style={styles.searchBarContent}>
              <TouchableOpacity onPress={closeSearch} style={styles.searchBackBtn}>
                <Ionicons name="arrow-back" size={24} color={Colors.text.primary} />
              </TouchableOpacity>
              
              <View style={styles.searchInputContainer}>
                <Ionicons name="search" size={18} color={Colors.text.tertiary} style={styles.searchIcon} />
                <TextInput
                  ref={searchInputRef}
                  style={styles.searchInput}
                  placeholder="Rechercher dans la conversation..."
                  placeholderTextColor={Colors.text.tertiary}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoFocus={initialSearchMode}
                  returnKeyType="search"
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.searchClearBtn}>
                    <Ionicons name="close-circle" size={18} color={Colors.text.tertiary} />
                  </TouchableOpacity>
                )}
              </View>
            </View>
            
            {/* Résultats de recherche */}
            {searchQuery.length > 0 && (
              <View style={styles.searchResultsBar}>
                <Text style={styles.searchResultsText}>
                  {searchResults.length === 0 
                    ? 'Aucun résultat' 
                    : searchResults.length === 1
                      ? '1 résultat'
                      : `${currentSearchIndex + 1} sur ${searchResults.length}`
                  }
                </Text>
                
                {searchResults.length > 0 && (
                  <View style={styles.searchNavButtons}>
                    <TouchableOpacity 
                      onPress={handlePrevSearchResult} 
                      style={[styles.searchNavBtn, searchResults.length <= 1 && styles.searchNavBtnDisabled]}
                      disabled={searchResults.length <= 1}
                    >
                      <Ionicons name="chevron-up" size={22} color={searchResults.length > 1 ? Colors.text.primary : Colors.text.tertiary} />
                    </TouchableOpacity>
                    <TouchableOpacity 
                      onPress={handleNextSearchResult} 
                      style={[styles.searchNavBtn, searchResults.length <= 1 && styles.searchNavBtnDisabled]}
                      disabled={searchResults.length <= 1}
                    >
                      <Ionicons name="chevron-down" size={22} color={searchResults.length > 1 ? Colors.text.primary : Colors.text.tertiary} />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}
          </SafeAreaView>
        </View>
      )}

      {/* Header */}
      {isSearchMode ? null : isSelectionMode ? (
        <SelectionHeader 
          selectedCount={selectedIds.size} 
          onClose={exitSelectionMode} 
          onDelete={() => setShowDeleteConfirm(true)} 
        />
      ) : (
        <ChatHeader
          title={conversationInfo.type === '1to1' 
            ? (conversationInfo.name || conversationName) 
            : (conversationInfo.name || conversationName)
          }
          onBackPress={() => navigation.goBack()}
          onTitlePress={() => {
            // @ts-ignore
            navigation.navigate('ContactInfo', { sessionId: conversationId });
          }}
          isEncrypted={true}
          avatar={
            <Avatar
              displayName={conversationInfo.name || conversationName}
              size="medium"
              avatarUri={conversationInfo.avatarBase64}
            />
          }
          subtitle=''
          rightActions={
            conversationInfo.session ? (
              <CallButton1to1 
                sessionId={conversationId} 
                contactName={conversationInfo.name || conversationName} 
              />
            ) : null
          }
        />
      )}

      {/* Main content */}
      <View style={styles.flex}>
        <View style={styles.content}>

          {/* Messages List */}
          <FlatList
            ref={flatListRef}
            data={messages || []}
            extraData={[messages, selectedIds, newMessageIds, searchResults, currentSearchIndex]}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            removeClippedSubviews={false}
            windowSize={15}
            maxToRenderPerBatch={15}
            initialNumToRender={25}
            contentContainerStyle={[
              styles.messagesList, 
              (!messages || messages.length === 0) && styles.messagesListEmpty
            ]}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            // v21.0: Handler pour les erreurs de scroll (recherche)
            onScrollToIndexFailed={(info) => {
              // Attendre que l'item soit rendu puis réessayer
              setTimeout(() => {
                if (flatListRef.current && messages && messages.length > info.index) {
                  flatListRef.current.scrollToIndex({ 
                    index: info.index, 
                    animated: true,
                    viewPosition: 0.5 
                  });
                }
              }, 100);
            }}
            ListFooterComponent={
              <>
                {/* v25.0: Placeholders pour médias en cours de réception */}
                {receiveEntries.length > 0 && receiveEntries.map((entry) => (
                  <View 
                    key={`recv-${entry.messageId}`}
                    style={[styles.mediaContainer, { marginVertical: 4, marginLeft: 52 }]}
                  >
                    <IncomingMediaPlaceholder
                      mediaType={entry.mediaType}
                      progress={entry.progress}
                      receivedChunks={entry.completedChunks}
                      totalChunks={entry.totalChunks}
                    />
                  </View>
                ))}
                {isTyping && <TypingIndicator senderName={typingUser || undefined} />}
                {/* Spacer pour éviter que le dernier message soit collé à l'input */}
                <View style={styles.listFooterSpacer} />
              </>
            }
            ListEmptyComponent={
              loading ? (
                <View style={styles.loadingWrap}>
                  <ActivityIndicator size="large" color={Colors.accent.primary} />
                  <Text style={styles.loadingText}>Chargement des messages...</Text>
                </View>
              ) : (
                <EmptyState onInvite={handleOpenShare} />
              )
            }
          />

          {/* Attachment Menu */}
          {showAttachMenu && (
            <Animated.View
              style={[
                styles.attachMenu,
                {
                  opacity: attachMenuAnim,
                  transform: [
                    { 
                      translateY: attachMenuAnim.interpolate({ 
                        inputRange: [0, 1], 
                        outputRange: [20, 0] 
                      }) 
                    },
                    {
                      scale: attachMenuAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.95, 1],
                      }),
                    },
                  ],
                },
              ]}
            >
              <View style={styles.attachGrid}>
                <TouchableOpacity style={styles.attachItem} onPress={handlePickGallery} activeOpacity={0.7}>
                  <View style={[styles.attachIconCircle, { backgroundColor: '#BF59CF' }]}>
                    <Icons.Image size={24} color="#FFF" />
                  </View>
                  <Text style={styles.attachLabel}>Galerie</Text>
                </TouchableOpacity>
                
                <TouchableOpacity style={styles.attachItem} onPress={handlePickCamera} activeOpacity={0.7}>
                  <View style={[styles.attachIconCircle, { backgroundColor: '#D3455B' }]}>
                    <Icons.Camera size={24} color="#FFF" />
                  </View>
                  <Text style={styles.attachLabel}>Caméra</Text>
                </TouchableOpacity>
                
                <TouchableOpacity style={styles.attachItem} onPress={handlePickFile} activeOpacity={0.7}>
                  <View style={[styles.attachIconCircle, { backgroundColor: '#0795DC' }]}>
                    <Icons.File size={24} color="#FFF" />
                  </View>
                  <Text style={styles.attachLabel}>Document</Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          )}

          {/* Emoji Picker */}
          {showEmojiPicker && (
            <Animated.View style={[
              styles.emojiPickerContainer,
              {
                opacity: emojiPickerAnim,
                transform: [{
                  translateY: emojiPickerAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [50, 0]
                  })
                }]
              }
            ]}>
              <ScrollView 
                horizontal={false} 
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.emojiGrid}
              >
                <View style={styles.emojiSection}>
                  <Text style={styles.emojiSectionTitle}>Smileys</Text>
                  <View style={styles.emojiRow}>
                    {['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😜', '🤪', '😎', '🤩', '🥳', '😏', '😒', '🙄', '😬', '😌', '😔', '😢', '😭', '😱', '😡', '🥺', '😴'].map((emoji, i) => (
                      <TouchableOpacity 
                        key={i} 
                        style={styles.emojiButton} 
                        onPress={() => handleEmojiSelect(emoji)}
                        activeOpacity={0.6}
                      >
                        <Text style={styles.emoji}>{emoji}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                <View style={styles.emojiSection}>
                  <Text style={styles.emojiSectionTitle}>Gestes</Text>
                  <View style={styles.emojiRow}>
                    {['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👋', '🙌', '👏', '🙏', '💪', '🖐️', '✋', '🤚'].map((emoji, i) => (
                      <TouchableOpacity 
                        key={i} 
                        style={styles.emojiButton} 
                        onPress={() => handleEmojiSelect(emoji)}
                        activeOpacity={0.6}
                      >
                        <Text style={styles.emoji}>{emoji}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                <View style={styles.emojiSection}>
                  <Text style={styles.emojiSectionTitle}>Objets</Text>
                  <View style={styles.emojiRow}>
                    {['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '❤️‍🔥', '💯', '💥', '✨', '🔥', '⭐', '🌟', '💫'].map((emoji, i) => (
                      <TouchableOpacity 
                        key={i} 
                        style={styles.emojiButton} 
                        onPress={() => handleEmojiSelect(emoji)}
                        activeOpacity={0.6}
                      >
                        <Text style={styles.emoji}>{emoji}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              </ScrollView>
            </Animated.View>
          )}

          {/* Reply Bar */}
          <ReplyBar replyTo={replyTo} onCancel={() => setReplyTo(null)} />

          {/* === MODE MAINS LIBRES (verrouillé) === */}
          {recordingLocked && (
            <Animated.View 
              style={[
                styles.lockedRecordingBar,
                {
                  opacity: recordingAnim,
                  transform: [{
                    translateY: recordingAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [20, 0],
                    }),
                  }],
                },
              ]}
            >
              {/* Bouton Annuler (poubelle) */}
              <TouchableOpacity
                style={styles.lockedCancelBtn}
                onPress={handleCancelRecording}
                activeOpacity={0.7}
              >
                <Ionicons name="trash-outline" size={22} color={Colors.accent.error} />
              </TouchableOpacity>

              {/* Zone centrale: Indicateur + Waveform */}
              <View style={styles.lockedCenterContent}>
                {/* Indicateur d'enregistrement */}
                <View style={styles.lockedIndicator}>
                  <Animated.View 
                    style={[
                      styles.recordingDot,
                      { transform: [{ scale: recordingPulse }] },
                    ]}
                  />
                  <Text style={styles.lockedDuration}>
                    {formatVoiceDuration(recordingDuration)}
                  </Text>
                </View>

                {/* Waveform animée */}
                <View style={styles.lockedWaveform}>
                  {recordingWaveform.slice(-25).map((level, i) => (
                    <Animated.View
                      key={i}
                      style={[
                        styles.lockedWaveformBar,
                        { 
                          height: Math.max(4, level * 24),
                          opacity: 0.5 + (i / 50), // Fade in effect
                        },
                      ]}
                    />
                  ))}
                </View>
              </View>

              {/* Bouton Envoyer */}
              <TouchableOpacity
                style={styles.lockedSendBtn}
                onPress={handleStopRecording}
                activeOpacity={0.8}
              >
                <Icons.Send size={22} color="#FFF" />
              </TouchableOpacity>
            </Animated.View>
          )}

          {/* Input Bar - visible sauf en mode verrouillé */}
          {!recordingLocked && (
            <Animated.View style={[
              styles.inputBar,
              { paddingBottom: Animated.add(keyboardHeight, insets.bottom || Space.sm) }
            ]}>
              <View style={styles.inputRow}>
                {/* Emoji button - caché pendant l'enregistrement */}
                {!isRecordingVoice && (
                  <TouchableOpacity 
                    onPress={toggleEmojiPicker} 
                    style={styles.inputIconInline}
                    activeOpacity={0.7}
                  >
                    {showEmojiPicker ? (
                      <Icons.Keyboard size={24} color={Colors.accent.primary} />
                    ) : (
                      <Icons.Emoji size={24} color={Colors.text.secondary} />
                    )}
                  </TouchableOpacity>
                )}
                
                {/* Zone de saisie OU barre d'enregistrement */}
                {isRecordingVoice ? (
                  // === BARRE D'ENREGISTREMENT (remplace le TextInput) ===
                  <View style={styles.recordingFieldContainer}>
                    {/* Icône poubelle à gauche */}
                    <TouchableOpacity
                      style={styles.recordingTrashBtn}
                      onPress={handleCancelRecording}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="trash-outline" size={20} color={Colors.accent.error} />
                    </TouchableOpacity>
                    
                    {/* Texte "Glisser pour annuler" avec animation */}
                    <View style={styles.recordingSlideHint}>
                      <Ionicons name="chevron-back" size={14} color={Colors.text.tertiary} />
                      <Text style={styles.recordingSlideText}>Glisser pour annuler</Text>
                    </View>
                    
                    {/* Indicateur rouge + Durée */}
                    <View style={styles.recordingDurationBox}>
                      <Animated.View 
                        style={[
                          styles.recordingDot,
                          { transform: [{ scale: recordingPulse }] }
                        ]} 
                      />
                      <Text style={styles.recordingDuration}>
                        {formatVoiceDuration(recordingDuration)}
                      </Text>
                    </View>
                  </View>
                ) : (
                  // === TEXT INPUT NORMAL ===
                  <View style={styles.inputFieldContainer}>
                    <TextInput
                      ref={inputRef}
                      style={styles.textInput}
                      value={inputText}
                      onChangeText={setInputText}
                      placeholder="Message"
                      placeholderTextColor={Colors.text.tertiary}
                      multiline
                      onFocus={handleInputFocus}
                      onBlur={handleInputBlur}
                      keyboardAppearance="dark"
                    />
                    
                    <TouchableOpacity 
                      onPress={toggleAttachMenu} 
                      style={styles.inputIconInline}
                      activeOpacity={0.7}
                    >
                      <Icons.Attach size={22} color={showAttachMenu ? Colors.accent.primary : Colors.text.secondary} />
                    </TouchableOpacity>
                  </View>
                )}
                
                {/* Bouton Send ou Micro */}
                <Animated.View style={{ transform: [{ scale: sendButtonScale }] }}>
                  {canSend ? (
                    <TouchableOpacity 
                      style={styles.sendBtn} 
                      onPress={handleSend} 
                      activeOpacity={0.8}
                      disabled={sending}
                    >
                      <Icons.Send size={20} color="#FFF" />
                    </TouchableOpacity>
                  ) : (
                    <VoiceRecordButton
                      onRecordStart={handleStartRecording}
                      onRecordEnd={handleStopRecording}
                      onRecordCancel={handleCancelRecording}
                      onRecordLock={handleLockRecording}
                      isRecording={isRecordingVoice}
                      isLocked={recordingLocked}
                      isSending={sendingVoice}
                      disabled={voiceDisabledByCall}
                    />
                  )}
                </Animated.View>
              </View>
            </Animated.View>
          )}
        </View>
      </View>

      {/* Reaction Picker Modal */}
      <ReactionPicker
        visible={showReactionPicker}
        position={reactionPosition}
        onSelect={(emoji) => reactionMessageId && handleReaction(reactionMessageId, emoji)}
        onClose={() => setShowReactionPicker(false)}
        selectedEmojis={
          reactionMessageId 
            ? (messages.find(m => m.id === reactionMessageId) as MessageWithStatus)?.reactions
                ?.filter(r => r.userReacted)
                ?.map(r => r.emoji) || []
            : []
        }
      />

      {/* Image Preview Modal */}
      {selectedImage && (
        <Modal visible={true} transparent animationType="fade">
          <View style={styles.previewScreen}>
            <View style={[styles.previewHeader, { paddingTop: insets.top + 12 }]}>
              <TouchableOpacity style={styles.previewClose} onPress={() => setSelectedImage(null)}>
                <Icons.Close size={24} color="#FFF" />
              </TouchableOpacity>
              <Text style={styles.previewTitle}>Aperçu</Text>
              <View style={{ width: 48 }} />
            </View>
            
            <Image source={{ uri: selectedImage }} style={styles.previewImg} resizeMode="contain" />
            
            {sendingImage && (
              <View style={styles.previewOverlay}>
                <ActivityIndicator size="large" color={Colors.accent.primary} />
                <Text style={styles.previewProgress}>{imageProgress}</Text>
              </View>
            )}
            
            <View style={styles.previewFooter}>
              <Text style={styles.previewHint}>🔐 Chiffré avant l'envoi</Text>
              <View style={styles.previewActions}>
                <TouchableOpacity 
                  style={styles.previewCancelBtn} 
                  onPress={() => setSelectedImage(null)}
                  disabled={sendingImage}
                >
                  <Text style={styles.previewCancelText}>Annuler</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.previewSendBtn} 
                  onPress={handleSendImage}
                  disabled={sendingImage}
                >
                  <Icons.Send size={18} color="#FFF" />
                  <Text style={styles.previewSendText}>Envoyer</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* File Preview Modal */}
      {selectedFile && (
        <Modal visible={true} transparent animationType="fade">
          <View style={styles.previewScreen}>
            <View style={[styles.previewHeader, { paddingTop: insets.top + 12 }]}>
              <TouchableOpacity style={styles.previewClose} onPress={() => setSelectedFile(null)}>
                <Icons.Close size={24} color="#FFF" />
              </TouchableOpacity>
              <Text style={styles.previewTitle}>Fichier</Text>
              <View style={{ width: 48 }} />
            </View>
            
            <View style={styles.filePreviewBody}>
              <View style={styles.filePreviewIcon}>
                <Text style={{ fontSize: 44 }}>{selectedFileIcon}</Text>
              </View>
              <Text style={styles.filePreviewName}>{selectedFile.name}</Text>
              <Text style={styles.filePreviewSize}>{formatFileSize(selectedFile.size)}</Text>
            </View>
            
            {sendingFile && (
              <View style={styles.previewOverlay}>
                <ActivityIndicator size="large" color={Colors.accent.primary} />
                <Text style={styles.previewProgress}>{fileProgress}</Text>
              </View>
            )}
            
            <View style={styles.previewFooter}>
              <Text style={styles.previewHint}>🔐 Chiffré avant l'envoi</Text>
              <View style={styles.previewActions}>
                <TouchableOpacity 
                  style={styles.previewCancelBtn} 
                  onPress={() => setSelectedFile(null)}
                  disabled={sendingFile}
                >
                  <Text style={styles.previewCancelText}>Annuler</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.previewSendBtn} 
                  onPress={handleSendFile}
                  disabled={sendingFile}
                >
                  <Icons.Send size={18} color="#FFF" />
                  <Text style={styles.previewSendText}>Envoyer</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* Image Viewer Modal */}
      {viewerImage && (
        <Modal visible={true} transparent animationType="fade">
          <View style={styles.viewerScreen}>
            <View style={[styles.viewerHeader, { paddingTop: insets.top + 12 }]}>
              <TouchableOpacity style={styles.viewerClose} onPress={() => setViewerImage(null)}>
                <Icons.Close size={24} color="#FFF" />
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              <TouchableOpacity 
                style={styles.viewerDownload}
                onPress={async () => {
                  try {
                    const { status } = await MediaLibrary.requestPermissionsAsync();
                    if (status !== 'granted') {
                      Alert.alert('Permission requise', 'Ghostr a besoin d\'accéder à votre galerie.');
                      return;
                    }
                    // v25.2: saveToLibraryAsync nécessite un file URI local
                    let saveUri = viewerImage;
                    if (viewerImage.startsWith('data:')) {
                      // Legacy base64 data URI → écrire dans un fichier temp
                      const b64 = viewerImage.split(',')[1];
                      saveUri = `${FileSystem.cacheDirectory}ghostr_save_${Date.now()}.jpg`;
                      await FileSystem.writeAsStringAsync(saveUri, b64, { encoding: FileSystem.EncodingType.Base64 });
                    }
                    await MediaLibrary.saveToLibraryAsync(saveUri);
                    Alert.alert('Succès', 'Image enregistrée dans la galerie');
                  } catch (e) {
                    Alert.alert('Erreur', 'Impossible de sauvegarder l\'image');
                  }
                }}
              >
                <Icons.Download size={22} color="#FFF" />
              </TouchableOpacity>
            </View>
            <Image source={{ uri: viewerImage }} style={styles.viewerImg} resizeMode="contain" />
          </View>
        </Modal>
      )}

      {/* Profile Modal */}
      <Modal
        visible={profileModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setProfileModalVisible(false)}
      >
        <Pressable 
          style={styles.profileModalOverlay} 
          onPress={() => setProfileModalVisible(false)}
        >
          <View style={styles.profileModalContent}>
            <View style={styles.profileModalAvatar}>
              <Avatar
                displayName={selectedProfile?.displayName}
                senderToken={selectedProfile?.senderToken}
                avatarUri={selectedProfile?.avatarBase64}
                size="xlarge"
              />
            </View>
            <Text style={styles.profileModalName}>
              {selectedProfile?.displayName || 'Anonyme'}
            </Text>
            <View style={styles.profileModalDivider} />
            <TouchableOpacity 
              style={styles.profileModalCloseButton}
              onPress={() => setProfileModalVisible(false)}
            >
              <Text style={styles.profileModalCloseText}>Fermer</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* Action Sheet Menu */}
      <ActionSheet
        visible={showMenu}
        onClose={() => setShowMenu(false)}
        items={[
          { title: 'Inviter quelqu\'un', onPress: handleOpenShare },
          { title: 'Supprimer tous les messages', onPress: () => setShowDeleteAllConfirm(true), destructive: true },
        ]}
      />

      {/* Share Modal */}
      {showShareModal && shareMasterKey && (
        <InviteModal
          visible={showShareModal}
          onClose={() => setShowShareModal(false)}
          conversationName={conversationName}
          masterKey={shareMasterKey}
        />
      )}

      {/* Delete Confirmation Modal */}
      <AlertModal
        visible={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Supprimer les messages"
        message={`Voulez-vous vraiment supprimer ${selectedIds.size} message(s) ? Cette action est irréversible.`}
        primaryButton={{
          title: 'Supprimer',
          onPress: handleDeleteSelected,
          variant: 'danger',
          loading: deleteLoading,
        }}
        secondaryButton={{
          title: 'Annuler',
          onPress: () => setShowDeleteConfirm(false),
        }}
      />

      {/* Delete All Confirmation Modal */}
      <AlertModal
        visible={showDeleteAllConfirm}
        onClose={() => setShowDeleteAllConfirm(false)}
        title="Supprimer tous les messages"
        message="Voulez-vous vraiment supprimer tous les messages de cette conversation ? Cette action est irréversible."
        primaryButton={{
          title: 'Tout supprimer',
          onPress: handleDeleteAll,
          variant: 'danger',
          loading: deleteLoading,
        }}
        secondaryButton={{
          title: 'Annuler',
          onPress: () => setShowDeleteAllConfirm(false),
        }}
      />

    </View>
  );
}

// ============================================
// STYLES
// ============================================

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: Colors.bg.primary,
  },
  flex: { 
    flex: 1,
  },
  content: { 
    flex: 1,
  },
  
  // Messages list
  messagesList: { 
    paddingTop: Space.md,
    paddingBottom: Space.xxl,  // Plus d'espace en bas pour respiration
    paddingHorizontal: Space.xs,
  },
  messagesListEmpty: { 
    flex: 1, 
    justifyContent: 'center',
  },
  listFooterSpacer: {
    height: Space.lg,  // 16px d'espace après le dernier message
  },
  
  // Loading state
  loadingWrap: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center', 
    paddingVertical: Space.xxxxl,
  },
  loadingText: { 
    color: Colors.text.secondary, 
    marginTop: Space.md, 
    fontSize: Type.size.md,
  },
  
  // Empty state
  emptyState: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center', 
    padding: Space.xxxl,
  },
  emptyIconWrap: { 
    width: 100, 
    height: 100, 
    borderRadius: 50, 
    backgroundColor: Colors.bg.elevated, 
    justifyContent: 'center', 
    alignItems: 'center', 
    marginBottom: Space.xxl,
    position: 'relative',
  },
  emptyIconGlow: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.accent.primaryMuted,
  },
  emptyIcon: { 
    fontSize: 44,
  },
  emptyTitle: { 
    fontSize: Type.size.xl, 
    fontWeight: Type.weight.bold, 
    color: Colors.text.primary, 
    marginBottom: Space.sm,
  },
  emptySubtitle: { 
    fontSize: Type.size.md, 
    color: Colors.text.secondary, 
    textAlign: 'center', 
    lineHeight: 22, 
    marginBottom: Space.xxl,
  },
  emptyBtn: { 
    backgroundColor: Colors.accent.primary, 
    paddingVertical: Space.md, 
    paddingHorizontal: Space.xxl, 
    borderRadius: Radius.full,
    position: 'relative',
    overflow: 'hidden',
  },
  emptyBtnGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  emptyBtnText: { 
    fontSize: Type.size.base, 
    fontWeight: Type.weight.semibold, 
    color: Colors.text.inverse, // White text on primary buttons
  },

  // v21.0: Search bar styles
  searchBar: {
    backgroundColor: Colors.bg.primary,
    borderBottomWidth: 1,
    borderBottomColor: Colors.ui.border,
  },
  searchBarSafe: {
    backgroundColor: Colors.bg.primary,
  },
  searchBarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Space.sm,
    paddingVertical: Space.sm,
    gap: Space.sm,
  },
  searchBackBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchInputContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bg.elevated,
    borderRadius: Radius.lg,
    paddingHorizontal: Space.md,
    height: 40,
  },
  searchIcon: {
    marginRight: Space.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: Type.size.base,
    color: Colors.text.primary,
    paddingVertical: 0,
  },
  searchClearBtn: {
    padding: Space.xs,
  },
  searchResultsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
    backgroundColor: Colors.bg.secondary,
    borderTopWidth: 1,
    borderTopColor: Colors.ui.border,
  },
  searchResultsText: {
    fontSize: Type.size.sm,
    color: Colors.text.secondary,
    fontWeight: Type.weight.medium,
  },
  searchNavButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
  searchNavBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: Radius.full,
    backgroundColor: Colors.bg.elevated,
  },
  searchNavBtnDisabled: {
    opacity: 0.4,
  },
  
  // v21.0: Styles de surlignage des résultats de recherche
  // Inspiré de WhatsApp/Telegram - jaune vif pour maximum de visibilité
  searchHighlightText: {
    borderRadius: 3,
    paddingHorizontal: 2,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  searchHighlightTextMine: {
    // Jaune vif pour les bulles vertes - excellent contraste
    backgroundColor: '#FFE066',
    color: '#1A1A1A',
    fontWeight: '600' as const,
  },
  searchHighlightTextTheirs: {
    // Jaune légèrement plus doux pour les bulles grises
    backgroundColor: '#FFD93D', 
    color: '#1A1A1A',
    fontWeight: '600' as const,
  },
  
  // Style pour la bulle du résultat de recherche actuel (très visible)
  bubbleSearchActive: {
    // Bordure accent épaisse + glow effect via shadow
    borderWidth: 2,
    borderColor: Colors.accent.primary,
    // Compenser la bordure dans le padding
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
    // Glow subtil
    shadowColor: Colors.accent.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  
  // Style pour les autres résultats de recherche (subtil mais visible)
  bubbleSearchMatch: {
    borderWidth: 1,
    borderColor: 'rgba(0, 217, 166, 0.5)',
    paddingHorizontal: 13,
    paddingTop: 9,
    paddingBottom: 7,
  },
  
  // Indicateur visuel du résultat actuel (barre latérale style WhatsApp)
  searchResultIndicator: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    width: 4,
    backgroundColor: Colors.accent.primary,
    borderRadius: 2,
  },
  searchResultIndicatorMine: {
    right: -10,
  },
  searchResultIndicatorTheirs: {
    left: -10,
  },
  
  // Date separator
  dateSeparator: { 
    alignItems: 'center', 
    marginVertical: Space.lg,
    marginTop: Space.xl,
  },
  datePill: { 
    backgroundColor: Colors.bg.glass, 
    paddingHorizontal: Space.md, 
    paddingVertical: Space.xs + 2, 
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.ui.borderLight,
  },
  dateText: { 
    fontSize: Type.size.xs, 
    color: Colors.text.secondary, 
    fontWeight: Type.weight.medium,
  },
  
  // Typing indicator
  typingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
    marginLeft: MESSAGE_AVATAR_SIZE + Space.md,
  },
  typingBubble: {
    backgroundColor: Colors.bg.elevated,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    borderRadius: Radius.lg,
    borderTopLeftRadius: Radius.xs,
  },
  typingDotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.accent.primary,
  },
  typingText: {
    marginLeft: Space.sm,
    fontSize: Type.size.sm,
    color: Colors.text.secondary,
    fontStyle: 'italic',
  },
  
  // Swipeable message
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
    backgroundColor: Colors.accent.primary,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Colors.accent.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  
  // Message row
  messageRow: { 
    flexDirection: 'row', 
    paddingHorizontal: Space.sm,
    alignItems: 'flex-end',
  },
  messageRowMine: { 
    justifyContent: 'flex-end',
  },
  messageRowTheirs: { 
    justifyContent: 'flex-start',
  },
  
  // Avatar spaces
  avatarSpaceLeft: {
    width: MESSAGE_AVATAR_SIZE,
    marginRight: Space.sm,
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginBottom: -6,
  },
  avatarSpaceRight: {
    width: MESSAGE_AVATAR_SIZE,
    marginLeft: Space.sm,
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginBottom: -6,
  },
  
  // Bubble wrapper
  bubbleWrapper: {
    position: 'relative',
  },
  bubbleWrapperMine: {},
  bubbleWrapperTheirs: {},
  
  senderName: {
    fontSize: Type.size.sm,
    fontWeight: Type.weight.semibold,
    marginBottom: 2,
    marginLeft: 14,
  },
  
  // Main bubble
  bubble: { 
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
    minWidth: 60,
  },
  bubbleMine: { 
    backgroundColor: Colors.bubble.outgoing,
  },
  bubbleTheirs: { 
    backgroundColor: Colors.bubble.incoming,
  },
  bubbleSelected: { 
    opacity: 0.7,
  },
  
  // Quoted message
  quotedMessage: {
    flexDirection: 'row',
    backgroundColor: Colors.bubble.reply,
    borderRadius: Radius.sm,
    marginBottom: Space.xs,
    overflow: 'hidden',
  },
  quotedMessageCompact: {
    marginBottom: 0,
  },
  quotedMessageMine: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  quotedBorder: {
    width: 3,
    backgroundColor: Colors.accent.primary,
  },
  quotedBorderMine: {
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  quotedContent: {
    flex: 1,
    padding: Space.sm,
  },
  quotedSender: {
    fontSize: Type.size.xs,
    fontWeight: Type.weight.semibold,
    color: Colors.accent.primary,
    marginBottom: 2,
  },
  quotedSenderMine: {
    color: 'rgba(255,255,255,0.8)',
  },
  quotedText: {
    fontSize: Type.size.sm,
    color: Colors.text.secondary,
  },
  
  // Reply bar
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bg.elevated,
    paddingLeft: 0,
    paddingRight: Space.sm,
    paddingVertical: Space.sm,
    marginHorizontal: Space.sm,
    marginBottom: Space.xs,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  replyBarBorder: {
    width: 3,
    alignSelf: 'stretch',
    borderTopLeftRadius: Radius.md,
    borderBottomLeftRadius: Radius.md,
    marginRight: Space.sm,
  },
  replyBarContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  replyBarIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.accent.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Space.sm,
  },
  replyBarText: {
    flex: 1,
  },
  replyBarSender: {
    fontSize: Type.size.xs,
    fontWeight: Type.weight.semibold,
    color: Colors.accent.primary,
    marginBottom: 1,
  },
  replyBarPreview: {
    fontSize: Type.size.sm,
    color: Colors.text.secondary,
  },
  replyBarClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.bg.tertiary,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: Space.sm,
  },
  
  // Message text
  messageText: { 
    fontSize: Type.size.base, 
    lineHeight: 21,
  },
  messageTextMine: {
    color: Colors.text.onBubbleMine,
  },
  messageTextTheirs: {
    color: Colors.text.onBubbleTheirs,
  },
  
  // Message footer
  messageFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 3,
    gap: 4,
  },
  timestamp: { 
    fontSize: 11,
  },
  timestampMine: { 
    color: 'rgba(255,255,255,0.6)',
  },
  timestampTheirs: { 
    color: 'rgba(255,255,255,0.5)',
  },
  
  // P7 FIX: Failed message retry/delete actions
  failedActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingTop: 4,
    paddingHorizontal: 2,
    gap: 0,
  },
  failedActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: 6,
    gap: 4,
  },
  failedActionText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#E74C3C',
  },
  failedActionSep: {
    width: 1,
    height: 12,
    backgroundColor: 'rgba(255,255,255,0.15)',
    marginHorizontal: 2,
  },
  
  // Reactions
  reactionOverlay: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  // Message with reactions wrapper (vertical layout)
  messageWithReactionsWrapper: {
    flexDirection: 'column',
  },
  reactionsRow: {
    flexDirection: 'row',
    paddingHorizontal: Space.sm,
    marginTop: -4,
    marginBottom: 2,
  },
  reactionsRowMine: {
    justifyContent: 'flex-end',
    paddingRight: 44, // Aligné avec la bulle (avatar space)
  },
  reactionsRowTheirs: {
    justifyContent: 'flex-start',
    paddingLeft: 44, // Aligné avec la bulle (avatar space)
  },
  
  // Reaction Picker (modal) - Compact et responsive
  reactionPicker: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bg.elevated,
    borderRadius: 12,
    paddingHorizontal: 4,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: Colors.ui.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 10,
  },
  reactionPickerEmoji: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  reactionPickerEmojiSelected: {
    backgroundColor: 'rgba(0, 217, 166, 0.15)',
    borderColor: Colors.accent.primary,
  },
  reactionPickerEmojiText: {
    fontSize: 20,
  },
  reactionPickerEmojiTextSelected: {
    // Style identique, le contour suffit
  },
  
  // Reactions Display (Messenger-style pill under message)
  reactionsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bg.elevated,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: Colors.ui.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  reactionsContainerMine: {
    // Styles spécifiques pour mes messages (si nécessaire)
  },
  reactionsContainerSelected: {
    borderColor: Colors.accent.primary,
    backgroundColor: 'rgba(0, 217, 166, 0.1)',
  },
  reactionsEmojis: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reactionEmoji: {
    fontSize: 14,
  },
  reactionEmojiOverlap: {
    marginLeft: -2,
  },
  reactionsCount: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.text.secondary,
    marginLeft: 4,
  },
  
  // Legacy styles (kept for compatibility)
  reactionItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reactionItemSelected: {
    backgroundColor: Colors.reaction.selected,
  },
  reactionItemEmoji: {
    fontSize: 14,
  },
  reactionItemCount: {
    fontSize: 11,
    color: Colors.text.secondary,
    marginLeft: 2,
  },
  
  // Checkbox
  checkbox: { 
    width: 22, 
    height: 22, 
    borderRadius: 11, 
    borderWidth: 2, 
    borderColor: Colors.ui.border, 
    marginRight: Space.sm, 
    justifyContent: 'center', 
    alignItems: 'center', 
    backgroundColor: Colors.bg.elevated,
  },
  checkboxSelected: { 
    backgroundColor: Colors.accent.primary, 
    borderColor: Colors.accent.primary,
  },
  checkmark: { 
    color: '#FFF', 
    fontSize: 12, 
    fontWeight: Type.weight.bold,
  },
  
  // Media container
  mediaContainer: {
    marginRight: '25%',
  },
  mediaContainerMine: {
    marginRight: 0,
    marginLeft: '25%',
  },
  
  // Image bubble
  imageBubble: { 
    overflow: 'hidden', 
    justifyContent: 'center', 
    alignItems: 'center', 
    backgroundColor: Colors.bg.elevated,
  },
  thumbnailImage: { 
    width: '100%', 
    height: '100%',
  },
  imageMetaGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: Space.xxl,
    paddingBottom: Space.sm,
    paddingHorizontal: Space.sm,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  imageMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Space.xs,
  },
  imageMetaText: { 
    color: '#FFF', 
    fontSize: Type.size.xs, 
    fontWeight: Type.weight.medium,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  imageMetaCheck: {
    marginLeft: Space.xxs,
  },
  imageError: { 
    flex: 1,
    justifyContent: 'center', 
    alignItems: 'center',
  },
  imageErrorIcon: { 
    fontSize: 32,
  },
  retryBtn: { 
    marginTop: Space.sm, 
    backgroundColor: Colors.accent.primary, 
    paddingHorizontal: Space.md, 
    paddingVertical: Space.xs, 
    borderRadius: Radius.sm,
  },
  retryText: { 
    color: Colors.text.inverse, // White text on primary buttons 
    fontSize: Type.size.xs,
    fontWeight: Type.weight.medium,
  },
  
  // File bubble
  fileBubble: { 
    minWidth: 220, 
    maxWidth: '100%', 
    padding: 14, 
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: 12,
  },
  fileBubbleMine: { 
    backgroundColor: Colors.bubble.outgoing,
  },
  fileBubbleTheirs: { 
    backgroundColor: Colors.bubble.incoming,
  },
  fileIconWrap: { 
    width: 48, 
    height: 48, 
    borderRadius: Radius.md, 
    justifyContent: 'center', 
    alignItems: 'center',
  },
  fileIconWrapMine: { 
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  fileIconWrapTheirs: { 
    backgroundColor: Colors.accent.primaryMuted,
  },
  fileIconEmoji: { 
    fontSize: 22,
  },
  fileDetails: { 
    flex: 1,
  },
  fileName: { 
    fontSize: Type.size.sm, 
    fontWeight: Type.weight.medium, 
    color: Colors.text.primary,
    marginBottom: Space.xxs,
  },
  fileMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  fileSize: { 
    fontSize: Type.size.xs, 
    color: Colors.text.secondary,
  },
  fileSizeMine: { 
    color: 'rgba(255,255,255,0.6)',
  },
  fileTime: {
    fontSize: Type.size.xs,
    color: Colors.text.secondary,
  },
  fileTimeMine: {
    color: 'rgba(255,255,255,0.6)',
  },
  
  // Input bar
  inputBar: { 
    backgroundColor: Colors.bg.primary, 
    paddingTop: Space.sm, 
    paddingHorizontal: Space.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.ui.divider,
  },
  inputRow: { 
    flexDirection: 'row', 
    alignItems: 'flex-end', 
    gap: Space.xs,
  },
  inputFieldContainer: { 
    flex: 1, 
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: Colors.bg.elevated, 
    borderRadius: Radius.xxl,
    paddingHorizontal: Space.sm,
    paddingVertical: Platform.OS === 'ios' ? Space.xs : 2,
    minHeight: 48,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: Colors.ui.borderLight,
  },
  inputIconInline: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Platform.OS === 'ios' ? 2 : 0,
  },
  textInput: { 
    flex: 1,
    fontSize: Type.size.base,
    color: Colors.text.primary, 
    maxHeight: 100, 
    lineHeight: 22,
    paddingTop: Platform.OS === 'ios' ? 8 : 6,
    paddingBottom: Platform.OS === 'ios' ? 8 : 6,
    paddingHorizontal: Space.xs,
    textAlignVertical: 'center',
  },
  sendBtn: { 
    width: 48, 
    height: 48, 
    borderRadius: 24, 
    backgroundColor: Colors.accent.primary, 
    justifyContent: 'center', 
    alignItems: 'center',
  },
  micBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.accent.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  
  // Emoji picker
  emojiPickerContainer: {
    backgroundColor: Colors.bg.primary,
    maxHeight: 280,
    borderTopWidth: 1,
    borderTopColor: Colors.ui.divider,
  },
  emojiGrid: {
    paddingHorizontal: Space.sm,
    paddingVertical: Space.sm,
  },
  emojiSection: {
    marginBottom: Space.md,
  },
  emojiSectionTitle: {
    fontSize: Type.size.xs,
    fontWeight: Type.weight.semibold,
    color: Colors.text.tertiary,
    marginBottom: Space.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  emojiRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  emojiButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: Radius.sm,
  },
  emoji: {
    fontSize: 28,
  },
  
  // Attach menu
  attachMenu: { 
    backgroundColor: Colors.bg.primary, 
    paddingVertical: Space.xl, 
    paddingHorizontal: Space.lg, 
    borderTopWidth: 1, 
    borderTopColor: Colors.ui.divider,
  },
  attachGrid: { 
    flexDirection: 'row', 
    justifyContent: 'space-around',
  },
  attachItem: { 
    alignItems: 'center',
  },
  attachIconCircle: { 
    width: 56, 
    height: 56, 
    borderRadius: 28, 
    justifyContent: 'center', 
    alignItems: 'center', 
    marginBottom: Space.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 5,
  },
  attachLabel: { 
    fontSize: Type.size.xs, 
    color: Colors.text.secondary, 
    fontWeight: Type.weight.medium,
  },
  
  // Preview screens
  previewScreen: { 
    flex: 1, 
    backgroundColor: Colors.bg.primary,
  },
  previewHeader: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingHorizontal: Space.lg, 
    paddingBottom: Space.lg,
  },
  previewClose: { 
    width: 48, 
    height: 48, 
    borderRadius: 24, 
    backgroundColor: Colors.bg.elevated, 
    justifyContent: 'center', 
    alignItems: 'center',
  },
  previewTitle: { 
    fontSize: Type.size.lg, 
    fontWeight: Type.weight.semibold, 
    color: Colors.text.primary,
  },
  previewImg: { 
    flex: 1, 
    margin: Space.lg, 
    borderRadius: Radius.md,
  },
  previewOverlay: { 
    ...StyleSheet.absoluteFillObject, 
    backgroundColor: Colors.ui.overlay, 
    justifyContent: 'center', 
    alignItems: 'center', 
    gap: Space.md,
  },
  previewProgress: { 
    color: Colors.text.primary, 
    fontSize: Type.size.md,
    marginTop: Space.sm,
  },
  previewFooter: { 
    padding: Space.xl, 
    backgroundColor: Colors.bg.secondary, 
    borderTopWidth: 1, 
    borderTopColor: Colors.ui.borderLight,
  },
  previewHint: { 
    fontSize: Type.size.sm, 
    color: Colors.text.secondary, 
    textAlign: 'center', 
    marginBottom: Space.lg,
  },
  previewActions: { 
    flexDirection: 'row', 
    gap: Space.md,
  },
  previewCancelBtn: { 
    flex: 1, 
    height: 50, 
    borderRadius: Radius.xxl, 
    backgroundColor: Colors.bg.elevated, 
    justifyContent: 'center', 
    alignItems: 'center',
  },
  previewCancelText: { 
    fontSize: Type.size.base, 
    fontWeight: Type.weight.semibold, 
    color: Colors.text.primary,
  },
  previewSendBtn: { 
    flex: 1, 
    height: 50, 
    borderRadius: Radius.xxl, 
    backgroundColor: Colors.accent.primary, 
    flexDirection: 'row', 
    justifyContent: 'center', 
    alignItems: 'center', 
    gap: Space.sm,
  },
  previewSendText: { 
    fontSize: Type.size.base, 
    fontWeight: Type.weight.semibold, 
    color: Colors.text.inverse, // White text on primary buttons
  },
  
  // File preview
  filePreviewBody: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center', 
    padding: Space.xxxl,
  },
  filePreviewIcon: { 
    width: 110, 
    height: 110, 
    borderRadius: Radius.xl, 
    backgroundColor: Colors.bg.elevated, 
    justifyContent: 'center', 
    alignItems: 'center', 
    marginBottom: Space.xl,
  },
  filePreviewName: { 
    fontSize: Type.size.lg, 
    fontWeight: Type.weight.semibold, 
    color: Colors.text.primary, 
    textAlign: 'center', 
    marginBottom: Space.xs,
  },
  filePreviewSize: { 
    fontSize: Type.size.sm, 
    color: Colors.text.secondary,
  },
  
  // Image viewer
  viewerScreen: { 
    flex: 1, 
    backgroundColor: '#000',
  },
  viewerHeader: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingHorizontal: Space.lg, 
    paddingBottom: Space.lg,
  },
  viewerClose: { 
    width: 48, 
    height: 48, 
    borderRadius: 24, 
    backgroundColor: 'rgba(255,255,255,0.1)', 
    justifyContent: 'center', 
    alignItems: 'center',
  },
  viewerDownload: { 
    width: 48, 
    height: 48, 
    borderRadius: 24, 
    backgroundColor: 'rgba(255,255,255,0.1)', 
    justifyContent: 'center', 
    alignItems: 'center',
  },
  viewerImg: { 
    flex: 1, 
    width: '100%',
  },
  
  // Profile Modal
  profileModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  profileModalContent: {
    backgroundColor: Colors.bg.elevated,
    borderRadius: Radius.xxl,
    padding: 28,
    alignItems: 'center',
    minWidth: 280,
    maxWidth: 340,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 20,
    borderWidth: 1,
    borderColor: Colors.ui.borderLight,
  },
  profileModalAvatar: {
    marginBottom: 20,
  },
  profileModalName: {
    fontSize: 22,
    fontWeight: Type.weight.bold,
    color: Colors.text.primary,
    textAlign: 'center',
    marginBottom: 4,
  },
  profileModalDivider: {
    width: '100%',
    height: 1,
    backgroundColor: Colors.ui.divider,
    marginVertical: 20,
  },
  profileModalCloseButton: {
    backgroundColor: Colors.accent.primary,
    paddingHorizontal: 36,
    paddingVertical: 14,
    borderRadius: Radius.full,
  },
  profileModalCloseText: {
    color: Colors.text.inverse, // White text on primary buttons
    fontSize: 16,
    fontWeight: Type.weight.semibold,
  },

  // Recording UI
  recordingBar: {
    backgroundColor: Colors.bg.primary,
    paddingVertical: Space.md,
    paddingHorizontal: Space.md,
    borderTopWidth: 1,
    borderTopColor: Colors.ui.divider,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  recordingContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  recordingCancelBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.bg.tertiary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#EA4335',
  },
  recordingDuration: {
    fontSize: Type.size.md,
    fontWeight: Type.weight.semibold,
    color: Colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  recordingWaveform: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    height: 24,
  },
  recordingWaveformBar: {
    width: 3,
    backgroundColor: Colors.accent.primary,
    borderRadius: 1.5,
  },
  recordingActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  recordingHint: {
    fontSize: Type.size.xs,
    color: Colors.text.tertiary,
  },
  recordingLockBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.bg.tertiary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordingSendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.accent.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordingStopBtn: {
    marginLeft: Space.md,
  },
  recordingStopInner: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#EA4335',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#EA4335',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  
  // === NOUVEAUX STYLES: Barre d'enregistrement intégrée (remplace TextInput) ===
  recordingFieldContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bg.elevated,
    borderRadius: Radius.xxl,
    paddingHorizontal: Space.sm,
    paddingVertical: Platform.OS === 'ios' ? Space.xs : 2,
    minHeight: 48,
    borderWidth: 1,
    borderColor: Colors.accent.error,
    justifyContent: 'space-between',
  },
  recordingTrashBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(234, 67, 53, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordingSlideHint: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  recordingSlideText: {
    fontSize: Type.size.sm,
    color: Colors.text.tertiary,
  },
  recordingDurationBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.xs,
  },
  
  // === STYLES MODE MAINS LIBRES (verrouillé) ===
  lockedRecordingBar: {
    backgroundColor: Colors.bg.primary,
    paddingVertical: Space.md,
    paddingHorizontal: Space.md,
    borderTopWidth: 1,
    borderTopColor: Colors.ui.divider,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  lockedCancelBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(234, 67, 53, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  lockedCenterContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bg.elevated,
    borderRadius: Radius.xxl,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    gap: Space.md,
  },
  lockedIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  lockedDuration: {
    fontSize: Type.size.md,
    fontWeight: Type.weight.semibold,
    color: Colors.text.primary,
    fontVariant: ['tabular-nums'],
    minWidth: 48,
  },
  lockedWaveform: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    height: 28,
    overflow: 'hidden',
  },
  lockedWaveformBar: {
    width: 3,
    backgroundColor: Colors.accent.primary,
    borderRadius: 1.5,
  },
  lockedSendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.accent.primary,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Colors.accent.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
});

// Voice message bubble styles
const voiceStyles = StyleSheet.create({
  voiceBubble: {
    minWidth: 200,
    maxWidth: 280,
    width: '100%',  // S'assurer que la bulle ne déborde pas
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    overflow: 'hidden',  // IMPORTANT: Empêcher le débordement
  },
  voiceBubbleMine: {
    backgroundColor: Colors.bubble.outgoing,
  },
  voiceBubbleTheirs: {
    backgroundColor: Colors.bubble.incoming,
  },
  playButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,  // Empêcher la réduction du bouton
  },
  playButtonMine: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  playButtonTheirs: {
    backgroundColor: Colors.accent.primaryMuted,
  },
  voiceContent: {
    flex: 1,
    minWidth: 0,  // IMPORTANT: Permettre le shrink du contenu
    overflow: 'hidden',  // Empêcher le débordement
  },
  waveformContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 24,
    marginBottom: 4,
    overflow: 'hidden',  // Empêcher le débordement de la waveform
  },
  waveformBar: {
    borderRadius: 1.5,
    flexShrink: 0,
  },
  voiceMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    flexWrap: 'nowrap',  // Empêcher le retour à la ligne
  },
  voiceDuration: {
    fontSize: Type.size.xs,
    color: Colors.text.secondary,
    fontWeight: Type.weight.medium,
    fontVariant: ['tabular-nums'],
  },
  voiceDurationMine: {
    color: 'rgba(255,255,255,0.7)',
  },
  voiceTime: {
    fontSize: Type.size.xs,
    color: Colors.text.tertiary,
  },
  voiceTimeMine: {
    color: 'rgba(255,255,255,0.5)',
  },
  voiceStatus: {
    marginLeft: 2,
  },
});

export default ConversationScreen;