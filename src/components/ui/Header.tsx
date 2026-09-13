// src/components/ui/Header.tsx
// Header modernes — Safe area aware, cohérent iOS/Android
// v3.0 — Migré sur useThemedStyles pour réactivité live au changement de thème.
//
// ────────────────────────────────────────────────────────────────────────────
// MIGRATION NOTE
// ────────────────────────────────────────────────────────────────────────────
// L'ancienne version v2 utilisait un `StyleSheet.create` au top-level qui
// capturait `theme.colors.X` au moment de l'import (= sombre uniquement).
// Les styles ne pouvaient donc pas répondre à un changement de thème.
// `theme.colors` a depuis été entièrement supprimé (cf. ./theme.ts).
//
// Ici on déplace `StyleSheet.create` à l'intérieur de chaque sous-composant
// via `useThemedStyles(builder)`. Le builder est mémoïsé par référence de
// palette : 0 work tant que `colors` ne change pas. Les composants Header
// sont rendus à chaque écran — un seul recalcul de StyleSheet survient au
// moment où l'utilisateur change de thème.
//
// Les `<StatusBar barStyle="light-content" …>` internes ont aussi été
// supprimés : c'est le rôle du `<ThemedStatusBar />` dans App.tsx, et
// dupliquer le StatusBar par écran provoquait des conflits visibles entre
// barStyle dark et light quand on naviguait. Le NavigationContainer et
// App.tsx pilotent désormais le StatusBar globalement.

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  TouchableOpacity,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, useThemedStyles } from './ThemeContext';
import { theme as themeStatic } from './theme';
import type { ColorPalette } from './theme';
import { generateAvatarInitials } from '../../services/crypto';

// ============================================
// TYPES
// ============================================

interface HeaderProps {
  title?: string;
  subtitle?: string;
  leftComponent?: React.ReactNode;
  rightComponent?: React.ReactNode;
  onBackPress?: () => void;
  showBackButton?: boolean;
  backgroundColor?: string;
  titleAlign?: 'left' | 'center';
  style?: ViewStyle;
  elevated?: boolean;
}

interface ChatHeaderProps {
  title: string;
  subtitle?: string;
  avatar?: React.ReactNode;
  onBackPress: () => void;
  onTitlePress?: () => void;
  isOnline?: boolean;
  /**
   * Affiche le cadenas « chiffré de bout en bout » à côté du titre.
   *
   * NOTE Phase 2 : la prop est aujourd'hui reçue mais pas encore rendue —
   * le bandeau et le sous-titre « Chiffré post-quantique » sont l'item 17
   * de la refonte. La prop est conservée parce que l'appelant la passe déjà
   * et qu'elle documente l'intention.
   */
  isEncrypted?: boolean;
  rightActions?: React.ReactNode;
}
// `onMenuPress` et `isTyping` ont été retirés de cette interface : aucun
// appelant ne les fournissait, et `onMenuPress` n'était même pas déstructuré
// par le composant — un menu passé en prop n'aurait jamais été affiché.
// L'indicateur de frappe est par ailleurs un signal de présence, contraire
// au positionnement métadonnées-minimales de l'app.

interface SelectionHeaderProps {
  selectedCount: number;
  onClose: () => void;
  onDelete?: () => void;
  onSelectAll?: () => void;
  rightActions?: React.ReactNode;
}

interface LargeHeaderProps {
  title: string;
  rightComponent?: React.ReactNode;
  backgroundColor?: string;
}

// Consistent content height across all platforms
// Matches ConversationListScreen header visual height
const HEADER_CONTENT_HEIGHT = 56;

// ============================================
// STANDARD HEADER
// ============================================

export const Header: React.FC<HeaderProps> = ({
  title,
  subtitle,
  leftComponent,
  rightComponent,
  onBackPress,
  showBackButton = true,
  backgroundColor,
  titleAlign = 'center',
  style,
  elevated = false,
}) => {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // Default backgroundColor resolved lazily from the live palette — callers
  // can still override via prop.
  const resolvedBg = backgroundColor ?? colors.background;

  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top,
          backgroundColor: resolvedBg,
        },
        elevated && styles.headerElevated,
        style,
      ]}
    >
      {/*
        Re-paint the Android status bar to match the header background so
        there's no visible seam between the OS status bar region and the
        header below. iOS ignores backgroundColor here (status bar is
        translucent), so this is effectively an Android polish.

        barStyle is derived from `isDark` rather than the resolved bg
        because callers can pass arbitrary backgroundColor props — we
        don't try to compute the luminance, we trust the global theme.
      */}
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={resolvedBg}
      />
      <View style={styles.headerContent}>
        <View style={styles.headerLeft}>
          {showBackButton && onBackPress ? (
            <TouchableOpacity
              style={styles.backButton}
              onPress={onBackPress}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={t('common.back')}
            >
              <Ionicons name="chevron-back" size={24} color={colors.primary} />
            </TouchableOpacity>
          ) : leftComponent ? (
            leftComponent
          ) : (
            <View style={styles.placeholder} />
          )}
        </View>

        <View style={[
          styles.headerCenter,
          titleAlign === 'left' && styles.headerCenterLeft,
        ]}>
          {title && (
            <Text
              style={styles.headerTitle}
              numberOfLines={1}
            >
              {title}
            </Text>
          )}
          {subtitle && (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>

        <View style={styles.headerRight}>
          {rightComponent || <View style={styles.placeholder} />}
        </View>
      </View>
    </View>
  );
};

// ============================================
// CHAT HEADER
// ============================================

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  title,
  subtitle,
  avatar,
  onBackPress,
  onTitlePress,
  isOnline = false,
  isEncrypted = true,
  rightActions,
}) => {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);

  const subtitleText = subtitle || '';
  const showSubtitle = subtitleText.length > 0;

  const headerInfoContent = (
    <>
      {avatar ? (
        <View style={styles.avatarContainer}>
          {avatar}
          {isOnline && <View style={styles.onlineIndicator} />}
        </View>
      ) : (
        <View style={styles.avatarPlaceholder}>
          <Text style={styles.avatarText}>
            {typeof title === 'string' && title.length > 0 ? generateAvatarInitials(title) : '?'}
          </Text>
          {isOnline && <View style={styles.onlineIndicator} />}
        </View>
      )}

      <View style={styles.chatHeaderInfo}>
        <Text style={[styles.chatHeaderTitle, !showSubtitle && styles.chatHeaderTitleSolo]} numberOfLines={1}>
          {title}
        </Text>
        {showSubtitle && (
          <Text style={styles.chatHeaderSubtitle} numberOfLines={1}>
            {subtitleText}
          </Text>
        )}
      </View>
    </>
  );

  return (
    <View
      style={[
        styles.chatHeader,
        { paddingTop: insets.top },
      ]}
    >
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={colors.surface}
      />
      <View style={styles.chatHeaderContent}>
        <TouchableOpacity
          style={styles.chatBackButton}
          onPress={onBackPress}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>

        {onTitlePress ? (
          <TouchableOpacity
            style={styles.chatHeaderTouchable}
            onPress={onTitlePress}
            activeOpacity={0.7}
          >
            {headerInfoContent}
          </TouchableOpacity>
        ) : (
          <View style={styles.chatHeaderTouchable}>
            {headerInfoContent}
          </View>
        )}

        <View style={styles.chatHeaderActions}>
          {rightActions}
        </View>
      </View>
    </View>
  );
};

// ============================================
// SELECTION HEADER
// ============================================

export const SelectionHeader: React.FC<SelectionHeaderProps> = ({
  selectedCount,
  onClose,
  onDelete,
  onSelectAll,
  rightActions,
}) => {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <View
      style={[
        styles.selectionHeader,
        { paddingTop: insets.top },
      ]}
    >
      {/*
        SelectionHeader paints itself with `colors.primary` (the teal
        brand colour) on both light and dark palettes. White text on
        teal is AA-legible regardless of theme, so we hardcode
        light-content here — it's a property of the saturated
        background, not of the global theme.
      */}
      <StatusBar barStyle="light-content" backgroundColor={colors.primary} />
      <View style={styles.selectionContent}>
        <TouchableOpacity
          style={styles.selectionClose}
          onPress={onClose}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('common.cancel')}
        >
          <Ionicons name="close" size={24} color={colors.textOnPrimary} />
        </TouchableOpacity>

        <Text style={styles.selectionCount}>
          {t('header.selectedCount', { count: selectedCount })}
        </Text>

        <View style={styles.selectionActions}>
          {rightActions}
          {onSelectAll && (
            <TouchableOpacity
              style={styles.selectionAction}
              onPress={onSelectAll}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('header.selectAll')}
            >
              <Ionicons name="checkbox-outline" size={22} color={colors.textOnPrimary} />
            </TouchableOpacity>
          )}
          {onDelete && (
            <TouchableOpacity
              style={styles.selectionAction}
              onPress={onDelete}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('common.delete')}
            >
              <Ionicons name="trash-outline" size={22} color={colors.textOnPrimary} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
};

// ============================================
// LARGE HEADER (Style iOS)
// ============================================

export const LargeHeader: React.FC<LargeHeaderProps> = ({
  title,
  rightComponent,
  backgroundColor,
}) => {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const resolvedBg = backgroundColor ?? colors.background;

  return (
    <View
      style={[
        styles.largeHeader,
        {
          paddingTop: insets.top + 12,
          backgroundColor: resolvedBg,
        },
      ]}
    >
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={resolvedBg}
      />
      <View style={styles.largeHeaderContent}>
        <Text style={styles.largeHeaderTitle}>{title}</Text>
        {rightComponent && (
          <View style={styles.largeHeaderRight}>{rightComponent}</View>
        )}
      </View>
    </View>
  );
};

// ============================================
// STYLES (live, per-palette)
// ============================================

const makeStyles = (colors: ColorPalette) =>
  ({
    // Standard Header
    header: {
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.divider,
    },
    headerElevated: {
      ...themeStatic.shadow.md,
      borderBottomWidth: 0,
    },
    headerContent: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: HEADER_CONTENT_HEIGHT,
      paddingHorizontal: 4,
    },
    // ════════════════════════════════════════════════════════════════════════
    // FLEX BALANCE — adapté i18n (préservé de v2.0)
    // ════════════════════════════════════════════════════════════════════════
    // 1 / 2 / 1.4 — le rightComponent obtient une zone plus généreuse
    // sans sacrifier la lisibilité du titre.
    headerLeft: {
      flex: 1,
      alignItems: 'flex-start',
    },
    headerCenter: {
      flex: 2,
      alignItems: 'center',
      paddingHorizontal: 8,
    },
    headerCenterLeft: {
      alignItems: 'flex-start',
      paddingLeft: 8,
    },
    headerRight: {
      flex: 1.4,
      alignItems: 'flex-end',
    },
    headerTitle: {
      fontSize: themeStatic.fontSize.lg,
      fontWeight: '600',
      color: colors.text,
      letterSpacing: -0.3,
    },
    headerSubtitle: {
      fontSize: themeStatic.fontSize.xs,
      color: colors.textSecondary,
      marginTop: 1,
    },
    backButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    placeholder: {
      width: 44,
    },

    // Chat Header
    chatHeader: {
      backgroundColor: colors.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.divider,
    },
    chatHeaderContent: {
      flexDirection: 'row',
      alignItems: 'center',
      height: HEADER_CONTENT_HEIGHT,
      paddingRight: 8,
    },
    chatBackButton: {
      width: 44,
      height: HEADER_CONTENT_HEIGHT,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chatHeaderTouchable: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
    },
    avatarContainer: {
      position: 'relative',
      marginRight: 12,
    },
    avatarPlaceholder: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    avatarText: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.textOnPrimary,
      letterSpacing: 0.3,
    },
    onlineIndicator: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      width: 11,
      height: 11,
      borderRadius: 5.5,
      backgroundColor: colors.online,
      borderWidth: 2,
      borderColor: colors.surface,
    },
    chatHeaderInfo: {
      flex: 1,
      justifyContent: 'center',
    },
    chatHeaderTitle: {
      fontSize: themeStatic.fontSize.base,
      fontWeight: '600',
      color: colors.text,
      letterSpacing: -0.2,
    },
    chatHeaderTitleSolo: {
      fontSize: themeStatic.fontSize.lg,
    },
    chatHeaderSubtitle: {
      fontSize: themeStatic.fontSize.xs,
      color: colors.textSecondary,
      marginTop: 1,
    },
    chatHeaderActions: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    menuButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    menuIcon: {
      fontSize: 22,
      color: colors.text,
    },

    // Selection Header
    selectionHeader: {
      backgroundColor: colors.primary,
    },
    selectionContent: {
      flexDirection: 'row',
      alignItems: 'center',
      height: HEADER_CONTENT_HEIGHT,
      paddingHorizontal: 4,
    },
    selectionClose: {
      width: 48,
      height: HEADER_CONTENT_HEIGHT,
      alignItems: 'center',
      justifyContent: 'center',
    },
    selectionCount: {
      flex: 1,
      fontSize: themeStatic.fontSize.lg,
      fontWeight: '600',
      color: colors.textOnPrimary,
    },
    selectionActions: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    selectionAction: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // Large Header
    largeHeader: {
      paddingHorizontal: 20,
      paddingBottom: 16,
    },
    largeHeaderContent: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    largeHeaderTitle: {
      fontSize: themeStatic.fontSize.display,
      fontWeight: '700',
      color: colors.text,
    },
    largeHeaderRight: {
      flexDirection: 'row',
      alignItems: 'center',
    },
  } as const);

export default Header;
