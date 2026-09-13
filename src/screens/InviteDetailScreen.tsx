// src/screens/InviteDetailScreen.tsx
// Écran dédié pour le détail d'une invitation en attente
// Accessible depuis la liste des conversations (tap sur une invitation)

import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Share, Platform, Animated, Easing } from 'react-native';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';

import { pendingInviteStore, PendingInvite } from '../services/pendingInvites';
import { inviteWatcher } from '../services/inviteWatcher';
import { sessionService } from '../services/tripleRatchet';
import { suppressNotification } from '../components/InAppNotification';
import { withExternalActivity } from '../services/lockGuard';
import { buildInviteUrl } from '../services/inviteUrl';
import { qrFitsCapacity } from '../services/groupInviteCodec';
import { useTheme, useThemedStyles, showToast, type ColorPalette, showConfirm } from '../components/ui';
import haptics from '../services/haptics';

type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { conversationId: string; conversationName: string };
  InviteDetail: { tag: string };
  ConnectionSuccess: { sessionId: string; contactName: string; inviteLabel: string; inviteTag?: string };
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;
type DetailRouteProp = RouteProp<RootStackParamList, 'InviteDetail'>;

export function InviteDetailScreen() {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<DetailRouteProp>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { tag } = route.params;

  const [invite, setInvite] = useState<PendingInvite | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // ── LOAD ──
  const loadInvite = useCallback(async () => {
    await pendingInviteStore.load();
    const all = pendingInviteStore.getAll();
    const found = all.find(i => i.tag === tag) || null;
    setInvite(found);
    if (!found) {
      // Invite was deleted or doesn't exist
      navigation.goBack();
    }
  }, [tag]);

  useEffect(() => {
    loadInvite();
    const unsub = pendingInviteStore.onChange(loadInvite);
    return () => unsub();
  }, [loadInvite]);

  // Listen for acceptance
  // Pré-supprimer la notification banner car cet écran gère via ConnectionSuccess
  useEffect(() => {
    suppressNotification(`accept_${tag}`);
    
    const unsub = inviteWatcher.onAccepted((session, acceptedInvite) => {
      if (acceptedInvite.tag === tag) {
        const contactName = session.theirProfile.displayName || t('common.contact');
        navigation.replace('ConnectionSuccess', {
          sessionId: session.id,
          contactName,
          inviteLabel: acceptedInvite.label,
          inviteTag: acceptedInvite.tag,
          contactAvatarBase64: session.theirProfile.avatarBase64,
        });
      }
    });
    return () => unsub();
  }, [tag]);

  useFocusEffect(useCallback(() => {
    inviteWatcher.forcePoll();
  }, []));

  // Pulse animation
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.6, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  // ── ACTIONS ──
  const handleShare = async () => {
    if (!invite) return;
    try {
      // Voir InviteModal.handleShare pour la justification de withExternalActivity
      const inviteUrl = buildInviteUrl(invite.inviteString);
      await withExternalActivity(() =>
        Share.share({
          message: t('inviteDetail.shareMessage', { code: inviteUrl }),
        })
      );
    } catch { /* cancelled */ }
  };

  const handleCopy = async () => {
    if (!invite) return;
    // On copie l'URL complète : si le destinataire a l'app, le lien
    // l'ouvre directement ; sinon, il est redirigé vers le store.
    await Clipboard.setStringAsync(buildInviteUrl(invite.inviteString));
    // Toast au lieu d'un Alert : la copie a réussi, il n'y a rien à
    // décider. Une modale bloquante ici forçait un tap sur « OK » avant
    // de pouvoir aller coller le lien dans une autre application.
    showToast(t('inviteDetail.copied'));
    haptics.selection();
  };

  const handleDelete = async () => {
    if (!invite) return;
    const confirmed = await showConfirm({
      title: t('inviteDetail.deleteTitle'),
      message: t('inviteDetail.deleteMessage'),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    // [Bug #1] Libérer l'OTPK réservée avant suppression
    if (invite.status === 'pending') {
      sessionService.unreserveOtpk(invite.oneTimePreKeyId);
    }
    await pendingInviteStore.remove(invite.tag);
    navigation.goBack();
  };

  // ── UTILS ──
  const formatTimeAgo = (ts: number): string => {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return t('inviteDetail.justNow');
    if (min < 60) return t('inviteDetail.minutesAgo', { count: min });
    const h = Math.floor(min / 60);
    if (h < 24) return t('inviteDetail.hoursAgo', { count: h });
    const d = Math.floor(h / 24);
    return t('inviteDetail.daysAgo', { count: d });
  };

  const formatExpiry = (expiresAt: number): string => {
    const days = Math.max(0, Math.floor((expiresAt - Date.now()) / 86400000));
    if (days === 0) return t('inviteDetail.expiringSoon');
    return t('inviteDetail.expiresInDays', { count: days });
  };

  if (!invite) return null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{invite.label}</Text>
        <TouchableOpacity onPress={handleDelete} activeOpacity={0.7}>
          <Text style={styles.deleteText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>{t('common.delete')}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.divider} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* QR Code */}
        <View style={styles.qrSection}>
          <View style={styles.qrCard}>
            {/* Garde de capacité.
                L'invitation 1:1 est courte par construction — le bundle PQXDH
                est téléversé au serveur et le QR ne porte que {v:2, t, n},
                soit ~150 caractères. Ce rendu passait donc jusqu'ici.
                MAIS il n'y avait AUCUNE vérification : le jour où une charge
                utile plus lourde arrive sur ce chemin (invitation de groupe,
                ajout d'un champ), react-native-qrcode-svg lève au rendu — et
                une exception de rendu dans un écran non protégé fait tomber
                l'application. En « M », le plafond n'est que de 2 331 octets.
                On vérifie donc, et on dégrade proprement vers le lien. */}
            {qrFitsCapacity(buildInviteUrl(invite.inviteString), 'M') ? (
              <QRCode
                value={buildInviteUrl(invite.inviteString)}
                size={180}
                backgroundColor="#FFFFFF"
                color="#0A0F14"
                ecl="M"
              />
            ) : (
              <Text style={styles.qrTooLarge} selectable numberOfLines={4}>
                {buildInviteUrl(invite.inviteString)}
              </Text>
            )}
          </View>
        </View>

        {/* Status */}
        <View style={styles.statusSection}>
          <View style={styles.statusRow}>
            <View style={styles.pulseDotOuter}>
              <Animated.View style={[styles.pulseDotRing, { transform: [{ scale: pulseAnim }], opacity: pulseAnim.interpolate({ inputRange: [1, 1.6], outputRange: [0.6, 0] }) }]} />
              <View style={styles.pulseDotInner} />
            </View>
            <Text style={styles.statusText}>{t('inviteDetail.pending')}</Text>
          </View>
          <Text style={styles.statusSub}>
            {t('inviteDetail.createdAt', { ago: formatTimeAgo(invite.createdAt), expires: formatExpiry(invite.expiresAt) })}
          </Text>
        </View>

        {/* Actions */}
        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.shareBtn} onPress={handleShare} activeOpacity={0.8}>
            <Ionicons name="share-outline" size={18} color={colors.textOnPrimary} />
            <Text
              style={styles.shareBtnText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.82}
            >
              {t('inviteDetail.shareTitle')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.copyBtn} onPress={handleCopy} activeOpacity={0.7}>
            <Ionicons name="copy-outline" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Security card */}
        <View style={styles.securityCard}>
          <Text style={styles.securityTitle}>{t('inviteDetail.securityTitle')}</Text>
          {[
            { icon: 'key-outline' as const, text: t('inviteDetail.security1') },
            { icon: 'eye-off-outline' as const, text: t('inviteDetail.security2') },
            { icon: 'shield-checkmark-outline' as const, text: t('inviteDetail.serverCantIdentify') },
          ].map((item, i) => (
            <View key={i} style={styles.securityRow}>
              <Ionicons name={item.icon} size={15} color={colors.primary} style={{ marginTop: 1 }} />
              <Text style={styles.securityText}>{item.text}</Text>
            </View>
          ))}
        </View>

      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: {},

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  backButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: colors.text, letterSpacing: -0.3 },
  deleteText: { fontSize: 14, fontWeight: '600', color: '#FF5A5A' },
  divider: { height: 1, backgroundColor: colors.divider, marginHorizontal: 16 },

  qrSection: { alignItems: 'center', paddingVertical: 28 },
  qrTooLarge: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  qrCard: {
    backgroundColor: '#FFFFFF', padding: 18, borderRadius: 20,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.4, shadowRadius: 24 },
      android: { elevation: 12 },
    }),
  },

  statusSection: { alignItems: 'center', paddingHorizontal: 20, paddingBottom: 28 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  pulseDotOuter: { width: 10, height: 10, alignItems: 'center', justifyContent: 'center' },
  pulseDotRing: { position: 'absolute', width: 10, height: 10, borderRadius: 5, backgroundColor: '#FFB547' },
  pulseDotInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFB547' },
  statusText: { fontSize: 17, fontWeight: '700', color: '#FFB547' },
  statusSub: { fontSize: 13, color: colors.textMuted, textAlign: 'center' },

  actionsRow: { flexDirection: 'row', paddingHorizontal: 20, gap: 10, marginBottom: 28 },
  shareBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 14, backgroundColor: colors.primary,
  },
  shareBtnText: { fontSize: 15, fontWeight: '700', color: colors.textOnPrimary },
  copyBtn: {
    width: 52, paddingVertical: 14, borderRadius: 14,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },

  securityCard: {
    marginHorizontal: 20, backgroundColor: colors.surface, borderRadius: 14,
    padding: 18, borderWidth: 1, borderColor: colors.border,
  },
  securityTitle: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginBottom: 14 },
  securityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  securityText: { fontSize: 13, color: colors.textMuted, flex: 1, lineHeight: 18 },

  inviteTagline: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.primary,
    textAlign: 'center',
    marginTop: 24,
    opacity: 0.6,
  },
}) as const;

export default InviteDetailScreen;