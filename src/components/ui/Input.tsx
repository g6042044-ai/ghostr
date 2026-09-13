// src/components/ui/Input.tsx
// Composants d'entrée simples et robustes

import React, { useState, useRef, useEffect } from 'react';
import { View, TextInput, Text, Animated, TouchableOpacity, Platform, TextInputProps, ViewStyle, ActivityIndicator } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { useTheme, useThemedStyles } from './ThemeContext';
import type { ColorPalette } from './theme';

// ============================================
// SEND ICON
// ============================================

const SendIcon = ({ color = '#FFFFFF', size = 22 }: { color?: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M22 2L11 13M22 2L15 22L11 13L2 9L22 2Z"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

// ============================================
// TYPES
// ============================================

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  containerStyle?: ViewStyle;
}

interface ChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  placeholder?: string;
  sending?: boolean;
  disabled?: boolean;
  maxLength?: number;
}

interface SearchInputProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onClear?: () => void;
  autoFocus?: boolean;
}

interface PINInputProps {
  length?: number;
  value: string;
  onChangeText: (text: string) => void;
  error?: boolean;
  secure?: boolean;
}

// ============================================
// STANDARD INPUT
// ============================================

export const Input: React.FC<InputProps> = ({
  label,
  error,
  hint,
  leftIcon,
  rightIcon,
  containerStyle,
  style,
  onFocus,
  onBlur,
  secureTextEntry,
  ...props
}) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus = (e: any) => {
    setIsFocused(true);
    onFocus?.(e);
  };

  const handleBlur = (e: any) => {
    setIsFocused(false);
    onBlur?.(e);
  };

  // Props additionnelles pour les champs de mot de passe
  const passwordProps = secureTextEntry ? {
    autoCapitalize: 'none' as const,
    autoCorrect: false,
    textContentType: 'password' as const,
    autoComplete: 'password' as const,
  } : {};

  return (
    <View style={[styles.inputContainer, containerStyle]}>
      {label && (
        <Text style={[styles.label, error && styles.labelError]}>{label}</Text>
      )}
      
      <View
        style={[
          styles.inputWrapper,
          isFocused && styles.inputWrapperFocused,
          error && styles.inputWrapperError,
        ]}
      >
        {leftIcon && <View style={styles.leftIcon}>{leftIcon}</View>}
        
        <TextInput
          style={[
            styles.input,
            leftIcon && styles.inputWithLeftIcon,
            rightIcon && styles.inputWithRightIcon,
            style,
          ]}
          placeholderTextColor={colors.placeholder}
          onFocus={handleFocus}
          onBlur={handleBlur}
          secureTextEntry={secureTextEntry}
          {...passwordProps}
          {...props}
        />
        
        {rightIcon && <View style={styles.rightIcon}>{rightIcon}</View>}
      </View>

      {(error || hint) && (
        <Text style={[styles.hint, error && styles.errorText]}>
          {error || hint}
        </Text>
      )}
    </View>
  );
};

// ============================================
// CHAT INPUT
// ============================================

export const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChangeText,
  onSend,
  placeholder,
  sending = false,
  disabled = false,
  maxLength = 5000,
}) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t('conversation.messageInputPlaceholder');
  const inputRef = useRef<TextInput>(null);
  const canSend = value.trim().length > 0 && !sending && !disabled;

  return (
    <View style={styles.chatInputContainer}>
      <View style={styles.chatInputWrapper}>
        <TextInput
          ref={inputRef}
          style={styles.chatInput}
          value={value}
          onChangeText={onChangeText}
          placeholder={resolvedPlaceholder}
          placeholderTextColor={colors.placeholder}
          multiline
          maxLength={maxLength}
          editable={!disabled}
        />
      </View>

      <TouchableOpacity
        style={[
          styles.sendButton,
          canSend ? styles.sendButtonActive : styles.sendButtonInactive,
        ]}
        onPress={onSend}
        disabled={!canSend}
        activeOpacity={0.7}
      >
        {sending ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <SendIcon color={canSend ? '#FFFFFF' : colors.textMuted} />
        )}
      </TouchableOpacity>
    </View>
  );
};

// ============================================
// SEARCH INPUT
// ============================================

export const SearchInput: React.FC<SearchInputProps> = ({
  value,
  onChangeText,
  placeholder,
  onClear,
  autoFocus = false,
}) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t('input.searchPlaceholder');
  return (
    <View style={styles.searchContainer}>
      <View style={styles.searchIconWrapper}>
        <Text style={styles.searchIcon}>🔍</Text>
      </View>
      
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={resolvedPlaceholder}
        placeholderTextColor={colors.placeholder}
        autoFocus={autoFocus}
        returnKeyType="search"
      />

      {value.length > 0 && onClear && (
        <TouchableOpacity style={styles.clearButton} onPress={onClear}>
          <Text style={styles.clearIcon}>✕</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

// ============================================
// PIN INPUT
// ============================================

export const PINInput: React.FC<PINInputProps> = ({
  length = 6,
  value,
  onChangeText,
  error = false,
  secure = true,
}) => {
  const styles = useThemedStyles(makeStyles);
  const inputRef = useRef<TextInput>(null);
  const shakeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (error) {
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
      ]).start();
    }
  }, [error]);

  const focusInput = () => {
    inputRef.current?.focus();
  };

  return (
    <TouchableOpacity activeOpacity={1} onPress={focusInput}>
      <Animated.View
        style={[
          styles.pinContainer,
          { transform: [{ translateX: shakeAnim }] },
        ]}
      >
        {Array.from({ length }).map((_, index) => {
          const isFilled = index < value.length;
          const isActive = index === value.length;

          return (
            <View
              key={index}
              style={[
                styles.pinDot,
                isFilled && styles.pinDotFilled,
                isActive && styles.pinDotActive,
                error && styles.pinDotError,
              ]}
            >
              {isFilled && secure && <View style={styles.pinDotInner} />}
              {isFilled && !secure && (
                <Text style={styles.pinDotText}>{value[index]}</Text>
              )}
            </View>
          );
        })}
      </Animated.View>

      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        value={value}
        onChangeText={(text) => {
          if (text.length <= length) {
            onChangeText(text);
          }
        }}
        keyboardType="number-pad"
        maxLength={length}
        autoFocus
      />
    </TouchableOpacity>
  );
};

// ============================================
// CODE INPUT
// ============================================

interface CodeInputProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
}

export const CodeInput: React.FC<CodeInputProps> = ({
  value,
  onChangeText,
  placeholder,
  error,
  hint,
}) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t('input.enterCode');
  return (
    <View style={styles.codeInputContainer}>
      <TextInput
        style={[styles.codeInput, error && styles.codeInputError]}
        value={value}
        onChangeText={onChangeText}
        placeholder={resolvedPlaceholder}
        placeholderTextColor={colors.placeholder}
        multiline
        autoCapitalize="characters"
        autoCorrect={false}
        spellCheck={false}
      />
      
      {(error || hint) && (
        <Text style={[styles.codeHint, error && styles.codeError]}>
          {error || hint}
        </Text>
      )}
    </View>
  );
};

// ============================================
// STYLES
// ============================================

const makeStyles = (colors: ColorPalette) => ({
  // Standard Input
  inputContainer: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: 8,
    marginLeft: 4,
  },
  labelError: {
    color: colors.danger,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.inputBackground,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.inputBorder,
    minHeight: 48,
  },
  inputWrapperFocused: {
    borderColor: colors.primary,
    backgroundColor: colors.surfaceElevated,
  },
  inputWrapperError: {
    borderColor: colors.danger,
  },
  input: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  inputWithLeftIcon: {
    paddingLeft: 8,
  },
  inputWithRightIcon: {
    paddingRight: 8,
  },
  leftIcon: {
    paddingLeft: 16,
  },
  rightIcon: {
    paddingRight: 16,
  },
  hint: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 6,
    marginLeft: 4,
  },
  errorText: {
    color: colors.danger,
  },

  // Chat Input
  chatInputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  chatInputWrapper: {
    flex: 1,
    backgroundColor: colors.inputBackground,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    minHeight: 48,
    maxHeight: 120,
    justifyContent: 'center',
  },
  chatInput: {
    fontSize: 16,
    color: colors.text,
    maxHeight: 100,
    lineHeight: 22,
    paddingTop: 0,
    paddingBottom: 0,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonActive: {
    backgroundColor: colors.primary,
  },
  sendButtonInactive: {
    backgroundColor: colors.surfaceLight,
  },

  // Search Input
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.inputBackground,
    borderRadius: 16,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  searchIconWrapper: {
    marginRight: 8,
  },
  searchIcon: {
    fontSize: 16,
    opacity: 0.6,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: colors.text,
    paddingVertical: 10,
  },
  clearButton: {
    padding: 4,
  },
  clearIcon: {
    fontSize: 14,
    color: colors.textMuted,
  },

  // PIN Input
  pinContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  pinDot: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.inputBackground,
    borderWidth: 2,
    borderColor: colors.inputBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinDotFilled: {
    borderColor: colors.primary,
    backgroundColor: colors.surfaceElevated,
  },
  pinDotActive: {
    borderColor: colors.primary,
  },
  pinDotError: {
    borderColor: colors.danger,
  },
  pinDotInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.text,
  },
  pinDotText: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text,
  },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    height: 0,
  },

  // Code Input
  codeInputContainer: {
    marginBottom: 16,
  },
  codeInput: {
    backgroundColor: colors.inputBackground,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.inputBorder,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.text,
    minHeight: 100,
    textAlignVertical: 'top',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  codeInputError: {
    borderColor: colors.danger,
  },
  codeHint: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 8,
  },
  codeError: {
    color: colors.danger,
  },
}) as const;

export default Input;