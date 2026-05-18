// src/screens/InvitationsScreen.tsx
// Écran dédié listant toutes les invitations
// Accessible depuis le bandeau "X invitations en attente" de ConversationListScreen
// Sections : "En attente" (pending uniquement, pas d'historique)

import { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, SectionList, ActivityIndicator } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { pendingInviteStore, PendingInvite } from '../services/pendingInvites';
import { inviteWatcher } from '../services/inviteWatcher';
import { useTheme, useThemedStyles, type ColorPalette } from '../components/ui';

type RootStackParamList = {
  ConversationList: undefined;
  Invitations: undefined;
  InviteDetail: { tag: string };
  Create1to1: undefined;
  Conversation: { conversationId: string; conversationName: string };
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Invitations'>;

type Section = {
  title: string;
  data: PendingInvite[];
};

export function InvitationsScreen() {
  const navigation = useNavigation<NavigationProp>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    await pendingInviteStore.load();
    const all = pendingInviteStore.getAll();
    const pending = all.filter(i => i.status === 'pending');

    const newSections: Section[] = [];
    if (pending.length > 0) newSections.push({ title: t('invitations.pendingSection'), data: pending });

    setSections(newSections);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    refresh();
    const unsub = pendingInviteStore.onChange(refresh);
    return () => unsub();
  }, [refresh]);

  useFocusEffect(useCallback(() => {
    refresh();
    inviteWatcher.forcePoll();
  }, [refresh]));

  // Listen for accepted invites → refresh list
  // Note: la notification banner est gérée par ConversationListScreen (toujours monté)
  useEffect(() => {
    const unsub = inviteWatcher.onAccepted(() => {
      refresh();
    });
    return () => unsub();
  }, [refresh]);

  // ── Formatters ──
  const formatTimeAgo = (ts: number): string => {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return t('inviteDetail.justNow');
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}j`;
  };

  // ── Renderers ──
  const renderSectionHeader = ({ section }: { section: Section }) => (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{section.title}</Text>
    </View>
  );

  const renderItem = ({ item }: { item: PendingInvite }) => {
    return (
      <TouchableOpacity
        style={styles.row}
        onPress={() => navigation.navigate('InviteDetail', { tag: item.tag })}
        activeOpacity={0.7}
      >
        <View style={[styles.rowIcon, { backgroundColor: 'rgba(0, 217, 166, 0.10)' }]}>
          <Ionicons name="qr-code-outline" size={20} color={colors.primary} />
        </View>
        <View style={styles.rowContent}>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {item.label}
          </Text>
          <View style={styles.rowMeta}>
            <View style={styles.rowPulseDot} />
            <Text style={styles.rowMetaText}>
              {t('invitations.pendingTimeAgo', { time: formatTimeAgo(item.createdAt) })}
            </Text>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
      </TouchableOpacity>
    );
  };

  const renderEmpty = () => (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <Ionicons name="qr-code-outline" size={32} color={colors.primary} />
      </View>
      <Text style={styles.emptyTitle}>{t('invitations.noInvitations')}</Text>
      <Text style={styles.emptySubtitle}>
        {t('invitations.noInvitationsHint')}
      </Text>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.loadingContainer, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{t('invitations.title')}</Text>
        <View style={{ width: 36 }} />
      </View>
      <View style={styles.divider} />

      {/* List */}
      {sections.length === 0 ? renderEmpty() : (
        <SectionList
          sections={sections}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          keyExtractor={(item) => item.tag}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          stickySectionHeadersEnabled={false}
        />
      )}

      {/* Create button */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={styles.createButton}
          onPress={() => navigation.navigate('Create1to1')}
          activeOpacity={0.8}
        >
          <Text
            style={styles.createButtonText}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.82}
          >
            {t('invitations.createInvitation')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.3,
  },
  divider: {
    height: 1,
    backgroundColor: colors.divider,
    marginHorizontal: 16,
  },

  // List
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },

  // Section headers
  sectionHeader: {
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },

  // Rows
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 14,
  },
  rowIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  rowPulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFB547',
  },
  rowMetaText: {
    fontSize: 13,
    color: colors.textMuted,
  },

  // Empty
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(0, 217, 166, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  emptyTagline: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.primary,
    marginTop: 16,
    opacity: 0.7,
  },

  // Bottom
  bottomBar: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
  },
  createButton: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textOnPrimary,
    letterSpacing: -0.2,
  },
}) as const;

export default InvitationsScreen;