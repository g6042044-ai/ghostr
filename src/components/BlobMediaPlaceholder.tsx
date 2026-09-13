// src/components/BlobMediaPlaceholder.tsx
// v28.0 — Placeholder moderne pour les médias chiffrés en cours de téléchargement.
//
// Remplace l'ancien BlobMediaPlaceholder inline dans ConversationScreen qui
// rendait TOUS les médias (image/voice/file) comme une ligne horizontale type
// "fichier" — disgracieuse pour les images et les vocaux dont le récepteur
// attend une forme native.
//
// DESIGN PRINCIPLES:
//   - Forme native du média final (image-shaped, voice-shaped, file-row)
//   - Skeleton + shimmer animé pour signaler le chargement (style Telegram/Signal)
//   - Bordures, gradients et radius cohérents avec le bubble final
//   - Aucun saut de layout entre placeholder → contenu réel (préserve
//     les dimensions imageWidth/imageHeight reçues dans la metadata E2E)
//   - Icône cadenas discrète + texte "déchiffrement" pour rassurer l'utilisateur
//     que le contenu reste E2E pendant tout le transfert.

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, useThemedStyles, type ColorPalette } from './ui';

// ============================================
// TYPES
// ============================================

export interface BlobMessageLike {
  id: string;
  conversationId?: string;
  sessionId?: string;
  blobId?: string;
  blobKey?: string;
  blobNonce?: string;
  blobSize?: number;
  blobMediaType?: 'image' | 'file' | 'voice';
  imageWidth?: number;
  imageHeight?: number;
  fileName?: string;
  fileSize?: number;
  fileMimeType?: string;
  voiceDuration?: number;
}

export interface BlobMediaPlaceholderProps {
  message: BlobMessageLike;
  isMine: boolean;
  isFirstOfGroup: boolean;
  isLastOfGroup: boolean;
  timestamp: number;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

  /** Largeur max de la bulle image (typiquement screenWidth * 0.68) */
  maxImageWidth: number;
  /** Hauteur max de la bulle image (typiquement 280) */
  maxImageHeight: number;

  /** true si un téléchargement est en cours (overlay actif) */
  downloading: boolean;
  /** Message d'erreur éventuel (affiché sous l'icône) */
  error: string | null;
  /** Tap → lance le téléchargement (avec retry si erreur) */
  onPress: () => void;

  /** Fonction de formatage du timestamp affiché (typiquement formatTime) */
  formatTime: (ts: number) => string;
  /** Fonction de formatage de la taille (typiquement formatFileSize) */
  formatFileSize: (bytes: number) => string;
  /** Fonction d'icône fichier (typiquement getFileIcon) */
  getFileIcon: (extension: string) => string;
}

// ============================================
// SHIMMER ANIMATION (effet "vague de lumière" qui traverse le placeholder)
// ============================================

const useShimmer = () => {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration: 1500,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return anim;
};

// ============================================
// HELPERS
// ============================================

const RADIUS_DEFAULT = 20;
const RADIUS_GROUPED = 6;

function getBorderRadius(
  isMine: boolean,
  isFirstOfGroup: boolean,
  isLastOfGroup: boolean
) {
  const r = RADIUS_DEFAULT;
  const g = RADIUS_GROUPED;
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
}

// `light` reflects whether the tick sits on a saturated/dark substrate
// (image overlay, mine-bubble teal). When false, we're rendering on the
// "theirs" bubble whose colour flips by scheme — we read from the palette
// instead of hardcoding rgba(0,0,0,0.5), which used to disappear on a dark
// `messageTheirs` (#1A252F).
function StatusTick({ status, light }: { status?: string; light?: boolean }) {
  const { colors } = useTheme();
  if (!status) return null;
  const color = light ? 'rgba(255,255,255,0.85)' : colors.textMuted;
  const readColor = '#53BDEB';
  if (status === 'sending') return <Ionicons name="time-outline" size={12} color={color} />;
  if (status === 'sent') return <Ionicons name="checkmark" size={14} color={color} />;
  if (status === 'delivered') return <Ionicons name="checkmark-done" size={14} color={color} />;
  if (status === 'read') return <Ionicons name="checkmark-done" size={14} color={readColor} />;
  if (status === 'failed') return <Ionicons name="alert-circle" size={14} color="#FF6B6B" />;
  return null;
}

// ============================================
// 1) IMAGE PLACEHOLDER — forme native image avec skeleton + ring de progress
// ============================================

const ImagePlaceholder: React.FC<BlobMediaPlaceholderProps> = ({
  message,
  isMine,
  isFirstOfGroup,
  isLastOfGroup,
  timestamp,
  status,
  maxImageWidth,
  maxImageHeight,
  downloading,
  error,
  onPress,
  formatTime,
}) => {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const shimmer = useShimmer();

  // Calcule les dimensions d'affichage à partir de la metadata E2E.
  // Ainsi, le placeholder a EXACTEMENT la même taille que l'image finale —
  // aucun saut de layout quand le download se termine.
  const imgW = message.imageWidth || 200;
  const imgH = message.imageHeight || 200;
  const aspectRatio = imgW / imgH;
  let displayWidth = Math.min(maxImageWidth, imgW);
  let displayHeight = displayWidth / aspectRatio;
  if (displayHeight > maxImageHeight) {
    displayHeight = maxImageHeight;
    displayWidth = displayHeight * aspectRatio;
  }

  const shimmerTranslate = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [-displayWidth, displayWidth * 1.2],
  });

  const radius = getBorderRadius(isMine, isFirstOfGroup, isLastOfGroup);

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      disabled={downloading && !error}
    >
      <View
        style={[
          styles.imageContainer,
          radius,
          { width: displayWidth, height: displayHeight },
        ]}
      >
        {/* Fond gradient subtil (simulé via deux View superposées) */}
        <View style={styles.imageBgBase} />
        <View style={styles.imageBgOverlay} />

        {/* Bande shimmer qui traverse de gauche à droite */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.shimmer,
            {
              width: displayWidth * 0.5,
              height: displayHeight,
              transform: [{ translateX: shimmerTranslate }, { skewX: '-15deg' }],
            },
          ]}
        />

        {/* Indicateur central */}
        <View style={styles.centerOverlay}>
          {error ? (
            <View style={styles.errorBadge}>
              <Ionicons name="refresh" size={18} color="#fff" />
              <Text style={styles.errorBadgeText} numberOfLines={1}>
                {t('conversation.tapToRetry', {})}
              </Text>
            </View>
          ) : downloading ? (
            <View style={styles.progressBadge}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.progressBadgeText}>
                {t('conversation.decrypting', {})}
              </Text>
            </View>
          ) : (
            <View style={styles.progressBadge}>
              <Ionicons name="lock-closed" size={16} color="#fff" />
              <Text style={styles.progressBadgeText}>
                {t('conversation.encrypted', {})}
              </Text>
            </View>
          )}
        </View>

        {/* Footer: timestamp + status (style WhatsApp image overlay) */}
        <View style={styles.imageFooter}>
          <View style={styles.imageFooterRow}>
            <Text style={styles.imageFooterText}>{formatTime(timestamp)}</Text>
            {isMine && (
              <View style={styles.imageFooterTick}>
                <StatusTick status={status} light />
              </View>
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
};

// ============================================
// 2) VOICE PLACEHOLDER — forme native message vocal avec waveform skeleton
// ============================================

const VOICE_BAR_COUNT = 28;

const VoicePlaceholder: React.FC<BlobMediaPlaceholderProps> = ({
  message,
  isMine,
  isFirstOfGroup,
  isLastOfGroup,
  timestamp,
  status,
  downloading,
  error,
  onPress,
  formatTime,
}) => {
  const { t } = useTranslation();
  // Live palette is needed for the inline icon colours below (play / refresh
  // accent). The `styles` builder also uses colours but those go through
  // `useThemedStyles` already.
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const shimmer = useShimmer();
  const radius = getBorderRadius(isMine, isFirstOfGroup, isLastOfGroup);

  // Génère une "waveform" fake déterministe basée sur l'id du message
  // pour que chaque vocal ait sa propre silhouette (pas tous identiques)
  const bars = React.useMemo(() => {
    const seed = (message.id || message.blobId || 'x').split('')
      .reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 7);
    const out: number[] = [];
    let s = seed;
    for (let i = 0; i < VOICE_BAR_COUNT; i++) {
      // PRNG xorshift léger (purement déterministe, pas crypto — UX uniquement)
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const v = (Math.abs(s) % 1000) / 1000;
      out.push(0.25 + v * 0.75); // entre 25% et 100%
    }
    return out;
  }, [message.id, message.blobId]);

  const duration = message.voiceDuration || 0;
  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // Le shimmer module l'opacité des barres pour suggérer un "scan" continu
  const shimmerOpacity = shimmer.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.35, 0.7, 0.35],
  });

  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress} disabled={downloading && !error}>
      <View style={[styles.voiceBubble, isMine ? styles.voiceBubbleMine : styles.voiceBubbleTheirs, radius]}>
        {/* Bouton play (désactivé pendant le download) */}
        <View style={[styles.voicePlayButton, isMine ? styles.voicePlayButtonMine : styles.voicePlayButtonTheirs]}>
          {/* Theirs: use the LIVE primary (teal) — was hardcoded to the
              dark-palette hex `#00D9A6`, which on light theme is slightly
              brighter than `colors.primary` (#00B38A) and breaks brand
              consistency with the rest of the UI. */}
          {error ? (
            <Ionicons name="refresh" size={18} color={isMine ? '#fff' : colors.primary} />
          ) : downloading ? (
            <ActivityIndicator size="small" color={isMine ? '#fff' : colors.primary} />
          ) : (
            <Ionicons name="play" size={18} color={isMine ? '#fff' : colors.primary} style={{ marginLeft: 2 }} />
          )}
        </View>

        <View style={styles.voiceContent}>
          {/* Waveform skeleton animée */}
          <Animated.View style={[styles.voiceWaveformRow, { opacity: shimmerOpacity }]}>
            {bars.map((h, i) => (
              <View
                key={i}
                style={[
                  styles.voiceBar,
                  {
                    height: Math.max(4, h * 22),
                    // Mine: bubble is teal in both themes → white-translucent
                    //   stays visible.
                    // Theirs: previously `rgba(139,164,184,0.5)` which was a
                    //   dark-palette derived tint, barely visible on the
                    //   light `messageTheirs` (#EEF2F6). Switching to
                    //   `textMuted` + ~50% alpha works on both substrates.
                    backgroundColor: isMine
                      ? 'rgba(255,255,255,0.45)'
                      : colors.textMuted + '80' /* ~50% */,
                  },
                ]}
              />
            ))}
          </Animated.View>

          <View style={styles.voiceMetaRow}>
            <Text style={[styles.voiceDuration, isMine && styles.voiceTextMine]}>
              {duration > 0 ? formatDuration(duration) : '—:—'}
            </Text>
            <View style={styles.voiceDot} />
            <Text style={[styles.voiceHint, isMine && styles.voiceTextMine]}>
              {error
                ? t('conversation.tapToRetry', {})
                : downloading
                  ? t('conversation.decrypting', {})
                  : t('conversation.tapToDownload', {})}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={[styles.voiceTime, isMine && styles.voiceTimeMine]}>
              {formatTime(timestamp)}
            </Text>
            {isMine && (
              <View style={styles.voiceStatusWrap}>
                <StatusTick status={status} light />
              </View>
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
};

// ============================================
// 3) FILE PLACEHOLDER — ligne fichier moderne
// ============================================

const FilePlaceholder: React.FC<BlobMediaPlaceholderProps> = ({
  message,
  isMine,
  isFirstOfGroup,
  isLastOfGroup,
  timestamp,
  status,
  downloading,
  error,
  onPress,
  formatTime,
  formatFileSize,
  getFileIcon,
}) => {
  const { t } = useTranslation();
  // Live palette for the inline icon colours (refresh / play / lock).
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const radius = getBorderRadius(isMine, isFirstOfGroup, isLastOfGroup);

  const fileName = message.fileName || t('conversation.file', {});
  const fileSize = message.fileSize ? formatFileSize(message.fileSize) : '';
  const extension = (fileName.split('.').pop() || '').toLowerCase();
  const iconEmoji = getFileIcon(extension);

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress} disabled={downloading && !error}>
      <View style={[styles.fileBubble, isMine ? styles.fileBubbleMine : styles.fileBubbleTheirs, radius]}>
        {/* Carré icône + halo */}
        <View style={[styles.fileIconWrap, isMine ? styles.fileIconWrapMine : styles.fileIconWrapTheirs]}>
          {/* Theirs accent: live `colors.primary` (was `'#00D9A6'`, the dark
              hex, slightly off-palette on light theme). Mine sits on a teal
              bubble in both themes, so white is correct. */}
          {downloading ? (
            <ActivityIndicator size="small" color={isMine ? '#fff' : colors.primary} />
          ) : error ? (
            <Ionicons name="refresh" size={20} color={isMine ? '#fff' : colors.primary} />
          ) : (
            <Text style={styles.fileIconEmoji}>{iconEmoji}</Text>
          )}
        </View>

        {/* Nom + sous-ligne (taille / état) */}
        <View style={styles.fileBody}>
          <Text
            style={[styles.fileName, isMine && styles.fileTextMine]}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {fileName}
          </Text>
          <View style={styles.fileSubRow}>
            <Text style={[styles.fileSub, isMine && styles.fileSubMine]} numberOfLines={1}>
              {error
                ? t('conversation.tapToRetry', {})
                : downloading
                  ? t('conversation.decrypting', {})
                  : (fileSize ? `${fileSize} · ${t('conversation.tap')}` : t('conversation.tapToDownload'))}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={[styles.fileTime, isMine && styles.fileTimeMine]}>
              {formatTime(timestamp)}
            </Text>
            {isMine && (
              <View style={styles.fileStatus}>
                <StatusTick status={status} light={isMine} />
              </View>
            )}
          </View>
        </View>

        {/* Indicateur cadenas (subtil, à droite) — toujours visible pour
            rappeler que le contenu reste chiffré tant que non téléchargé */}
        {!downloading && !error && (
          <View style={styles.fileLockBadge}>
            <Ionicons
              name="lock-closed"
              size={12}
              // Theirs: previously `rgba(139, 164, 184, 0.6)` which is the
              // dark `textSecondary` colour as an opaque tint — barely
              // perceptible on the light `messageTheirs` (#EEF2F6). Using
              // `textMuted` from the live palette guarantees visibility on
              // both substrates.
              color={isMine ? 'rgba(255,255,255,0.5)' : colors.textMuted}
            />
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
};

// ============================================
// COMPOSANT PRINCIPAL — dispatch selon le type
// ============================================

export const BlobMediaPlaceholder: React.FC<BlobMediaPlaceholderProps> = (props) => {
  const mediaType = props.message.blobMediaType || 'file';

  if (mediaType === 'image') {
    return <ImagePlaceholder {...props} />;
  }
  if (mediaType === 'voice') {
    return <VoicePlaceholder {...props} />;
  }
  return <FilePlaceholder {...props} />;
};

// ============================================
// STYLES
// ============================================

const makeStyles = (colors: ColorPalette) => StyleSheet.create({
  // ============ IMAGE ============
  imageContainer: {
    overflow: 'hidden',
    position: 'relative',
    // Loading placeholder background — uses messageTheirs so it matches
    // the eventual incoming bubble while the image streams in.
    backgroundColor: colors.messageTheirs,
  },
  imageBgBase: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.messageTheirs,
  },
  imageBgOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.primary + '0A', // ~4% alpha tint
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    backgroundColor: colors.primary + '1A', // ~10% alpha tint
    ...Platform.select({
      ios: {
        shadowColor: colors.primary + '80', // ~50% alpha
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.9,
        shadowRadius: 30,
      },
      android: {},
    }),
  },
  centerOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  progressBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    // Progress badge sits on top of media content (photo). Dark
    // semi-transparent works on both themes since the substrate is the
    // photo itself.
    backgroundColor: 'rgba(10, 15, 20, 0.65)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    gap: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  progressBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  errorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 107, 107, 0.85)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    gap: 6,
  },
  errorBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  imageFooter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 18,
    paddingHorizontal: 10,
    paddingBottom: 8,
    backgroundColor: 'transparent',
  },
  imageFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  imageFooterText: {
    // White stays correct: this text sits over media content with a
    // shadow for legibility.
    color: '#fff',
    fontSize: 11,
    fontWeight: '500',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  imageFooterTick: {
    marginLeft: 2,
  },

  // ============ VOICE ============
  voiceBubble: {
    minWidth: 220,
    maxWidth: 280,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    overflow: 'hidden',
  },
  // Mine = teal `messageMine` bubble (same on both themes)
  voiceBubbleMine: { backgroundColor: colors.messageMine },
  // Theirs = `messageTheirs` (light on light, dark on dark)
  voiceBubbleTheirs: { backgroundColor: colors.messageTheirs },
  voicePlayButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  voicePlayButtonMine: { backgroundColor: 'rgba(255,255,255,0.18)' },
  voicePlayButtonTheirs: { backgroundColor: colors.primary + '26' /* ~15% */ },
  voiceContent: {
    flex: 1,
    minWidth: 0,
  },
  voiceWaveformRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 24,
    gap: 2,
    marginBottom: 4,
  },
  voiceBar: {
    width: 2.5,
    borderRadius: 1.5,
  },
  voiceMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'nowrap',
  },
  voiceDuration: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  voiceDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.textMuted + '66' /* ~40% */,
  },
  voiceHint: {
    fontSize: 11,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  voiceTextMine: {
    color: 'rgba(255,255,255,0.65)',
  },
  voiceTime: {
    fontSize: 11,
    color: colors.textMuted,
  },
  voiceTimeMine: {
    color: 'rgba(255,255,255,0.5)',
  },
  voiceStatusWrap: {
    marginLeft: 4,
  },

  // ============ FILE ============
  fileBubble: {
    minWidth: 220,
    maxWidth: 300,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  fileBubbleMine: { backgroundColor: colors.messageMine },
  fileBubbleTheirs: { backgroundColor: colors.messageTheirs },
  fileIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  fileIconWrapMine: { backgroundColor: 'rgba(255,255,255,0.15)' },
  fileIconWrapTheirs: { backgroundColor: colors.primary + '26' /* ~15% */ },
  fileIconEmoji: {
    fontSize: 20,
  },
  fileBody: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    marginBottom: 3,
  },
  fileTextMine: {
    color: '#FFFFFF',
  },
  fileSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  fileSub: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  fileSubMine: {
    color: 'rgba(255,255,255,0.7)',
  },
  fileTime: {
    fontSize: 11,
    color: colors.textMuted,
  },
  fileTimeMine: {
    color: 'rgba(255,255,255,0.55)',
  },
  fileStatus: {
    marginLeft: 4,
  },
  fileLockBadge: {
    marginLeft: 4,
    opacity: 0.7,
  },
});

export default BlobMediaPlaceholder;