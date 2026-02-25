// src/screens/SettingsScreen.tsx
// Paramètres de l'application
// v5.0 - Design compact et moderne pour le profil

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  TextInput,
  Modal,
  Alert,
  ActivityIndicator,
  Animated,
  Pressable,
  Dimensions,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { 
  getOrCreateDeviceState, 
  clearAllData, 
  getGlobalDisplayName, 
  setGlobalDisplayName,
  getGlobalAvatar,
  setGlobalAvatar,
} from '../services/storage';
import { isLockEnabled } from '../services/appLock';
import { getPrivacyStatus } from '../services/privacySettings';
import { sessionService } from '../services/tripleRatchet';
import { theme, Header, AlertModal } from '../components/ui';
import { Avatar } from '../components/Avatar';
import { AVATAR_COLORS } from '../services/crypto';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

type RootStackParamList = {
  ConversationList: undefined;
  Settings: undefined;
  Security: undefined;
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
  
  // Profil
  const [displayName, setDisplayName] = useState<string>('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [showPhotoOptions, setShowPhotoOptions] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newAvatarUri, setNewAvatarUri] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [processingImage, setProcessingImage] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  
  // Animations
  const avatarScale = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const photoOptionsSlide = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const photoOptionsFade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    loadInfo();
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', loadInfo);
    return unsubscribe;
  }, [navigation]);

  // Animation pour le BottomSheet d'édition
  useEffect(() => {
    if (showEditProfile) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 65,
          friction: 11,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: SCREEN_HEIGHT,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [showEditProfile]);

  // Animation pour le ActionSheet des options photo
  useEffect(() => {
    if (showPhotoOptions) {
      Animated.parallel([
        Animated.spring(photoOptionsSlide, {
          toValue: 0,
          useNativeDriver: true,
          tension: 65,
          friction: 11,
        }),
        Animated.timing(photoOptionsFade, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(photoOptionsSlide, {
          toValue: SCREEN_HEIGHT,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(photoOptionsFade, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [showPhotoOptions]);

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
    } catch (e) {
      console.error('Failed to load settings info:', e);
    }
  };

  const handleClearData = async () => {
    setClearing(true);
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

  const processImage = async (uri: string): Promise<string> => {
    // 160×160 @ q0.5: ~4-5KB base64. Net à toutes les tailles UI:
    //   - ConversationScreen: 28dp (84px) ✓
    //   - SettingsScreen: 72dp (216px) ✓
    //   - ContactInfoScreen: 110dp (330px) — légèrement soft, acceptable
    //
    // IMPACT RÉSEAU: L'avatar est envoyé seulement au premier message par
    // session (après restart app) ou quand il change (getAvatarIfChanged).
    // ~99% des messages n'incluent PAS l'avatar → tier 2KB = decoys small.
    // Le ~1% qui l'inclut: 200B texte + 5KB avatar = ~5.2KB → tier 8KB
    //   = match 30% des decoys (medium). Acceptable.
    //
    // IMPACT LOCAL: Pas stocké par message (strippé des isMine dans saveLocalMessage1to1).
    // Stocké 1× dans GLOBAL_AVATAR_KEY + 1× dans MY_PROFILE.
    const manipulated = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 160, height: 160 } }],
      { 
        compress: 0.5, 
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      }
    );
    return `data:image/jpeg;base64,${manipulated.base64}`;
  };

  const handlePickGallery = async () => {
    setShowPhotoOptions(false);
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'Veuillez autoriser l\'accès à la galerie.');
        return;
      }
      
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      
      if (!result.canceled && result.assets[0]) {
        setProcessingImage(true);
        const base64 = await processImage(result.assets[0].uri);
        setNewAvatarUri(base64);
        setProcessingImage(false);
      }
    } catch (error) {
      console.error('Gallery pick failed:', error);
      setProcessingImage(false);
      Alert.alert('Erreur', 'Impossible de charger l\'image.');
    }
  };

  const handleTakePhoto = async () => {
    setShowPhotoOptions(false);
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'Veuillez autoriser l\'accès à la caméra.');
        return;
      }
      
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      
      if (!result.canceled && result.assets[0]) {
        setProcessingImage(true);
        const base64 = await processImage(result.assets[0].uri);
        setNewAvatarUri(base64);
        setProcessingImage(false);
      }
    } catch (error) {
      console.error('Camera capture failed:', error);
      setProcessingImage(false);
      Alert.alert('Erreur', 'Impossible de prendre la photo.');
    }
  };

  const handleRemovePhoto = () => {
    setShowPhotoOptions(false);
    setNewAvatarUri('');
  };

  const handleEditProfile = () => {
    setNewDisplayName(displayName);
    setNewAvatarUri(avatarUri);
    setProfileError(null);
    setShowEditProfile(true);
  };

  const handleSaveProfile = async () => {
    const trimmed = newDisplayName.trim();
    
    if (!trimmed) {
      setProfileError('Le pseudo ne peut pas être vide');
      return;
    }
    
    if (trimmed.length < 2) {
      setProfileError('Minimum 2 caractères');
      return;
    }
    
    if (trimmed.length > 30) {
      setProfileError('Maximum 30 caractères');
      return;
    }
    
    setSavingProfile(true);
    try {
      // Déterminer le nouvel avatar
      const finalAvatar = newAvatarUri === '' ? null : (newAvatarUri && newAvatarUri !== avatarUri ? newAvatarUri : avatarUri);
      
      // 1. Écrire les deux valeurs en parallèle (au lieu de séquentiel)
      const writes: Promise<void>[] = [setGlobalDisplayName(trimmed)];
      if (newAvatarUri === '') {
        writes.push(setGlobalAvatar(null));
      } else if (newAvatarUri && newAvatarUri !== avatarUri) {
        writes.push(setGlobalAvatar(newAvatarUri));
      }
      await Promise.all(writes);
      
      // 2. Mise à jour UI immédiate (avant sync async)
      setDisplayName(trimmed);
      setAvatarUri(finalAvatar);
      setShowEditProfile(false);
      
      // 3. Sync sessionService DIRECTEMENT avec les valeurs en mémoire
      //    (au lieu de syncProfileFromGlobal qui relit tout depuis AsyncStorage)
      await sessionService.updateMyProfileDirect({
        displayName: trimmed,
        avatarBase64: finalAvatar || undefined,
      });
    } catch (e) {
      setProfileError('Erreur lors de la sauvegarde');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAvatarPressIn = () => {
    Animated.spring(avatarScale, { toValue: 0.95, useNativeDriver: true }).start();
  };
  
  const handleAvatarPressOut = () => {
    Animated.spring(avatarScale, { toValue: 1, useNativeDriver: true }).start();
  };

  const getAvatarColor = (name: string): string => {
    if (!name.trim()) return AVATAR_COLORS[0];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash) + name.charCodeAt(i);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  };

  const getInitials = (name: string): string => {
    if (!name.trim()) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.trim().substring(0, 2).toUpperCase();
  };

  const remainingChars = 30 - newDisplayName.length;

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
        {/* ========== PROFIL - Row compacte ========== */}
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
                <Text style={styles.profileAvatarBadgeIcon}>✎</Text>
              </View>
            </View>
            
            <View style={styles.profileContent}>
              <Text style={styles.profileName} numberOfLines={1}>
                {displayName || 'Définir un pseudo'}
              </Text>
              <Text style={styles.profileHint}>Nom et photo de profil</Text>
            </View>
            
            <Text style={styles.chevron}>›</Text>
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
            <View style={[styles.settingIcon, { backgroundColor: theme.colors.primary + '20' }]}>
              <Text style={styles.iconEmoji}>🔐</Text>
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
              <Text style={[
                styles.statusText,
                lockEnabled ? styles.statusTextActive : styles.statusTextInactive
              ]}>
                {lockEnabled ? 'ON' : 'OFF'}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        </View>

        {/* Confidentialité */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>CONFIDENTIALITÉ</Text>
          
          <View style={styles.privacyCard}>
            <View style={styles.privacyRow}>
              <View style={[styles.checkIcon, styles.checkIconActive]}>
                <Text style={styles.checkText}>✓</Text>
              </View>
              <View style={styles.privacyContent}>
                <Text style={styles.privacyLabel}>Chiffré sur votre appareil</Text>
                <Text style={styles.privacyDesc}>Le serveur ne peut pas lire vos messages</Text>
              </View>
            </View>
            
            <View style={styles.privacyRow}>
              <View style={[styles.checkIcon, styles.checkIconActive]}>
                <Text style={styles.checkText}>✓</Text>
              </View>
              <View style={styles.privacyContent}>
                <Text style={styles.privacyLabel}>Clés locales</Text>
                <Text style={styles.privacyDesc}>Générées uniquement sur votre téléphone</Text>
              </View>
            </View>
            
            <View style={styles.privacyRow}>
              <View style={[styles.checkIcon, styles.checkIconActive]}>
                <Text style={styles.checkText}>✓</Text>
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
                <Text style={[styles.checkText, !relayEnabled && styles.checkTextInactive]}>
                  {relayEnabled ? '✓' : '○'}
                </Text>
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
              <Text style={styles.iconEmoji}>🗑️</Text>
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.dangerLabel}>Effacer toutes les données</Text>
              <Text style={styles.dangerHint}>
                Supprime définitivement conversations et messages
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
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
              <Text style={styles.aboutTagline}>Messagerie privée</Text>
            </View>
            <View style={styles.versionBadge}>
              <Text style={styles.versionText}>v4.0</Text>
            </View>
          </View>
          <Text style={styles.aboutCopyright}>
            Vos conversations, votre vie privée
          </Text>
        </View>
      </ScrollView>

      {/* ========== BOTTOM SHEET - Édition du profil ========== */}
      <Modal
        visible={showEditProfile}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={() => setShowEditProfile(false)}
      >
        <KeyboardAvoidingView 
          style={styles.modalContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        >
          <Animated.View style={[styles.modalOverlay, { opacity: fadeAnim }]}>
            <Pressable 
              style={StyleSheet.absoluteFill} 
              onPress={() => setShowEditProfile(false)} 
            />
          </Animated.View>

          <Animated.View
            style={[
              styles.bottomSheet,
              {
                transform: [{ translateY: slideAnim }],
                paddingBottom: Math.max(insets.bottom, 16),
              },
            ]}
          >
            <View style={styles.bottomSheetHandle} />
            
            <View style={styles.bottomSheetHeader}>
              <Text style={styles.bottomSheetTitle}>Modifier le profil</Text>
            </View>
            
            {/* Avatar + Input en ligne */}
            <View style={styles.editProfileContent}>
              <TouchableOpacity
                onPress={() => setShowPhotoOptions(true)}
                onPressIn={handleAvatarPressIn}
                onPressOut={handleAvatarPressOut}
                activeOpacity={1}
                disabled={processingImage}
              >
                <Animated.View style={[
                  styles.editAvatarWrapper,
                  { transform: [{ scale: avatarScale }] }
                ]}>
                  {processingImage ? (
                    <View style={[styles.editAvatar, styles.editAvatarLoading]}>
                      <ActivityIndicator size="small" color={theme.colors.primary} />
                    </View>
                  ) : newAvatarUri && newAvatarUri !== '' ? (
                    <Image source={{ uri: newAvatarUri }} style={styles.editAvatar} />
                  ) : (
                    <View 
                      style={[
                        styles.editAvatar, 
                        styles.editAvatarPlaceholder,
                        { backgroundColor: getAvatarColor(newDisplayName) }
                      ]}
                    >
                      <Text style={styles.editAvatarInitials}>
                        {getInitials(newDisplayName)}
                      </Text>
                    </View>
                  )}
                  <View style={styles.editAvatarBadge}>
                    <Text style={styles.editAvatarBadgeIcon}>📷</Text>
                  </View>
                </Animated.View>
              </TouchableOpacity>
              
              <View style={styles.editInputSection}>
                <View style={[
                  styles.editInputWrapper,
                  inputFocused && styles.editInputWrapperFocused,
                  profileError && styles.editInputWrapperError,
                ]}>
                  <TextInput
                    style={styles.editInput}
                    value={newDisplayName}
                    onChangeText={(text) => {
                      setNewDisplayName(text);
                      setProfileError(null);
                    }}
                    placeholder="Votre pseudo"
                    placeholderTextColor={theme.colors.placeholder}
                    maxLength={30}
                    returnKeyType="done"
                    blurOnSubmit
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => setInputFocused(false)}
                    autoCorrect={false}
                  />
                  <Text style={[
                    styles.editInputCounter,
                    remainingChars <= 5 && styles.editInputCounterWarning,
                  ]}>
                    {remainingChars}
                  </Text>
                </View>
                {profileError && (
                  <Text style={styles.editError}>{profileError}</Text>
                )}
              </View>
            </View>
            
            {/* Actions */}
            <View style={styles.bottomSheetActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setShowEditProfile(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.cancelButtonText}>Annuler</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[
                  styles.saveButton,
                  (savingProfile || processingImage || !newDisplayName.trim()) && styles.saveButtonDisabled
                ]}
                onPress={handleSaveProfile}
                disabled={savingProfile || processingImage || !newDisplayName.trim()}
                activeOpacity={0.7}
              >
                {savingProfile ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.saveButtonText}>Enregistrer</Text>
                )}
              </TouchableOpacity>
            </View>
          </Animated.View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ========== ACTION SHEET - Options photo ========== */}
      <Modal
        visible={showPhotoOptions}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={() => setShowPhotoOptions(false)}
      >
        <View style={styles.modalContainer}>
          <Animated.View style={[styles.modalOverlay, { opacity: photoOptionsFade }]}>
            <Pressable 
              style={StyleSheet.absoluteFill} 
              onPress={() => setShowPhotoOptions(false)} 
            />
          </Animated.View>

          <Animated.View
            style={[
              styles.actionSheet,
              {
                transform: [{ translateY: photoOptionsSlide }],
                paddingBottom: Math.max(insets.bottom, 16),
              },
            ]}
          >
            <View style={styles.bottomSheetHandle} />
            
            <View style={styles.photoOptionsGrid}>
              <TouchableOpacity
                style={styles.photoOptionItem}
                onPress={handleTakePhoto}
                activeOpacity={0.7}
              >
                <View style={[styles.photoOptionIcon, { backgroundColor: theme.colors.primary + '20' }]}>
                  <Text style={styles.photoOptionEmoji}>📷</Text>
                </View>
                <Text style={styles.photoOptionLabel}>Caméra</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={styles.photoOptionItem}
                onPress={handlePickGallery}
                activeOpacity={0.7}
              >
                <View style={[styles.photoOptionIcon, { backgroundColor: '#BB8FCE20' }]}>
                  <Text style={styles.photoOptionEmoji}>🖼️</Text>
                </View>
                <Text style={styles.photoOptionLabel}>Galerie</Text>
              </TouchableOpacity>
              
              {(newAvatarUri || avatarUri) && newAvatarUri !== '' && (
                <TouchableOpacity
                  style={styles.photoOptionItem}
                  onPress={handleRemovePhoto}
                  activeOpacity={0.7}
                >
                  <View style={[styles.photoOptionIcon, { backgroundColor: theme.colors.danger + '20' }]}>
                    <Text style={styles.photoOptionEmoji}>🗑️</Text>
                  </View>
                  <Text style={[styles.photoOptionLabel, { color: theme.colors.danger }]}>Supprimer</Text>
                </TouchableOpacity>
              )}
            </View>
            
            <TouchableOpacity
              style={styles.actionSheetCancel}
              onPress={() => setShowPhotoOptions(false)}
              activeOpacity={0.7}
            >
              <Text style={styles.actionSheetCancelText}>Annuler</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>
      </Modal>

      {/* Modal de confirmation effacement */}
      <AlertModal
        visible={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title="Effacer toutes les données"
        message="Cette action supprimera définitivement toutes vos conversations et messages. Cette action est irréversible."
        icon={<Text style={{ fontSize: 48 }}>⚠️</Text>}
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
    padding: 12,
  },
  profileAvatarContainer: {
    position: 'relative',
    marginRight: 14,
  },
  profileAvatarBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: theme.colors.surface,
  },
  profileAvatarBadgeIcon: {
    fontSize: 10,
    color: '#FFFFFF',
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
    fontSize: 14,
    color: theme.colors.textSecondary,
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
    fontSize: 13,
    color: theme.colors.textMuted,
    textAlign: 'center',
  },
  
  // ============================================
  // MODAL & BOTTOM SHEET
  // ============================================
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  bottomSheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  bottomSheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: theme.colors.borderLight,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 6,
  },
  bottomSheetHeader: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  bottomSheetTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: theme.colors.text,
    textAlign: 'center',
  },
  
  // ============================================
  // EDIT PROFILE - Compact Layout
  // ============================================
  editProfileContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
    gap: 16,
  },
  editAvatarWrapper: {
    position: 'relative',
  },
  editAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
  },
  editAvatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  editAvatarLoading: {
    backgroundColor: theme.colors.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editAvatarInitials: {
    fontSize: 26,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  editAvatarBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: theme.colors.background,
  },
  editAvatarBadgeIcon: {
    fontSize: 12,
  },
  editInputSection: {
    flex: 1,
  },
  editInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.inputBackground,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: theme.colors.inputBorder,
    paddingHorizontal: 14,
  },
  editInputWrapperFocused: {
    borderColor: theme.colors.primary,
  },
  editInputWrapperError: {
    borderColor: theme.colors.danger,
  },
  editInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 16,
    color: theme.colors.text,
  },
  editInputCounter: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginLeft: 8,
  },
  editInputCounterWarning: {
    color: theme.colors.warning,
  },
  editError: {
    fontSize: 12,
    color: theme.colors.danger,
    marginTop: 6,
    marginLeft: 4,
  },
  
  // ============================================
  // BOTTOM SHEET ACTIONS
  // ============================================
  bottomSheetActions: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: 8,
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    height: 48,
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.colors.text,
  },
  saveButton: {
    flex: 1,
    height: 48,
    backgroundColor: theme.colors.primary,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  
  // ============================================
  // ACTION SHEET - Photo Options Grid
  // ============================================
  actionSheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  photoOptionsGrid: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingVertical: 20,
    paddingHorizontal: 16,
    gap: 24,
  },
  photoOptionItem: {
    alignItems: 'center',
    gap: 8,
  },
  photoOptionIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoOptionEmoji: {
    fontSize: 24,
  },
  photoOptionLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: theme.colors.text,
  },
  actionSheetCancel: {
    marginHorizontal: 16,
    marginBottom: 8,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
  },
  actionSheetCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.colors.textSecondary,
  },
});

export default SettingsScreen;