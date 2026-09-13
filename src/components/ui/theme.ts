// src/components/ui/theme.ts
// v4.0 — Palettes claire et sombre + tokens non chromatiques.
//
// ════════════════════════════════════════════════════════════════════════════
// ARCHITECTURE
// ════════════════════════════════════════════════════════════════════════════
// Ce module expose DEUX choses, de natures très différentes :
//
//   1. LES PALETTES (`darkColors`, `lightColors`, `getColorsForScheme`).
//      Ce sont des données pures. Personne ne les lit directement pour
//      styler : on passe par `useTheme()` / `useThemedStyles()`
//      (./ThemeContext.tsx), qui renvoient la palette ACTIVE et re-rendent
//      les consommateurs quand elle change.
//
//   2. LES TOKENS NON CHROMATIQUES (`theme`) : espacements, rayons, tailles
//      de police, ombres, durées d'animation. Indépendants du thème, donc
//      figés sans risque.
//
// ⚠️ `theme.colors` N'EXISTE PLUS.
//
// Les versions précédentes l'exposaient : une COPIE de la palette résolue au
// chargement du module. Tout `StyleSheet.create({ color: theme.colors.X })`
// écrit au niveau module capturait ces valeurs une fois pour toutes et ne
// pouvait plus jamais changer — d'où la modale « redémarrez l'application »
// qui accompagnait chaque changement d'apparence, et un mode clair de fait
// inatteignable.
//
// Toutes ces feuilles de styles ont été converties en FABRIQUES
// `makeStyles(colors)` consommées par `useThemedStyles`. La clé `colors` a
// ensuite été retirée pour que le compilateur interdise toute rechute :
// réintroduire `theme.colors.X` ne compile pas.
//
// ════════════════════════════════════════════════════════════════════════════
// PRIVACY
// ════════════════════════════════════════════════════════════════════════════
// `Appearance.getColorScheme()` reads only the local OS preference (no
// network). The user's stored override lives in AsyncStorage (cf.
// services/themeStorage.ts), never sent to the server, never logged.

import { Dimensions, Appearance } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Responsive breakpoints — unchanged from v2.0
const isSmallDevice = SCREEN_WIDTH < 375;
const isMediumDevice = SCREEN_WIDTH >= 375 && SCREEN_WIDTH < 414;
const isLargeDevice = SCREEN_WIDTH >= 414;

const scale = (size: number) => (SCREEN_WIDTH / 375) * size;
const verticalScale = (size: number) => (SCREEN_HEIGHT / 812) * size;
const moderateScale = (size: number, factor = 0.5) => size + (scale(size) - size) * factor;

// ════════════════════════════════════════════════════════════════════════════
// COLOR PALETTES
// ════════════════════════════════════════════════════════════════════════════
// Both palettes have the EXACT same shape (same keys). This is enforced by
// the `ColorPalette` type below — if you add a key to one, TypeScript will
// require it in the other.
//
// `darkColors` is the original v2.0 palette, unchanged. `lightColors` was
// designed by inverting the perceptual roles (backgrounds → near-white,
// surfaces → cool grey tints), keeping the accent (`primary`) recognisable in
// both modes, and tuning each colour for AA contrast on its own background.

// Same shape on both → enforced by the `typeof darkColors` annotation below.
// NB: no `as const` on either palette — that would lock each property to a
// singleton literal type and forbid `lightColors` from holding a different
// hex. The values are runtime constants; freezing them at the type level
// gains us nothing here.
const darkColors = {
  // Brand / accent
  primary: '#00D9A6',
  primaryDark: '#00B38A',
  primaryLight: '#00F5BD',

  secondary: '#00B4D8',
  accent: '#7B61FF',

  // Backgrounds — deep premium dark
  background: '#0A0F14',
  surface: '#0F161C',
  surfaceLight: '#1A252F',
  surfaceElevated: '#243240',

  // Text
  text: '#F0F4F8',
  textSecondary: '#8BA4B8',
  textMuted: '#5D7485',
  textOnPrimary: '#0A0F14',

  // Borders
  border: 'rgba(139, 164, 184, 0.12)',
  borderLight: 'rgba(139, 164, 184, 0.06)',
  divider: 'rgba(240, 244, 248, 0.06)',

  // States
  success: '#00D9A6',
  warning: '#FFB547',
  error: '#FF6B6B',
  info: '#00B4D8',

  // Message bubbles
  messageMine: '#005C4B',
  messageTheirs: '#1A252F',
  messageMineLight: '#006D5B',

  // Specials
  verified: '#00D9A6',
  unverified: '#FFB547',
  online: '#00D9A6',
  typing: '#00D9A6',

  // Overlays / glassmorphism
  overlay: 'rgba(10, 15, 20, 0.95)',
  overlayLight: 'rgba(10, 15, 20, 0.8)',
  glass: 'rgba(26, 37, 47, 0.85)',
  glassLight: 'rgba(36, 50, 64, 0.6)',

  // Input
  inputBackground: '#1A252F',
  inputBorder: 'rgba(139, 164, 184, 0.12)',
  placeholder: '#5D7485',

  // Danger
  danger: '#FF6B6B',
  dangerLight: '#FF8A8A',

  // Message status
  // `statusSent` était à 0.5 d'alpha : sur la bulle `messageMine` (#005C4B)
  // cela donnait un contraste ≈ 2,6:1, sous le seuil WCAG de 3:1 exigé pour
  // un élément graphique porteur de sens. À 0.72 on est à ≈ 4,4:1 et la
  // hiérarchie envoyé < distribué reste lisible.
  statusSent: 'rgba(255,255,255,0.72)',
  statusDelivered: 'rgba(255,255,255,0.92)',
  statusRead: '#00D9A6',

  // Reactions
  reactionBg: 'rgba(26, 37, 47, 0.95)',
  reactionBorder: 'rgba(139, 164, 184, 0.15)',
  reactionSelected: 'rgba(0, 217, 166, 0.2)',

  // Reply / quote
  replyBg: 'rgba(0, 217, 166, 0.12)',
  replyBorder: 'rgba(0, 217, 166, 0.4)',
};

// Light palette — designed for parity, not just inversion.
//
// Design notes:
//  - `primary` stays the same teal, which works visually on both backgrounds
//    (it's mid-luminance, not particularly bright or dark).
//  - Backgrounds: pure white would clash with the saturated primary, so we
//    use a very faint cool tint (#F7F9FB → #FFFFFF) that echoes the dark
//    palette's blue-grey character.
//  - Text contrast targets WCAG AA on its background (≈4.5:1 for body, 3:1
//    for muted labels).
//  - Message bubble for "mine" stays a saturated teal so the brand identity
//    survives the mode change (text is white for AA contrast).
//  - Glass/overlay alphas are tuned for a light substrate (darker base,
//    lower alpha) so the glassmorphism reads correctly.
const lightColors: typeof darkColors = {
  // Brand / accent — preserved
  primary: '#00B38A',          // slightly darker than dark.primary for AA on white
  primaryDark: '#008F6E',
  primaryLight: '#00D9A6',

  secondary: '#0091B0',
  accent: '#6951DB',

  // Backgrounds — soft cool whites
  background: '#FFFFFF',
  surface: '#F7F9FB',          // page sections / cards
  surfaceLight: '#EEF2F6',     // input fields, raised tiles
  surfaceElevated: '#E5EBF1',  // pressed states, deep wells

  // Text — near-black with cool tint to match palette character
  text: '#0F1A24',
  textSecondary: '#4A5C6E',
  textMuted: '#7D8E9F',
  textOnPrimary: '#FFFFFF',

  // Borders — soft cool grey
  border: 'rgba(15, 26, 36, 0.10)',
  borderLight: 'rgba(15, 26, 36, 0.05)',
  divider: 'rgba(15, 26, 36, 0.06)',

  // States — slightly desaturated for light bg
  success: '#00B38A',
  warning: '#E89500',
  error: '#D63838',
  info: '#0091B0',

  // Message bubbles
  // Mine: teal that holds the brand on white background; white text on top.
  messageMine: '#00B38A',
  messageMineLight: '#00C998',
  // Theirs: light grey-blue card
  messageTheirs: '#EEF2F6',

  // Specials
  verified: '#00B38A',
  unverified: '#E89500',
  online: '#00B38A',
  typing: '#00B38A',

  // Overlays — darker base + lower alpha for light substrate
  overlay: 'rgba(15, 26, 36, 0.55)',
  overlayLight: 'rgba(15, 26, 36, 0.35)',
  glass: 'rgba(247, 249, 251, 0.85)',
  glassLight: 'rgba(238, 242, 246, 0.6)',

  // Input
  inputBackground: '#F7F9FB',
  inputBorder: 'rgba(15, 26, 36, 0.10)',
  placeholder: '#7D8E9F',

  // Danger
  danger: '#D63838',
  dangerLight: '#E66060',

  // Message status — for light theme, status icons sit on the teal "mine"
  // bubble, so we mirror the dark palette's alphas-over-white-on-coloured.
  // Mêmes seuils de contraste que la palette sombre (cf. commentaire là-bas).
  statusSent: 'rgba(255,255,255,0.78)',
  statusDelivered: 'rgba(255,255,255,0.94)',
  statusRead: '#FFFFFF',

  // Reactions — light card with teal-tinted selected state
  reactionBg: 'rgba(247, 249, 251, 0.98)',
  reactionBorder: 'rgba(15, 26, 36, 0.10)',
  reactionSelected: 'rgba(0, 179, 138, 0.18)',

  // Reply / quote
  replyBg: 'rgba(0, 179, 138, 0.10)',
  replyBorder: 'rgba(0, 179, 138, 0.45)',
};

// Same shape on both → enforced by the `typeof darkColors` annotation above.
export type ColorScheme = 'light' | 'dark';
export type ColorPalette = typeof darkColors;

/**
 * Returns the colour palette for a given scheme. Pure function, no side
 * effects. Used both at boot to pick the initial palette and at runtime by
 * `useTheme()` (cf. ./ThemeContext.tsx).
 */
export function getColorsForScheme(scheme: ColorScheme): ColorPalette {
  return scheme === 'light' ? lightColors : darkColors;
}

// ════════════════════════════════════════════════════════════════════════════
// SCHEME DE DÉMARRAGE
// ════════════════════════════════════════════════════════════════════════════
// Résolu UNE fois, de façon synchrone, au premier import du module.
//
// À cet instant AsyncStorage n'a pas encore été lu (c'est asynchrone), donc
// on ne peut honorer que la préférence de l'OS. La préférence stockée par
// l'utilisateur est appliquée juste après par le `ThemeContext`.
//
// Ce scheme ne sert plus qu'à DEUX choses, toutes deux transitoires :
//   1. la valeur de repli de `resolveScheme()` quand `Appearance` ne renvoie
//      rien d'exploitable ;
//   2. la palette du `useTheme()` hors provider en production (garde-fou
//      anti-crash).
//
// Il ne détermine plus l'apparence d'aucun style : `theme.colors` a été
// supprimé, donc plus rien n'est peint à partir d'une palette figée.
const _bootScheme: ColorScheme = ((): ColorScheme => {
  try {
    // `getColorScheme()` peut renvoyer null sur les appareils qui n'exposent
    // pas de préférence ; on retombe sur le sombre, identité visuelle
    // historique de l'app.
    return Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
})();

/** Scheme résolu au démarrage (préférence OS). Cf. le bloc ci-dessus. */
export function getBootScheme(): ColorScheme {
  return _bootScheme;
}

// ════════════════════════════════════════════════════════════════════════════
// TOKENS NON CHROMATIQUES
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ `theme` NE CONTIENT PLUS DE COULEURS. La clé `colors` a été supprimée.
//
// Elle exposait une COPIE de la palette figée au chargement du module. Tout
// `StyleSheet.create({ backgroundColor: theme.colors.background })` écrit au
// niveau module capturait cette valeur une fois pour toutes : changer
// d'apparence dans les Réglages ne pouvait pas les mettre à jour, d'où la
// modale « redémarrez l'application » qui existait jusqu'ici.
//
// Les couleurs passent DÉSORMAIS EXCLUSIVEMENT par le contexte :
//   const { colors } = useTheme();                    // lecture inline
//   const styles = useThemedStyles(makeStyles);       // feuille de styles
//
// Ce qui reste ici est indépendant du thème (espacements, rayons, tailles de
// police, ombres, durées) et peut donc rester figé sans risque.
//
// La suppression est VOLONTAIREMENT non rétrocompatible : si du code
// réintroduit `theme.colors.X`, TypeScript échoue au lieu de laisser
// réapparaître silencieusement un écran figé sur l'ancienne palette.
export const theme = {
  spacing: {
    xxs: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32,
    xxxxl: 48,
  },

  borderRadius: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    full: 9999,
    messageSent: { topLeft: 20, topRight: 20, bottomLeft: 20, bottomRight: 6 },
    messageReceived: { topLeft: 6, topRight: 20, bottomLeft: 20, bottomRight: 20 },
    bubble: {
      default: 20,
      grouped: 6,
    },
  },

  fontSize: {
    xs: moderateScale(11),
    sm: moderateScale(12),
    md: moderateScale(14),
    base: moderateScale(15),
    lg: moderateScale(16),
    xl: moderateScale(18),
    xxl: moderateScale(22),
    xxxl: moderateScale(28),
    display: moderateScale(34),
  },

  fontWeight: {
    normal: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
    heavy: '800' as const,
  },

  safeArea: {
    top: 0,
    bottom: 0,
  },

  header: {
    height: 52,
    contentPaddingVertical: 6,
  },

  input: {
    height: 48,
    minHeight: 44,
    maxHeight: 120,
  },

  button: {
    small: { height: 36, paddingHorizontal: 16 },
    medium: { height: 48, paddingHorizontal: 24 },
    large: { height: 56, paddingHorizontal: 32 },
  },

  icon: {
    xs: 16,
    sm: 20,
    md: 24,
    lg: 28,
    xl: 32,
    xxl: 40,
  },

  avatar: {
    xs: 24,
    sm: 32,
    md: 40,
    lg: 52,
    xl: 72,
    xxl: 96,
  },

  shadow: {
    none: {},
    sm: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.2,
      shadowRadius: 2,
      elevation: 2,
    },
    md: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.25,
      shadowRadius: 6,
      elevation: 4,
    },
    lg: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.3,
      shadowRadius: 12,
      elevation: 8,
    },
    xl: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.35,
      shadowRadius: 20,
      elevation: 16,
    },
    glow: {
      shadowColor: '#00D9A6',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.3,
      shadowRadius: 12,
      elevation: 8,
    },
  },

  animation: {
    fast: 150,
    normal: 250,
    slow: 350,
    spring: {
      tension: 100,
      friction: 12,
    },
    springBouncy: {
      tension: 200,
      friction: 15,
    },
    springStiff: {
      tension: 400,
      friction: 20,
    },
  },

  responsive: {
    isSmall: isSmallDevice,
    isMedium: isMediumDevice,
    isLarge: isLargeDevice,
    screenWidth: SCREEN_WIDTH,
    screenHeight: SCREEN_HEIGHT,
  },
};

// Utility re-exports — unchanged
export const scale_fn = scale;
export const verticalScale_fn = verticalScale;
export const moderateScale_fn = moderateScale;

// Type exports
export type Theme = typeof theme;
export type ThemeColors = ColorPalette;

// ════════════════════════════════════════════════════════════════════════════
// COULEURS DES BULLES — fonction pure de la palette passée en argument.
// ════════════════════════════════════════════════════════════════════════════
// L'export `messageColors` qui l'accompagnait a été supprimé : c'étaient des
// getters résolus contre `theme.colors`, donc contre la palette de démarrage.
// Les appelants passent maintenant la palette de `useTheme()`.
export function getMessageColors(colors: ColorPalette) {
  return {
    sent: {
      background: colors.messageMine,
      // On the teal bubble, white is the AA-safe text for both palettes.
      text: '#FFFFFF',
      time: 'rgba(255, 255, 255, 0.7)',
      check: colors.statusRead,
    },
    received: {
      background: colors.messageTheirs,
      text: colors.text,
      time: colors.textMuted,
    },
  };
}


// ════════════════════════════════════════════════════════════════════════════
// PALETTE D'AVATARS — SOURCE UNIQUE
// ════════════════════════════════════════════════════════════════════════════
// Le projet hébergeait TROIS palettes d'avatars divergentes :
//   - celle-ci (`avatarColors`, utilisée par GroupAvatar et la liste) ;
//   - `WHATSAPP_AVATAR_COLORS` dans Avatar.tsx ;
//   - `AVATAR_COLORS` dans services/crypto.ts (profil et écran de contact).
//
// Les trois dérivaient la couleur du même hash, mais indexaient des tableaux
// différents : un même contact changeait donc de couleur entre la liste de
// conversations, l'en-tête du fil et sa fiche. Sur une app sans photo de
// profil imposée, la couleur d'avatar EST l'identifiant visuel du contact —
// la voir changer d'un écran à l'autre casse la reconnaissance.
//
// Les deux autres tableaux ont été supprimés ; celui-ci est désormais la
// seule définition. Il vit dans le design system parce que c'est de la
// couleur : `services/crypto.ts` n'a plus à connaître la charte graphique.
//
// Volontairement identique en clair et en sombre : ces teintes sont
// saturées et lisibles sur les deux fonds, et un contact doit rester
// reconnaissable quand l'utilisateur change de thème.
//
// ⚠️ L'ORDRE ET LA LONGUEUR de ce tableau déterminent la couleur de chaque
// contact (`hash % length`). Y insérer ou en retirer une entrée recolore
// tout le carnet d'adresses. Ajouter uniquement à la FIN, et seulement si
// c'est assumé.
export const avatarColors = [
  '#00D9A6',
  '#FF6B6B',
  '#00B4D8',
  '#7B61FF',
  '#FFB547',
  '#45B7D1',
  '#96CEB4',
  '#F7DC6F',
  '#BB8FCE',
  '#85C1E9',
  '#E74C3C',
  '#00CED1',
];

// Helpers — unchanged from v2.0
export const createResponsiveStyle = <T extends Record<string, any>>(
  base: T,
  small?: Partial<T>,
  medium?: Partial<T>,
  large?: Partial<T>,
): T => {
  if (isSmallDevice && small) return { ...base, ...small };
  if (isMediumDevice && medium) return { ...base, ...medium };
  if (isLargeDevice && large) return { ...base, ...large };
  return base;
};

/**
 * Couleur d'avatar déterministe pour un identifiant stable (senderToken,
 * groupId, nom d'affichage à défaut).
 *
 * SEULE fonction de l'app qui attribue une couleur d'avatar. Les variantes
 * locales qui existaient dans Avatar.tsx, ContactInfoScreen, EditProfile,
 * SetupProfile et services/crypto.ts ont toutes été supprimées au profit
 * de celle-ci — elles réimplémentaient ce même hash sur des palettes
 * différentes, d'où des couleurs incohérentes d'un écran à l'autre.
 *
 * Hash djb2-like sur 32 bits signés. Aucune propriété cryptographique
 * attendue : il ne sert qu'à répartir les contacts sur la palette de façon
 * stable dans le temps et entre les écrans.
 */
export const getAvatarColor = (token: string): string => {
  if (!token) return avatarColors[0];
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return avatarColors[Math.abs(hash) % avatarColors.length];
};

// Re-export the palettes themselves for callers that need to inspect both
// (e.g. building a swatch preview in `ThemeScreen`).
export { darkColors, lightColors };

export default theme;
