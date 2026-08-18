// src/screens/GroupInfoScreen.tsx
// Profil d'un groupe (pattern WhatsApp/Signal) :
//   • Avatar + nom + description (éditables par l'admin)
//   • Bouton "Inviter via QR" (admin)
//   • Liste des membres avec badge Admin ; appui long → bloquer et signaler
//     (tous) / retirer / promouvoir (admin)
//   • "Quitter le groupe" (rouge)
//   • Mute

import { useState, useCallback, useLayoutEffect, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, FlatList, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, useFocusEffect, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

import * as groups from '../services/groupService';
import * as apiGroups from '../services/apiGroups';
import type { GroupMember } from '../services/groupService';
import { useTheme } from '../components/ui/ThemeContext';
import { Header } from '../components/ui/Header';
import { Avatar } from '../components/Avatar';
import { GroupAvatar } from '../components/GroupAvatar';
import { ReportModal } from '../components/ReportModal';
import { blockFingerprint } from '../services/blockService';

import { showActionSheet, showAlert, showConfirm, showToast, type ActionSheetRequest } from '../components/ui';

type RootStackParamList = {
  ConversationList: undefined;
  GroupInfo: { groupId: string };
  AddGroupMembers: { groupId: string };
  GroupInviteQR: { groupId: string };
};
type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'GroupInfo'>;
type ScreenRoute = RouteProp<RootStackParamList, 'GroupInfo'>;

export function GroupInfoScreen() {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ScreenRoute>();
  const { groupId } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();

  const [, forceRender] = useState(0);
  const refresh = useCallback(() => forceRender(n => n + 1), []);

  // « Bloquer et signaler » un membre — guideline App Store 1.2, même
  // pattern que ContactInfoScreen : ReportModal (signalement optionnel)
  // puis blockFingerprint. Le blocage est INCONDITIONNEL une fois la
  // confirmation acceptée : performMemberBlock est branché sur toutes les
  // sorties du modal (soumission, Annuler, fermeture), dédupliqué par
  // blockDoneRef (le modal appelle onClose PUIS onSubmitted lors d'une
  // soumission).
  const [reportVisible, setReportVisible] = useState(false);
  const [reportTarget, setReportTarget] = useState<{ fingerprint: string; displayName: string } | null>(null);
  const blockDoneRef = useRef(false);

  const performMemberBlock = useCallback(async (target: { fingerprint: string; displayName: string }) => {
    if (blockDoneRef.current) return;
    blockDoneRef.current = true;
    await blockFingerprint(target.fingerprint, target.displayName);
    showToast(t('groups.memberBlocked', { name: target.displayName, defaultValue: `${target.displayName} a été bloqué.` }));
    refresh();
  }, [refresh, t]);

  // Rafraîchir à chaque focus + sur mises à jour de groupe.
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const g = groups.getGroup(groupId);
  const members = groups.getMembers(groupId);
  const iAmAdmin = groups.amIAdmin(groupId);
  const myFp = g?.myFingerprint;

  const memberLite = members.map(m => ({ fingerprint: m.fingerprint, displayName: m.displayName, avatarBase64: m.avatarBase64 }));

  // Appui long sur un membre → feuille d'actions d'administration.
  //
  // C'était un `Alert.alert` servant de menu, ce que l'API native ne sait pas
  // faire proprement : pas d'icône, ordre des boutons différent entre iOS et
  // Android, et un « Annuler » qu'il fallait pousser manuellement dans le
  // tableau. `ActionSheet` est le composant prévu pour un choix parmi N — il
  // gère l'annulation, la mise en avant destructrice et les icônes.
  const handleMemberLongPress = useCallback((m: GroupMember) => {
    if (m.fingerprint === myFp) return;

    const items: ActionSheetRequest['items'] = [];

    if (iAmAdmin && m.role !== 'admin') {
      items.push({
        title: t('groups.makeAdmin', 'Promouvoir administrateur'),
        icon: <Ionicons name="shield-checkmark-outline" size={24} color={colors.primary} />,
        onPress: async () => {
          const r = await apiGroups.promoteMember(groupId, m.fingerprint);
          if (!r.success) void showAlert({ title: t('common.error', 'Erreur'), message: r.error || '' });
          refresh();
        },
      });
    }

    if (iAmAdmin) {
      items.push({
        title: t('groups.removeMember', 'Retirer du groupe'),
        icon: <Ionicons name="person-remove-outline" size={24} color={colors.danger} />,
        destructive: true,
        onPress: async () => {
          const confirmed = await showConfirm({
            title: t('groups.removeConfirmTitle', 'Retirer ce membre ?'),
            message: t('groups.removeConfirmBody', { name: m.displayName, defaultValue: `${m.displayName} sera retiré du groupe.` }),
            confirmText: t('groups.removeMember', 'Retirer'),
            cancelText: t('common.cancel', 'Annuler'),
            destructive: true,
          });
          if (!confirmed) return;
          const r = await apiGroups.removeMember(groupId, m.fingerprint);
          if (!r.success) void showAlert({ title: t('common.error', 'Erreur'), message: r.error || '' });
          refresh();
        },
      });
    }

    // « Bloquer et signaler » — offert à TOUS les membres (admin ou non) :
    // un participant non-admin doit pouvoir se protéger d'un membre abusif
    // sans dépendre de l'admin (guideline 1.2).
    items.push({
      title: t('groups.blockAndReport', 'Bloquer et signaler'),
      icon: <Ionicons name="ban-outline" size={24} color={colors.danger} />,
      destructive: true,
      onPress: async () => {
        const confirmed = await showConfirm({
          title: t('groups.blockAndReport', 'Bloquer et signaler'),
          message: t('groups.blockConfirmBody', { name: m.displayName, defaultValue: `${m.displayName} ne pourra plus vous contacter. Vous pourrez transmettre le contenu fautif à la modération à l'étape suivante.` }),
          confirmText: t('common.continue', 'Continuer'),
          cancelText: t('common.cancel', 'Annuler'),
          destructive: true,
        });
        if (!confirmed) return;
        blockDoneRef.current = false;
        setReportTarget({ fingerprint: m.fingerprint, displayName: m.displayName });
        setReportVisible(true);
      },
    });

    void showActionSheet({ title: m.displayName, items });
  }, [iAmAdmin, myFp, groupId, refresh, t, colors]);

  const handleLeave = useCallback(async () => {
    const confirmed = await showConfirm({
      title: t('groups.leaveTitle', 'Quitter le groupe ?'),
      message: t('groups.leaveBody', 'Vous ne recevrez plus les messages de ce groupe.'),
      confirmText: t('groups.leave', 'Quitter'),
      cancelText: t('common.cancel', 'Annuler'),
      destructive: true,
    });
    if (!confirmed) return;
    await apiGroups.leaveGroup(groupId);
    navigation.navigate('ConversationList');
  }, [groupId, navigation, t]);

  const handleToggleMute = useCallback((val: boolean) => {
    groups.updateGroupMeta(groupId, { muted: val });
    refresh();
  }, [groupId, refresh]);

  if (!g) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        <Header title={t('groups.info', 'Infos du groupe')} showBackButton onBackPress={() => navigation.goBack()} />
        <View style={styles.center}><Text style={{ color: colors.textSecondary }}>{t('groups.notFound', 'Groupe introuvable')}</Text></View>
      </SafeAreaView>
    );
  }

  const renderMember = ({ item }: { item: GroupMember }) => {
    const isMe = item.fingerprint === myFp;
    return (
      <TouchableOpacity
        style={styles.memberRow}
        onLongPress={() => handleMemberLongPress(item)}
        delayLongPress={300}
        activeOpacity={!isMe ? 0.6 : 1}
      >
        <Avatar displayName={item.displayName} senderToken={item.fingerprint} avatarUri={item.avatarBase64} size="medium" />
        <View style={styles.memberInfo}>
          <Text style={[styles.memberName, { color: colors.text }]} numberOfLines={1}>
            {item.displayName}{isMe ? ` (${t('groups.you', 'vous')})` : ''}
          </Text>
        </View>
        {item.role === 'admin' && (
          <View style={[styles.adminBadge, { backgroundColor: colors.primary + '22' }]}>
            <Text style={[styles.adminBadgeText, { color: colors.primary }]}>{t('groups.admin', 'Admin')}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <Header title={t('groups.info', 'Infos du groupe')} showBackButton onBackPress={() => navigation.goBack()} />
      <ScrollView>
        {/* En-tête : avatar + nom + description */}
        <View style={styles.profileHeader}>
          <GroupAvatar name={g.name} members={memberLite} groupId={groupId} avatarUri={g.avatarBase64} size="xlarge" />
          <Text style={[styles.groupName, { color: colors.text }]}>{g.name}</Text>
          {!!g.description && <Text style={[styles.groupDesc, { color: colors.textSecondary }]}>{g.description}</Text>}
          <Text style={[styles.memberCount, { color: colors.textSecondary }]}>
            {t('groups.memberCount', { count: members.length, defaultValue: `${members.length} membres` })}
          </Text>
        </View>

        {/* Mute */}
        <View style={[styles.optionRow, { borderColor: colors.border }]}>
          <Ionicons name="notifications-off-outline" size={22} color={colors.textSecondary} />
          <Text style={[styles.optionLabel, { color: colors.text }]}>{t('groups.mute', 'Mettre en sourdine')}</Text>
          <Switch
            value={!!g.muted}
            onValueChange={handleToggleMute}
            trackColor={{ false: colors.surfaceElevated, true: colors.primary + '60' }}
            thumbColor={g.muted ? colors.primary : colors.textMuted}
          />
        </View>

        {/* Ajouter des membres depuis les contacts (admin) */}
        {iAmAdmin && (
          <TouchableOpacity
            style={[styles.optionRow, { borderColor: colors.border }]}
            onPress={() => navigation.navigate('AddGroupMembers', { groupId })}
          >
            <Ionicons name="person-add-outline" size={22} color={colors.primary} />
            <Text style={[styles.optionLabel, { color: colors.primary }]}>{t('groups.addMembers', 'Ajouter des membres')}</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        )}

        {/* Inviter via QR / lien (admin).
            L'écran `GroupInviteQR` était déclaré dans le navigateur (App.tsx)
            et documenté dans l'en-tête de ce fichier, mais AUCUNE navigation
            n'y menait : la fonctionnalité était injoignable. */}
        {iAmAdmin && (
          <TouchableOpacity
            style={[styles.optionRow, { borderColor: colors.border }]}
            onPress={() => navigation.navigate('GroupInviteQR', { groupId })}
          >
            <Ionicons name="qr-code-outline" size={22} color={colors.primary} />
            <Text style={[styles.optionLabel, { color: colors.primary }]}>{t('groups.inviteByQR', 'Inviter via QR')}</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        )}

        {/* Liste des membres */}
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
          {t('groups.membersSection', 'Membres')}
        </Text>
        <FlatList
          data={members}
          keyExtractor={m => m.fingerprint}
          renderItem={renderMember}
          scrollEnabled={false}
        />
        {/* Le hint s'affiche pour tout le monde : le long-press propose
            désormais au minimum « Bloquer et signaler », admin ou non. */}
        <Text style={[styles.longPressHint, { color: colors.textSecondary }]}>
          {t('groups.longPressHint', 'Appui long sur un membre pour le gérer.')}
        </Text>

        {/* Quitter */}
        <TouchableOpacity style={styles.leaveRow} onPress={handleLeave}>
          <Ionicons name="exit-outline" size={22} color={colors.danger} />
          <Text style={[styles.leaveText, { color: colors.danger }]}>{t('groups.leave', 'Quitter le groupe')}</Text>
        </TouchableOpacity>
        <View style={{ height: 32 }} />
      </ScrollView>

      {/* Signalement du membre bloqué — même contenu transmis que depuis
          ContactInfoScreen (nom affiché + empreinte). `reportTarget` reste
          renseigné après fermeture pour laisser le BottomSheet s'animer. */}
      {reportTarget && (
        <ReportModal
          visible={reportVisible}
          onClose={() => {
            setReportVisible(false);
            void performMemberBlock(reportTarget);
          }}
          context="contact"
          content={`[blocked contact] name="${reportTarget.displayName}" fingerprint="${reportTarget.fingerprint}"`}
          onSubmitted={() => { void performMemberBlock(reportTarget); }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  profileHeader: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 16 },
  groupName: { fontSize: 22, fontWeight: '700', marginTop: 12, textAlign: 'center' },
  groupDesc: { fontSize: 14, marginTop: 6, textAlign: 'center', lineHeight: 20 },
  memberCount: { fontSize: 13, marginTop: 8 },
  optionRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth },
  optionLabel: { flex: 1, marginLeft: 14, fontSize: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  memberInfo: { flex: 1, marginLeft: 12 },
  memberName: { fontSize: 16 },
  adminBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  adminBadgeText: { fontSize: 12, fontWeight: '600' },
  longPressHint: { fontSize: 12, paddingHorizontal: 16, paddingTop: 8, fontStyle: 'italic' },
  leaveRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 16, marginTop: 20 },
  leaveText: { marginLeft: 14, fontSize: 16, fontWeight: '500' },
});
