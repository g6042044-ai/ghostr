// src/screens/InviteDetailScreen.tsx
// Écran dédié pour le détail d'une invitation en attente
// Accessible depuis la liste des conversations (tap sur une invitation)

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  Share,
  Platform,
  Animated,
  Easing,
} from 'react-native';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';

import { pendingInviteStore, PendingInvite } from '../services/pendingInvites';
import { inviteWatcher } from '../services/inviteWatcher';
import { sessionService } from '../services/tripleRatchet';
import { suppressNotification } from '../components/InAppNotification';
import { theme } from '../components/ui';

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
        const contactName = session.theirProfile.displayName || 'Contact';
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
      await Share.share({
        message: `Rejoins ma conversation sécurisée Ghostr !\n\n${invite.inviteString}`,
      });
    } catch { /* cancelled */ }
  };

  const handleCopy = async () => {
    if (!invite) return;
    await Clipboard.setStringAsync(invite.inviteString);
    Alert.alert('Copié', 'Code d\'invitation copié dans le presse-papier.');
  };

  const handleDelete = () => {
    if (!invite) return;
    Alert.alert(
      'Supprimer l\'invitation ?',
      'Si quelqu\'un scanne ce QR code après, la connexion échouera.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: async () => {
            // [Bug #1] Libérer l'OTPK réservée avant suppression
            if (invite.status === 'pending') {
              sessionService.unreserveOtpk(invite.oneTimePreKeyId);
            }
            await pendingInviteStore.remove(invite.tag);
            navigation.goBack();
          },
        },
      ],
    );
  };

  // ── UTILS ──
  const formatTimeAgo = (ts: number): string => {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'À l\'instant';
    if (min < 60) return `il y a ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `il y a ${h}h`;
    const d = Math.floor(h / 24);
    return `il y a ${d}j`;
  };

  const formatExpiry = (expiresAt: number): string => {
    const days = Math.max(0, Math.floor((expiresAt - Date.now()) / 86400000));
    if (days === 0) return 'Expire bientôt';
    return `Expire dans ${days} jour${days > 1 ? 's' : ''}`;
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
          <Ionicons name="chevron-back" size={20} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{invite.label}</Text>
        <TouchableOpacity onPress={handleDelete} activeOpacity={0.7}>
          <Text style={styles.deleteText}>Supprimer</Text>
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
            <QRCode
              value={invite.inviteString}
              size={180}
              backgroundColor="#FFFFFF"
              color="#0A0F14"
              ecl="M"
            />
          </View>
        </View>

        {/* Status */}
        <View style={styles.statusSection}>
          <View style={styles.statusRow}>
            <View style={styles.pulseDotOuter}>
              <Animated.View style={[styles.pulseDotRing, { transform: [{ scale: pulseAnim }], opacity: pulseAnim.interpolate({ inputRange: [1, 1.6], outputRange: [0.6, 0] }) }]} />
              <View style={styles.pulseDotInner} />
            </View>
            <Text style={styles.statusText}>En attente…</Text>
          </View>
          <Text style={styles.statusSub}>
            Créée {formatTimeAgo(invite.createdAt)} · {formatExpiry(invite.expiresAt)}
          </Text>
        </View>

        {/* Actions */}
        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.shareBtn} onPress={handleShare} activeOpacity={0.8}>
            <Ionicons name="share-outline" size={18} color={theme.colors.textOnPrimary} />
            <Text style={styles.shareBtnText}>Partager</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.copyBtn} onPress={handleCopy} activeOpacity={0.7}>
            <Ionicons name="copy-outline" size={18} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Security card */}
        <View style={styles.securityCard}>
          <Text style={styles.securityTitle}>Sécurité</Text>
          {[
            { icon: 'key-outline' as const, text: 'Chiffrement X25519 + ML-KEM-768' },
            { icon: 'eye-off-outline' as const, text: 'Le QR ne contient qu\'un pointeur anonyme' },
            { icon: 'shield-checkmark-outline' as const, text: 'Le serveur ne peut pas vous identifier' },
          ].map((item, i) => (
            <View key={i} style={styles.securityRow}>
              <Ionicons name={item.icon} size={15} color={theme.colors.primary} style={{ marginTop: 1 }} />
              <Text style={styles.securityText}>{item.text}</Text>
            </View>
          ))}
        </View>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  scroll: { flex: 1 },
  scrollContent: {},

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  backButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: theme.colors.text, letterSpacing: -0.3 },
  deleteText: { fontSize: 14, fontWeight: '600', color: '#FF5A5A' },
  divider: { height: 1, backgroundColor: theme.colors.divider, marginHorizontal: 16 },

  qrSection: { alignItems: 'center', paddingVertical: 28 },
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
  statusSub: { fontSize: 13, color: theme.colors.textMuted, textAlign: 'center' },

  actionsRow: { flexDirection: 'row', paddingHorizontal: 20, gap: 10, marginBottom: 28 },
  shareBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 14, backgroundColor: theme.colors.primary,
  },
  shareBtnText: { fontSize: 15, fontWeight: '700', color: theme.colors.textOnPrimary },
  copyBtn: {
    width: 52, paddingVertical: 14, borderRadius: 14,
    backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border,
    alignItems: 'center', justifyContent: 'center',
  },

  securityCard: {
    marginHorizontal: 20, backgroundColor: theme.colors.surface, borderRadius: 14,
    padding: 18, borderWidth: 1, borderColor: theme.colors.border,
  },
  securityTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.textSecondary, marginBottom: 14 },
  securityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  securityText: { fontSize: 13, color: theme.colors.textMuted, flex: 1, lineHeight: 18 },

  inviteTagline: {
    fontSize: 12,
    fontWeight: '500',
    color: theme.colors.primary,
    textAlign: 'center',
    marginTop: 24,
    opacity: 0.6,
  },
});

export default InviteDetailScreen;