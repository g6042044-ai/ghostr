// src/screens/CreateGroupScreen.tsx
// Création d'un groupe — flux moderne en 2 étapes (pattern WhatsApp/Signal) :
//   Étape 1 : identité (avatar optionnel, nom, description)
//   Étape 2 : sélection des premiers membres parmi les contacts 1:1 existants
// L'admin (créateur) peut aussi créer un groupe vide et inviter par QR ensuite.

import { useState, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, FlatList, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { sessionService } from '../services/tripleRatchet';
import * as apiGroups from '../services/apiGroups';
import { GroupError, errorMessage } from '../services/errorMessages';
import { useTheme } from '../components/ui/ThemeContext';
import { Header } from '../components/ui/Header';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Avatar } from '../components/Avatar';
import { Ionicons } from '@expo/vector-icons';

import { showAlert } from '../components/ui';

type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { conversationId: string; conversationName: string };
  CreateGroup: undefined;
};
type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'CreateGroup'>;

interface ContactRow {
  sessionId: string;
  fingerprint: string;
  displayName: string;
  avatarBase64?: string;
}

const MAX_GROUP_MEMBERS = 50;

export function CreateGroupScreen() {
  const navigation = useNavigation<NavigationProp>();
  const { t } = useTranslation();
  const { colors } = useTheme();

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  // Contacts 1:1 existants (candidats membres).
  const contacts = useMemo<ContactRow[]>(() => {
    try {
      return sessionService.getAllSessions().map((s: any) => ({
        sessionId: s.id,
        fingerprint: s.theirIdentityKeyFingerprint,
        displayName: s.theirProfile?.displayName || t('groups.unknownContact'),
        avatarBase64: s.theirProfile?.avatarBase64,
      }));
    } catch {
      return [];
    }
  }, [t]);

  const toggle = useCallback((sessionId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else {
        // -1 car le créateur compte déjà comme membre.
        if (next.size >= MAX_GROUP_MEMBERS - 1) {
          showAlert({ title: t('groups.full'), message: t('groups.maxReached') });
          return prev;
        }
        next.add(sessionId);
      }
      return next;
    });
  }, [t]);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    const trimmed = name.trim();
    if (!trimmed) {
      showAlert({ title: t('groups.nameRequired'), message: t('groups.enterName') });
      return;
    }
    setCreating(true);
    try {
      const initialMembers = contacts
        .filter(c => selected.has(c.sessionId))
        .map(c => ({ sessionId: c.sessionId, fingerprint: c.fingerprint, displayName: c.displayName, avatarBase64: c.avatarBase64 }));

      const res = await apiGroups.createGroup({
        name: trimmed,
        description: description.trim() || undefined,
        approvalRequired: true,
        initialMembers,
      });

      if (!res.success || !res.groupId) {
        throw new Error(res.error || GroupError.CREATE_FAILED);
      }
      // Remplacer l'écran par la conversation du groupe.
      navigation.replace('Conversation', { conversationId: res.groupId, conversationName: trimmed });
    } catch (e: any) {
      showAlert({ title: t('common.error'), message: errorMessage(e, 'groups.createFailed') });
      setCreating(false);
    }
  }, [creating, name, description, contacts, selected, navigation, t]);

  // ── Étape 1 : identité ──────────────────────────────────────────────
  const renderStep1 = () => (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <View style={styles.avatarRow}>
        <View style={[styles.groupAvatarPlaceholder, { backgroundColor: colors.primary }]}>
          <Ionicons name="people" size={40} color="#FFFFFF" />
        </View>
      </View>

      <Input
        label={t('groups.nameLabel')}
        placeholder={t('groups.namePlaceholder')}
        value={name}
        onChangeText={setName}
        maxLength={64}
        autoFocus
      />
      <View style={{ height: 12 }} />
      <Input
        label={t('groups.descriptionLabel')}
        placeholder={t('groups.descriptionPlaceholder')}
        value={description}
        onChangeText={setDescription}
        maxLength={200}
        multiline
      />

      <View style={{ height: 24 }} />
      <Button
        title={t('common.next')}
        onPress={() => setName(n => { const v = n.trim(); if (!v) { showAlert({ title: t('groups.nameRequired'), message: t('groups.enterName') }); } else { setStep(2); } return n; })}
        variant="primary"
      />
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        {t('groups.privacyHint')}
      </Text>
    </ScrollView>
  );

  // ── Étape 2 : membres ───────────────────────────────────────────────
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

  const renderStep2 = () => (
    <View style={{ flex: 1 }}>
      {contacts.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="people-outline" size={48} color={colors.textSecondary} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {t('groups.noContacts')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={c => c.sessionId}
          renderItem={renderContact}
          contentContainerStyle={{ paddingVertical: 8 }}
        />
      )}
      <View style={styles.footer}>
        <Text style={[styles.selCount, { color: colors.textSecondary }]}>
          {t('groups.selectedCount', { count: selected.size })}
        </Text>
        <Button
          title={creating ? t('groups.creating') : t('groups.create')}
          onPress={handleCreate}
          variant="primary"
          loading={creating}
          disabled={creating}
        />
      </View>
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <Header
        title={step === 1 ? t('groups.newGroup') : t('groups.addMembers')}
        showBackButton
        onBackPress={() => (step === 2 ? setStep(1) : navigation.goBack())}
      />
      {creating && step === 1 ? (
        <View style={styles.empty}><ActivityIndicator color={colors.primary} /></View>
      ) : step === 1 ? renderStep1() : renderStep2()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  body: { padding: 16 },
  avatarRow: { alignItems: 'center', marginVertical: 16 },
  groupAvatarPlaceholder: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: 13, textAlign: 'center', marginTop: 16, lineHeight: 18 },
  contactRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  contactName: { flex: 1, marginLeft: 12, fontSize: 16 },
  checkbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyText: { textAlign: 'center', marginTop: 12, fontSize: 14, lineHeight: 20 },
  footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(128,128,128,0.2)' },
  selCount: { textAlign: 'center', marginBottom: 10, fontSize: 13 },
});
