// src/screens/ThemeScreen.tsx
// Sélecteur d'apparence (Clair / Sombre / Système).
//
// ════════════════════════════════════════════════════════════════════════════
// PATTERN
// ════════════════════════════════════════════════════════════════════════════
// Reprend la structure de LanguageScreen.tsx :
//  - Section "Système" en premier avec sous-titre indiquant le mode détecté
//  - Section "Clair" / "Sombre" pour override explicite
//  - Tap = applique immédiatement (persistence + Context)
//  - Indicateur visuel sur le choix actif
//
// ════════════════════════════════════════════════════════════════════════════
// COMPORTEMENT VISUEL
// ════════════════════════════════════════════════════════════════════════════
// Le tap applique le thème INSTANTANÉMENT, sur cet écran comme sur tous les
// autres. Plus de confirmation « redémarrer l'application », plus d'encart
// « sera appliqué au prochain lancement ».
//
// Ce détour existait parce que certains écrans construisaient leur
// `StyleSheet.create` au niveau module à partir d'une palette capturée au
// démarrage : elles ne pouvaient donc pas suivre un changement à chaud, et
// l'app aurait affiché un mélange des deux thèmes. Ces captures ont toutes
// été converties en fabriques consommées par `useThemedStyles`, et
// `theme.colors` a été supprimé pour empêcher leur réapparition. Le
// redémarrage n'a plus de raison d'être.
//
// ════════════════════════════════════════════════════════════════════════════
// PRIVACY
// ════════════════════════════════════════════════════════════════════════════
// Aucun appel réseau. Le choix est strictement local (AsyncStorage,
// cf. services/themeStorage.ts).

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Appearance } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

import { Header, useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import type { AppearancePreference } from '../services/themeStorage';
import haptics from '../services/haptics';

export function ThemeScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors, preference, setAppearance } = useTheme();
  const styles = useThemedStyles(makeStyles);

  // Pour le sous-titre de l'option "Système", on lit l'OS au render. Ça
  // bouge si l'utilisateur change le thème système pendant qu'il est sur
  // cet écran (rare mais possible) — le ThemeContext se ré-abonne déjà à
  // Appearance.addChangeListener, donc on re-render naturellement.
  const osScheme = (() => {
    try {
      const v = Appearance.getColorScheme();
      return v === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  })();

  const handleSelect = (pref: AppearancePreference) => {
    // No-op si l'utilisateur retape son choix courant.
    if (pref === preference) return;
    // Application immédiate : le contexte re-rend tous les consommateurs de
    // `useTheme()`, c'est-à-dire l'application entière.
    void setAppearance(pref);
    haptics.selection();
  };

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header
        title={t('themeScreen.title')}
        onBackPress={() => navigation.goBack()}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Section "Système" */}
        <View style={styles.section}>
          <Row
            colors={colors}
            iconName="phone-portrait-outline"
            label={t('themeScreen.systemDefault')}
            sublabel={
              osScheme === 'dark'
                ? t('themeScreen.systemDefaultSubtitleDark')
                : t('themeScreen.systemDefaultSubtitleLight')
            }
            selected={preference === 'system'}
            onPress={() => handleSelect('system')}
            isLast
          />
        </View>

        {/* Section overrides explicites */}
        <View style={styles.section}>
          <Row
            colors={colors}
            iconName="sunny-outline"
            label={t('themeScreen.light')}
            sublabel={t('themeScreen.lightSubtitle')}
            selected={preference === 'light'}
            onPress={() => handleSelect('light')}
            isLast={false}
          />
          <Row
            colors={colors}
            iconName="moon-outline"
            label={t('themeScreen.dark')}
            sublabel={t('themeScreen.darkSubtitle')}
            selected={preference === 'dark'}
            onPress={() => handleSelect('dark')}
            isLast
          />
        </View>
      </ScrollView>

    </View>
  );
}

interface RowProps {
  colors: ColorPalette;
  iconName: keyof typeof Ionicons.glyphMap;
  label: string;
  sublabel: string;
  selected: boolean;
  onPress: () => void;
  isLast: boolean;
}

const Row: React.FC<RowProps> = ({ colors, iconName, label, sublabel, selected, onPress, isLast }) => {
  // Pas de useThemedStyles ici — la row reçoit directement la palette pour
  // éviter une indirection inutile. Le style row est mémoïsé dans le parent.
  return (
    <TouchableOpacity
      style={[
        rowStyles.row,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[rowStyles.iconWrap, { backgroundColor: colors.primary + '15' }]}>
        <Ionicons name={iconName} size={20} color={colors.primary} />
      </View>
      <View style={rowStyles.rowContent}>
        <Text style={[rowStyles.rowLabel, { color: selected ? colors.primary : colors.text }]}>
          {label}
        </Text>
        <Text style={[rowStyles.rowSublabel, { color: colors.textMuted }]} numberOfLines={1}>
          {sublabel}
        </Text>
      </View>
      {selected && (
        <Ionicons name="checkmark" size={22} color={colors.primary} style={rowStyles.checkmark} />
      )}
    </TouchableOpacity>
  );
};

// Le seul stylesheet "statique" — pour les dimensions, paddings, etc. qui
// ne dépendent pas de la couleur. Évite un useMemo pour les valeurs constantes.
const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 64,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  rowContent: {
    flex: 1,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  rowSublabel: {
    fontSize: 13,
    marginTop: 2,
  },
  checkmark: {
    marginLeft: 12,
  },
});

const makeStyles = (colors: ColorPalette) =>
  ({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      padding: 16,
      paddingTop: 8,
    },
    section: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      marginBottom: 16,
      overflow: 'hidden',
    },
  } as const);

export default ThemeScreen;
