// src/components/ui/index.ts
// Export centralisé de tous les composants UI

// Theme — palettes, types, helpers
export {
  theme,
  messageColors,
  createResponsiveStyle,
  getColorsForScheme,
  getMessageColors,
  getAvatarColor,
  avatarColors,
  darkColors,
  lightColors,
  getBootScheme,
} from './theme';
export type { Theme, ThemeColors, ColorScheme, ColorPalette } from './theme';

// Theme context — provider + hooks pour live-reactive consumers
export {
  ThemeProvider,
  useTheme,
  useThemeColors,
  useThemedStyles,
} from './ThemeContext';
export type { ThemeContextValue } from './ThemeContext';

// Icons
export { Icons } from './Icons';

// Buttons
export { Button, IconButton, FAB, LinkButton } from './Button';

// Modals
export { BottomSheet, AlertModal, ActionSheet } from './Modal';

// Inputs
export { Input, ChatInput, SearchInput, PINInput, CodeInput } from './Input';

// Headers
export { Header, ChatHeader, SelectionHeader, LargeHeader } from './Header';
