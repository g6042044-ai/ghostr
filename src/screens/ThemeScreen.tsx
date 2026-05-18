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
// L'écran lui-même est entièrement réactif (utilise useTheme + useThemedStyles)
// donc bascule INSTANTANÉMENT au tap. C'est important pour un picker — le
// choix doit produire un feedback visible immédiatement.
//
// Si le nouveau scheme diffère de celui du boot (= les autres écrans ont
// été initialisés sur l'autre thème), on affiche un encart explicatif
// (`requiresReload`). Cf. THEME_MIGRATION.md pour la roadmap qui élimine ce
// caveat.
//
// ════════════════════════════════════════════════════════════════════════════
// PRIVACY
// ════════════════════════════════════════════════════════════════════════════
// Aucun appel réseau. Le choix est strictement local (AsyncStorage,
// cf. services/themeStorage.ts).

import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Appearance } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

import { Header, AlertModal, useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import type { AppearancePreference } from '../services/themeStorage';
import { restartApp, canRestartApp } from '../services/themeStorage';

export function ThemeScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors, preference, setAppearance, requiresReload } = useTheme();
  const styles = useThemedStyles(makeStyles);

  // Restart-confirmation state. When the user picks an option that requires
  // a reload to fully propagate (i.e., differs from the boot palette), we
  // ask first instead of leaving them with a half-themed app.
  const [pendingChoice, setPendingChoice] = useState<AppearancePreference | null>(null);
  const [restarting, setRestarting] = useState(false);
  // Compute restart capability once — `expo-updates` may be unavailable in
  // dev. If it isn't, we fall back to the legacy banner.
  const canRestart = canRestartApp();

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
    // No-op if the user picked the option they already have.
    if (pref === preference) return;

    // Compute what the EFFECTIVE colour scheme would be after this choice.
    // For 'system', we resolve against the current OS scheme. For 'light'
    // and 'dark', it's just the value itself.
    const resolveEffective = (p: AppearancePreference) =>
      p === 'system'
        ? (Appearance.getColorScheme() === 'light' ? 'light' : 'dark')
        : p;

    const currentEffective = resolveEffective(preference);
    const nextEffective = resolveEffective(pref);

    // If the effective scheme isn't actually changing (e.g., currently on
    // 'system' resolving to dark, user picks 'dark'), the on-screen colors
    // won't change visually — just the preference label. Apply silently,
    // no restart needed.
    if (currentEffective === nextEffective) {
      void setAppearance(pref);
      return;
    }

    // The effective scheme IS changing. To guarantee every screen renders
    // in the new palette without any half-themed transition, we restart
    // the JS bundle. This is symmetric: same flow whether you switch to
    // Light or to Dark, as long as the visible colours will change.
    if (canRestart) {
      setPendingChoice(pref);
      return;
    }

    // Fallback path: expo-updates not available. Apply the choice and
    // let the `requiresReload` banner inform the user.
    void setAppearance(pref);
  };

  const handleConfirmRestart = async () => {
    if (!pendingChoice) return;
    setRestarting(true);
    try {
      await setAppearance(pendingChoice);
      // Tiny delay so AsyncStorage write completes before the restart
      // tears down the JS context. AsyncStorage writes are atomic but the
      // promise resolution can race with bundle teardown on slow devices.
      await new Promise((r) => setTimeout(r, 150));
      await restartApp();
    } catch (e) {
      // If restart fails, fall back to applying without restart. The user
      // will see the legacy banner.
      setRestarting(false);
      setPendingChoice(null);
    }
  };

  const handleCancelRestart = () => {
    setPendingChoice(null);
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
        {requiresReload && !canRestart && (
          <View style={styles.banner}>
            <Ionicons
              name="information-circle"
              size={20}
              color={colors.info}
              style={styles.bannerIcon}
            />
            <View style={styles.bannerContent}>
              <Text style={styles.bannerTitle} numberOfLines={2}>
                {t('themeScreen.applyOnRestartTitle')}
              </Text>
              <Text style={styles.bannerMessage} numberOfLines={4}>
                {t('themeScreen.applyOnRestartMessage')}
              </Text>
            </View>
          </View>
        )}

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

      {/*
        Restart confirmation modal — appears when the user picks a scheme
        that needs a JS reload to fully propagate. Auto-restarting on
        confirm avoids the half-themed state where some screens (the ones
        with legacy module-level styles) keep showing the previous theme
        until the next launch. The user retains the option to cancel and
        live with the banner instead.
      */}
      <AlertModal
        visible={pendingChoice !== null}
        title={t('themeScreen.restartConfirmTitle')}
        message={t('themeScreen.restartConfirmMessage')}
        primaryButton={{
          title: t('themeScreen.restartConfirmAction'),
          onPress: handleConfirmRestart,
          loading: restarting,
        }}
        secondaryButton={{
          title: t('common.cancel'),
          onPress: handleCancelRestart,
        }}
        onClose={handleCancelRestart}
      />
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
    banner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      marginBottom: 16,
      borderLeftWidth: 3,
      borderLeftColor: colors.info,
    },
    bannerIcon: {
      marginRight: 10,
      marginTop: 1,
    },
    bannerContent: {
      flex: 1,
    },
    bannerTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 4,
    },
    bannerMessage: {
      fontSize: 13,
      color: colors.textSecondary,
      lineHeight: 18,
    },
  } as const);

export default ThemeScreen;
