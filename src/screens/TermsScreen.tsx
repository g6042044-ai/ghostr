// src/screens/TermsScreen.tsx
// Conditions d'utilisation (EULA) — Guideline App Store 1.2
//
// Deux modes :
//   - Gate (onAccept fourni) : affiché au premier lancement AVANT la création
//     du profil (et une fois pour les utilisateurs existants après mise à
//     jour). L'app n'est pas utilisable tant que les conditions ne sont pas
//     acceptées. Rendu HORS NavigationContainer — aucune dépendance à
//     react-navigation.
//   - Lecture (readOnly) : consultation depuis Réglages → À propos.
//
// La clause de tolérance zéro (section 3) est une exigence explicite de la
// guideline 1.2 : « terms must make it clear that there is no tolerance for
// objectionable content or abusive users ».

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StatusBar, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Button, useTheme, useThemedStyles, showToast, type ColorPalette } from '../components/ui';

interface TermsScreenProps {
  /** Mode gate : appelé quand l'utilisateur accepte les conditions */
  onAccept?: () => void;
  /** Mode lecture : pas de bouton d'acceptation */
  readOnly?: boolean;
  /** Mode lecture : fermeture de l'écran */
  onClose?: () => void;
}

// Sections affichées dans l'ordre. Chaque clé a `terms.<key>Title` et
// `terms.<key>Body` dans les 8 langues.
const SECTIONS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] as const;

// Contact de modération réellement joignable (guideline 1.2) : la section 7
// ne citait le site qu'en texte brut non actionnable.
const MODERATION_EMAIL = 'support@theghostr.com';

export function TermsScreen({ onAccept, readOnly, onClose }: TermsScreenProps) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const handleContactPress = async () => {
    try {
      await Linking.openURL(`mailto:${MODERATION_EMAIL}`);
    } catch {
      // Aucune app e-mail configurée : on affiche l'adresse pour copie manuelle.
      showToast(t('terms.contactError'));
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor="transparent"
        translucent
      />

      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        {readOnly && onClose && (
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
        )}
        <Text style={styles.title}>{t('terms.title')}</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: readOnly ? insets.bottom + 24 : 24 },
        ]}
        showsVerticalScrollIndicator
      >
        <Text style={styles.intro}>{t('terms.intro')}</Text>

        {SECTIONS.map((key) => (
          <View key={key} style={styles.section}>
            <Text style={styles.sectionTitle}>{t(`terms.${key}Title`)}</Text>
            <Text style={styles.sectionBody}>{t(`terms.${key}Body`)}</Text>
          </View>
        ))}

        <TouchableOpacity style={styles.contactBtn} onPress={handleContactPress} activeOpacity={0.7}>
          <Ionicons name="mail-outline" size={18} color={colors.primary} />
          <Text style={styles.contactBtnText}>{t('terms.contactButton')}</Text>
        </TouchableOpacity>

        <Text style={styles.lastUpdated}>{t('terms.lastUpdated')}</Text>
      </ScrollView>

      {!readOnly && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
          <Text style={styles.footerNote}>{t('terms.acceptNote')}</Text>
          <Button
            title={t('terms.acceptButton')}
            onPress={() => onAccept?.()}
            variant="primary"
            fullWidth
          />
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 8,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: -8,
  },
  title: {
    flex: 1,
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.5,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20 },
  intro: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 21,
    marginBottom: 20,
  },
  section: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 6,
  },
  sectionBody: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 21,
  },
  contactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.surface,
    marginBottom: 16,
  },
  contactBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.primary,
  },
  lastUpdated: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 4,
    marginBottom: 12,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  footerNote: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 12,
    lineHeight: 17,
  },
}) as const;

export default TermsScreen;
