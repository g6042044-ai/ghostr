// src/components/ui/Icons.tsx
// Icônes personnalisées pour l'application - Style moderne
// v2.0 — Theme-reactive defaults via useTheme(). The previous version used
// `theme.colors.X` as default parameter values, which evaluated at module-
// import time and froze the icon colours to the boot palette. Now each
// icon calls useTheme() and resolves any unspecified colour from the live
// palette.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from './ThemeContext';

interface IconProps {
  size?: number;
  color?: string;
}

// Wrapper pour les icônes emoji avec style cohérent
const IconWrapper: React.FC<IconProps & { children: string }> = ({
  size = 24,
  color,
  children,
}) => (
  <Text style={{ fontSize: size, color }}>{children}</Text>
);

// Each "shape" icon below is a function component that lets the caller
// override `color`, but falls back to the appropriate palette key when
// nothing is passed in. The fall-back resolution happens at render time so
// theme changes propagate live.

const BackIcon: React.FC<IconProps> = ({ size = 24, color }) => {
  const { colors } = useTheme();
  const c = color ?? colors.text;
  return (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size * 0.8, color: c }]}>‹</Text>
    </View>
  );
};

const CloseIcon: React.FC<IconProps> = ({ size = 24, color }) => {
  const { colors } = useTheme();
  const c = color ?? colors.text;
  return (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size * 0.7, color: c }]}>✕</Text>
    </View>
  );
};

const MenuIcon: React.FC<IconProps> = ({ size = 24, color }) => {
  const { colors } = useTheme();
  const c = color ?? colors.text;
  return (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size * 0.8, color: c }]}>⋮</Text>
    </View>
  );
};

const SendIcon: React.FC<IconProps> = ({ size = 24, color }) => {
  const { colors } = useTheme();
  const c = color ?? colors.textOnPrimary;
  return (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <View style={[styles.sendIcon, {
        borderLeftWidth: size * 0.45,
        borderTopWidth: size * 0.25,
        borderBottomWidth: size * 0.25,
        borderLeftColor: c,
      }]} />
    </View>
  );
};

const AddIcon: React.FC<IconProps> = ({ size = 24, color }) => {
  const { colors } = useTheme();
  const c = color ?? colors.text;
  return (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size, color: c, fontWeight: '300' }]}>+</Text>
    </View>
  );
};

const CheckIcon: React.FC<IconProps> = ({ size = 24, color }) => {
  const { colors } = useTheme();
  const c = color ?? colors.primary;
  return (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size * 0.7, color: c }]}>✓</Text>
    </View>
  );
};

const DoubleCheckIcon: React.FC<IconProps> = ({ size = 24, color }) => {
  const { colors } = useTheme();
  const c = color ?? colors.info;
  return (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size * 0.6, color: c }]}>✓✓</Text>
    </View>
  );
};

const CheckboxEmptyIcon: React.FC<IconProps> = ({ size = 24, color }) => {
  const { colors } = useTheme();
  const c = color ?? colors.border;
  return (
    <View style={[styles.checkbox, {
      width: size,
      height: size,
      borderRadius: size / 2,
      borderColor: c,
    }]} />
  );
};

const CheckboxFilledIcon: React.FC<IconProps> = ({ size = 24, color }) => {
  const { colors } = useTheme();
  const c = color ?? colors.primary;
  return (
    <View style={[styles.checkbox, styles.checkboxFilled, {
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: c,
      borderColor: c,
    }]}>
      <Text style={[styles.checkboxCheck, { fontSize: size * 0.6 }]}>✓</Text>
    </View>
  );
};

// Public API — same shape as v1 so call sites need no changes.
export const Icons = {
  Back: BackIcon,
  Close: CloseIcon,
  Menu: MenuIcon,
  Send: SendIcon,
  Add: AddIcon,
  Check: CheckIcon,
  DoubleCheck: DoubleCheckIcon,

  // Emoji icons — palette-independent
  Chat: ({ size = 24 }: IconProps) => <IconWrapper size={size}>💬</IconWrapper>,
  Phone: ({ size = 24 }: IconProps) => <IconWrapper size={size}>📞</IconWrapper>,
  Video: ({ size = 24 }: IconProps) => <IconWrapper size={size}>📹</IconWrapper>,

  Lock: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔒</IconWrapper>,
  LockOpen: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔓</IconWrapper>,
  Shield: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🛡️</IconWrapper>,
  Key: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔐</IconWrapper>,
  Verified: ({ size = 24 }: IconProps) => <IconWrapper size={size}>✅</IconWrapper>,

  Camera: ({ size = 24 }: IconProps) => <IconWrapper size={size}>📷</IconWrapper>,
  QRCode: ({ size = 24 }: IconProps) => <IconWrapper size={size}>📱</IconWrapper>,
  Link: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔗</IconWrapper>,
  Copy: ({ size = 24 }: IconProps) => <IconWrapper size={size}>📋</IconWrapper>,

  Settings: ({ size = 24 }: IconProps) => <IconWrapper size={size}>⚙️</IconWrapper>,
  Refresh: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔄</IconWrapper>,
  Search: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔍</IconWrapper>,
  Info: ({ size = 24 }: IconProps) => <IconWrapper size={size}>ℹ️</IconWrapper>,
  Warning: ({ size = 24 }: IconProps) => <IconWrapper size={size}>⚠️</IconWrapper>,
  Error: ({ size = 24 }: IconProps) => <IconWrapper size={size}>❌</IconWrapper>,
  Success: ({ size = 24 }: IconProps) => <IconWrapper size={size}>✅</IconWrapper>,

  Delete: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🗑️</IconWrapper>,
  Trash: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🗑️</IconWrapper>,

  CheckboxEmpty: CheckboxEmptyIcon,
  CheckboxFilled: CheckboxFilledIcon,
};

const styles = StyleSheet.create({
  iconContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconText: {
    textAlign: 'center',
  },
  sendIcon: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderRightWidth: 0,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 4,
  },
  checkbox: {
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxFilled: {
    borderWidth: 0,
  },
  checkboxCheck: {
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
});

export default Icons;
