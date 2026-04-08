// src/components/ui/Header.tsx
// Header modernes — Safe area aware, cohérent iOS/Android
// FIX: Utilise useSafeAreaInsets() dynamiquement (pas de valeurs hardcodées)

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  StatusBar,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from './theme';
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
  onMenuPress?: () => void;
  onTitlePress?: () => void;
  isOnline?: boolean;
  isTyping?: boolean;
  isEncrypted?: boolean;
  rightActions?: React.ReactNode;
}

interface SelectionHeaderProps {
  selectedCount: number;
  onClose: () => void;
  onDelete?: () => void;
  onSelectAll?: () => void;
  rightActions?: React.ReactNode;
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
  backgroundColor = theme.colors.background,
  titleAlign = 'center',
  style,
  elevated = false,
}) => {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top,
          backgroundColor,
        },
        elevated && styles.headerElevated,
        style,
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={backgroundColor} />
      
      <View style={styles.headerContent}>
        <View style={styles.headerLeft}>
          {showBackButton && onBackPress ? (
            <TouchableOpacity
              style={styles.backButton}
              onPress={onBackPress}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.backIcon}>‹</Text>
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
  onMenuPress,
  onTitlePress,
  isOnline = false,
  isTyping = false,
  isEncrypted = true,
  rightActions,
}) => {
  const insets = useSafeAreaInsets();

  // WhatsApp-style: only show subtitle when typing or explicit subtitle passed
  const subtitleText = isTyping ? 'écrit...' : (subtitle || '');
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
          <Text 
            style={[
              styles.chatHeaderSubtitle,
              isTyping && styles.chatHeaderTyping,
            ]} 
            numberOfLines={1}
          >
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
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.surface} />
      
      <View style={styles.chatHeaderContent}>
        <TouchableOpacity
          style={styles.chatBackButton}
          onPress={onBackPress}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <Text style={styles.chatBackIcon}>‹</Text>
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

  return (
    <View
      style={[
        styles.selectionHeader,
        { paddingTop: insets.top },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.primary} />
      
      <View style={styles.selectionContent}>
        <TouchableOpacity
          style={styles.selectionClose}
          onPress={onClose}
          activeOpacity={0.7}
        >
          <Text style={styles.selectionCloseIcon}>✕</Text>
        </TouchableOpacity>

        <Text style={styles.selectionCount}>
          {selectedCount} sélectionné{selectedCount > 1 ? 's' : ''}
        </Text>

        <View style={styles.selectionActions}>
          {rightActions}
          {onSelectAll && (
            <TouchableOpacity
              style={styles.selectionAction}
              onPress={onSelectAll}
              activeOpacity={0.7}
            >
              <Text style={styles.selectionActionIcon}>☑️</Text>
            </TouchableOpacity>
          )}
          {onDelete && (
            <TouchableOpacity
              style={styles.selectionAction}
              onPress={onDelete}
              activeOpacity={0.7}
            >
              <Text style={styles.selectionActionIcon}>🗑️</Text>
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

interface LargeHeaderProps {
  title: string;
  rightComponent?: React.ReactNode;
  backgroundColor?: string;
}

export const LargeHeader: React.FC<LargeHeaderProps> = ({
  title,
  rightComponent,
  backgroundColor = theme.colors.background,
}) => {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.largeHeader,
        {
          paddingTop: insets.top + 12,
          backgroundColor,
        },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={backgroundColor} />
      
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
// STYLES
// ============================================

const styles = StyleSheet.create({
  // Standard Header
  header: {
    backgroundColor: theme.colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
  },
  headerElevated: {
    ...theme.shadow.md,
    borderBottomWidth: 0,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: HEADER_CONTENT_HEIGHT,
    paddingHorizontal: 4,
  },
  headerLeft: {
    flex: 1,
    alignItems: 'flex-start',
  },
  headerCenter: {
    flex: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenterLeft: {
    alignItems: 'flex-start',
    paddingLeft: 8,
  },
  headerRight: {
    flex: 1,
    alignItems: 'flex-end',
  },
  headerTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: '600',
    color: theme.colors.text,
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textSecondary,
    marginTop: 1,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 32,
    color: theme.colors.primary,
    fontWeight: '300',
  },
  placeholder: {
    width: 44,
  },

  // Chat Header
  chatHeader: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
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
  chatBackIcon: {
    fontSize: 32,
    color: theme.colors.primary,
    fontWeight: '300',
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
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.textOnPrimary,
    letterSpacing: 0.3,
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 11,
    height: 11,
    borderRadius: 5.5,
    backgroundColor: theme.colors.online,
    borderWidth: 2,
    borderColor: theme.colors.surface,
  },
  chatHeaderInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  chatHeaderTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: '600',
    color: theme.colors.text,
    letterSpacing: -0.2,
  },
  chatHeaderTitleSolo: {
    fontSize: theme.fontSize.lg,
  },
  chatHeaderSubtitle: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textSecondary,
    marginTop: 1,
  },
  chatHeaderTyping: {
    color: theme.colors.typing,
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
    color: theme.colors.text,
  },

  // Selection Header
  selectionHeader: {
    backgroundColor: theme.colors.primary,
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
  selectionCloseIcon: {
    fontSize: 18,
    color: theme.colors.textOnPrimary,
    fontWeight: '600',
  },
  selectionCount: {
    flex: 1,
    fontSize: theme.fontSize.lg,
    fontWeight: '600',
    color: theme.colors.textOnPrimary,
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
  selectionActionIcon: {
    fontSize: 20,
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
    fontSize: theme.fontSize.display,
    fontWeight: '700',
    color: theme.colors.text,
  },
  largeHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});

export default Header;