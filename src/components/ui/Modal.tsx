// src/components/ui/Modal.tsx
// Modales robustes avec boutons visibles
// AlertModal centrée au milieu de l'écran
// BottomSheet avec support du clavier

import React, { useEffect, useRef } from 'react';
import {
  Modal as RNModal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  Animated,
  Dimensions,
  Platform,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from './theme';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// ============================================
// TYPES
// ============================================

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  showHandle?: boolean;
}

interface AlertModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  message: string;
  icon?: React.ReactNode;
  primaryButton?: {
    title: string;
    onPress: () => void;
    variant?: 'primary' | 'danger';
    loading?: boolean;
  };
  secondaryButton?: {
    title: string;
    onPress: () => void;
  };
}

interface ActionSheetItem {
  title: string;
  icon?: React.ReactNode;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  items: ActionSheetItem[];
  showCancel?: boolean;
  cancelText?: string;
}

// ============================================
// BOTTOM SHEET
// ============================================

export const BottomSheet: React.FC<BottomSheetProps> = ({
  visible,
  onClose,
  title,
  children,
  showHandle = true,
}) => {
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 65,
          friction: 11,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: SCREEN_HEIGHT,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  return (
    <RNModal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView 
        style={styles.modalContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
          <Pressable style={styles.overlayPressable} onPress={onClose} />
        </Animated.View>

        <Animated.View
          style={[
            styles.bottomSheet,
            {
              transform: [{ translateY: slideAnim }],
              paddingBottom: Math.max(insets.bottom, 20),
            },
          ]}
        >
          {showHandle && <View style={styles.handle} />}
          
          {title && (
            <View style={styles.bottomSheetHeader}>
              <Text style={styles.bottomSheetTitle}>{title}</Text>
            </View>
          )}

          <ScrollView 
            style={styles.bottomSheetContent}
            showsVerticalScrollIndicator={false}
            bounces={false}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </RNModal>
  );
};

// ============================================
// ALERT MODAL - CENTRÉE AU MILIEU DE L'ÉCRAN
// ============================================

export const AlertModal: React.FC<AlertModalProps> = ({
  visible,
  onClose,
  title,
  message,
  icon,
  primaryButton,
  secondaryButton,
}) => {
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          useNativeDriver: true,
          tension: 100,
          friction: 8,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      scaleAnim.setValue(0.9);
      fadeAnim.setValue(0);
    }
  }, [visible]);

  const getPrimaryButtonStyle = () => {
    if (primaryButton?.variant === 'danger') {
      return styles.alertButtonDanger;
    }
    return styles.alertButtonPrimary;
  };

  return (
    <RNModal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.alertModalWrapper}>
        {/* Overlay en position absolue pour ne pas affecter le centrage */}
        <Animated.View 
          style={[
            styles.alertOverlayAbsolute, 
            { opacity: fadeAnim }
          ]}
        >
          <Pressable 
            style={StyleSheet.absoluteFill} 
            onPress={onClose} 
          />
        </Animated.View>
        
        {/* Contenu centré */}
        <Animated.View
          style={[
            styles.alertContainer,
            {
              transform: [{ scale: scaleAnim }],
              opacity: fadeAnim,
            },
          ]}
        >
          {icon && <View style={styles.alertIcon}>{icon}</View>}
          
          <Text style={styles.alertTitle}>{title}</Text>
          <Text style={styles.alertMessage}>{message}</Text>

          <View style={styles.alertButtons}>
            {secondaryButton && (
              <TouchableOpacity
                style={[styles.alertButton, styles.alertButtonSecondary]}
                onPress={secondaryButton.onPress}
                activeOpacity={0.7}
              >
                <Text style={styles.alertButtonSecondaryText}>
                  {secondaryButton.title}
                </Text>
              </TouchableOpacity>
            )}
            {primaryButton && (
              <TouchableOpacity
                style={[styles.alertButton, getPrimaryButtonStyle()]}
                onPress={primaryButton.onPress}
                disabled={primaryButton.loading}
                activeOpacity={0.7}
              >
                {primaryButton.loading ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.alertButtonPrimaryText}>
                    {primaryButton.title}
                  </Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        </Animated.View>
      </View>
    </RNModal>
  );
};

// ============================================
// ACTION SHEET
// ============================================

export const ActionSheet: React.FC<ActionSheetProps> = ({
  visible,
  onClose,
  title,
  items,
  showCancel = true,
  cancelText = 'Annuler',
}) => {
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 65,
          friction: 11,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: SCREEN_HEIGHT,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  return (
    <RNModal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
          <Pressable style={styles.overlayPressable} onPress={onClose} />
        </Animated.View>

        <Animated.View
          style={[
            styles.actionSheet,
            {
              transform: [{ translateY: slideAnim }],
              paddingBottom: Math.max(insets.bottom, 20),
            },
          ]}
        >
          <View style={styles.handle} />

          {title && (
            <View style={styles.actionSheetHeader}>
              <Text style={styles.actionSheetTitle}>{title}</Text>
            </View>
          )}

          <View style={styles.actionSheetItems}>
            {items.map((item, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.actionSheetItem,
                  index === items.length - 1 && styles.actionSheetItemLast,
                  item.disabled && styles.actionSheetItemDisabled,
                ]}
                onPress={() => {
                  if (!item.disabled) {
                    item.onPress();
                    onClose();
                  }
                }}
                activeOpacity={0.7}
                disabled={item.disabled}
              >
                {item.icon && (
                  <View style={styles.actionSheetItemIcon}>{item.icon}</View>
                )}
                <Text
                  style={[
                    styles.actionSheetItemText,
                    item.destructive && styles.actionSheetItemTextDestructive,
                    item.disabled && styles.actionSheetItemTextDisabled,
                  ]}
                >
                  {item.title}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {showCancel && (
            <TouchableOpacity
              style={styles.actionSheetCancel}
              onPress={onClose}
              activeOpacity={0.7}
            >
              <Text style={styles.actionSheetCancelText}>{cancelText}</Text>
            </TouchableOpacity>
          )}
        </Animated.View>
      </View>
    </RNModal>
  );
};

// ============================================
// STYLES
// ============================================

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.overlay,
  },
  overlayPressable: {
    flex: 1,
  },

  // Bottom Sheet
  bottomSheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: SCREEN_HEIGHT * 0.9,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: theme.colors.borderLight,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  bottomSheetHeader: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  bottomSheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.colors.text,
  },
  bottomSheetContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },

  // Alert Modal - CENTRÉ
  alertModalWrapper: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  alertOverlayAbsolute: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.overlay,
  },
  alertContainer: {
    backgroundColor: theme.colors.surface,
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 320,
    alignItems: 'center',
    // Ombre pour donner de la profondeur
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 20,
  },
  alertIcon: {
    marginBottom: 16,
  },
  alertTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  alertMessage: {
    fontSize: 15,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  alertButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  alertButton: {
    flex: 1,
    height: 50,
    minHeight: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertButtonPrimary: {
    backgroundColor: theme.colors.primary,
  },
  alertButtonDanger: {
    backgroundColor: theme.colors.danger,
  },
  alertButtonSecondary: {
    backgroundColor: theme.colors.surfaceLight,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  alertButtonPrimaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  alertButtonSecondaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.text,
  },

  // Action Sheet
  actionSheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  actionSheetHeader: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  actionSheetTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  actionSheetItems: {
    paddingTop: 8,
  },
  actionSheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    minHeight: 56,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  actionSheetItemLast: {
    borderBottomWidth: 0,
  },
  actionSheetItemDisabled: {
    opacity: 0.5,
  },
  actionSheetItemIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  actionSheetItemText: {
    fontSize: 17,
    color: theme.colors.text,
    flex: 1,
  },
  actionSheetItemTextDestructive: {
    color: theme.colors.danger,
  },
  actionSheetItemTextDisabled: {
    color: theme.colors.textMuted,
  },
  actionSheetCancel: {
    marginTop: 8,
    marginHorizontal: 20,
    height: 50,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
  },
  actionSheetCancelText: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.colors.textSecondary,
  },
});

export default BottomSheet;