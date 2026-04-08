// src/screens/SettingsScreen.tsx
// Paramètres de l'application
// v5.0 - Design compact et moderne pour le profil

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
  Platform,
  Switch,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { 
  getOrCreateDeviceState, 
  clearAllData, 
  getGlobalDisplayName, 
  getGlobalAvatar,
} from '../services/storage';
import { isLockEnabled } from '../services/appLock';
import { getPrivacyStatus } from '../services/privacySettings';
import { theme, Header, AlertModal } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { Ionicons } from '@expo/vector-icons';
import { isSilentMode, setSilentMode, loadSilentMode } from '../services/callTones';
import { isPushEnabled, setPushEnabled } from '../services/pushNotificationService';
import { SplashScreen } from './SplashScreen';

type RootStackParamList = {
  ConversationList: undefined;
  Settings: undefined;
  Security: undefined;
  EditProfile: undefined;
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Settings'>;

interface Props {
  onSecurityChange?: () => void;
}

export function SettingsScreen({ onSecurityChange }: Props) {
  const navigation = useNavigation<NavigationProp>();
  const insets = useSafeAreaInsets();
  
  const [deviceId, setDeviceId] = useState<string>('');
  const [lockEnabled, setLockEnabled] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [relayEnabled, setRelayEnabled] = useState(false);
  const [silentModeEnabled, setSilentModeEnabled] = useState(false);
  const [pushNotifEnabled, setPushNotifEnabled] = useState(false);
  
  // Profil
  const [displayName, setDisplayName] = useState<string>('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  
  // (No profile-edit animations needed — now a dedicated screen)

  useEffect(() => {
    loadInfo();
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', loadInfo);
    return unsubscribe;
  }, [navigation]);

  const loadInfo = async () => {
    try {
      const deviceState = await getOrCreateDeviceState();
      setDeviceId(deviceState.deviceId.substring(0, 16) + '...');
      
      const locked = await isLockEnabled();
      setLockEnabled(locked);
      
      const privacyStatus = getPrivacyStatus();
      setRelayEnabled(privacyStatus.relayEnabled);
      
      const name = await getGlobalDisplayName();
      setDisplayName(name || '');
      
      const avatar = await getGlobalAvatar();
      setAvatarUri(avatar);
      
      const silent = await loadSilentMode();
      setSilentModeEnabled(silent);
      
      setPushNotifEnabled(isPushEnabled());
    } catch (e) {
      console.error('Failed to load settings info:', e);
    }
  };

  const handleToggleSilentMode = async (enabled: boolean) => {
    setSilentModeEnabled(enabled);
    await setSilentMode(enabled);
  };

  const handleTogglePush = async (enabled: boolean) => {
    setPushNotifEnabled(enabled);
    await setPushEnabled(enabled);
    if (enabled) {
      // Re-enregistrer les tokens pour toutes les sessions
      const { sendPushTokenToAllPeers } = require('../services/api1to1');
      sendPushTokenToAllPeers().catch(() => {});
    }
  };

  const handleClearData = async () => {
    setClearing(true);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      await clearAllData();
      setShowClearConfirm(false);
      navigation.navigate('ConversationList');
    } catch (e) {
      console.error('Clear data error:', e);
    } finally {
      setClearing(false);
    }
  };

  const handleEditProfile = () => {
    navigation.navigate('EditProfile');
  };

  // Full-screen loading when clearing data
  if (clearing) return <SplashScreen statusMessage="Effacement des données…" />;

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header
        title="Paramètres"
        onBackPress={() => navigation.goBack()}
      />

      <ScrollView 
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ========== PROFIL ========== */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>PROFIL</Text>
          
          <TouchableOpacity
            style={styles.profileRow}
            onPress={handleEditProfile}
            activeOpacity={0.7}
          >
            <View style={styles.profileAvatarContainer}>
              <Avatar
                displayName={displayName}
                avatarUri={avatarUri || undefined}
                size="large"
              />
              <View style={styles.profileAvatarBadge}>
                <Ionicons name="camera" size={11} color="#FFFFFF" />
              </View>
            </View>
            
            <View style={styles.profileContent}>
              <Text style={styles.profileName} numberOfLines={1}>
                {displayName || 'Définir un pseudo'}
              </Text>
              <Text style={styles.profileHint}>Appuyez pour modifier</Text>
            </View>
            
            <Ionicons name="chevron-forward" size={18} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Sécurité */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SÉCURITÉ</Text>
          
          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => navigation.navigate('Security')}
            activeOpacity={0.7}
          >
            <View style={[styles.settingIcon, { backgroundColor: theme.colors.primary + '15' }]}>
              <Ionicons name="lock-closed" size={20} color={theme.colors.primary} />
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.settingLabel}>Verrouillage de l'app</Text>
              <Text style={styles.settingValue}>
                {lockEnabled ? 'Activé' : 'Désactivé'}
              </Text>
            </View>
            <View style={[
              styles.statusBadge,
              lockEnabled ? styles.statusActive : styles.statusInactive
            ]}>
              <Ionicons 
                name={lockEnabled ? 'shield-checkmark' : 'shield-outline'} 
                size={14} 
                color={lockEnabled ? theme.colors.success : theme.colors.textMuted} 
              />
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Confidentialité */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>NOTIFICATIONS</Text>
          
          <View style={styles.settingRow}>
            <View style={[styles.settingIcon, { backgroundColor: theme.colors.primary + '15' }]}>
              <Ionicons name="notifications" size={20} color={theme.colors.primary} />
            </View>
            <View style={[styles.settingContent, { flex: 1 }]}>
              <Text style={styles.settingLabel}>Notifications push</Text>
              <Text style={[styles.settingValue, { fontSize: 12, marginTop: 2, lineHeight: 16 }]}>
                Un signal vide transite par Google/Apple — aucun contenu n'est exposé.
              </Text>
            </View>
            <Switch
              value={pushNotifEnabled}
              onValueChange={handleTogglePush}
              trackColor={{ false: '#333', true: theme.colors.primary + '60' }}
              thumbColor={pushNotifEnabled ? theme.colors.primary : '#888'}
            />
          </View>
        </View>

        {/* Confidentialité */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>CONFIDENTIALITÉ</Text>
          
          <View style={styles.privacyCard}>
            <View style={styles.privacyRow}>
              <View style={[styles.checkIcon, styles.checkIconActive]}>
                <Ionicons name="checkmark" size={16} color={theme.colors.success} />
              </View>
              <View style={styles.privacyContent}>
                <Text style={styles.privacyLabel}>Chiffré sur votre appareil</Text>
                <Text style={styles.privacyDesc}>Le serveur ne peut pas lire vos messages</Text>
              </View>
            </View>
            
            <View style={styles.privacyRow}>
              <View style={[styles.checkIcon, styles.checkIconActive]}>
                <Ionicons name="checkmark" size={16} color={theme.colors.success} />
              </View>
              <View style={styles.privacyContent}>
                <Text style={styles.privacyLabel}>Clés locales</Text>
                <Text style={styles.privacyDesc}>Générées uniquement sur votre téléphone</Text>
              </View>
            </View>
            
            <View style={styles.privacyRow}>
              <View style={[styles.checkIcon, styles.checkIconActive]}>
                <Ionicons name="checkmark" size={16} color={theme.colors.success} />
              </View>
              <View style={styles.privacyContent}>
                <Text style={styles.privacyLabel}>Protection renforcée</Text>
                <Text style={styles.privacyDesc}>Résistant aux futurs ordinateurs quantiques</Text>
              </View>
            </View>
            
            <View style={[styles.privacyRow, styles.privacyRowLast]}>
              <View style={[
                styles.checkIcon, 
                relayEnabled ? styles.checkIconActive : styles.checkIconInactive
              ]}>
                <Ionicons name={relayEnabled ? 'checkmark' : 'ellipse-outline'} size={16} color={relayEnabled ? theme.colors.success : theme.colors.textMuted} />
              </View>
              <View style={styles.privacyContent}>
                <Text style={[styles.privacyLabel, !relayEnabled && styles.privacyLabelInactive]}>
                  Relay anonyme
                </Text>
                <Text style={styles.privacyDesc}>
                  {relayEnabled ? 'Votre IP est masquée' : 'Non configuré'}
                </Text>
              </View>
            </View>
            
            {/* Note technique */}
            <View style={styles.privacyTechNote}>
              <Text style={styles.privacyTechText}>
                Triple Ratchet · X25519 · ML-KEM-768
              </Text>
            </View>
          </View>
        </View>




        {/* Zone de danger */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, styles.dangerSectionTitle]}>ZONE DE DANGER</Text>
          
          <TouchableOpacity
            style={styles.dangerRow}
            onPress={() => setShowClearConfirm(true)}
            activeOpacity={0.7}
          >
            <View style={[styles.settingIcon, styles.dangerIcon]}>
              <Ionicons name="trash-outline" size={20} color={theme.colors.danger} />
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.dangerLabel}>Effacer toutes les données</Text>
              <Text style={styles.dangerHint}>
                Supprime définitivement conversations et messages
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.colors.danger + '60'} />
          </TouchableOpacity>
        </View>

        {/* À propos */}
        <View style={styles.aboutSection}>
          <View style={styles.aboutCard}>
            <Image 
              source={require('../../assets/icon_nobg.png')} 
              style={styles.aboutLogoImage}
            />
            <View style={styles.aboutTextContainer}>
              <Text style={styles.aboutTitle}>Ghostr</Text>
            </View>
            <View style={styles.versionBadge}>
              <Text style={styles.versionText}>v5.0</Text>
            </View>
          </View>
          <Text style={styles.aboutCopyright}>
            Triple Ratchet · X25519 · ML-KEM-768
          </Text>
        </View>
      </ScrollView>

      {/* Modal de confirmation effacement */}
      <AlertModal
        visible={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title="Effacer toutes les données"
        message="Cette action supprimera définitivement toutes vos conversations et messages. Cette action est irréversible."
        icon={<Ionicons name="warning" size={48} color={theme.colors.warning} />}
        primaryButton={{
          title: 'Effacer tout',
          onPress: handleClearData,
          variant: 'danger',
          loading: clearing,
        }}
        secondaryButton={{
          title: 'Annuler',
          onPress: () => setShowClearConfirm(false),
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingTop: 8,
  },
  
  // ============================================
  // PROFILE ROW - Compact
  // ============================================
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  profileAvatarContainer: {
    position: 'relative',
    marginRight: 14,
  },
  profileAvatarBadge: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2.5,
    borderColor: theme.colors.surface,
  },
  profileContent: {
    flex: 1,
  },
  profileName: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.colors.text,
    marginBottom: 2,
  },
  profileHint: {
    fontSize: 14,
    color: theme.colors.textSecondary,
  },
  
  // ============================================
  // SECTIONS
  // ============================================
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: 12,
    marginLeft: 4,
  },
  dangerSectionTitle: {
    color: theme.colors.danger,
  },
  
  // Setting Row
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: 16,
  },
  settingIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  iconEmoji: {
    fontSize: 20,
  },
  settingContent: {
    flex: 1,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: theme.colors.text,
    marginBottom: 2,
  },
  settingValue: {
    fontSize: 14,
    color: theme.colors.textSecondary,
  },
  chevron: {
    fontSize: 24,
    color: theme.colors.textMuted,
    marginLeft: 8,
  },
  // Notification settings extras
  settingRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  settingIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingTextWrap: {
    flex: 1,
  },
  settingDesc: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  
  // Status Badge
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    marginRight: 8,
  },
  statusActive: {
    backgroundColor: theme.colors.success + '20',
  },
  statusInactive: {
    backgroundColor: theme.colors.surfaceLight,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
  },
  statusTextActive: {
    color: theme.colors.success,
  },
  statusTextInactive: {
    color: theme.colors.textMuted,
  },
  
  // Privacy Card
  privacyCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: 6,
  },
  privacyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  privacyRowLast: {
    borderBottomWidth: 0,
  },
  checkIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  checkIconActive: {
    backgroundColor: theme.colors.success + '20',
  },
  checkIconInactive: {
    backgroundColor: theme.colors.surfaceLight,
  },
  checkText: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.success,
  },
  checkTextInactive: {
    color: theme.colors.textMuted,
  },
  privacyContent: {
    flex: 1,
  },
  privacyLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: theme.colors.text,
    marginBottom: 2,
  },
  privacyLabelInactive: {
    color: theme.colors.textMuted,
  },
  privacyDesc: {
    fontSize: 13,
    color: theme.colors.textSecondary,
  },
  privacyTechNote: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
    alignItems: 'center',
  },
  privacyTechText: {
    fontSize: 11,
    color: theme.colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.3,
  },
  
  // Info Section
  infoSection: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    overflow: 'hidden',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  infoRowLast: {
    borderBottomWidth: 0,
  },
  infoLabel: {
    fontSize: 15,
    color: theme.colors.text,
  },
  infoValue: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    maxWidth: '50%',
    textAlign: 'right',
  },
  
  // Danger Row
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.danger + '10',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.colors.danger + '30',
  },
  dangerIcon: {
    backgroundColor: theme.colors.danger + '20',
  },
  dangerLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: theme.colors.danger,
    marginBottom: 2,
  },
  dangerHint: {
    fontSize: 13,
    color: theme.colors.textSecondary,
  },
  
  // About Section
  aboutSection: {
    alignItems: 'center',
    paddingVertical: 32,
    marginTop: 8,
  },
  aboutCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 20,
    marginBottom: 16,
    width: '100%',
    ...theme.shadow.sm,
  },
  aboutLogoImage: {
    width: 52,
    height: 52,
    borderRadius: 14,
  },
  aboutTextContainer: {
    flex: 1,
    marginLeft: 16,
  },
  aboutTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: theme.colors.text,
    letterSpacing: -0.3,
  },
  aboutTagline: {
    fontSize: 13,
    color: theme.colors.primary,
    fontWeight: '500',
    marginTop: 2,
  },
  versionBadge: {
    backgroundColor: theme.colors.primary + '15',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  versionText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.primary,
  },
  aboutCopyright: {
    fontSize: 11,
    color: theme.colors.textMuted,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.3,
  },
  
});

export default SettingsScreen;