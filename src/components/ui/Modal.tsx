// src/components/ui/Modal.tsx
// Modales robustes avec boutons visibles
// AlertModal centrée au milieu de l'écran
// BottomSheet avec support du clavier

import React, { useEffect, useRef } from 'react';
import { Modal as RNModal, View, Text, StyleSheet, TouchableOpacity, Pressable, Animated, Dimensions, Platform, ScrollView, ActivityIndicator, KeyboardAvoidingView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, useThemedStyles } from './ThemeContext';
import type { ColorPalette } from './theme';

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
  subtitle?: string;
  icon?: React.ReactNode;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
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
  const styles = useThemedStyles(makeStyles);
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
  const styles = useThemedStyles(makeStyles);
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
                <Text
                  style={styles.alertButtonSecondaryText}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.82}
                >
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
                  <Text
                    style={styles.alertButtonPrimaryText}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.82}
                  >
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
  subtitle,
  items,
  showCancel = true,
  cancelText,
}) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const resolvedCancelText = cancelText ?? t('common.cancel');
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // PERF FIX (UX) : garde anti double-tap.
  // Pendant la fermeture (200-250ms), le RNModal reste monté donc les
  // TouchableOpacity restent cliquables. Sans cette garde, un tap rapide
  // pouvait déclencher item.onPress() deux fois (ou pire, naviguer vers
  // un écran A puis B avant que le premier ne soit traité côté navigator).
  const isHandlingPressRef = useRef(false);

  // Reset la garde et les anims chaque ouverture.
  useEffect(() => {
    if (visible) {
      isHandlingPressRef.current = false;

      // PERF FIX (UX) : les items sont visibles dès le 1er paint.
      // L'entrée visuelle du menu, c'est le slide-up du sheet — pas besoin
      // d'animer aussi chaque item. La version précédente ajoutait :
      //   80ms delay + 40ms × N stagger + spring 250-400ms par item
      //   = ~400-600ms d'attente avant que les boutons soient "posés".
      // Maintenant : sheet glisse → items déjà à leur place = snappy.
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 100,   // était 65 — un peu plus stiff = arrive plus vite
          friction: 13,   // était 11 — limite l'overshoot avec la nouvelle tension
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 180,  // était 200
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: SCREEN_HEIGHT,
          duration: 220,  // était 250
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 180,  // était 200
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  // PERF FIX (UX) : handler unifié qui résout le bug "1er clic ne marche pas".
  //
  // Avant — séquence problématique :
  //   1. user tap → item.onPress() → setShowMenu(false) puis navigation.navigate(...)
  //   2. onClose() → setShowMenu(false) (redondant)
  //   3. React batch → modal.visible passe false
  //   4. RNModal commence à se détacher
  //   5. Sur Android, naviguer vers presentation: 'fullScreenModal' ouvre une
  //      NOUVELLE Activity. Pendant que la WindowManager.removeView du dialog
  //      tourne, l'event de navigation peut être avalé par le système.
  //   → l'utilisateur tape "Créer", rien ne se passe, retape, ça marche.
  //
  // Après :
  //   1. on guard contre les taps répétés (isHandlingPressRef)
  //   2. on ferme d'abord (l'utilisateur voit le feedback immédiat)
  //   3. on défère item.onPress() au tick suivant via setTimeout(0)
  //      → laisse React commiter visible=false → RNModal commence le détachement
  //      → la navigation se fait après, sans race avec la nouvelle Activity
  //   Délai ajouté : < 1 frame (~4-16ms typique), invisible à l'œil.
  const handleItemPress = (item: ActionSheetItem) => {
    if (item.disabled || isHandlingPressRef.current) return;
    isHandlingPressRef.current = true;
    onClose();
    setTimeout(() => {
      item.onPress();
    }, 0);
  };

  // Cancel button : pas de race possible (pas de navigation), on appelle direct.
  // On guard quand même contre les double-taps pour cohérence.
  const handleCancelPress = () => {
    if (isHandlingPressRef.current) return;
    isHandlingPressRef.current = true;
    onClose();
  };

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
          <Pressable style={styles.overlayPressable} onPress={handleCancelPress} />
        </Animated.View>

        <Animated.View
          style={[
            styles.actionSheet,
            {
              transform: [{ translateY: slideAnim }],
              paddingBottom: Math.max(insets.bottom, 16) + 8,
            },
          ]}
        >
          <View style={styles.handle} />

          {/* Header */}
          {title && (
            <View style={styles.actionSheetHeader}>
              <Text style={styles.actionSheetTitle}>{title}</Text>
              {subtitle && (
                <Text style={styles.actionSheetSubtitle}>{subtitle}</Text>
              )}
            </View>
          )}

          {/* Items as cards — pas d'animation per-item, ils glissent avec le sheet */}
          <View style={styles.actionSheetCards}>
            {items.map((item, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.actionSheetCard,
                  item.disabled && styles.actionSheetCardDisabled,
                  item.destructive && styles.actionSheetCardDestructive,
                ]}
                onPress={() => handleItemPress(item)}
                activeOpacity={0.7}
                disabled={item.disabled}
              >
                {item.icon && (
                  <View style={[
                    styles.actionSheetCardIcon,
                    item.destructive && styles.actionSheetCardIconDestructive,
                  ]}>
                    {item.icon}
                  </View>
                )}
                <View style={styles.actionSheetCardContent}>
                  <Text
                    style={[
                      styles.actionSheetCardTitle,
                      item.destructive && styles.actionSheetCardTitleDestructive,
                      item.disabled && styles.actionSheetCardTitleDisabled,
                    ]}
                    numberOfLines={1}
                  >
                    {item.title}
                  </Text>
                  {item.subtitle && (
                    <Text style={styles.actionSheetCardSubtitle} numberOfLines={2}>
                      {item.subtitle}
                    </Text>
                  )}
                </View>
                <View style={styles.actionSheetCardChevron}>
                  <Text style={[
                    styles.actionSheetCardChevronText,
                    item.destructive && { color: colors.danger },
                  ]}>›</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>

          {showCancel && (
            <TouchableOpacity
              style={styles.actionSheetCancel}
              onPress={handleCancelPress}
              activeOpacity={0.7}
            >
              <Text style={styles.actionSheetCancelText}>{resolvedCancelText}</Text>
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

const makeStyles = (colors: ColorPalette) => ({
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
  },
  overlayPressable: {
    flex: 1,
  },

  // Bottom Sheet
  bottomSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: SCREEN_HEIGHT * 0.9,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: colors.borderLight,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  bottomSheetHeader: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  bottomSheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
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
    backgroundColor: colors.overlay,
  },
  alertContainer: {
    backgroundColor: colors.surface,
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
    color: colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  alertMessage: {
    fontSize: 15,
    color: colors.textSecondary,
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
    backgroundColor: colors.primary,
  },
  alertButtonDanger: {
    backgroundColor: colors.danger,
  },
  alertButtonSecondary: {
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.border,
  },
  alertButtonPrimaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    flexShrink: 1,
    textAlign: 'center',
  },
  alertButtonSecondaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    flexShrink: 1,
    textAlign: 'center',
  },

  // Action Sheet - Modern card-based design
  actionSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  actionSheetHeader: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 4,
  },
  actionSheetTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.4,
  },
  actionSheetSubtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 4,
    lineHeight: 20,
  },
  actionSheetCards: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    gap: 8,
  },
  actionSheetCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionSheetCardDisabled: {
    opacity: 0.5,
  },
  actionSheetCardDestructive: {
    backgroundColor: colors.danger + '08',
    borderColor: colors.danger + '20',
  },
  actionSheetCardIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  actionSheetCardIconDestructive: {
    backgroundColor: colors.danger + '15',
  },
  actionSheetCardContent: {
    flex: 1,
  },
  actionSheetCardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: -0.2,
  },
  actionSheetCardTitleDestructive: {
    color: colors.danger,
  },
  actionSheetCardTitleDisabled: {
    color: colors.textMuted,
  },
  actionSheetCardSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 3,
    lineHeight: 18,
  },
  actionSheetCardChevron: {
    marginLeft: 8,
  },
  actionSheetCardChevronText: {
    fontSize: 22,
    color: colors.textMuted,
    fontWeight: '300',
  },
  actionSheetCancel: {
    marginTop: 4,
    marginHorizontal: 16,
    height: 50,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceLight,
    borderRadius: 14,
  },
  actionSheetCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textSecondary,
  },
}) as const;

export default BottomSheet;