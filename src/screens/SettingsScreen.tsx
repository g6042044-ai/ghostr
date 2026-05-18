// src/screens/SettingsScreen.tsx
// Paramètres de l'application
// v5.0 - Design compact et moderne pour le profil

import { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image, Platform, Switch } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { clearAllData } from '../services/storage';
import { isLockEnabled } from '../services/appLock';
import { getPrivacyStatus } from '../services/privacySettings';
import { theme, Header, AlertModal, useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { Ionicons } from '@expo/vector-icons';
import { isPushEnabled, setPushEnabled } from '../services/pushNotificationService';
import { SplashScreen } from './SplashScreen';
import { getLanguageInfo } from '../i18n';
// PERF — Lecture du profil depuis la RAM de sessionService au lieu d'AsyncStorage.
// La donnée est garantie chargée car App.tsx await sessionService.initialize()
// avant setIsInitializing(false). Cf. Phase 2 / Action 2.x du plan d'action.
import { sessionService } from '../services/tripleRatchet';

type RootStackParamList = {
  ConversationList: undefined;
  Settings: undefined;
  Security: undefined;
  EditProfile: undefined;
  Language: undefined;
  Theme: undefined;
  MigrationExport: undefined;
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Settings'>;

interface Props {
  onSecurityChange?: () => void;
  /** Called when the user confirms they want to restore from backup, OVER
   *  their existing account. App.tsx will then mount MigrationImportScreen.
   *  The double-confirmation (with typed phrase) is handled in this screen. */
  onRequestRestore?: () => void;
}

export function SettingsScreen({ onSecurityChange, onRequestRestore }: Props) {
  const navigation = useNavigation<NavigationProp>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t, i18n } = useTranslation();
  const { preference: appearancePref } = useTheme();
  
  const [lockEnabled, setLockEnabled] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [relayEnabled, setRelayEnabled] = useState(false);
  const [pushNotifEnabled, setPushNotifEnabled] = useState(false);
  
  // ──────────────────────────────────────────────────────────────────────────
  // PROFIL — INIT SYNCHRONE DEPUIS LA RAM DE sessionService
  // ──────────────────────────────────────────────────────────────────────────
  // Avant : useState('') puis loadInfo() asynchrone (await getGlobalDisplayName
  //   + await getGlobalAvatar — 2 lectures AsyncStorage + 2 décryptions AES-GCM).
  //   Le premier paint affichait t('settings.profileSetName') ("Définir le nom")
  //   et un avatar par défaut, puis se remplissait après ~50-300 ms (avatar
  //   base64 = grosse string à décrypter). Flash visible à chaque ouverture.
  //
  // Après : initialiseur lazy useState(() => sessionService.getMyProfile()).
  //   sessionService.initialize() (awaité au boot dans App.tsx avant
  //   setIsInitializing(false)) charge déjà myProfile en RAM via loadProfile().
  //   getMyProfile() est synchrone, retourne un clone immédiat → premier paint
  //   avec les bonnes valeurs, zéro flash.
  //
  // Subscription onProfileChange : quand EditProfileScreen sauve via
  //   updateMyProfileDirect(), tous les listeners sont notifiés synchrone-
  //   ment (cf. sessionService.notifyProfileChange ligne 1318). Plus besoin
  //   de re-fetch AsyncStorage au focus pour le profil — l'autre useEffect
  //   navigation.addListener('focus', loadInfo) reste pour les champs non
  //   profil (lock, push, silent, etc.).
  //
  // SÉCURITÉ : aucun changement. Même donnée, même source de vérité, juste
  //   accédée depuis la RAM au lieu d'un round-trip AsyncStorage + AEAD inutile.
  // ──────────────────────────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState<string>(() => {
    const p = sessionService.getMyProfile();
    return p.displayName === 'Anonymous' ? '' : p.displayName;
  });
  const [avatarUri, setAvatarUri] = useState<string | null>(() => {
    return sessionService.getMyProfile().avatarBase64 ?? null;
  });
  
  // (No profile-edit animations needed — now a dedicated screen)

  useEffect(() => {
    loadInfo();
  }, []);

  // Subscription réactive au profil — pas de re-fetch nécessaire.
  // updateMyProfileDirect (depuis EditProfileScreen) notifie tous les listeners.
  useEffect(() => {
    const unsubscribe = sessionService.onProfileChange((profile) => {
      setDisplayName(profile.displayName === 'Anonymous' ? '' : profile.displayName);
      setAvatarUri(profile.avatarBase64 ?? null);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', loadInfo);
    return unsubscribe;
  }, [navigation]);

  const loadInfo = async () => {
    try {
      const locked = await isLockEnabled();
      setLockEnabled(locked);

      const privacyStatus = getPrivacyStatus();
      setRelayEnabled(privacyStatus.relayEnabled);

      // Profil : intentionnellement RIEN ici. La source de vérité est
      // sessionService (init sync au mount + onProfileChange listener).
      // Cf. bloc commentaire au-dessus du useState displayName.

      setPushNotifEnabled(isPushEnabled());
    } catch (e) {
      console.error('Failed to load settings info:', e);
    }
  };

  const handleTogglePush = async (enabled: boolean) => {
    setPushNotifEnabled(enabled);
    await setPushEnabled(enabled);
    if (enabled) {
      // Re-enregistrer les tokens pour toutes les sessions
      const { sendPushTokenToAllPeers } = require('../services/api1to1');
      sendPushTokenToAllPeers().catch(() => {});
    }
    // v28.0: Informer TOUS les pairs de la préférence globale de mute.
    // Si désactivé → les pairs utilisent un blob aléatoire → aucun push envoyé.
    // Si réactivé → les pairs ré-envoient de vrais blobs push.
    try {
      const { sendMutePreferenceToAllPeers } = require('../services/api1to1');
      sendMutePreferenceToAllPeers(!enabled).catch(() => {});
    } catch {}
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

  const handleLanguagePress = () => {
    navigation.navigate('Language');
  };

  const handleAppearancePress = () => {
    navigation.navigate('Theme');
  };

  // Full-screen loading when clearing data
  if (clearing) return <SplashScreen statusMessage={t('settings.clearingData')} />;

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header
        title={t('settings.title')}
        onBackPress={() => navigation.goBack()}
      />

      <ScrollView 
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ========== PROFIL ========== */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.profileSection')}</Text>
          
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
                {displayName || t('settings.profileSetName')}
              </Text>
              <Text style={styles.profileHint} numberOfLines={1}>{t('settings.profileTapToEdit')}</Text>
            </View>
            
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Sécurité */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.securitySection')}</Text>
          
          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => navigation.navigate('Security')}
            activeOpacity={0.7}
          >
            <View style={[styles.settingIcon, { backgroundColor: colors.primary + '15' }]}>
              <Ionicons name="lock-closed" size={20} color={colors.primary} />
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.settingLabel} numberOfLines={1}>{t('settings.appLock')}</Text>
              <Text style={styles.settingValue} numberOfLines={1}>
                {lockEnabled ? t('settings.appLockEnabled') : t('settings.appLockDisabled')}
              </Text>
            </View>
            <View style={[
              styles.statusBadge,
              lockEnabled ? styles.statusActive : styles.statusInactive
            ]}>
              <Ionicons 
                name={lockEnabled ? 'shield-checkmark' : 'shield-outline'} 
                size={14} 
                color={lockEnabled ? colors.success : colors.textMuted} 
              />
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Notifications */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.notificationsSection')}</Text>
          
          <View style={styles.settingRow}>
            <View style={[styles.settingIcon, { backgroundColor: colors.primary + '15' }]}>
              <Ionicons name="notifications" size={20} color={colors.primary} />
            </View>
            <View style={[styles.settingContent, { flex: 1 }]}>
              <Text style={styles.settingLabel} numberOfLines={1}>{t('settings.pushNotifications')}</Text>
              <Text style={[styles.settingValue, { fontSize: 12, marginTop: 2, lineHeight: 16 }]} numberOfLines={2}>
                {t('settings.pushNotificationsHint')}
              </Text>
            </View>
            <Switch
              value={pushNotifEnabled}
              onValueChange={handleTogglePush}
              trackColor={{ false: '#333', true: colors.primary + '60' }}
              thumbColor={pushNotifEnabled ? colors.primary : '#888'}
            />
          </View>
        </View>

        {/* Général — Langue */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.generalSection')}</Text>

          <TouchableOpacity
            style={styles.settingRow}
            onPress={handleLanguagePress}
            activeOpacity={0.7}
          >
            <View style={[styles.settingIcon, { backgroundColor: colors.primary + '15' }]}>
              <Ionicons name="language" size={20} color={colors.primary} />
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.settingLabel} numberOfLines={1}>{t('settings.language')}</Text>
              <Text style={styles.settingValue} numberOfLines={1}>
                {getLanguageInfo(i18n.language)?.name ?? i18n.language}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.settingRow, { marginTop: 8 }]}
            onPress={handleAppearancePress}
            activeOpacity={0.7}
          >
            <View style={[styles.settingIcon, { backgroundColor: colors.primary + '15' }]}>
              <Ionicons
                name={
                  appearancePref === 'light'
                    ? 'sunny-outline'
                    : appearancePref === 'dark'
                    ? 'moon-outline'
                    : 'phone-portrait-outline'
                }
                size={20}
                color={colors.primary}
              />
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.settingLabel} numberOfLines={1}>{t('settings.appearance')}</Text>
              <Text style={styles.settingValue} numberOfLines={1}>
                {appearancePref === 'light'
                  ? t('settings.appearanceValueLight')
                  : appearancePref === 'dark'
                  ? t('settings.appearanceValueDark')
                  : t('settings.appearanceValueSystem')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Confidentialité */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.privacySection')}</Text>
          
          <View style={styles.privacyCard}>
            <View style={styles.privacyRow}>
              <View style={[styles.checkIcon, styles.checkIconActive]}>
                <Ionicons name="checkmark" size={16} color={colors.success} />
              </View>
              <View style={styles.privacyContent}>
                <Text style={styles.privacyLabel} numberOfLines={1}>{t('settings.privacy.encryptedLocally')}</Text>
                <Text style={styles.privacyDesc} numberOfLines={2}>{t('settings.privacy.encryptedLocallyDesc')}</Text>
              </View>
            </View>
            
            <View style={styles.privacyRow}>
              <View style={[styles.checkIcon, styles.checkIconActive]}>
                <Ionicons name="checkmark" size={16} color={colors.success} />
              </View>
              <View style={styles.privacyContent}>
                <Text style={styles.privacyLabel} numberOfLines={1}>{t('settings.privacy.localKeys')}</Text>
                <Text style={styles.privacyDesc} numberOfLines={2}>{t('settings.privacy.localKeysDesc')}</Text>
              </View>
            </View>
            
            <View style={styles.privacyRow}>
              <View style={[styles.checkIcon, styles.checkIconActive]}>
                <Ionicons name="checkmark" size={16} color={colors.success} />
              </View>
              <View style={styles.privacyContent}>
                <Text style={styles.privacyLabel} numberOfLines={1}>{t('settings.privacy.quantumResistant')}</Text>
                <Text style={styles.privacyDesc} numberOfLines={2}>{t('settings.privacy.quantumResistantDesc')}</Text>
              </View>
            </View>
            
            <View style={[styles.privacyRow, styles.privacyRowLast]}>
              <View style={[
                styles.checkIcon, 
                relayEnabled ? styles.checkIconActive : styles.checkIconInactive
              ]}>
                <Ionicons name={relayEnabled ? 'checkmark' : 'ellipse-outline'} size={16} color={relayEnabled ? colors.success : colors.textMuted} />
              </View>
              <View style={styles.privacyContent}>
                <Text style={[styles.privacyLabel, !relayEnabled && styles.privacyLabelInactive]} numberOfLines={1}>
                  {t('settings.privacy.anonymousRelay')}
                </Text>
                <Text style={styles.privacyDesc} numberOfLines={2}>
                  {relayEnabled ? t('settings.privacy.anonymousRelayActive') : t('settings.privacy.anonymousRelayInactive')}
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




        {/* Sauvegarde et migration */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.migrationSection')}</Text>

          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => navigation.navigate('MigrationExport')}
            activeOpacity={0.7}
          >
            <View style={[styles.settingIcon, { backgroundColor: colors.primary + '15' }]}>
              <Ionicons name="phone-portrait-outline" size={20} color={colors.primary} />
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.settingLabel} numberOfLines={2}>{t('settings.migrateToNewDevice')}</Text>
              <Text style={[styles.settingValue, { fontSize: 12, marginTop: 2, lineHeight: 16 }]} numberOfLines={2}>
                {t('settings.migrateHint')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>

          {onRequestRestore && (
            <TouchableOpacity
              style={[styles.settingRow, { marginTop: 8 }]}
              onPress={() => setShowRestoreConfirm(true)}
              activeOpacity={0.7}
            >
              <View style={[styles.settingIcon, { backgroundColor: colors.primary + '15' }]}>
                <Ionicons name="cloud-download-outline" size={20} color={colors.primary} />
              </View>
              <View style={styles.settingContent}>
                <Text style={styles.settingLabel} numberOfLines={2}>{t('settings.restoreFromBackup')}</Text>
                <Text style={[styles.settingValue, { fontSize: 12, marginTop: 2, lineHeight: 16 }]} numberOfLines={2}>
                  {t('settings.restoreFromBackupHint')}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>


        {/* Zone de danger */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, styles.dangerSectionTitle]}>{t('settings.dangerSection')}</Text>
          
          <TouchableOpacity
            style={styles.dangerRow}
            onPress={() => setShowClearConfirm(true)}
            activeOpacity={0.7}
          >
            <View style={[styles.settingIcon, styles.dangerIcon]}>
              <Ionicons name="trash-outline" size={20} color={colors.danger} />
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.dangerLabel} numberOfLines={1}>{t('settings.clearAll')}</Text>
              <Text style={styles.dangerHint} numberOfLines={2}>
                {t('settings.clearAllHint')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.danger + '60'} />
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
        title={t('settings.clearAllConfirmTitle')}
        message={t('settings.clearAllConfirmMessage')}
        icon={<Ionicons name="warning" size={48} color={colors.warning} />}
        primaryButton={{
          title: t('settings.clearAllConfirmAction'),
          onPress: handleClearData,
          variant: 'danger',
          loading: clearing,
        }}
        secondaryButton={{
          title: t('common.cancel'),
          onPress: () => setShowClearConfirm(false),
        }}
      />

      {/* Modal de confirmation restore (avertissement écrasement compte) */}
      <AlertModal
        visible={showRestoreConfirm}
        onClose={() => setShowRestoreConfirm(false)}
        title={t('settings.restoreConfirmTitle')}
        message={t('settings.restoreConfirmMessage')}
        icon={<Ionicons name="alert-circle" size={48} color={colors.danger} />}
        primaryButton={{
          title: t('settings.restoreConfirmAction'),
          onPress: () => {
            setShowRestoreConfirm(false);
            // Defer slightly so the modal close animation completes before
            // the import screen mounts (otherwise we get a weird stack jump).
            setTimeout(() => onRequestRestore?.(), 150);
          },
          variant: 'danger',
        }}
        secondaryButton={{
          title: t('common.cancel'),
          onPress: () => setShowRestoreConfirm(false),
        }}
      />
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: {
    flex: 1,
    backgroundColor: colors.background,
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
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
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
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2.5,
    borderColor: colors.surface,
  },
  profileContent: {
    flex: 1,
  },
  profileName: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 2,
  },
  profileHint: {
    fontSize: 14,
    color: colors.textSecondary,
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
    color: colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: 12,
    marginLeft: 4,
  },
  dangerSectionTitle: {
    color: colors.danger,
  },
  
  // Setting Row
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
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
    color: colors.text,
    marginBottom: 2,
  },
  settingValue: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  chevron: {
    fontSize: 24,
    color: colors.textMuted,
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
    color: colors.textMuted,
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
    backgroundColor: colors.success + '20',
  },
  statusInactive: {
    backgroundColor: colors.surfaceLight,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
  },
  statusTextActive: {
    color: colors.success,
  },
  statusTextInactive: {
    color: colors.textMuted,
  },
  
  // Privacy Card
  privacyCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 6,
  },
  privacyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
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
    backgroundColor: colors.success + '20',
  },
  checkIconInactive: {
    backgroundColor: colors.surfaceLight,
  },
  checkText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.success,
  },
  checkTextInactive: {
    color: colors.textMuted,
  },
  privacyContent: {
    flex: 1,
  },
  privacyLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
    marginBottom: 2,
  },
  privacyLabelInactive: {
    color: colors.textMuted,
  },
  privacyDesc: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  privacyTechNote: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    alignItems: 'center',
  },
  privacyTechText: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.3,
  },
  
  // Info Section
  infoSection: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    overflow: 'hidden',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  infoRowLast: {
    borderBottomWidth: 0,
  },
  infoLabel: {
    fontSize: 15,
    color: colors.text,
  },
  infoValue: {
    fontSize: 14,
    color: colors.textSecondary,
    maxWidth: '50%',
    textAlign: 'right',
  },
  
  // Danger Row
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.danger + '10',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.danger + '30',
  },
  dangerIcon: {
    backgroundColor: colors.danger + '20',
  },
  dangerLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.danger,
    marginBottom: 2,
  },
  dangerHint: {
    fontSize: 13,
    color: colors.textSecondary,
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
    backgroundColor: colors.surface,
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
    color: colors.text,
    letterSpacing: -0.3,
  },
  aboutTagline: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: '500',
    marginTop: 2,
  },
  versionBadge: {
    backgroundColor: colors.primary + '15',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  versionText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primary,
  },
  aboutCopyright: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.3,
  },
  
}) as const;

export default SettingsScreen;