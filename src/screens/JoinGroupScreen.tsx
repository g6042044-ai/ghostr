// src/screens/JoinGroupScreen.tsx
// Rejoindre un groupe via une invitation scannée.
//   • Reçoit la chaîne d'invitation de groupe (déjà parsée par le scanner unifié)
//   • Décode {v:3, k:'group', g, ti, ts, ab, n}
//   • Établit une session 1:1 vers l'admin (via son bundle `ab`)
//   • Envoie group_join_request (preuve de ticket)
//   • Attend l'approbation (onJoinResponse) ; à l'acceptation, le welcome crée
//     le groupe localement → on navigue vers la conversation.

import { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

import { sessionService } from '../services/tripleRatchet';
import * as apiGroups from '../services/apiGroups';
import { GroupError, errorMessage, localizedError } from '../services/errorMessages';
import * as groups from '../services/groupService';
import {
  decodeGroupInvite as codecDecodeGroupInvite,
  GROUP_INVITE_VERSION,
  GROUP_INVITE_VERSION_TAG,
} from '../services/groupInviteCodec';
import { waitForSealedSenderReady } from '../services/api1to1';
import { useTheme } from '../components/ui/ThemeContext';
import { Header } from '../components/ui/Header';
import { Button } from '../components/ui/Button';
import { GroupAvatar } from '../components/GroupAvatar';

type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { conversationId: string; conversationName: string };
  JoinGroup: { inviteString: string };
};
type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'JoinGroup'>;
type ScreenRoute = RouteProp<RootStackParamList, 'JoinGroup'>;

interface GroupInvitePayload {
  v: number; k: string;
  g: string; ti: string; ts: string; n: string;
  /** Bundle embarqué (formats v3/v4). Absent en v5. */
  ab?: string;
  /** Tag de récupération du bundle sur le serveur (format v5). Absent en v3/v4. */
  bt?: string;
}

type Phase = 'preview' | 'connecting' | 'waiting' | 'error';

/**
 * Décode une invitation de groupe.
 *
 * Délègue au codec partagé (`groupInviteCodec`), qui gère À LA FOIS le format
 * binaire compact v4 et l'ancien format JSON v3 — un utilisateur peut avoir
 * reçu un lien émis par une version antérieure de l'application.
 *
 * Les noms de champs courts (g/ti/ts/ab/n) sont conservés ici pour ne pas
 * toucher au reste de l'écran, qui les référence directement.
 */
function decodeGroupInvite(inviteString: string): GroupInvitePayload | null {
  const decoded = codecDecodeGroupInvite(inviteString);
  if (!decoded) return null;
  return {
    v: decoded.bundleTag ? GROUP_INVITE_VERSION_TAG : GROUP_INVITE_VERSION,
    k: 'group',
    g: decoded.groupId,
    ti: decoded.ticketId,
    ts: decoded.ticketSecret,
    ab: decoded.bundleJson,
    bt: decoded.bundleTag,
    n: decoded.name,
  };
}

export function JoinGroupScreen() {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ScreenRoute>();
  const { t } = useTranslation();
  const { colors } = useTheme();

  const payload = decodeGroupInvite(route.params?.inviteString || '');
  const [phase, setPhase] = useState<Phase>('preview');
  const [errorMsg, setErrorMsg] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Écoute la réponse d'approbation.
  useEffect(() => {
    if (!payload) return;
    const unsub = apiGroups.onJoinResponse((e) => {
      if (e.groupId !== payload.g) return;
      if (!mountedRef.current) return;
      if (e.approved) {
        // Le welcome (reçu en parallèle) a créé le groupe localement.
        navigation.replace('Conversation', { conversationId: payload.g, conversationName: payload.n || t('groups.group') });
      } else {
        setErrorMsg(t('groups.joinDeclined'));
        setPhase('error');
      }
    });
    return unsub;
  }, [payload, navigation, t]);

  const handleJoin = useCallback(async () => {
    if (!payload) return;
    setPhase('connecting');
    try {
      // Déjà membre ? (re-scan) → aller direct à la conversation.
      if (groups.getGroup(payload.g)) {
        navigation.replace('Conversation', { conversationId: payload.g, conversationName: payload.n });
        return;
      }

      // S'assurer que le Sealed Sender est prêt avant l'établissement réseau.
      await waitForSealedSenderReady(30_000);

      // Résoudre le bundle de l'admin.
      //   • v3/v4 : il est embarqué dans l'invitation, rien à faire.
      //   • v5    : seul un tag est présent ; le bundle a été publié sur le
      //             serveur (même mécanisme que les invitations 1:1) et doit
      //             être récupéré. Le serveur purgeant au bout de 48 h, un QR
      //             photographié il y a plusieurs jours échouera ici — on
      //             renvoie donc un message explicite plutôt qu'une erreur
      //             cryptographique incompréhensible.
      let adminBundle = payload.ab;
      if (!adminBundle) {
        if (!payload.bt) {
          throw localizedError('groups.inviteMalformed');
        }
        try {
          adminBundle = await sessionService.fetchGroupAdminBundle(payload.bt);
        } catch {
          throw localizedError('groups.qrExpired');
        }
      }

      // Créer une session 1:1 vers l'admin à partir de son bundle.
      const sess = await sessionService.createMeshInitiatorSession(adminBundle, {
        displayName: t('groups.admin'),
      } as any);
      if (!sess) throw localizedError('groups.adminSessionFailed');

      // Envoyer la demande de jonction (avec la preuve de ticket).
      const r = await apiGroups.sendJoinRequest(sess.sessionId, payload.g, payload.ti, payload.ts);
      if (!r.success) throw new Error(r.error || GroupError.JOIN_REQUEST_FAILED);

      if (mountedRef.current) setPhase('waiting');
    } catch (e: any) {
      if (mountedRef.current) {
        setErrorMsg(errorMessage(e, 'groups.joinSendFailed'));
        setPhase('error');
      }
    }
  }, [payload, navigation, t]);

  // Invitation invalide.
  if (!payload) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        <Header title={t('groups.joinGroup')} showBackButton onBackPress={() => navigation.goBack()} />
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.danger} />
          <Text style={[styles.bodyText, { color: colors.textSecondary }]}>
            {t('groups.invalidInvite')}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <Header title={t('groups.joinGroup')} showBackButton onBackPress={() => navigation.goBack()} />
      <View style={styles.body}>
        <GroupAvatar name={payload.n} groupId={payload.g} size="xlarge" />
        <Text style={[styles.groupName, { color: colors.text }]}>{payload.n || t('groups.group')}</Text>

        {phase === 'preview' && (
          <>
            <Text style={[styles.bodyText, { color: colors.textSecondary }]}>
              {t('groups.joinPreview')}
            </Text>
            <View style={styles.buttonWrap}>
              <Button title={t('groups.requestToJoin')} onPress={handleJoin} variant="primary" />
            </View>
          </>
        )}

        {phase === 'connecting' && (
          <View style={styles.statusWrap}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={[styles.bodyText, { color: colors.textSecondary }]}>
              {t('groups.connecting')}
            </Text>
          </View>
        )}

        {phase === 'waiting' && (
          <View style={styles.statusWrap}>
            <Ionicons name="hourglass-outline" size={48} color={colors.primary} />
            <Text style={[styles.bodyText, { color: colors.text }]}>
              {t('groups.waitingApproval')}
            </Text>
            <Text style={[styles.subText, { color: colors.textSecondary }]}>
              {t('groups.waitingHint')}
            </Text>
          </View>
        )}

        {phase === 'error' && (
          <View style={styles.statusWrap}>
            <Ionicons name="close-circle-outline" size={48} color={colors.danger} />
            <Text style={[styles.bodyText, { color: colors.danger }]}>{errorMsg}</Text>
            <View style={styles.buttonWrap}>
              <Button title={t('common.retry')} onPress={handleJoin} variant="secondary" />
            </View>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  body: { flex: 1, alignItems: 'center', paddingTop: 48, paddingHorizontal: 24 },
  groupName: { fontSize: 24, fontWeight: '700', marginTop: 16, textAlign: 'center' },
  bodyText: { fontSize: 15, textAlign: 'center', marginTop: 16, lineHeight: 22 },
  subText: { fontSize: 13, textAlign: 'center', marginTop: 10, lineHeight: 18 },
  buttonWrap: { width: '100%', marginTop: 32 },
  statusWrap: { alignItems: 'center', marginTop: 40 },
});
