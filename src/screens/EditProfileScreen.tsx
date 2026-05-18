// src/screens/EditProfileScreen.tsx
// Modern profile editor — full-screen layout, avatar + input centered, footer pinned bottom

import { useState, useRef, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, TextInput, Alert, ActivityIndicator, Animated, Platform, KeyboardAvoidingView, Keyboard } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import { suppressLock, releaseLock } from '../services/lockGuard';
import { ensureCameraPermission, ensureMediaLibraryPermission } from '../services/permissions';
import { Ionicons } from '@expo/vector-icons';
import { setGlobalDisplayName, setGlobalAvatar } from '../services/storage';
import { sessionService } from '../services/tripleRatchet';
import { Header, useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import { ImageCropper } from '../components/ImageCropper';
import { AVATAR_COLORS } from '../services/crypto';
import { invalidateAvatarCacheForAllSessions } from '../services/api1to1';
import { SplashScreen } from './SplashScreen';

type NavigationProp = NativeStackNavigationProp<{ Settings: undefined; EditProfile: undefined }, 'EditProfile'>;

const AVATAR_FULL = 110;
const AVATAR_SMALL = 64;

export function EditProfileScreen() {
  const navigation = useNavigation<NavigationProp>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  // ──────────────────────────────────────────────────────────────────────────
  // PROFIL — INIT SYNCHRONE DEPUIS LA RAM DE sessionService
  // ──────────────────────────────────────────────────────────────────────────
  // Avant : useState('') + loadProfile() async (await getGlobalDisplayName +
  //   await getGlobalAvatar — chaque getGlobalAvatar lit AsyncStorage et
  //   décrypte un base64 de ~50-150 KB). L'utilisateur voyait le champ vide
  //   se remplir 100-300 ms après l'ouverture, particulièrement visible sur
  //   cet écran focalisé sur le profil.
  //
  // Après : useMemo() pour snapshot synchrone au mount, puis useState init
  //   immédiat. sessionService.getMyProfile() lit la RAM (donnée chargée par
  //   sessionService.initialize() au boot, awaité avant que l'UI principale
  //   ne soit interactive).
  //
  // SÉCURITÉ : strictement équivalent. La RAM de sessionService est peuplée
  //   par loadProfile() qui appelle decryptIfNeeded sur les mêmes blobs que
  //   getGlobalDisplayName/getGlobalAvatar lisaient. On évite juste un
  //   round-trip AsyncStorage + AEAD redondant à chaque ouverture de l'écran.
  //
  // CAS LIMITE : si sessionService n'est pas initialisé (Edit accessible
  //   uniquement depuis Settings → impossible en pratique car App.tsx force
  //   l'init avant le rendu de tout écran qui n'est ni Welcome ni
  //   SetupProfile), getMyProfile() retourne { displayName: 'Anonymous' } —
  //   on traite comme vide dans le mapping initial.
  // ──────────────────────────────────────────────────────────────────────────
  const initialProfile = useMemo(() => {
    const p = sessionService.getMyProfile();
    return {
      displayName: p.displayName === 'Anonymous' ? '' : p.displayName,
      avatarUri: p.avatarBase64 ?? null,
    };
  }, []);

  const [displayName, setDisplayName] = useState(initialProfile.displayName);
  const [avatarUri, setAvatarUri] = useState<string | null>(initialProfile.avatarUri);
  const [originalName] = useState(initialProfile.displayName);
  const [originalAvatar] = useState<string | null>(initialProfile.avatarUri);
  const [saving, setSaving] = useState(false);
  const [processingImage, setProcessingImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [kbVisible, setKbVisible] = useState(false);

  // ─── In-app cropper state ──────────────────────────────────────────────────
  // Replaces ImagePicker's `allowsEditing: true` OS editor (poor contrast on
  // dark images, especially on Android OEM skins). When non-null, the cropper
  // modal is mounted with sourceUri and intercepts UI until confirm/cancel.
  const [cropperSource, setCropperSource] = useState<string | null>(null);
  const [cropperVisible, setCropperVisible] = useState(false);

  const avatarSizeAnim = useRef(new Animated.Value(AVATAR_FULL)).current;
  const decorOpacity = useRef(new Animated.Value(1)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Profil déjà initialisé synchronement via useMemo+useState ci-dessus.
    // On lance juste l'animation d'entrée — plus de loadProfile() à attendre.
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

  // (loadProfile supprimé — l'init synchrone via useMemo+useState au mount
  // remplit déjà displayName/avatarUri/originalName/originalAvatar depuis la
  // RAM de sessionService. Cf. bloc commentaire au-dessus du useMemo.)

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
  // processImage() has been removed: the in-app ImageCropper now handles the
  // resize → JPEG-compress → base64 pipeline as part of confirm(), so the
  // value passed to setAvatarUri is already a ready-to-store data: URI.

  const hasChanges = displayName.trim() !== originalName || avatarUri !== originalAvatar;
  const canSave = displayName.trim().length >= 2 && !saving && !processingImage && hasChanges;
  const remaining = 30 - displayName.length;

  // ─── Photo ──
  // After picking, we open our in-app ImageCropper (which has the contrast
  // controls + rotate/flip our code controls). `allowsEditing: false` skips
  // the OS native editor that produced the readability issue.
  // We request `quality: 1` so the cropper sees a clean image; final
  // compression happens in the cropper's confirm step (matches the previous
  // 120×120 @ 0.3 JPEG pipeline byte-for-byte).
  const handlePickGallery = async () => {
    // PERM FIX : le service gère suppressLock/releaseLock + Alert + Settings.
    const perm = await ensureMediaLibraryPermission();
    if (perm.status !== 'granted') return;

    suppressLock();
    try {
      setProcessingImage(true);
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"], allowsEditing: false, quality: 1,
      });
      if (!r.canceled && r.assets[0]) {
        // Hand off to in-app cropper. State updates batch into one render so
        // the cropper modal opens in the same frame that processingImage
        // clears — no visible gap.
        setCropperSource(r.assets[0].uri);
        setCropperVisible(true);
      }
    } catch {
    } finally { setProcessingImage(false); releaseLock(); }
  };
  const handleTakePhoto = async () => {
    // PERM FIX : voir handlePickGallery.
    const perm = await ensureCameraPermission();
    if (perm.status !== 'granted') return;

    suppressLock();
    try {
      setProcessingImage(true);
      const r = await ImagePicker.launchCameraAsync({
        allowsEditing: false, quality: 1,
      });
      if (!r.canceled && r.assets[0]) {
        setCropperSource(r.assets[0].uri);
        setCropperVisible(true);
      }
    } catch {
    } finally { setProcessingImage(false); releaseLock(); }
  };
  const handleCropConfirm = (dataUri: string) => {
    // dataUri is a fully-processed `data:image/jpeg;base64,…` ready to store.
    setCropperVisible(false);
    setCropperSource(null);
    setAvatarUri(dataUri);
  };
  const handleCropCancel = () => {
    setCropperVisible(false);
    setCropperSource(null);
    // Avatar state unchanged — same UX as cancelling the OS editor before.
  };
  const handleAvatarPress = () => {
    Keyboard.dismiss();
    Alert.alert(t('editProfile.photoOptions'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('setupProfile.takePhoto'), onPress: handleTakePhoto },
      { text: t('setupProfile.chooseGallery'), onPress: handlePickGallery },
      avatarUri && avatarUri !== '' ? { text: t('common.delete'), onPress: () => setAvatarUri(''), style: 'destructive' } : null,
    ].filter(Boolean) as any);
  };

  // ─── Save ──
  const handleSave = async () => {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed.length < 2) { setError(t('editProfile.errorMinChars')); return; }
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
    } catch { setSaving(false); setError(t('editProfile.errorSaveFailed')); }
  };

  // Full-screen loading states
  if (processingImage) return <SplashScreen statusMessage={t('editProfile.processingPhoto')} />;
  if (saving) return <SplashScreen statusMessage={t('editProfile.updatingProfile')} />;

  return (
    <View style={styles.container}>
      <Header
        title={t('editProfile.title')}
        onBackPress={() => navigation.goBack()}
        rightComponent={
          <TouchableOpacity onPress={handleSave} disabled={!canSave} activeOpacity={0.7} style={styles.saveBtn}>
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.saveBtnText, !canSave && styles.saveBtnTextDisabled]} numberOfLines={1}>{t('common.save')}</Text>
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
                borderColor: colors.primary,
                backgroundColor: (avatarUri && avatarUri !== '') ? 'transparent' : getAvatarColor(displayName),
              }}>
                {processingImage ? (
                  <ActivityIndicator size="large" color={colors.primary} />
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
              {!kbVisible && <Text style={styles.avatarHint}>{t('editProfile.editPhoto')}</Text>}
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
                color={inputFocused ? colors.primary : colors.textMuted}
                style={styles.inputIcon}
              />
              <TextInput
                style={styles.input}
                value={displayName}
                onChangeText={(txt) => { setDisplayName(txt); setError(null); }}
                placeholder={t('setupProfile.namePlaceholder')}
                placeholderTextColor={colors.placeholder}
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
              {!kbVisible && <Text style={styles.inputHint}>{t('editProfile.visibleHint')}</Text>}
            </Animated.View>
          </View>

          {/* Bottom spacer — takes remaining space, pushes content up */}
          <View style={styles.bottomSpacer} />

        </Animated.View>

        {/* Footer — pinned to bottom */}
        {!kbVisible && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.footerText}>{t('editProfile.serverInvisibleFooter')}</Text>
          </View>
        )}
      </KeyboardAvoidingView>

      {/* ─── In-app cropper ─── replaces the OS native image editor.
          Mounted as a sibling so it overlays the entire screen when
          visible. When sourceUri is null and visible is false, it returns
          early and renders nothing. */}
      <ImageCropper
        visible={cropperVisible}
        sourceUri={cropperSource}
        onConfirm={handleCropConfirm}
        onCancel={handleCropCancel}
      />
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: { flex: 1, backgroundColor: colors.background },
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
  saveBtnText: { fontSize: 16, fontWeight: '700', color: colors.primary },
  saveBtnTextDisabled: { color: colors.textMuted, opacity: 0.4 },

  // Avatar
  avatarSection: { alignItems: 'center', marginBottom: 28 },
  cameraBadge: {
    position: 'absolute', bottom: 2, right: 2,
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: colors.background,
  },
  cameraBadgeSmall: {
    width: 24, height: 24, borderRadius: 12, bottom: 0, right: 0,
  },
  avatarHint: { fontSize: 14, fontWeight: '500', color: colors.primary, marginTop: 12 },
  avatarInitials: { fontSize: 38, fontWeight: '600', color: '#FFF', letterSpacing: 1 },
  avatarInitialsSmall: { fontSize: 22 },

  // Form
  formSection: {},
  inputCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 14, borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 14,
  },
  inputCardFocused: { borderColor: colors.primary, backgroundColor: colors.primary + '06' },
  inputCardError: { borderColor: colors.danger },
  inputIcon: { marginRight: 10 },
  input: {
    flex: 1, paddingVertical: Platform.OS === 'ios' ? 16 : 14,
    fontSize: 17, color: colors.text,
  },
  inputCounter: { fontSize: 13, color: colors.textMuted, fontWeight: '600', marginLeft: 8 },
  inputCounterWarn: { color: colors.warning },
  inputError: { fontSize: 13, color: colors.danger, marginTop: 8, marginLeft: 4 },
  inputHint: { fontSize: 13, color: colors.textMuted, marginTop: 8, marginLeft: 4 },

  // Footer
  footer: { alignItems: 'center', paddingTop: 8 },
  footerText: { fontSize: 13, fontWeight: '500', color: colors.primary, opacity: 0.6 },
}) as const;

export default EditProfileScreen;