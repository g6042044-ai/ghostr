// src/components/ui/Button.tsx
// Composants de boutons modernes et réutilisables

import React from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  View,
  Animated,
  Pressable,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { theme } from './theme';

// ============================================
// TYPES
// ============================================

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'small' | 'medium' | 'large';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  fullWidth?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
}

interface IconButtonProps {
  icon: React.ReactNode;
  onPress: () => void;
  size?: number;
  color?: string;
  backgroundColor?: string;
  disabled?: boolean;
  style?: ViewStyle;
}

interface FABProps {
  icon: React.ReactNode;
  onPress: () => void;
  color?: string;
  backgroundColor?: string;
  size?: 'small' | 'medium' | 'large';
  style?: ViewStyle;
}

// ============================================
// BUTTON COMPONENT
// ============================================

export const Button: React.FC<ButtonProps> = ({
  title,
  onPress,
  variant = 'primary',
  size = 'medium',
  disabled = false,
  loading = false,
  icon,
  iconPosition = 'left',
  fullWidth = false,
  style,
  textStyle,
}) => {
  const scaleAnim = React.useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.96,
      useNativeDriver: true,
      tension: 300,
      friction: 10,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 300,
      friction: 10,
    }).start();
  };

  const getVariantStyles = (): { container: ViewStyle; text: TextStyle } => {
    switch (variant) {
      case 'primary':
        return {
          container: {
            backgroundColor: theme.colors.primary,
          },
          text: {
            color: theme.colors.textOnPrimary,
          },
        };
      case 'secondary':
        return {
          container: {
            backgroundColor: theme.colors.surface,
            borderWidth: 1.5,
            borderColor: theme.colors.border,
          },
          text: {
            color: theme.colors.text,
          },
        };
      case 'ghost':
        return {
          container: {
            backgroundColor: 'transparent',
          },
          text: {
            color: theme.colors.primary,
          },
        };
      case 'danger':
        return {
          container: {
            backgroundColor: theme.colors.danger,
          },
          text: {
            color: theme.colors.textOnPrimary,
          },
        };
      case 'success':
        return {
          container: {
            backgroundColor: theme.colors.success,
          },
          text: {
            color: theme.colors.textOnPrimary,
          },
        };
      default:
        return {
          container: {},
          text: {},
        };
    }
  };

  const getSizeStyles = (): { container: ViewStyle; text: TextStyle } => {
    switch (size) {
      case 'small':
        return {
          container: {
            height: theme.button.small.height,
            paddingHorizontal: theme.button.small.paddingHorizontal,
            borderRadius: theme.borderRadius.md,
          },
          text: {
            fontSize: theme.fontSize.sm,
          },
        };
      case 'medium':
        return {
          container: {
            height: theme.button.medium.height,
            paddingHorizontal: theme.button.medium.paddingHorizontal,
            borderRadius: theme.borderRadius.lg,
          },
          text: {
            fontSize: theme.fontSize.md,
          },
        };
      case 'large':
        return {
          container: {
            height: theme.button.large.height,
            paddingHorizontal: theme.button.large.paddingHorizontal,
            borderRadius: theme.borderRadius.xl,
          },
          text: {
            fontSize: theme.fontSize.lg,
          },
        };
    }
  };

  const variantStyles = getVariantStyles();
  const sizeStyles = getSizeStyles();

  return (
    <Animated.View style={[{ transform: [{ scale: scaleAnim }] }, fullWidth && styles.fullWidth]}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled || loading}
        activeOpacity={0.8}
        style={[
          styles.button,
          variantStyles.container,
          sizeStyles.container,
          disabled && styles.buttonDisabled,
          fullWidth && styles.fullWidth,
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator 
            size="small" 
            color={variantStyles.text.color as string} 
          />
        ) : (
          <View style={styles.buttonContent}>
            {icon && iconPosition === 'left' && (
              <View style={styles.iconLeft}>{icon}</View>
            )}
            <Text
              style={[
                styles.buttonText,
                variantStyles.text,
                sizeStyles.text,
                disabled && styles.textDisabled,
                textStyle,
              ]}
            >
              {title}
            </Text>
            {icon && iconPosition === 'right' && (
              <View style={styles.iconRight}>{icon}</View>
            )}
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
};

// ============================================
// ICON BUTTON COMPONENT
// ============================================

export const IconButton: React.FC<IconButtonProps> = ({
  icon,
  onPress,
  size = 44,
  color,
  backgroundColor = 'transparent',
  disabled = false,
  style,
}) => {
  const scaleAnim = React.useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.9,
      useNativeDriver: true,
      tension: 400,
      friction: 10,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 400,
      friction: 10,
    }).start();
  };

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled}
        activeOpacity={0.7}
        style={[
          styles.iconButton,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor,
          },
          disabled && styles.buttonDisabled,
          style,
        ]}
      >
        {icon}
      </TouchableOpacity>
    </Animated.View>
  );
};

// ============================================
// FAB (Floating Action Button)
// ============================================

export const FAB: React.FC<FABProps> = ({
  icon,
  onPress,
  color = theme.colors.textOnPrimary,
  backgroundColor = theme.colors.primary,
  size = 'medium',
  style,
}) => {
  const scaleAnim = React.useRef(new Animated.Value(1)).current;

  const getSizeValue = () => {
    switch (size) {
      case 'small': return 48;
      case 'medium': return 56;
      case 'large': return 64;
    }
  };

  const fabSize = getSizeValue();

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.92,
      useNativeDriver: true,
      tension: 400,
      friction: 10,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 400,
      friction: 10,
    }).start();
  };

  return (
    <Animated.View
      style={[
        styles.fab,
        {
          transform: [{ scale: scaleAnim }],
          width: fabSize,
          height: fabSize,
          borderRadius: fabSize / 2,
          backgroundColor,
        },
        theme.shadow.lg,
        style,
      ]}
    >
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={0.9}
        style={[
          styles.fabTouchable,
          {
            width: fabSize,
            height: fabSize,
            borderRadius: fabSize / 2,
          },
        ]}
      >
        {icon}
      </TouchableOpacity>
    </Animated.View>
  );
};

// ============================================
// LINK BUTTON
// ============================================

interface LinkButtonProps {
  title: string;
  onPress: () => void;
  color?: string;
  size?: 'small' | 'medium' | 'large';
  disabled?: boolean;
}

export const LinkButton: React.FC<LinkButtonProps> = ({
  title,
  onPress,
  color = theme.colors.primary,
  size = 'medium',
  disabled = false,
}) => {
  const getFontSize = () => {
    switch (size) {
      case 'small': return theme.fontSize.sm;
      case 'medium': return theme.fontSize.md;
      case 'large': return theme.fontSize.lg;
    }
  };

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.6}
      style={styles.linkButton}
    >
      <Text
        style={[
          styles.linkButtonText,
          {
            color: disabled ? theme.colors.textMuted : color,
            fontSize: getFontSize(),
          },
        ]}
      >
        {title}
      </Text>
    </TouchableOpacity>
  );
};

// ============================================
// STYLES
// ============================================

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontWeight: '600',
    textAlign: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  textDisabled: {
    opacity: 0.7,
  },
  fullWidth: {
    width: '100%',
  },
  iconLeft: {
    marginRight: 8,
  },
  iconRight: {
    marginLeft: 8,
  },
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabTouchable: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkButton: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  linkButtonText: {
    fontWeight: '600',
  },
});

export default Button;
