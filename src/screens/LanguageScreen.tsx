// src/screens/LanguageScreen.tsx
// Sélecteur de langue.
//
// UX inspirée de Telegram / Signal :
//  - Première section : "Système" (suit la langue de l'OS) avec sous-titre
//    indiquant la langue détectée.
//  - Seconde section : barre de recherche + liste des langues, chacune écrite
//    dans son propre script (sans drapeau — un drapeau ≠ une langue).
//  - Sous chaque langue, le nom anglais en gris pour aider quelqu'un qui
//    s'est trompé et ne reconnaît plus son script.
//  - Tap = applique immédiatement, indicateur visuel sur le choix actif.
//  - Search : filtre par `name` natif OU `englishName` (insensible casse,
//    accents). Une langue qui matche par son nom anglais est prioritaire pour
//    quelqu'un qui voudrait passer EN→AR mais ne sait écrire qu'en alphabet
//    latin.
//  - PAS de prompt de redémarrage : le changement de langue est instantané
//    car on ne flip pas le layout RN (cf. STRATÉGIE RTL dans i18n/index.ts).
//
// Aucun appel réseau. Aucune télémétrie. Le choix est strictement local.

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

import { Header, useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import { SUPPORTED_LANGUAGES, changeLanguage, detectDeviceLanguage, getLanguageInfo, type LanguageCode, type LanguageInfo } from '../i18n';
import { loadStoredLanguage } from '../i18n/storage';

/** Seuil au-delà duquel on affiche la barre de recherche. */
const SEARCH_BAR_THRESHOLD = 6;

/** Normalise une chaîne pour la recherche : lowercase + supprime les accents. */
function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    // NFD décompose les diacritiques (ex: "é" → "e" + "´")
    .normalize('NFD')
    // Supprime les marques diacritiques combinées (Mn = Mark, nonspacing)
    .replace(/[\u0300-\u036f]/g, '');
}

export function LanguageScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  // null = "Système" (pas d'override stocké)
  const [storedChoice, setStoredChoice] = useState<LanguageCode | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadStoredLanguage().then((v) => {
      if (cancelled) return;
      setStoredChoice(v);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const deviceLang = detectDeviceLanguage();
  const deviceLangInfo = getLanguageInfo(deviceLang);

  // Trie ALPHABÉTIQUEMENT par nom natif. Cohérent avec Telegram, Signal, etc. :
  // les utilisateurs cherchent par l'orthographe de leur propre langue.
  const sortedLanguages = useMemo<readonly LanguageInfo[]>(() => {
    return [...SUPPORTED_LANGUAGES].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }, []);

  const filteredLanguages = useMemo(() => {
    const q = normalizeForSearch(search.trim());
    if (!q) return sortedLanguages;
    return sortedLanguages.filter((lang) => {
      const haystack =
        normalizeForSearch(lang.name) + ' ' +
        normalizeForSearch(lang.englishName) + ' ' +
        lang.code.toLowerCase();
      return haystack.includes(q);
    });
  }, [sortedLanguages, search]);

  const handleSelect = async (code: LanguageCode | null) => {
    try {
      await changeLanguage(code);
      setStoredChoice(code);
      // Pas de prompt de redémarrage : le changement est instantané grâce au
      // re-render automatique des composants useTranslation(). Le bidi du
      // texte arabe/ourdou est géré par RN sans toucher au layout.
    } catch {
      // Silencieux : useTranslation forcera un re-render si changeLanguage
      // a partiellement réussi.
    }
  };

  // 1er render : on attend la lecture AsyncStorage pour ne pas afficher un
  // faux indicateur de sélection. Très court (<30ms typique).
  if (!loaded) {
    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <Header
          title={t('languageScreen.title')}
          onBackPress={() => navigation.goBack()}
        />
      </View>
    );
  }

  const showSearch = SUPPORTED_LANGUAGES.length >= SEARCH_BAR_THRESHOLD;

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header
        title={t('languageScreen.title')}
        onBackPress={() => navigation.goBack()}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Section "Système" — toujours visible, jamais filtrée par la recherche */}
        <View style={styles.section}>
          <LanguageRow
            label={t('languageScreen.systemDefault')}
            sublabel={t('languageScreen.systemDefaultSubtitle', {
              lang: deviceLangInfo?.name ?? deviceLang,
            })}
            selected={storedChoice === null}
            onPress={() => handleSelect(null)}
            isFirst
            isLast
          />
        </View>

        {/* Barre de recherche — apparaît dès qu'il y a beaucoup de langues */}
        {showSearch && (
          <View style={styles.searchContainer}>
            <Ionicons
              name="search"
              size={18}
              color={colors.textMuted}
              style={styles.searchIcon}
            />
            <TextInput
              style={styles.searchInput}
              placeholder={t('languageScreen.searchPlaceholder')}
              placeholderTextColor={colors.textMuted}
              value={search}
              onChangeText={setSearch}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              clearButtonMode="while-editing"
              // textAlign 'auto' (défaut) : RN/bidi alignera le texte tapé selon
              // sa directionnalité (Arabic à droite, Latin à gauche). C'est le
              // comportement désiré sans toucher au layout.
            />
            {search.length > 0 && (
              <TouchableOpacity
                onPress={() => setSearch('')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.searchClear}
                accessibilityLabel={t('common.close')}
              >
                <Ionicons
                  name="close-circle"
                  size={18}
                  color={colors.textMuted}
                />
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Liste filtrée des langues */}
        {filteredLanguages.length === 0 ? (
          <View style={styles.emptySection}>
            <Text style={styles.emptyText}>{t('languageScreen.noResults')}</Text>
          </View>
        ) : (
          <View style={styles.section}>
            {filteredLanguages.map((lang, idx) => (
              <LanguageRow
                key={lang.code}
                label={lang.name}
                sublabel={lang.englishName}
                selected={storedChoice === lang.code}
                onPress={() => handleSelect(lang.code)}
                isFirst={idx === 0}
                isLast={idx === filteredLanguages.length - 1}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

interface LanguageRowProps {
  label: string;
  sublabel?: string;
  selected: boolean;
  onPress: () => void;
  isFirst: boolean;
  isLast: boolean;
}

const LanguageRow: React.FC<LanguageRowProps> = ({
  label,
  sublabel,
  selected,
  onPress,
  isLast,
}) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <TouchableOpacity
      style={[
        styles.row,
        !isLast && styles.rowDivider,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.rowContent}>
        <Text style={[styles.rowLabel, selected && styles.rowLabelSelected]}>
          {label}
        </Text>
        {sublabel && (
          <Text style={styles.rowSublabel} numberOfLines={1}>
            {sublabel}
          </Text>
        )}
      </View>
      {selected && (
        <Ionicons
          name="checkmark"
          size={22}
          color={colors.primary}
          style={styles.checkmark}
        />
      )}
    </TouchableOpacity>
  );
};

const makeStyles = (colors: ColorPalette) => ({
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
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginBottom: 12,
    minHeight: 44,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: colors.text,
    paddingVertical: 10,
  },
  searchClear: {
    padding: 4,
    marginLeft: 4,
  },
  emptySection: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 56,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  rowContent: {
    flex: 1,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.text,
  },
  rowLabelSelected: {
    color: colors.primary,
  },
  rowSublabel: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },
  checkmark: {
    marginLeft: 12,
  },
}) as const;

export default LanguageScreen;
