// src/components/ui/index.ts
// Export centralisé de tous les composants UI

// Theme — palettes, types, helpers
export {
  theme,
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

// Icônes — plus d'export ici. `ui/Icons.tsx` a été SUPPRIMÉ.
//
// C'était un troisième système d'icônes, composé d'emojis rendus dans un
// <Text> (💬 📞 🔒 ⚙️ 🗑️ …). Trois problèmes :
//   1. le rendu dépendait de la police emoji de l'OS — dessin, taille
//      optique et couleur variaient entre iOS et Android, et changeaient
//      avec la version du système ;
//   2. une icône emoji ignore la couleur du thème : impossible de la
//      teinter, donc impossible de l'accorder au mode clair ;
//   3. le fichier n'était importé par AUCUN écran — c'était du poids mort.
//
// L'app utilise désormais Ionicons partout, et les SVG maison uniquement
// pour le logo et les icônes de bulle de ConversationScreen (coches de
// statut, réponse), qui n'ont pas d'équivalent satisfaisant chez Ionicons.

// Buttons
export { Button, IconButton, FAB, LinkButton } from './Button';

// Modals
export { BottomSheet, AlertModal, ActionSheet } from './Modal';

// Toast — confirmations éphémères non bloquantes (API impérative)
export { ToastHost, showToast } from './Toast';
export type { ToastOptions, ToastVariant } from './Toast';

// Dialogues impératifs — remplacent `Alert.alert` dans tous les écrans
export { AlertHost, showAlert, showConfirm, showActionSheet, isAlertHostReady } from './AlertHost';
export type { AlertButton, AlertRequest, ConfirmRequest, ActionSheetRequest } from './AlertHost';

// Inputs
export { Input, ChatInput, SearchInput, PINInput, CodeInput } from './Input';

// Headers
export { Header, ChatHeader, SelectionHeader, LargeHeader } from './Header';
