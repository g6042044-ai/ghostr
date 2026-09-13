// src/screens/AddGroupMembersScreen.tsx
// Ajout de membres à un groupe EXISTANT depuis les contacts 1:1 (réservé admin).
// Reprend l'UX de l'étape 2 de la création de groupe : on coche des contacts puis
// on valide. Chaque contact est ajouté via apiGroups.addMemberBySession (welcome +
// distribution des senderKeys), exactement comme à la création.

import { useState, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

import { sessionService } from '../services/tripleRatchet';
import * as apiGroups from '../services/apiGroups';
import * as groups from '../services/groupService';
import { useTheme } from '../components/ui/ThemeContext';
import { Header } from '../components/ui/Header';
import { Button } from '../components/ui/Button';
import { Avatar } from '../components/Avatar';

import { showAlert } from '../components/ui';

type RootStackParamList = {
  AddGroupMembers: { groupId: string };
};
type ScreenRoute = RouteProp<RootStackParamList, 'AddGroupMembers'>;

interface ContactRow {
  sessionId: string;
  fingerprint: string;
  displayName: string;
  avatarBase64?: string;
}

// Seuil au-delà duquel on affiche la barre de recherche (aligné sur LanguageScreen).
const SEARCH_THRESHOLD = 8;

/** Normalisation insensible à la casse et aux accents (recherche contacts). */
function normalizeForSearch(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function AddGroupMembersScreen() {
  const navigation = useNavigation();
  const route = useRoute<ScreenRoute>();
  const { groupId } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');

  const currentCount = groups.getMembers(groupId).length;
  const remainingSlots = Math.max(0, groups.MAX_GROUP_MEMBERS - currentCount);

  // Contacts 1:1 NON déjà membres du groupe.
  const contacts = useMemo<ContactRow[]>(() => {
    try {
      const memberFps = new Set(groups.getMembers(groupId).map(m => m.fingerprint));
      return sessionService.getAllSessions()
        .map((s: any) => ({
          sessionId: s.id,
          fingerprint: s.theirIdentityKeyFingerprint,
          displayName: s.theirProfile?.displayName || t('groups.unknownContact'),
          avatarBase64: s.theirProfile?.avatarBase64,
        }))
        .filter((c: ContactRow) => c.fingerprint && !memberFps.has(c.fingerprint));
    } catch {
      return [];
    }
  }, [groupId, t]);

  const showSearch = contacts.length >= SEARCH_THRESHOLD;
  const filteredContacts = useMemo(() => {
    const q = normalizeForSearch(search);
    if (!q) return contacts;
    return contacts.filter(c => normalizeForSearch(c.displayName).includes(q));
  }, [contacts, search]);

  const toggle = useCallback((sessionId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        if (next.size >= remainingSlots) {
          showAlert({
            title: t('groups.full'),
            message: t('groups.maxReachedExisting', { count: groups.MAX_GROUP_MEMBERS }),
          });
          return prev;
        }
        next.add(sessionId);
      }
      return next;
    });
  }, [remainingSlots, t]);

  const handleAdd = useCallback(async () => {
    if (adding || selected.size === 0) return;
    if (!groups.amIAdmin(groupId)) {
      showAlert({ title: t('common.error'), message: t('groups.adminOnlyAction') });
      return;
    }
    setAdding(true);
    const toAdd = contacts.filter(c => selected.has(c.sessionId));
    const failures: string[] = [];
    for (const c of toAdd) {
      try {
        const r = await apiGroups.addMemberBySession(groupId, c.sessionId, c.fingerprint, c.displayName, c.avatarBase64);
        if (!r.success) failures.push(c.displayName);
      } catch {
        failures.push(c.displayName);
      }
    }
    setAdding(false);

    if (failures.length === 0) {
      navigation.goBack();
    } else {
      showAlert({
        title: t('groups.addPartialTitle'),
        message: t('groups.addPartialBody', { names: failures.join(', ') }),
        buttons: [{ text: t('common.ok'), onPress: () => navigation.goBack() }],
      });
    }
  }, [adding, selected, contacts, groupId, navigation, t]);

  const renderContact = ({ item }: { item: ContactRow }) => {
    const isSel = selected.has(item.sessionId);
    return (
      <TouchableOpacity style={styles.contactRow} onPress={() => toggle(item.sessionId)} activeOpacity={0.7}>
        <Avatar displayName={item.displayName} senderToken={item.fingerprint} avatarUri={item.avatarBase64} size="medium" />
        <Text style={[styles.contactName, { color: colors.text }]} numberOfLines={1}>{item.displayName}</Text>
        <View style={[styles.checkbox, { borderColor: isSel ? colors.primary : colors.border, backgroundColor: isSel ? colors.primary : 'transparent' }]}>
          {isSel && <Ionicons name="checkmark" size={16} color="#FFFFFF" />}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <Header title={t('groups.addMembers')} showBackButton onBackPress={() => navigation.goBack()} />
      {contacts.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="people-outline" size={48} color={colors.textSecondary} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {t('groups.noContactsToAdd')}
          </Text>
        </View>
      ) : (
        <>
          {showSearch && (
            <View style={[styles.searchContainer, { backgroundColor: colors.surface }]}>
              <Ionicons name="search" size={18} color={colors.textMuted} style={styles.searchIcon} />
              <TextInput
                style={[styles.searchInput, { color: colors.text }]}
                placeholder={t('groups.searchContacts')}
                placeholderTextColor={colors.textMuted}
                value={search}
                onChangeText={setSearch}
                autoCorrect={false}
                returnKeyType="search"
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')} style={styles.searchClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          )}
          {filteredContacts.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="search-outline" size={40} color={colors.textSecondary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                {t('groups.noSearchResults')}
              </Text>
            </View>
          ) : (
            <FlatList
              data={filteredContacts}
              keyExtractor={c => c.sessionId}
              renderItem={renderContact}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingVertical: 8 }}
            />
          )}
        </>
      )}
      {contacts.length > 0 && (
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <Text style={[styles.selCount, { color: colors.textSecondary }]}>
            {t('groups.selectedCount', { count: selected.size })}
          </Text>
          <Button
            title={adding ? t('groups.adding') : t('groups.addSelected')}
            onPress={handleAdd}
            variant="primary"
            loading={adding}
            disabled={adding || selected.size === 0}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchContainer: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 12,
    paddingHorizontal: 12, marginHorizontal: 16, marginTop: 10, minHeight: 44,
  },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 10 },
  searchClear: { marginLeft: 6 },
  contactRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  contactName: { flex: 1, marginLeft: 12, fontSize: 16 },
  checkbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyText: { textAlign: 'center', marginTop: 12, fontSize: 14, lineHeight: 20 },
  footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  selCount: { textAlign: 'center', marginBottom: 10, fontSize: 13 },
});
