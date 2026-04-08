// src/screens/SetupProfileScreen.tsx
// Modern identity creation — full-screen layout, elements fill space when keyboard closed

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, KeyboardAvoidingView, Platform,
  Image, TouchableOpacity, Animated, Alert, ActivityIndicator, StatusBar,
  Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { suppressLock, releaseLock } from '../services/lockGuard';
import { setGlobalDisplayName, setGlobalAvatar } from '../services/storage';
import { sessionService } from '../services/tripleRatchet';
import { theme, Button } from '../components/ui';
import { AVATAR_COLORS } from '../services/crypto';
import { Ionicons } from '@expo/vector-icons';
import { SplashScreen } from './SplashScreen';

interface SetupProfileScreenProps { onComplete: () => void; }

const AVATAR_FULL = 120;
const AVATAR_SMALL = 72;

export function SetupProfileScreen({ onComplete }: SetupProfileScreenProps) {
  const insets = useSafeAreaInsets();
  const [displayName, setDisplayName] = useState('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [processingImage, setProcessingImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kbVisible, setKbVisible] = useState(false);

  const avatarSizeAnim = useRef(new Animated.Value(AVATAR_FULL)).current;
  const headerOpacity = useRef(new Animated.Value(1)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(contentOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

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
  const getAvatarColor = (name: string): string => {
    if (!name.trim()) return AVATAR_COLORS[0];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h) + name.charCodeAt(i);
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  };
  const processImage = async (uri: string): Promise<string> => {
    const compressed = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 120, height: 120 } }],
      { compress: 0.3, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    return `data:image/jpeg;base64,${compressed.base64}`;
  };

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
      avatarUri ? { text: 'Supprimer', onPress: () => setAvatarUri(null), style: 'destructive' } : null,
    ].filter(Boolean) as any);
  };

  const handleContinue = async () => {
    Keyboard.dismiss();
    const trimmed = displayName.trim();
    if (!trimmed) { setError('Veuillez entrer un pseudo'); return; }
    if (trimmed.length < 2) { setError('Minimum 2 caractères'); return; }
    setLoading(true); setError(null);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      await setGlobalDisplayName(trimmed);
      if (avatarUri) await setGlobalAvatar(avatarUri);
      await sessionService.updateMyProfileDirect({ displayName: trimmed, avatarBase64: avatarUri || undefined });
      onComplete();
    } catch (e) { console.error('[SetupProfile] Error:', e); setError('Erreur lors de la sauvegarde'); setLoading(false); }
  };

  const canContinue = displayName.trim().length > 0 && !loading && !processingImage;
  const remaining = 30 - displayName.length;

  // Full-screen loading states
  if (processingImage) return <SplashScreen statusMessage="Traitement de la photo…" />;
  if (loading) return <SplashScreen statusMessage="Création de votre profil…" />;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
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
                <Text style={styles.stepLabel}>VOTRE PROFIL</Text>
                <Text style={styles.title}>Créez votre identité</Text>
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
                borderColor: theme.colors.primary,
                backgroundColor: avatarUri ? 'transparent' : getAvatarColor(displayName),
              }}>
                {processingImage ? (
                  <ActivityIndicator size="large" color={theme.colors.primary} />
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
                <Text style={styles.avatarHint}>Appuyez pour ajouter une photo</Text>
              )}
            </Animated.View>
          </View>

          {/* Input + Button */}
          <View style={styles.formSection}>
            <View style={[styles.inputRow, error && styles.inputRowError]}>
              <TextInput
                style={styles.input}
                value={displayName}
                onChangeText={t => { setDisplayName(t); setError(null); }}
                placeholder="Votre pseudo"
                placeholderTextColor={theme.colors.placeholder}
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
              {!kbVisible && <Text style={styles.inputHint}>Ce pseudo sera visible par vos contacts</Text>}
            </Animated.View>

            <View style={styles.buttonWrap}>
              <Button title="Continuer" onPress={handleContinue} variant="primary" size="large" fullWidth loading={loading} disabled={!canContinue} />
            </View>
          </View>

          {/* Bottom spacer */}
          <View style={styles.bottomSpacer} />

        </Animated.View>

        {/* Footer */}
        {!kbVisible && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
            <Text style={styles.footerText}>Chiffrement de bout en bout</Text>
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
    fontSize: 12, fontWeight: '700', color: theme.colors.primary,
    letterSpacing: 1.5, marginBottom: 8,
  },
  title: {
    fontSize: 26, fontWeight: '700', color: theme.colors.text,
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
    backgroundColor: theme.colors.primary,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: theme.colors.background,
  },
  cameraBadgeSmall: {
    width: 26, height: 26, borderRadius: 13, bottom: 0, right: 0,
  },
  avatarHint: {
    fontSize: 13, color: theme.colors.textMuted, marginTop: 12,
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
    backgroundColor: theme.colors.surface,
    borderRadius: 14, borderWidth: 1.5, borderColor: theme.colors.border,
    paddingRight: 14,
  },
  inputRowError: {
    borderColor: theme.colors.danger,
  },
  input: {
    flex: 1, paddingHorizontal: 18,
    paddingVertical: Platform.OS === 'ios' ? 16 : 14,
    fontSize: 17, color: theme.colors.text,
  },
  counter: { fontSize: 12, color: theme.colors.textMuted, fontWeight: '500' },
  counterWarn: { color: theme.colors.warning },
  errorText: { fontSize: 13, color: theme.colors.danger, marginTop: 8, marginLeft: 4 },
  inputHint: { fontSize: 13, color: theme.colors.textMuted, marginTop: 8, marginLeft: 4 },
  buttonWrap: {
    marginTop: 24,
  },

  // Footer
  footer: {
    alignItems: 'center',
    paddingTop: 8,
  },
  footerText: {
    fontSize: 13, fontWeight: '500', color: theme.colors.primary, opacity: 0.6,
  },
});

export default SetupProfileScreen;