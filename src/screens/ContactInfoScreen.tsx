/**
 * ContactInfoScreen.tsx
 * Écran d'info contact 1:1 - Style WhatsApp/Telegram
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Image,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { sessionService } from '../services/tripleRatchet/sessionService';
import { sendSessionReset1to1, clearLocalMessages1to1, clearUnreadCount } from '../services/api1to1';
import { useCall1to1 } from '../hooks/useCall1to1';
import { isInCall1to1 } from '../services/call1to1Service';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { theme } from '../components/ui/theme';
import { Avatar } from '../components/Avatar';
import { generateAvatarInitials } from '../services/crypto';

const COLORS = {
  primary: theme.colors.primary,
  accent: theme.colors.accent,
  background: theme.colors.background,
  surface: theme.colors.surface,
  surfaceLight: theme.colors.surfaceLight,
  text: theme.colors.text,
  textSecondary: theme.colors.textSecondary,
  textTertiary: theme.colors.textMuted,
  danger: theme.colors.danger,
  dangerLight: theme.colors.danger + '1F',
  border: theme.colors.border,
};

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

  const [contact, setContact] = useState<ContactData | null>(null);
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [isCallingAudio, setIsCallingAudio] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Hook pour les appels 1:1
  const { startCall, isInCall } = useCall1to1();

  useEffect(() => {
    loadContact();
  }, [sessionId]);

  const loadContact = async () => {
    try {
      setLoading(true);
      const session = sessionService.getSession(sessionId);
      if (session) {
        setContact({
          displayName: session.theirProfile?.displayName || session.displayName || 'Contact',
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

  // Appel audio via Triple Ratchet
  const handleCall = async () => {
    if (isCallingAudio || isInCall || !contact) return;
    
    try {
      setIsCallingAudio(true);
      const result = await startCall(sessionId, contact.displayName);
      
      if (!result.success) {
        Alert.alert('Erreur', result.error || 'Impossible de démarrer l\'appel');
      }
    } catch (error) {
      console.error('[ContactInfo] Call error:', error);
      Alert.alert('Erreur', 'Une erreur est survenue lors du démarrage de l\'appel');
    } finally {
      setIsCallingAudio(false);
    }
  };

  const handleVideoCall = () => Alert.alert('Appel vidéo', 'Les appels vidéo arrivent bientôt !');

  // Recherche dans la conversation
  const handleSearch = () => {
    if (!contact) return;
    // Naviguer vers la conversation en mode recherche
    navigation.navigate('Conversation', {
      conversationId: sessionId,
      conversationName: contact.displayName,
      searchMode: true,
    });
  };

  const handleBlock = () => {
    Alert.alert(
      blocked ? 'Débloquer' : 'Bloquer',
      blocked 
        ? `${contact?.displayName} pourra à nouveau vous contacter.`
        : `${contact?.displayName} ne pourra plus vous envoyer de messages.`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: blocked ? 'Débloquer' : 'Bloquer', style: blocked ? 'default' : 'destructive', onPress: () => setBlocked(!blocked) },
      ]
    );
  };

  const handleDelete = () => {
    // BUG FIX #5: Bloquer la suppression si un appel est en cours
    if (isInCall1to1()) {
      Alert.alert('Appel en cours', 'Terminez l\'appel avant de supprimer la conversation.');
      return;
    }
    Alert.alert(
      'Supprimer la conversation',
      'Tous les messages seront supprimés. Cette action est irréversible.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: async () => {
            try {
              // BUG FIX #1: Nettoyer TOUTES les données de transport AVANT de supprimer la session
              await clearLocalMessages1to1(sessionId);
              await clearUnreadCount(sessionId);
              try { await AsyncStorage.removeItem(`@ghostr_reactions_${sessionId}`); } catch {}
              await sessionService.deleteSession(sessionId);
              navigation.goBack();
              navigation.goBack();
            } catch (error) {
              Alert.alert('Erreur', 'Impossible de supprimer');
            }
          },
        },
      ]
    );
  };

  const handleResetSession = () => {
    Alert.alert(
      'Réinitialiser le chiffrement',
      'La session de chiffrement sera détruite des deux côtés. ' +
      'Un nouveau handshake sera nécessaire au prochain message.\n\n' +
      'Utilisez cette option si :\n' +
      '• Vous suspectez une compromission de vos clés\n' +
      '• Un appareil avec cette session a été perdu ou volé\n' +
      '• Vous souhaitez forcer une rotation complète des clés',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Réinitialiser',
          style: 'destructive',
          onPress: async () => {
            setResetting(true);
            try {
              const result = await sendSessionReset1to1(sessionId);
              if (result.success) {
                Alert.alert(
                  'Session réinitialisée',
                  'Le chiffrement a été réinitialisé. Un nouveau handshake sera établi au prochain message.',
                  [{ text: 'OK', onPress: () => { navigation.goBack(); navigation.goBack(); } }]
                );
              } else {
                Alert.alert('Erreur', result.error || 'Impossible de réinitialiser la session');
              }
            } catch (error) {
              Alert.alert('Erreur', 'Une erreur est survenue lors de la réinitialisation');
            } finally {
              setResetting(false);
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
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  if (!contact) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Contact non trouvé</Text>
      </View>
    );
  }

  const avatarColor = getAvatarColor(sessionId);
  const initial = generateAvatarInitials(contact.displayName);

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[avatarColor + '30', COLORS.background]}
        style={styles.gradient}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />

      <SafeAreaView edges={['top']} style={styles.safeHeader}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color={COLORS.text} />
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
            <Ionicons name="lock-closed" size={14} color={COLORS.primary} />
            <Text style={styles.statusText}>Chiffré de bout en bout</Text>
          </View>
        </View>

        {/* Quick Actions */}
        <View style={styles.quickActions}>
          <QuickAction icon="call" label="Audio" onPress={handleCall} />
          <QuickAction icon="videocam" label="Vidéo" onPress={handleVideoCall} />
          <QuickAction icon="search" label="Recherche" onPress={handleSearch} />
          <QuickAction 
            icon={muted ? "notifications-off" : "notifications"} 
            label={muted ? "Muet" : "Son"} 
            onPress={() => setMuted(!muted)}
            muted={muted}
          />
        </View>

        {/* Security Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Sécurité</Text>
          <View style={styles.card}>
            <Row icon="shield-checkmark" title="Chiffrement" subtitle="Triple Ratchet + ML-KEM-768" />
            <View style={styles.sep} />
            <Row 
              icon="finger-print" 
              title="Empreinte" 
              subtitle={formatFingerprint(contact.fingerprint)}
              mono
              onPress={() => Alert.alert('Empreinte de sécurité', 'Comparez cette empreinte avec votre contact pour vérifier la sécurité.\n\n' + formatFingerprint(contact.fingerprint))}
              chevron
            />
          </View>
        </View>

        {/* Settings Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Paramètres</Text>
          <View style={styles.card}>
            <Row 
              icon="notifications" 
              title="Notifications" 
              subtitle={muted ? 'Désactivées' : 'Activées'}
              toggle
              toggleValue={!muted}
              onToggle={() => setMuted(!muted)}
            />
            <View style={styles.sep} />
            <Row 
              icon={blocked ? "checkmark-circle" : "ban"} 
              title={blocked ? "Contact bloqué" : "Bloquer le contact"}
              danger={!blocked}
              onPress={handleBlock}
              rightText={blocked ? "Débloquer" : undefined}
            />
          </View>
        </View>

        {/* Sécurité & Danger */}
        <TouchableOpacity 
          style={styles.resetBtn} 
          onPress={handleResetSession}
          disabled={resetting}
        >
          <Ionicons name="refresh-outline" size={20} color={COLORS.primary} />
          <Text style={styles.resetBtnText}>
            {resetting ? 'Réinitialisation...' : 'Réinitialiser le chiffrement'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.dangerBtn} onPress={handleDelete}>
          <Ionicons name="trash-outline" size={20} color={COLORS.danger} />
          <Text style={styles.dangerBtnText}>Supprimer la conversation</Text>
        </TouchableOpacity>

        <Text style={styles.footer}>
          Conversation créée le {new Date(contact.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
        </Text>
      </ScrollView>
    </View>
  );
};

// Composants réutilisables
const QuickAction = ({ icon, label, onPress, muted }: { icon: string; label: string; onPress: () => void; muted?: boolean }) => (
  <TouchableOpacity style={styles.quickAction} onPress={onPress}>
    <View style={[styles.quickActionIcon, muted && styles.quickActionIconMuted]}>
      <Ionicons name={icon as any} size={22} color={muted ? COLORS.textSecondary : COLORS.primary} />
    </View>
    <Text style={styles.quickActionLabel}>{label}</Text>
  </TouchableOpacity>
);

const Row = ({ 
  icon, title, subtitle, mono, danger, toggle, toggleValue, onToggle, onPress, chevron, rightText 
}: { 
  icon: string; title: string; subtitle?: string; mono?: boolean; danger?: boolean; 
  toggle?: boolean; toggleValue?: boolean; onToggle?: () => void; onPress?: () => void; chevron?: boolean; rightText?: string;
}) => (
  <TouchableOpacity style={styles.row} onPress={onPress || onToggle} disabled={!onPress && !onToggle}>
    <View style={[styles.rowIcon, danger && styles.rowIconDanger]}>
      <Ionicons name={icon as any} size={20} color={danger ? COLORS.danger : COLORS.primary} />
    </View>
    <View style={styles.rowContent}>
      <Text style={[styles.rowTitle, danger && styles.rowTitleDanger]}>{title}</Text>
      {subtitle && <Text style={[styles.rowSubtitle, mono && styles.mono]}>{subtitle}</Text>}
    </View>
    {toggle && (
      <View style={[styles.toggle, !toggleValue && styles.toggleOff]}>
        <View style={[styles.toggleKnob, !toggleValue && styles.toggleKnobOff]} />
      </View>
    )}
    {chevron && <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />}
    {rightText && <Text style={styles.rightText}>{rightText}</Text>}
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  gradient: { position: 'absolute', top: 0, left: 0, right: 0, height: 300 },
  safeHeader: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  backBtn: { width: 40, height: 40, margin: 12, borderRadius: 20, backgroundColor: 'rgba(10,15,20,0.45)', justifyContent: 'center', alignItems: 'center' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.background },
  errorText: { fontSize: 16, color: COLORS.textSecondary },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 100 },

  profile: { alignItems: 'center', marginBottom: 24 },
  avatar: { width: 110, height: 110, borderRadius: 55, justifyContent: 'center', alignItems: 'center', marginBottom: 16, borderWidth: 4, borderColor: COLORS.background },
  avatarImage: { width: 110, height: 110, borderRadius: 55, marginBottom: 16, borderWidth: 4, borderColor: COLORS.background },
  avatarText: { fontSize: 44, fontWeight: '700', color: '#FFF' },
  name: { fontSize: 26, fontWeight: '700', color: COLORS.text, marginBottom: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: { fontSize: 14, color: COLORS.textSecondary },

  quickActions: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 16, marginBottom: 28, gap: 8 },
  quickAction: { alignItems: 'center', flex: 1, maxWidth: 80 },
  quickActionIcon: { width: 52, height: 52, borderRadius: 16, backgroundColor: COLORS.surfaceLight, justifyContent: 'center', alignItems: 'center', marginBottom: 6 },
  quickActionIconMuted: { backgroundColor: COLORS.surface },
  quickActionLabel: { fontSize: 12, color: COLORS.textSecondary, fontWeight: '500' },

  section: { marginBottom: 20, paddingHorizontal: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: COLORS.textTertiary, textTransform: 'uppercase', marginBottom: 8, marginLeft: 4 },
  card: { backgroundColor: COLORS.surface, borderRadius: 16, overflow: 'hidden' },
  sep: { height: 1, backgroundColor: COLORS.border, marginLeft: 64 },

  row: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  rowIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: COLORS.surfaceLight, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  rowIconDanger: { backgroundColor: COLORS.dangerLight },
  rowContent: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '500', color: COLORS.text },
  rowTitleDanger: { color: COLORS.danger },
  rowSubtitle: { fontSize: 13, color: COLORS.textSecondary, marginTop: 2 },
  mono: { fontFamily: 'monospace', fontSize: 11, letterSpacing: 1, color: COLORS.textTertiary },

  toggle: { width: 50, height: 30, borderRadius: 15, backgroundColor: COLORS.primary, padding: 3 },
  toggleOff: { backgroundColor: COLORS.surfaceLight },
  toggleKnob: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFF', alignSelf: 'flex-end' },
  toggleKnobOff: { alignSelf: 'flex-start' },
  rightText: { fontSize: 14, color: COLORS.primary, fontWeight: '600' },

  resetBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginHorizontal: 16, marginBottom: 12, padding: 16, backgroundColor: COLORS.surfaceLight, borderRadius: 16, gap: 10, borderWidth: 1, borderColor: COLORS.border },
  resetBtnText: { fontSize: 16, fontWeight: '600', color: COLORS.primary },

  dangerBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginHorizontal: 16, marginBottom: 24, padding: 16, backgroundColor: COLORS.dangerLight, borderRadius: 16, gap: 10 },
  dangerBtnText: { fontSize: 16, fontWeight: '600', color: COLORS.danger },

  footer: { textAlign: 'center', fontSize: 13, color: COLORS.textTertiary, paddingHorizontal: 20 },
  footerTagline: { textAlign: 'center', fontSize: 12, fontWeight: '500', color: COLORS.primary, marginTop: 8, marginBottom: 20, opacity: 0.6 },
});

export default ContactInfoScreen;