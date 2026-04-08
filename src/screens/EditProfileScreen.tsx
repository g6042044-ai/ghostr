// src/screens/EditProfileScreen.tsx
// Modern profile editor — full-screen layout, avatar + input centered, footer pinned bottom

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, TextInput,
  Alert, ActivityIndicator, Animated, Platform, KeyboardAvoidingView,
  Keyboard, Dimensions,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { suppressLock, releaseLock } from '../services/lockGuard';
import { Ionicons } from '@expo/vector-icons';
import {
  getGlobalDisplayName, setGlobalDisplayName,
  getGlobalAvatar, setGlobalAvatar,
} from '../services/storage';
import { sessionService } from '../services/tripleRatchet';
import { theme, Header } from '../components/ui';
import { AVATAR_COLORS } from '../services/crypto';
import { invalidateAvatarCacheForAllSessions } from '../services/api1to1';
import { SplashScreen } from './SplashScreen';

type NavigationProp = NativeStackNavigationProp<{ Settings: undefined; EditProfile: undefined }, 'EditProfile'>;

const AVATAR_FULL = 110;
const AVATAR_SMALL = 64;

export function EditProfileScreen() {
  const navigation = useNavigation<NavigationProp>();
  const insets = useSafeAreaInsets();

  const [displayName, setDisplayName] = useState('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [originalName, setOriginalName] = useState('');
  const [originalAvatar, setOriginalAvatar] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [processingImage, setProcessingImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [kbVisible, setKbVisible] = useState(false);

  const avatarSizeAnim = useRef(new Animated.Value(AVATAR_FULL)).current;
  const decorOpacity = useRef(new Animated.Value(1)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    loadProfile();
    Animated.timing(contentOpacity, { toValue: 1, duration: 350, useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(show, () => {
      setKbVisible(true);
      Animated.parallel([
        Animated.timing(avatarSizeAnim, { toValue: AVATAR_SMALL, duration: 250, useNativeDriver: false }),
        Animated.timing(decorOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    });
    const s2 = Keyboard.addListener(hide, () => {
      setKbVisible(false);
      Animated.parallel([
        Animated.timing(avatarSizeAnim, { toValue: AVATAR_FULL, duration: 250, useNativeDriver: false }),
        Animated.timing(decorOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    });
    return () => { s1.remove(); s2.remove(); };
  }, []);

  const loadProfile = async () => {
    const name = await getGlobalDisplayName();
    const avatar = await getGlobalAvatar();
    setDisplayName(name || '');
    setAvatarUri(avatar);
    setOriginalName(name || '');
    setOriginalAvatar(avatar);
  };

  // ─── Helpers ──
  const getAvatarColor = (name: string): string => {
    if (!name.trim()) return AVATAR_COLORS[0];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h) + name.charCodeAt(i);
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  };
  const getInitials = (name: string): string => {
    if (!name.trim()) return '?';
    const p = name.trim().split(/\s+/);
    if (p.length >= 2) return (p[0][0] + p[1][0]).toUpperCase();
    return name.trim().substring(0, 2).toUpperCase();
  };
  const processImage = async (uri: string): Promise<string> => {
    const compressed = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 120, height: 120 } }],
      { compress: 0.3, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    return `data:image/jpeg;base64,${compressed.base64}`;
  };

  const hasChanges = displayName.trim() !== originalName || avatarUri !== originalAvatar;
  const canSave = displayName.trim().length >= 2 && !saving && !processingImage && hasChanges;
  const remaining = 30 - displayName.length;

  // ─── Photo ──
  const handlePickGallery = async () => {
    suppressLock();
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission requise', "Autorisez l'accès à la galerie."); return; }
      setProcessingImage(true);
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.1,
      });
      if (!r.canceled && r.assets[0]) {
        setAvatarUri(await processImage(r.assets[0].uri));
      }
    } catch {
    } finally { setProcessingImage(false); releaseLock(); }
  };
  const handleTakePhoto = async () => {
    suppressLock();
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission requise', "Autorisez l'accès à la caméra."); return; }
      setProcessingImage(true);
      const r = await ImagePicker.launchCameraAsync({
        allowsEditing: true, aspect: [1, 1], quality: 0.1,
      });
      if (!r.canceled && r.assets[0]) {
        setAvatarUri(await processImage(r.assets[0].uri));
      }
    } catch {
    } finally { setProcessingImage(false); releaseLock(); }
  };
  const handleAvatarPress = () => {
    Keyboard.dismiss();
    Alert.alert('Photo de profil', undefined, [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Prendre une photo', onPress: handleTakePhoto },
      { text: 'Choisir dans la galerie', onPress: handlePickGallery },
      avatarUri && avatarUri !== '' ? { text: 'Supprimer', onPress: () => setAvatarUri(''), style: 'destructive' } : null,
    ].filter(Boolean) as any);
  };

  // ─── Save ──
  const handleSave = async () => {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed.length < 2) { setError('Minimum 2 caractères'); return; }
    Keyboard.dismiss();
    setSaving(true); setError(null);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      const finalAvatar = avatarUri === '' ? null : avatarUri;
      const writes: Promise<void>[] = [setGlobalDisplayName(trimmed)];
      if (avatarUri === '') writes.push(setGlobalAvatar(null));
      else if (avatarUri && avatarUri !== originalAvatar) writes.push(setGlobalAvatar(avatarUri));
      await Promise.all(writes);
      await sessionService.updateMyProfileDirect({ displayName: trimmed, avatarBase64: finalAvatar || undefined });
      const avatarChanged = (avatarUri === '' && originalAvatar) || (avatarUri && avatarUri !== originalAvatar);
      if (avatarChanged) invalidateAvatarCacheForAllSessions();
      navigation.goBack();
    } catch { setSaving(false); setError('Erreur lors de la sauvegarde'); }
  };

  // Full-screen loading states
  if (processingImage) return <SplashScreen statusMessage="Traitement de la photo…" />;
  if (saving) return <SplashScreen statusMessage="Mise à jour du profil…" />;

  return (
    <View style={styles.container}>
      <Header
        title="Modifier le profil"
        onBackPress={() => navigation.goBack()}
        rightComponent={
          <TouchableOpacity onPress={handleSave} disabled={!canSave} activeOpacity={0.7} style={styles.saveBtn}>
            {saving ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : (
              <Text style={[styles.saveBtnText, !canSave && styles.saveBtnTextDisabled]}>OK</Text>
            )}
          </TouchableOpacity>
        }
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Animated.View style={[styles.mainContent, { opacity: contentOpacity }]}>

          {/* Spacer — pushes content toward visual center */}
          <View style={styles.topSpacer} />

          {/* Avatar — shrinks when keyboard up */}
          <View style={styles.avatarSection}>
            <TouchableOpacity onPress={handleAvatarPress} activeOpacity={0.8} disabled={processingImage || saving}>
              <Animated.View style={{
                width: avatarSizeAnim,
                height: avatarSizeAnim,
                borderRadius: AVATAR_FULL / 2,
                overflow: 'hidden',
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 3,
                borderColor: theme.colors.primary,
                backgroundColor: (avatarUri && avatarUri !== '') ? 'transparent' : getAvatarColor(displayName),
              }}>
                {processingImage ? (
                  <ActivityIndicator size="large" color={theme.colors.primary} />
                ) : avatarUri && avatarUri !== '' ? (
                  <Image source={{ uri: avatarUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                ) : (
                  <Text style={[styles.avatarInitials, kbVisible && styles.avatarInitialsSmall]}>
                    {getInitials(displayName)}
                  </Text>
                )}
              </Animated.View>
              <View style={[styles.cameraBadge, kbVisible && styles.cameraBadgeSmall]}>
                <Ionicons name="camera" size={kbVisible ? 12 : 16} color="#FFFFFF" />
              </View>
            </TouchableOpacity>
            <Animated.View style={{ opacity: decorOpacity }}>
              {!kbVisible && <Text style={styles.avatarHint}>Modifier la photo</Text>}
            </Animated.View>
          </View>

          {/* Input */}
          <View style={styles.formSection}>
            <View style={[
              styles.inputCard,
              inputFocused && styles.inputCardFocused,
              error && styles.inputCardError,
            ]}>
              <Ionicons
                name="person-outline"
                size={20}
                color={inputFocused ? theme.colors.primary : theme.colors.textMuted}
                style={styles.inputIcon}
              />
              <TextInput
                style={styles.input}
                value={displayName}
                onChangeText={(t) => { setDisplayName(t); setError(null); }}
                placeholder="Votre pseudo"
                placeholderTextColor={theme.colors.placeholder}
                maxLength={30}
                returnKeyType="done"
                blurOnSubmit
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                autoCorrect={false}
              />
              <Text style={[styles.inputCounter, remaining <= 5 && styles.inputCounterWarn]}>
                {remaining}
              </Text>
            </View>
            {error && <Text style={styles.inputError}>{error}</Text>}
            <Animated.View style={{ opacity: decorOpacity }}>
              {!kbVisible && <Text style={styles.inputHint}>Visible par vos contacts</Text>}
            </Animated.View>
          </View>

          {/* Bottom spacer — takes remaining space, pushes content up */}
          <View style={styles.bottomSpacer} />

        </Animated.View>

        {/* Footer — pinned to bottom */}
        {!kbVisible && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.footerText}>Profil chiffré, invisible pour le serveur</Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  mainContent: {
    flex: 1,
    paddingHorizontal: 32,
  },

  // Spacing — golden ratio distribution
  topSpacer: { flex: 3 },
  bottomSpacer: { flex: 4 },

  // Save
  saveBtn: { paddingHorizontal: 8, paddingVertical: 8 },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: theme.colors.primary },
  saveBtnTextDisabled: { color: theme.colors.textMuted, opacity: 0.4 },

  // Avatar
  avatarSection: { alignItems: 'center', marginBottom: 28 },
  cameraBadge: {
    position: 'absolute', bottom: 2, right: 2,
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: theme.colors.primary,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: theme.colors.background,
  },
  cameraBadgeSmall: {
    width: 24, height: 24, borderRadius: 12, bottom: 0, right: 0,
  },
  avatarHint: { fontSize: 14, fontWeight: '500', color: theme.colors.primary, marginTop: 12 },
  avatarInitials: { fontSize: 38, fontWeight: '600', color: '#FFF', letterSpacing: 1 },
  avatarInitialsSmall: { fontSize: 22 },

  // Form
  formSection: {},
  inputCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 14, borderWidth: 1.5, borderColor: theme.colors.border,
    paddingHorizontal: 14,
  },
  inputCardFocused: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary + '06' },
  inputCardError: { borderColor: theme.colors.danger },
  inputIcon: { marginRight: 10 },
  input: {
    flex: 1, paddingVertical: Platform.OS === 'ios' ? 16 : 14,
    fontSize: 17, color: theme.colors.text,
  },
  inputCounter: { fontSize: 13, color: theme.colors.textMuted, fontWeight: '600', marginLeft: 8 },
  inputCounterWarn: { color: theme.colors.warning },
  inputError: { fontSize: 13, color: theme.colors.danger, marginTop: 8, marginLeft: 4 },
  inputHint: { fontSize: 13, color: theme.colors.textMuted, marginTop: 8, marginLeft: 4 },

  // Footer
  footer: { alignItems: 'center', paddingTop: 8 },
  footerText: { fontSize: 13, fontWeight: '500', color: theme.colors.primary, opacity: 0.6 },
});

export default EditProfileScreen;