// src/components/ReportModal.tsx
// Modal de signalement de contenu — Guideline App Store 1.2
//
// Utilisé par :
//   - ConversationScreen : signaler un message (long-press → Signaler)
//   - ContactInfoScreen  : « Bloquer et signaler » un contact
//
// CONSENTEMENT EXPLICITE : le texte au-dessus du bouton explique que le
// contenu signalé sera transmis à la modération Ghostr. Le serveur ne peut
// pas lire les messages ; seul ce que l'utilisateur choisit de signaler
// est transmis, via le tunnel OHTTP (pas d'IP). Cf. reportService.ts.

import React, { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { BottomSheet, Button, useTheme, useThemedStyles, showToast, type ColorPalette } from './ui';
import { submitReport, type ReportCategory, type ReportContext } from '../services/reportService';

const CATEGORIES: ReportCategory[] = ['spam', 'harassment', 'illegal', 'other'];

interface ReportModalProps {
  visible: boolean;
  onClose: () => void;
  /** 'message' : signalement d'un message · 'contact' : blocage d'un contact */
  context: ReportContext;
  /** Contenu transmis à la modération (texte du message, ou description du contact) */
  content: string;
  /** Appelé après l'envoi (même best-effort raté) — ex. : exécuter le blocage */
  onSubmitted?: () => void;
}

export const ReportModal: React.FC<ReportModalProps> = ({
  visible,
  onClose,
  context,
  content,
  onSubmitted,
}) => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [sending, setSending] = useState(false);

  const handleClose = () => {
    if (sending) return;
    setCategory(null);
    onClose();
  };

  const handleSubmit = async () => {
    if (!category || sending) return;
    setSending(true);
    const result = await submitReport(category, content, context);
    setSending(false);
    setCategory(null);
    onClose();

    // Best-effort : même si l'envoi échoue (hors-ligne), l'action locale
    // (blocage / retour) continue — l'utilisateur est informé par le toast.
    if (result.ok) {
      showToast(t('report.success'));
    } else {
      showToast(t('report.sendFailed'));
    }
    onSubmitted?.();
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={handleClose}
      title={context === 'contact' ? t('report.titleBlock') : t('report.titleMessage')}
    >
      <View style={styles.container}>
        <Text style={styles.subtitle}>{t('report.chooseCategory')}</Text>

        {CATEGORIES.map((cat) => {
          const selected = category === cat;
          return (
            <TouchableOpacity
              key={cat}
              style={[styles.categoryRow, selected && styles.categoryRowSelected]}
              onPress={() => setCategory(cat)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={selected ? 'radio-button-on' : 'radio-button-off'}
                size={22}
                color={selected ? colors.primary : colors.textMuted}
              />
              <Text style={[styles.categoryLabel, selected && styles.categoryLabelSelected]}>
                {t(`report.categories.${cat}`)}
              </Text>
            </TouchableOpacity>
          );
        })}

        {/* Consentement explicite — le contenu quitte l'appareil */}
        <View style={styles.consentBox}>
          <Ionicons name="shield-checkmark-outline" size={18} color={colors.textSecondary} />
          <Text style={styles.consentText}>
            {context === 'contact' ? t('report.consentBlock') : t('report.consentMessage')}
          </Text>
        </View>

        <Button
          title={context === 'contact' ? t('report.submitBlock') : t('report.submitMessage')}
          onPress={handleSubmit}
          variant="danger"
          disabled={!category}
          loading={sending}
          fullWidth
        />
        <Button
          title={t('common.cancel')}
          onPress={handleClose}
          variant="ghost"
          disabled={sending}
          fullWidth
          style={styles.cancelButton}
        />
      </View>
    </BottomSheet>
  );
};

const makeStyles = (colors: ColorPalette) => ({
  container: { paddingBottom: 8 },
  subtitle: { fontSize: 14, color: colors.textSecondary, marginBottom: 12 },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.surface,
    marginBottom: 8,
  },
  categoryRowSelected: {
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  categoryLabel: { fontSize: 15, color: colors.text, flex: 1 },
  categoryLabelSelected: { fontWeight: '600' },
  consentBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.surface,
    marginTop: 8,
    marginBottom: 16,
  },
  consentText: { flex: 1, fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  cancelButton: { marginTop: 8 },
}) as const;

export default ReportModal;
