// src/screens/SetupProfileScreen.tsx
// Modern identity creation — full-screen layout, elements fill space when keyboard closed

import { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, KeyboardAvoidingView, Platform, Image, TouchableOpacity, Animated, ActivityIndicator, StatusBar, Keyboard, BackHandler } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import { suppressLock, releaseLock } from '../services/lockGuard';
import { ensureCameraPermission, ensureMediaLibraryPermission } from '../services/permissions';
import { setGlobalDisplayName, setGlobalAvatar } from '../services/storage';
import { sessionService } from '../services/tripleRatchet';
import { Button, useTheme, useThemedStyles, getAvatarColor, type ColorPalette, showActionSheet } from '../components/ui';
import { ImageCropper } from '../components/ImageCropper';
import { Ionicons } from '@expo/vector-icons';
import { SplashScreen } from './SplashScreen';

interface SetupProfileScreenProps {
  onComplete: () => void;
  /**
   * Callback optionnel pour revenir au WelcomeScreen.
   * Quand fourni, un bouton retour discret apparaît en haut à gauche.
   * Non fourni → pas de bouton retour (ex: si l'utilisateur a déjà créé
   * un compte et arrive ici via une autre route).
   *
   * UX : on autorise le retour sur l'écran d'initialisation pour permettre
   * à l'utilisateur de relire le carrousel d'onboarding s'il a cliqué trop
   * vite. Aucune donnée n'est encore persistée à ce stade — pas de risque
   * de perte. Le retour matériel Android est aussi câblé sur ce callback.
   */
  onBack?: () => void;
}

const AVATAR_FULL = 120;
const AVATAR_SMALL = 72;

export function SetupProfileScreen({ onComplete, onBack }: SetupProfileScreenProps) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [processingImage, setProcessingImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kbVisible, setKbVisible] = useState(false);

  // ─── In-app cropper state ──────────────────────────────────────────────────
  // Replaces ImagePicker's `allowsEditing: true` OS editor (poor contrast on
  // dark images, especially on Android OEM skins). When non-null, the cropper
  // modal is mounted with sourceUri and intercepts UI until confirm/cancel.
  const [cropperSource, setCropperSource] = useState<string | null>(null);
  const [cropperVisible, setCropperVisible] = useState(false);

  const avatarSizeAnim = useRef(new Animated.Value(AVATAR_FULL)).current;
  const headerOpacity = useRef(new Animated.Value(1)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(contentOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // RETOUR MATÉRIEL ANDROID
  // ════════════════════════════════════════════════════════════════════════
  // Si onBack est fourni → on l'invoque (retour vers WelcomeScreen).
  // Sinon → on bloque (true) pour empêcher la sortie accidentelle de l'app
  // au milieu de l'init du profil.
  // Pendant un loading/processingImage critique, on bloque toujours.
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (loading || processingImage) return true;  // bloqué pendant les ops cryptos
      if (onBack) { onBack(); return true; }
      return true;  // pas de onBack → on bloque la sortie de l'app
    });
    return () => sub.remove();
  }, [loading, processingImage, onBack]);

  // Keyboard listeners — shrink avatar, hide decorative text
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(show, () => {
      setKbVisible(true);
      Animated.parallel([
        Animated.timing(avatarSizeAnim, { toValue: AVATAR_SMALL, duration: 250, useNativeDriver: false }),
        Animated.timing(headerOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    });
    const s2 = Keyboard.addListener(hide, () => {
      setKbVisible(false);
      Animated.parallel([
        Animated.timing(avatarSizeAnim, { toValue: AVATAR_FULL, duration: 250, useNativeDriver: false }),
        Animated.timing(headerOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    });
    return () => { s1.remove(); s2.remove(); };
  }, []);

  // ─── Helpers ──
  const getInitials = (name: string): string => {
    if (!name.trim()) return '?';
    const p = name.trim().split(/\s+/);
    if (p.length >= 2) return (p[0][0] + p[1][0]).toUpperCase();
    return name.trim().substring(0, 2).toUpperCase();
  };
  // `getAvatarColor` local supprimé : il réimplémentait le hash du design
  // system sur une palette différente, si bien que l'aperçu du profil ne
  // montrait PAS la couleur que les autres verront. La fonction partagée est
  // importée depuis `components/ui`.
  // processImage() has been removed: the in-app ImageCropper now handles the
  // resize → JPEG-compress → base64 pipeline as part of confirm(), so the
  // value passed to setAvatarUri is already a ready-to-store data: URI.

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
    // ActionSheet du design system plutôt qu'un `Alert.alert` à quatre
    // boutons. Un choix parmi N est exactement ce qu'une feuille d'actions
    // sait faire : les options y sont empilées, avec icône et sous-titre
    // possibles. Un Alert natif à quatre boutons les empile aussi, mais sans
    // icône, avec un ordre différent sur iOS et Android, et dans le style de
    // l'OS — soit la première impression que le nouvel utilisateur a de
    // l'app, en dehors de sa propre identité visuelle.
    void showActionSheet({
      title: t('setupProfile.photoOptions'),
      items: [
        {
          title: t('setupProfile.takePhoto'),
          icon: <Ionicons name="camera-outline" size={24} color={colors.primary} />,
          onPress: handleTakePhoto,
        },
        {
          title: t('setupProfile.chooseGallery'),
          icon: <Ionicons name="images-outline" size={24} color={colors.primary} />,
          onPress: handlePickGallery,
        },
        // L'option de suppression n'apparaît que s'il y a une photo à
        // supprimer — proposer « Retirer la photo » quand il n'y en a pas
        // est une impasse.
        ...(avatarUri
          ? [{
              title: t('setupProfile.removePhoto'),
              icon: <Ionicons name="trash-outline" size={24} color={colors.danger} />,
              onPress: () => setAvatarUri(null),
              destructive: true,
            }]
          : []),
      ],
    });
  };

  const handleContinue = async () => {
    Keyboard.dismiss();
    const trimmed = displayName.trim();
    if (!trimmed) { setError(t('setupProfile.errorEnterName')); return; }
    if (trimmed.length < 2) { setError(t('setupProfile.errorMinChars')); return; }
    setLoading(true); setError(null);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      await setGlobalDisplayName(trimmed);
      if (avatarUri) await setGlobalAvatar(avatarUri);
      await sessionService.updateMyProfileDirect({ displayName: trimmed, avatarBase64: avatarUri || undefined });
      onComplete();
    } catch (e) { console.error('[SetupProfile] Error:', e); setError(t('setupProfile.errorSaveFailed')); setLoading(false); }
  };

  const canContinue = displayName.trim().length > 0 && !loading && !processingImage;
  const remaining = 30 - displayName.length;

  // Full-screen loading states
  if (processingImage) return <SplashScreen statusMessage={t('setupProfile.processingPhoto')} />;
  if (loading) return <SplashScreen statusMessage={t('setupProfile.creatingProfile')} />;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Idem WelcomeScreen : la barre d'état doit suivre le thème, l'écran
          étant peint avec `colors.background`. */}
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor="transparent"
        translucent
      />

      {/* ═══════════════════════════════════════════════════════════════════
          BOUTON RETOUR — uniquement si onBack est fourni ET clavier fermé
          ═══════════════════════════════════════════════════════════════════
          Discret, en haut à gauche. Désactivé pendant loading/processing
          pour éviter un retour pendant la création du profil (qui sauvegarde
          en chiffré + register KT). hitSlop élargi pour le confort tactile.
          Masqué quand le clavier est ouvert pour ne pas entrer en conflit
          visuel avec l'avatar réduit. */}
      {onBack && !kbVisible && (
        <TouchableOpacity
          style={[styles.backButton, { top: insets.top + 8 }]}
          onPress={() => {
            if (loading || processingImage) return;
            Keyboard.dismiss();
            onBack();
          }}
          disabled={loading || processingImage}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityLabel={t('common.back')}
          accessibilityRole="button"
        >
          <Ionicons
            name="chevron-back"
            size={26}
            color={(loading || processingImage) ? colors.textMuted : colors.text}
          />
        </TouchableOpacity>
      )}

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Animated.View style={[styles.mainContent, { opacity: contentOpacity }]}>

          {/* Top spacer */}
          <View style={styles.topSpacer} />

          {/* Header — hidden when keyboard is up */}
          <Animated.View style={[styles.header, { opacity: headerOpacity }]}>
            {!kbVisible && (
              <>
                <Text style={styles.stepLabel}>{t('setupProfile.stepLabel')}</Text>
                <Text style={styles.title}>{t('setupProfile.title')}</Text>
              </>
            )}
          </Animated.View>

          {/* Avatar — shrinks when keyboard is up */}
          <View style={styles.avatarSection}>
            <TouchableOpacity
              onPress={handleAvatarPress}
              activeOpacity={0.8}
              disabled={processingImage}
            >
              <Animated.View style={{
                width: avatarSizeAnim,
                height: avatarSizeAnim,
                borderRadius: AVATAR_FULL / 2,
                overflow: 'hidden',
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 3,
                borderColor: colors.primary,
                backgroundColor: avatarUri ? 'transparent' : getAvatarColor(displayName),
              }}>
                {processingImage ? (
                  <ActivityIndicator size="large" color={colors.primary} />
                ) : avatarUri ? (
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
            <Animated.View style={{ opacity: headerOpacity }}>
              {!kbVisible && (
                <Text style={styles.avatarHint}>{t('setupProfile.tapToAddPhoto')}</Text>
              )}
            </Animated.View>
          </View>

          {/* Input + Button */}
          <View style={styles.formSection}>
            <View style={[styles.inputRow, error && styles.inputRowError]}>
              <TextInput
                style={styles.input}
                value={displayName}
                onChangeText={(txt) => { setDisplayName(txt); setError(null); }}
                placeholder={t('setupProfile.namePlaceholder')}
                placeholderTextColor={colors.placeholder}
                maxLength={30}
                returnKeyType="done"
                blurOnSubmit
                autoCorrect={false}
                autoCapitalize="words"
              />
              <Text style={[styles.counter, remaining <= 5 && styles.counterWarn]}>{remaining}</Text>
            </View>
            {error && <Text style={styles.errorText}>{error}</Text>}
            <Animated.View style={{ opacity: headerOpacity }}>
              {!kbVisible && <Text style={styles.inputHint}>{t('setupProfile.nameVisibleHint')}</Text>}
            </Animated.View>

            <View style={styles.buttonWrap}>
              <Button title={t('setupProfile.continue')} onPress={handleContinue} variant="primary" size="large" fullWidth loading={loading} disabled={!canContinue} />
            </View>
          </View>

          {/* Bottom spacer */}
          <View style={styles.bottomSpacer} />

        </Animated.View>

        {/* Footer */}
        {!kbVisible && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
            <Text style={styles.footerText}>{t('setupProfile.endToEndFooter')}</Text>
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

  // Bouton retour — positionnement absolu pour ne pas perturber le flex layout
  // existant (topSpacer flex: 2, bottomSpacer flex: 3). z-index élevé pour
  // rester au-dessus de l'avatar et du formulaire en cas de chevauchement
  // sur petit écran.
  backButton: {
    position: 'absolute',
    left: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    elevation: 3,
  },

  mainContent: {
    flex: 1,
    paddingHorizontal: 32,
  },

  // Spacing — fills the screen naturally
  topSpacer: { flex: 2 },
  bottomSpacer: { flex: 3 },

  // Header
  header: {
    alignItems: 'center',
    marginBottom: 12,
    minHeight: 60,
    justifyContent: 'flex-end',
  },
  stepLabel: {
    fontSize: 12, fontWeight: '700', color: colors.primary,
    letterSpacing: 1.5, marginBottom: 8,
  },
  title: {
    fontSize: 26, fontWeight: '700', color: colors.text,
    textAlign: 'center', letterSpacing: -0.5,
  },

  // Avatar
  avatarSection: {
    alignItems: 'center',
    marginVertical: 20,
  },
  cameraBadge: {
    position: 'absolute', bottom: 2, right: 2,
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: colors.background,
  },
  cameraBadgeSmall: {
    width: 26, height: 26, borderRadius: 13, bottom: 0, right: 0,
  },
  avatarHint: {
    fontSize: 13, color: colors.textMuted, marginTop: 12,
  },
  avatarInitials: {
    fontSize: 42, fontWeight: '600', color: '#FFF', letterSpacing: 1,
  },
  avatarInitialsSmall: {
    fontSize: 24,
  },

  // Form
  formSection: {
    marginTop: 4,
  },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 14, borderWidth: 1.5, borderColor: colors.border,
    paddingRight: 14,
  },
  inputRowError: {
    borderColor: colors.danger,
  },
  input: {
    flex: 1, paddingHorizontal: 18,
    paddingVertical: Platform.OS === 'ios' ? 16 : 14,
    fontSize: 17, color: colors.text,
  },
  counter: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  counterWarn: { color: colors.warning },
  errorText: { fontSize: 13, color: colors.danger, marginTop: 8, marginLeft: 4 },
  inputHint: { fontSize: 13, color: colors.textMuted, marginTop: 8, marginLeft: 4 },
  buttonWrap: {
    marginTop: 24,
  },

  // Footer
  footer: {
    alignItems: 'center',
    paddingTop: 8,
  },
  footerText: {
    fontSize: 13, fontWeight: '500', color: colors.primary, opacity: 0.6,
  },
}) as const;

export default SetupProfileScreen;