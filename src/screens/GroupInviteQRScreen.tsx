// src/screens/GroupInviteQRScreen.tsx
// Invitation à un groupe par QR code (réservé à l'admin).
//   • Génère un ticket (secret) + encode {v:3, k:'group', g, ti, ts, ab, n}
//   • Affiche le QR + un lien partageable (buildInviteUrl)
//   • Toggle "approbation requise"
//   • Bouton "Réinitialiser le lien" (révoque les anciens tickets)
//
// Sécurité : le QR contient le bundle PUBLIC de l'admin (clés publiques) pour
// que le joiner puisse établir une session 1:1 vers l'admin et lui envoyer sa
// demande. Le ticketSecret prouve l'invitation ; il ne quitte jamais l'appareil
// côté serveur (transporté dans le fragment de l'URL, jamais en clair au relai).

import { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Share, Switch, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { Ionicons } from '@expo/vector-icons';

import { sessionService } from '../services/tripleRatchet';
import * as groups from '../services/groupService';
import { buildInviteUrl } from '../services/inviteUrl';
import { encodeGroupInvite, encodeGroupInviteWithTag, qrFitsCapacity, qrPayloadByteLength } from '../services/groupInviteCodec';
import { useTheme } from '../components/ui/ThemeContext';
import { Header } from '../components/ui/Header';
import { showToast, ToastHost } from '../components/ui/Toast';
import haptics from '../services/haptics';
import { GroupError, errorMessage, localizedError } from '../services/errorMessages';

import { showAlert, showConfirm } from '../components/ui';

// Global injecté par le bundler React Native (même convention que le reste du
// projet, cf. apiGroups.ts, groupService.ts, hardwareKeyProvider.ts).
declare const __DEV__: boolean;

type RootStackParamList = {
  GroupInviteQR: { groupId: string };
};
type ScreenRoute = RouteProp<RootStackParamList, 'GroupInviteQR'>;

// ─────────────────────────────────────────────────────────────────────────────
// CAPACITÉ DU QR
// ─────────────────────────────────────────────────────────────────────────────
// Un QR code version 40 (le plus grand) contient au maximum 2 953 octets en
// correction d'erreur « L », 2 331 en « M ». Une invitation de groupe embarque
// le bundle PQXDH de l'admin, dont la clé ML-KEM-768 fait à elle seule 1 184
// octets.
//
// Avec l'ancien format v3 (double encodage base64 + JSON), l'URL finale
// atteignait ~2 980 caractères : au-delà de la capacité MAXIMALE. Le QR ne
// pouvait donc jamais être rendu, et tout composant tentant de l'afficher sans
// garde de capacité levait une exception.
//
// Le format v4 (cf. `groupInviteCodec.ts`) sérialise les clés en binaire et
// n'encode qu'une fois en base64 : ~2 170 caractères, soit sous la limite de
// « M ». Le QR est affichable — mais il reste dense (version 40, 177×177
// modules), d'où la taille d'affichage volontairement généreuse ci-dessous.
//
// Le garde `qrFitsCapacity` reste indispensable : il protège contre un nom de
// groupe très long, un futur passage à ML-KEM-1024, ou tout changement de
// format. Le fallback par lien n'a aucune limite de taille.
const QR_ECL = 'L' as const;

/**
 * Taille d'affichage. Le QR nominal (v5, ~166 caractères) est un petit QR
 * — version 6 environ — qui scannerait dès 150 px. On conserve 300 px pour
 * couvrir le cas de repli : si la publication du bundle échoue, on affiche le
 * v4 embarqué, qui est un QR version 40 (177×177 modules) et devient
 * illisible en dessous de ~300 px.
 */
const QR_DISPLAY_SIZE = 300;

export function GroupInviteQRScreen() {
  const navigation = useNavigation();
  const route = useRoute<ScreenRoute>();
  const { groupId } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();

  // Deux représentations DISTINCTES de la même invitation :
  //   • qrString   — v5, référence le bundle par tag serveur. Court, donc le QR
  //                  est scannable instantanément. Valable 48 h (rétention).
  //   • linkString — v4, bundle embarqué. Long, mais un lien n'a pas de limite
  //                  de taille et ne dépend pas du serveur : il survit à la
  //                  purge et reste valide aussi longtemps que le ticket.
  const [qrString, setQrString] = useState<string | null>(null);
  const [linkString, setLinkString] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [approvalRequired, setApprovalRequired] = useState(true);
  const [groupName, setGroupName] = useState('');

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const g = groups.getGroup(groupId);
      if (!g) throw new Error(GroupError.UNKNOWN_GROUP);
      if (!groups.amIAdmin(groupId)) throw localizedError('groups.adminOnly');
      setGroupName(g.name);
      setApprovalRequired(g.approvalRequired);

      // Un ticket valide (réutilise le plus récent non révoqué ou en crée un).
      const ticket = groups.createTicket(groupId, {});
      if (!ticket) throw new Error(GroupError.TICKET_FAILED);

      // ── Lien durable (v4, bundle embarqué) ────────────────────────────────
      // Construit en premier : il ne dépend d'aucun réseau, donc il est
      // disponible même si la publication du bundle échoue ensuite.
      const adminBundle = await sessionService.generateMyBundleForGroup();
      if (!adminBundle) throw new Error(GroupError.BUNDLE_FAILED);

      const inline = encodeGroupInvite({
        groupId,
        ticketId: ticket.ticketId,
        ticketSecret: ticket.secret,
        bundleJson: adminBundle,
        name: g.name,
      });
      setLinkString(inline);

      // ── QR court (v5, bundle publié côté serveur) ─────────────────────────
      // On republie à CHAQUE affichage de l'écran : cela réarme la fenêtre de
      // rétention de 48 h, donc un QR montré à l'instant fonctionne toujours.
      //
      // Échec toléré : si le sealed sender n'est pas prêt ou si le réseau est
      // indisponible, on retombe sur le v4 dans le QR. Il sera dense, mais
      // l'invitation reste fonctionnelle — mieux vaut un QR difficile qu'un
      // écran en erreur.
      try {
        const { tag } = await sessionService.publishGroupAdminBundle();
        setQrString(encodeGroupInviteWithTag({
          groupId,
          ticketId: ticket.ticketId,
          ticketSecret: ticket.secret,
          bundleTag: tag,
          name: g.name,
        }));
      } catch (pubErr: any) {
        __DEV__ && console.warn('[GroupInviteQR] publication du bundle impossible, repli sur le format embarqué:', pubErr?.message);
        setQrString(inline);
      }
    } catch (e: any) {
      showAlert({ title: t('common.error'), message: errorMessage(e, 'groups.inviteFailed') });
      navigation.goBack();
    } finally {
      setLoading(false);
    }
  }, [groupId, navigation, t]);

  useEffect(() => { void generate(); }, [generate]);

  // Le QR encode le format court ; le lien partagé/copié encode le format
  // durable. Ce sont deux URL différentes, volontairement.
  const qrUrl = qrString ? buildInviteUrl(qrString) : '';
  const inviteUrl = linkString ? buildInviteUrl(linkString) : '';

  // Le QR n'est affiché que si la valeur tient dans la capacité du niveau de
  // correction choisi ; au-delà, react-native-qrcode-svg lève au rendu.
  //
  // NOTE — l'ancienne condition contenait un bug :
  //     inviteUrl.length <= QR_SAFE_BUDGET && QR_SAFE_BUDGET <= QR_BYTE_CAPACITY_L
  // Le second terme comparait deux constantes (2900 ≤ 2953), toujours vrai :
  // c'était du code mort. Elle mesurait par ailleurs `.length` (unités UTF-16)
  // contre une capacité exprimée en OCTETS — faux dès qu'un caractère non-ASCII
  // apparaît. `qrFitsCapacity` mesure bien la longueur en octets UTF-8.
  const qrFits = qrFitsCapacity(qrUrl, QR_ECL);

  __DEV__ && qrUrl && console.log(
    `[GroupInviteQR] QR ${qrPayloadByteLength(qrUrl)} o / lien ${qrPayloadByteLength(inviteUrl)} o — QR ${qrFits ? 'affiché' : 'remplacé par le lien'}`
  );

  const handleShare = useCallback(async () => {
    if (!inviteUrl) return;
    try {
      await Share.share({
        message: t('groups.shareMessage', { name: groupName, url: inviteUrl }),
      });
    } catch {}
  }, [inviteUrl, groupName, t]);

  const handleCopy = useCallback(async () => {
    if (!inviteUrl) return;
    await Clipboard.setStringAsync(inviteUrl);
    // Même pattern que InviteDetailScreen : toast, pas de modale. L'Alert
    // précédent avait en plus un titre vide (`''`), ce qui produisait une
    // boîte de dialogue au rendu bancal sur Android.
    showToast(t('groups.linkCopied'));
    haptics.selection();
  }, [inviteUrl, t]);

  const handleReset = useCallback(async () => {
    const confirmed = await showConfirm({
      title: t('groups.resetLinkTitle'),
      message: t('groups.resetLinkBody'),
      confirmText: t('groups.resetLinkConfirm'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;

    // Les erreurs levées dans un handler d'événement ne sont PAS
    // interceptées par un ErrorBoundary React (celui-ci ne couvre que le
    // rendu, componentDidMount/Update). Sans ce try/catch, une exception ici
    // remontait au gestionnaire global et faisait planter l'application.
    try {
      groups.revokeAllTickets(groupId);
      await generate();
    } catch (e: any) {
      void showAlert({ title: t('common.error'), message: errorMessage(e, 'groups.inviteFailed') });
    }
  }, [groupId, generate, t]);

  const handleToggleApproval = useCallback((val: boolean) => {
    // Idem : handler d'événement → hors de portée de l'ErrorBoundary.
    // On restaure l'état visuel si la persistance échoue, pour ne pas laisser
    // l'interrupteur mentir sur l'état réel du groupe.
    setApprovalRequired(val);
    try {
      groups.updateGroupMeta(groupId, { approvalRequired: val });
    } catch (e: any) {
      setApprovalRequired(!val);
      showAlert({ title: t('common.error'), message: errorMessage(e) });
    }
  }, [groupId, t]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <Header title={t('groups.inviteByQR')} showBackButton onBackPress={() => navigation.goBack()} />

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={[styles.groupName, { color: colors.text }]}>{groupName}</Text>

          {qrFits ? (
            <>
              <View style={styles.qrCard}>
                {/* Version 40 (177×177 modules) : en dessous de ~300 px, la
                    densité descend sous 1,7 px/module et la plupart des
                    caméras échouent au scan. */}
                <QRCode
                  value={qrUrl}
                  size={QR_DISPLAY_SIZE}
                  backgroundColor="#FFFFFF"
                  color="#0A0F14"
                  ecl={QR_ECL}
                />
              </View>
              <Text style={[styles.warn, { color: colors.textSecondary }]}>
                <Ionicons name="warning-outline" size={14} color={colors.textSecondary} />{' '}
                {t('groups.qrWarning')}
              </Text>
            </>
          ) : (
            <View style={[styles.linkCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Ionicons name="link-outline" size={28} color={colors.primary} />
              <Text style={[styles.linkTitle, { color: colors.text }]}>
                {t('groups.inviteByLinkTitle')}
              </Text>
              <Text style={[styles.linkHint, { color: colors.textSecondary }]}>
                {t('groups.inviteByLinkHint')}
              </Text>
              <Text style={[styles.linkText, { color: colors.textSecondary, borderColor: colors.border }]} selectable numberOfLines={3}>
                {inviteUrl}
              </Text>
            </View>
          )}

          {/* Actions */}
          <View style={styles.actionsRow}>
            <TouchableOpacity style={[styles.action, { backgroundColor: colors.surface }]} onPress={handleShare}>
              <Ionicons name="share-outline" size={22} color={colors.primary} />
              <Text style={[styles.actionLabel, { color: colors.text }]}>{t('groups.share')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.action, { backgroundColor: colors.surface }]} onPress={handleCopy}>
              <Ionicons name="copy-outline" size={22} color={colors.primary} />
              <Text style={[styles.actionLabel, { color: colors.text }]}>{t('groups.copyLink')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.action, { backgroundColor: colors.surface }]} onPress={handleReset}>
              <Ionicons name="refresh-outline" size={22} color={colors.danger} />
              <Text style={[styles.actionLabel, { color: colors.text }]}>{t('groups.resetLink')}</Text>
            </TouchableOpacity>
          </View>

          {/* Toggle approbation */}
          <View style={[styles.toggleRow, { borderTopColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.toggleTitle, { color: colors.text }]}>{t('groups.approvalRequired')}</Text>
              <Text style={[styles.toggleSub, { color: colors.textSecondary }]}>
                {t('groups.approvalHint')}
              </Text>
            </View>
            <Switch
              value={approvalRequired}
              onValueChange={handleToggleApproval}
              trackColor={{ false: colors.surfaceElevated, true: colors.primary + '60' }}
              thumbColor={approvalRequired ? colors.primary : colors.textMuted}
            />
          </View>
        </ScrollView>
      )}

      {/*
        Host de toast LOCAL. Cet écran est déclaré `presentation: 'modal'` :
        sur iOS il est présenté dans un view controller au-dessus de la
        racine React, donc le `<ToastHost />` monté dans App.tsx serait
        masqué derrière lui. Le host le plus récemment monté reçoit les
        messages (cf. la pile dans Toast.tsx) et rend la main à celui de la
        racine quand cet écran se démonte.
      */}
      <ToastHost />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 20, alignItems: 'center' },
  groupName: { fontSize: 20, fontWeight: '700', marginBottom: 20, textAlign: 'center' },
  qrCard: { backgroundColor: '#FFFFFF', padding: 20, borderRadius: 20, marginBottom: 16 },
  linkCard: { width: '100%', alignItems: 'center', padding: 20, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, marginBottom: 16 },
  linkTitle: { fontSize: 16, fontWeight: '700', marginTop: 10, marginBottom: 6, textAlign: 'center' },
  linkHint: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 14 },
  linkText: { fontSize: 12, fontFamily: 'monospace', padding: 10, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, width: '100%', textAlign: 'center' },
  warn: { fontSize: 13, textAlign: 'center', lineHeight: 18, marginBottom: 24, paddingHorizontal: 16 },
  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginBottom: 8 },
  action: { alignItems: 'center', justifyContent: 'center', paddingVertical: 14, paddingHorizontal: 20, borderRadius: 16, minWidth: 96 },
  actionLabel: { fontSize: 13, marginTop: 6 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', width: '100%', paddingTop: 20, marginTop: 16, borderTopWidth: StyleSheet.hairlineWidth },
  toggleTitle: { fontSize: 15, fontWeight: '600' },
  toggleSub: { fontSize: 13, marginTop: 2, lineHeight: 18, paddingRight: 12 },
});
