/**
 * ContactInfoScreen.tsx
 * Écran d'info contact 1:1 - Style WhatsApp/Telegram
 *
 * CORRECTIONS APPLIQUÉES:
 *   1. Notifications: suppression du doublon (Quick Action mute retiré,
 *      toggle persistant dans la section Paramètres uniquement)
 *   2. Mute: état persisté via muteService (AsyncStorage chiffré)
 *      + envoi E2E au pair → push bloqué côté émetteur
 *   3. Vidéo: bouton désactivé visuellement (pas encore implémenté)
 *   4. Reset clés: supprimé (faux sentiment de sécurité, le Triple Ratchet
 *      se répare automatiquement via DH ratchet steps)
 *   5. Blocage: supprimé (cosmétique, n'empêchait rien — supprimer la
 *      conversation est la bonne réponse)
 */

import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { sessionService } from '../services/tripleRatchet/sessionService';
import { clearLocalMessages1to1, clearUnreadCount } from '../services/api1to1';
import { useCall1to1 } from '../hooks/useCall1to1';
import { isInCall1to1 } from '../services/call1to1Service';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { loadMuteState, setSessionMuted } from '../services/muteService';
import { getActiveLanguage } from '../i18n';

// NOTE: previous versions defined a local COLORS object that mirrored
// theme.colors with a few renames. We now consume `colors` directly from
// `useTheme()` so the screen flips live on theme change. Keys mapped:
//   colors.textMuted  → colors.textMuted
//   (colors.danger + "1F")   → colors.danger + '1F'
// All other keys were identical to the global palette.

type RootStackParamList = { 
  ContactInfo: { sessionId: string };
  Conversation: { conversationId: string; conversationName: string; searchMode?: boolean };
};
type ContactInfoRouteProp = RouteProp<RootStackParamList, 'ContactInfo'>;
type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

const getAvatarColor = (id: string): string => {
  const colors = ['#00D9A6', '#7B61FF', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#F093FB', '#F5576C'];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
};

interface ContactData {
  displayName: string;
  avatarBase64?: string;
  fingerprint: string;
  createdAt: number;
}

export const ContactInfoScreen: React.FC = () => {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ContactInfoRouteProp>();
  const { sessionId } = route.params;
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const [contact, setContact] = useState<ContactData | null>(null);
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState(false);
  const [isCallingAudio, setIsCallingAudio] = useState(false);

  const { startCall, isInCall } = useCall1to1();

  useEffect(() => {
    loadContact();
    loadPersistedStates();
  }, [sessionId]);

  const loadContact = async () => {
    try {
      setLoading(true);
      const session = sessionService.getSession(sessionId);
      if (session) {
        setContact({
          displayName: session.theirProfile?.displayName || session.displayName || t('common.contact'),
          avatarBase64: session.theirProfile?.avatarBase64,
          fingerprint: session.theirIdentityKeyFingerprint || sessionId.slice(0, 32),
          createdAt: session.createdAt || Date.now(),
        });
      }
    } catch (error) {
      console.error('Error loading contact:', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Charge l'état de mute depuis le stockage.
   */
  const loadPersistedStates = async () => {
    try {
      const isMuted = await loadMuteState(sessionId);
      setMuted(isMuted);
    } catch (error) {
      __DEV__ && console.error('[ContactInfo] Error loading persisted states:', error);
    }
  };

  /**
   * Toggle mute — persiste via muteService (AsyncStorage chiffré + cache mémoire)
   */
  const handleToggleMute = async (newMuted: boolean) => {
    setMuted(newMuted);
    await setSessionMuted(sessionId, newMuted);
  };

  const handleCall = async () => {
    if (isCallingAudio || isInCall || !contact) return;
    try {
      setIsCallingAudio(true);
      const result = await startCall(sessionId, contact.displayName);
      if (!result.success) {
        Alert.alert(t('common.error'), result.error || t('contactInfo.callError'));
      }
    } catch (error) {
      console.error('[ContactInfo] Call error:', error);
      Alert.alert(t('common.error'), t('contactInfo.callGenericError'));
    } finally {
      setIsCallingAudio(false);
    }
  };

  const handleVideoCall = () => {
    // Bouton désactivé — ne rien faire
  };

  const handleSearch = () => {
    if (!contact) return;
    navigation.navigate('Conversation', {
      conversationId: sessionId,
      conversationName: contact.displayName,
      searchMode: true,
    });
  };

  const handleDelete = () => {
    if (isInCall1to1()) {
      Alert.alert(t('conversationList.callInProgressTitle'), t('conversationList.callInProgressMessage'));
      return;
    }
    Alert.alert(
      t('contactInfo.deleteConversation'),
      t('contactInfo.deleteConfirmMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await clearLocalMessages1to1(sessionId);
              await clearUnreadCount(sessionId);
              try { await AsyncStorage.removeItem(`@ghostr_reactions_${sessionId}`); } catch {}
              await sessionService.deleteSession(sessionId);
              navigation.goBack();
              navigation.goBack();
            } catch (error) {
              Alert.alert(t('common.error'), t('contactInfo.deleteFailed'));
            }
          },
        },
      ]
    );
  };

  const formatFingerprint = (fp: string): string => {
    return fp.toUpperCase().match(/.{1,4}/g)?.slice(0, 8).join(' ') || fp;
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!contact) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{t('contactInfo.notFound')}</Text>
      </View>
    );
  }

  const avatarColor = getAvatarColor(sessionId);

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[avatarColor + '30', colors.background]}
        style={styles.gradient}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />

      <SafeAreaView edges={['top']} style={styles.safeHeader}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color={colors.text} />
        </TouchableOpacity>
      </SafeAreaView>

      <ScrollView style={styles.scroll} contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]} showsVerticalScrollIndicator={false}>
        {/* Profile */}
        <View style={styles.profile}>
          <Avatar
            displayName={contact.displayName}
            senderToken={sessionId}
            avatarUri={contact.avatarBase64}
            size="xlarge"
            style={styles.avatarImage}
            backgroundColor={avatarColor}
          />
          <Text style={styles.name}>{contact.displayName}</Text>
          <View style={styles.statusRow}>
            <Ionicons name="lock-closed" size={14} color={colors.primary} />
            <Text style={styles.statusText}>{t('contactInfo.encryptedE2E')}</Text>
          </View>
        </View>

        {/* Quick Actions — CORRIGÉ: notification retirée (reste dans Paramètres), vidéo désactivée */}
        <View style={styles.quickActions}>
          <QuickAction icon="call" label={t('contactInfo.audio')} onPress={handleCall} />
          <QuickAction icon="videocam" label={t('contactInfo.video')} onPress={handleVideoCall} disabled />
          <QuickAction icon="search" label={t('contactInfo.search')} onPress={handleSearch} />
        </View>

        {/* Security */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('contactInfo.securitySection')}</Text>
          <View style={styles.card}>
            <Row icon="shield-checkmark" title={t('contactInfo.encryption')} subtitle="Triple Ratchet + ML-KEM-768" />
            <View style={styles.sep} />
            <Row 
              icon="finger-print" 
              title={t('contactInfo.fingerprint')} 
              subtitle={formatFingerprint(contact.fingerprint)}
              mono
              onPress={() => Alert.alert(t('contactInfo.fingerprintTitle'), t('contactInfo.fingerprintMessage') + '\n\n' + formatFingerprint(contact.fingerprint))}
              chevron
            />
          </View>
        </View>

        {/* Paramètres — CORRIGÉ: un seul toggle notifications, état persisté */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('contactInfo.settingsSection')}</Text>
          <View style={styles.card}>
            <Row 
              icon={muted ? "notifications-off" : "notifications"} 
              title={t('contactInfo.notifications')} 
              subtitle={muted ? t('contactInfo.notificationsOff') : t('contactInfo.notificationsOn')}
              toggle
              toggleValue={!muted}
              onToggle={() => handleToggleMute(!muted)}
            />
          </View>
        </View>

        {/* Supprimer la conversation */}
        <TouchableOpacity style={styles.dangerBtn} onPress={handleDelete}>
          <Ionicons name="trash-outline" size={20} color={colors.danger} />
          <Text style={styles.dangerBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
            {t('contactInfo.deleteConversation')}
          </Text>
        </TouchableOpacity>

        <Text style={styles.footer}>
          {t('contactInfo.createdOn', { date: new Date(contact.createdAt).toLocaleDateString(getActiveLanguage(), { day: 'numeric', month: 'long', year: 'numeric' }) })}
        </Text>
      </ScrollView>
    </View>
  );
};

// --- Composants réutilisables ---

const QuickAction = ({ icon, label, onPress, muted, disabled }: { icon: string; label: string; onPress: () => void; muted?: boolean; disabled?: boolean }) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <TouchableOpacity style={styles.quickAction} onPress={onPress} disabled={disabled}>
      <View style={[styles.quickActionIcon, muted && styles.quickActionIconMuted, disabled && styles.quickActionIconDisabled]}>
        <Ionicons name={icon as any} size={22} color={disabled ? colors.textMuted : muted ? colors.textSecondary : colors.primary} />
      </View>
      <Text
        style={[styles.quickActionLabel, disabled && styles.quickActionLabelDisabled]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
};

const Row = ({ 
  icon, title, subtitle, mono, danger, toggle, toggleValue, onToggle, onPress, chevron, rightText 
}: { 
  icon: string; title: string; subtitle?: string; mono?: boolean; danger?: boolean; 
  toggle?: boolean; toggleValue?: boolean; onToggle?: () => void; onPress?: () => void; chevron?: boolean; rightText?: string;
}) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <TouchableOpacity style={styles.row} onPress={onPress || onToggle} disabled={!onPress && !onToggle}>
      <View style={[styles.rowIcon, danger && styles.rowIconDanger]}>
        <Ionicons name={icon as any} size={20} color={danger ? colors.danger : colors.primary} />
      </View>
      <View style={styles.rowContent}>
        <Text
          style={[styles.rowTitle, danger && styles.rowTitleDanger]}
          numberOfLines={2}
        >
          {title}
        </Text>
        {subtitle && (
          <Text
            style={[styles.rowSubtitle, mono && styles.mono]}
            numberOfLines={mono ? 2 : 3}
          >
            {subtitle}
          </Text>
        )}
      </View>
      {toggle && (
        <View style={[styles.toggle, !toggleValue && styles.toggleOff]}>
          <View style={[styles.toggleKnob, !toggleValue && styles.toggleKnobOff]} />
        </View>
      )}
      {chevron && <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />}
      {rightText && <Text style={styles.rightText}>{rightText}</Text>}
    </TouchableOpacity>
  );
};

const makeStyles = (colors: ColorPalette) => ({
  container: { flex: 1, backgroundColor: colors.background },
  gradient: { position: 'absolute', top: 0, left: 0, right: 0, height: 300 },
  safeHeader: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  backBtn: { width: 40, height: 40, margin: 12, borderRadius: 20, backgroundColor: 'rgba(10,15,20,0.45)', justifyContent: 'center', alignItems: 'center' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background },
  errorText: { fontSize: 16, color: colors.textSecondary },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 100 },

  profile: { alignItems: 'center', marginBottom: 24 },
  avatar: { width: 110, height: 110, borderRadius: 55, justifyContent: 'center', alignItems: 'center', marginBottom: 16, borderWidth: 4, borderColor: colors.background },
  avatarImage: { width: 110, height: 110, borderRadius: 55, marginBottom: 16, borderWidth: 4, borderColor: colors.background },
  avatarText: { fontSize: 44, fontWeight: '700', color: '#FFF' },
  name: { fontSize: 26, fontWeight: '700', color: colors.text, marginBottom: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: { fontSize: 14, color: colors.textSecondary },

  quickActions: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 16, marginBottom: 28, gap: 8 },
  // maxWidth: 96 (vs 80 avant) pour absorber les langues à mots longs
  // (DE "Suchen" passe, FR "Rechercher" passe, RU "Поиск" passe).
  // Combiné à numberOfLines=1 + adjustsFontSizeToFit sur le label, on tient
  // jusqu'à des chaînes ~12 chars sans dégradation visible.
  quickAction: { alignItems: 'center', flex: 1, maxWidth: 96, paddingHorizontal: 4 },
  quickActionIcon: { width: 52, height: 52, borderRadius: 16, backgroundColor: colors.surfaceLight, justifyContent: 'center', alignItems: 'center', marginBottom: 6 },
  quickActionIconMuted: { backgroundColor: colors.surface },
  quickActionIconDisabled: { backgroundColor: colors.surface, opacity: 0.4 },
  quickActionLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '500', textAlign: 'center' },
  quickActionLabelDisabled: { opacity: 0.4 },

  section: { marginBottom: 20, paddingHorizontal: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textMuted, textTransform: 'uppercase', marginBottom: 8, marginLeft: 4 },
  card: { backgroundColor: colors.surface, borderRadius: 16, overflow: 'hidden' },
  sep: { height: 1, backgroundColor: colors.border, marginLeft: 64 },

  row: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  rowIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.surfaceLight, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  rowIconDanger: { backgroundColor: (colors.danger + "1F") },
  rowContent: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '500', color: colors.text },
  rowTitleDanger: { color: colors.danger },
  rowSubtitle: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  mono: { fontFamily: 'monospace', fontSize: 11, letterSpacing: 1, color: colors.textMuted },

  toggle: { width: 50, height: 30, borderRadius: 15, backgroundColor: colors.primary, padding: 3 },
  toggleOff: { backgroundColor: colors.surfaceLight },
  toggleKnob: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFF', alignSelf: 'flex-end' },
  toggleKnobOff: { alignSelf: 'flex-start' },
  rightText: { fontSize: 14, color: colors.primary, fontWeight: '600' },

  dangerBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginHorizontal: 16, marginBottom: 24, padding: 16, backgroundColor: (colors.danger + "1F"), borderRadius: 16, gap: 10 },
  dangerBtnText: { fontSize: 16, fontWeight: '600', color: colors.danger },

  footer: { textAlign: 'center', fontSize: 13, color: colors.textMuted, paddingHorizontal: 20 },
  footerTagline: { textAlign: 'center', fontSize: 12, fontWeight: '500', color: colors.primary, marginTop: 8, marginBottom: 20, opacity: 0.6 },
}) as const;

export default ContactInfoScreen;