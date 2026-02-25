// src/components/ui/Icons.tsx
// Icônes personnalisées pour l'application - Style moderne

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from './theme';

interface IconProps {
  size?: number;
  color?: string;
}

// Wrapper pour les icônes emoji avec style cohérent
const IconWrapper: React.FC<IconProps & { children: string }> = ({ 
  size = 24, 
  color, 
  children 
}) => (
  <Text style={{ fontSize: size, color }}>{children}</Text>
);

// Icônes principales de l'application
export const Icons = {
  // Navigation
  Back: ({ size = 24, color = theme.colors.text }: IconProps) => (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size * 0.8, color }]}>‹</Text>
    </View>
  ),
  
  Close: ({ size = 24, color = theme.colors.text }: IconProps) => (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size * 0.7, color }]}>✕</Text>
    </View>
  ),
  
  Menu: ({ size = 24, color = theme.colors.text }: IconProps) => (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size * 0.8, color }]}>⋮</Text>
    </View>
  ),
  
  // Actions
  Send: ({ size = 24, color = theme.colors.textOnPrimary }: IconProps) => (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <View style={[styles.sendIcon, { 
        borderLeftWidth: size * 0.45, 
        borderTopWidth: size * 0.25, 
        borderBottomWidth: size * 0.25,
        borderLeftColor: color,
      }]} />
    </View>
  ),
  
  Add: ({ size = 24, color = theme.colors.text }: IconProps) => (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size, color, fontWeight: '300' }]}>+</Text>
    </View>
  ),
  
  Check: ({ size = 24, color = theme.colors.primary }: IconProps) => (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size * 0.7, color }]}>✓</Text>
    </View>
  ),
  
  DoubleCheck: ({ size = 24, color = theme.colors.info }: IconProps) => (
    <View style={[styles.iconContainer, { width: size, height: size }]}>
      <Text style={[styles.iconText, { fontSize: size * 0.6, color }]}>✓✓</Text>
    </View>
  ),
  
  // Communication
  Chat: ({ size = 24 }: IconProps) => <IconWrapper size={size}>💬</IconWrapper>,
  Phone: ({ size = 24 }: IconProps) => <IconWrapper size={size}>📞</IconWrapper>,
  Video: ({ size = 24 }: IconProps) => <IconWrapper size={size}>📹</IconWrapper>,
  
  // Sécurité
  Lock: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔒</IconWrapper>,
  LockOpen: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔓</IconWrapper>,
  Shield: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🛡️</IconWrapper>,
  Key: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔐</IconWrapper>,
  Verified: ({ size = 24 }: IconProps) => <IconWrapper size={size}>✅</IconWrapper>,
  
  // Médias
  Camera: ({ size = 24 }: IconProps) => <IconWrapper size={size}>📷</IconWrapper>,
  QRCode: ({ size = 24 }: IconProps) => <IconWrapper size={size}>📱</IconWrapper>,
  Link: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔗</IconWrapper>,
  Copy: ({ size = 24 }: IconProps) => <IconWrapper size={size}>📋</IconWrapper>,
  
  // Interface
  Settings: ({ size = 24 }: IconProps) => <IconWrapper size={size}>⚙️</IconWrapper>,
  Refresh: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔄</IconWrapper>,
  Search: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🔍</IconWrapper>,
  Info: ({ size = 24 }: IconProps) => <IconWrapper size={size}>ℹ️</IconWrapper>,
  Warning: ({ size = 24 }: IconProps) => <IconWrapper size={size}>⚠️</IconWrapper>,
  Error: ({ size = 24 }: IconProps) => <IconWrapper size={size}>❌</IconWrapper>,
  Success: ({ size = 24 }: IconProps) => <IconWrapper size={size}>✅</IconWrapper>,
  
  // Actions destructives
  Delete: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🗑️</IconWrapper>,
  Trash: ({ size = 24 }: IconProps) => <IconWrapper size={size}>🗑️</IconWrapper>,
  
  // Checkbox
  CheckboxEmpty: ({ size = 24, color = theme.colors.border }: IconProps) => (
    <View style={[styles.checkbox, { 
      width: size, 
      height: size, 
      borderRadius: size / 2,
      borderColor: color 
    }]} />
  ),
  
  CheckboxFilled: ({ size = 24, color = theme.colors.primary }: IconProps) => (
    <View style={[styles.checkbox, styles.checkboxFilled, { 
      width: size, 
      height: size, 
      borderRadius: size / 2,
      backgroundColor: color,
      borderColor: color,
    }]}>
      <Text style={[styles.checkboxCheck, { fontSize: size * 0.6 }]}>✓</Text>
    </View>
  ),
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
