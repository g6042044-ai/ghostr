// src/screens/SetupProfileScreen.tsx
// v6.0 - Keyboard-aware, responsive, modern messaging UX

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, KeyboardAvoidingView, Platform,
  ScrollView, Image, TouchableOpacity, Animated, Alert,
  ActivityIndicator, StatusBar, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { setGlobalDisplayName, setGlobalAvatar } from '../services/storage';
import { sessionService } from '../services/tripleRatchet';
import { theme, Button } from '../components/ui';
import { AVATAR_COLORS } from '../services/crypto';

interface SetupProfileScreenProps { onComplete: () => void; }
const AVATAR_SIZE = 110;

export function SetupProfileScreen({ onComplete }: SetupProfileScreenProps) {
  const insets = useSafeAreaInsets();
  const [displayName, setDisplayName] = useState('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [processingImage, setProcessingImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  
  const avatarScale = useRef(new Animated.Value(1)).current;
  const avatarFloat = useRef(new Animated.Value(0)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView>(null);
  
  useEffect(() => {
    Animated.timing(contentOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    const floatLoop = Animated.loop(Animated.sequence([
      Animated.timing(avatarFloat, { toValue: -6, duration: 2000, useNativeDriver: true }),
      Animated.timing(avatarFloat, { toValue: 0, duration: 2000, useNativeDriver: true }),
    ]));
    floatLoop.start();
    return () => floatLoop.stop();
  }, []);

  useEffect(() => {
    const evShow = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const evHide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(evShow, () => {
      setIsKeyboardVisible(true);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
    });
    const s2 = Keyboard.addListener(evHide, () => setIsKeyboardVisible(false));
    return () => { s1.remove(); s2.remove(); };
  }, []);
  
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
    const m = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 160, height: 160 } }], { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    return `data:image/jpeg;base64,${m.base64}`;
  };
  
  const handlePickGallery = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission requise', 'Autorisez l\'accès à la galerie.'); return; }
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.8 });
      if (!r.canceled && r.assets[0]) { setProcessingImage(true); setAvatarUri(await processImage(r.assets[0].uri)); setProcessingImage(false); }
    } catch { setProcessingImage(false); Alert.alert('Erreur', 'Impossible de charger l\'image.'); }
  };
  const handleTakePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission requise', 'Autorisez l\'accès à la caméra.'); return; }
      const r = await ImagePicker.launchCameraAsync({ allowsEditing: true, aspect: [1, 1], quality: 0.8 });
      if (!r.canceled && r.assets[0]) { setProcessingImage(true); setAvatarUri(await processImage(r.assets[0].uri)); setProcessingImage(false); }
    } catch { setProcessingImage(false); Alert.alert('Erreur', 'Impossible de prendre la photo.'); }
  };
  const handleAvatarPress = () => {
    Keyboard.dismiss();
    Alert.alert('Photo de profil', 'Comment souhaitez-vous ajouter votre photo ?', [
      { text: 'Annuler', style: 'cancel' },
      { text: '📷 Prendre une photo', onPress: handleTakePhoto },
      { text: '🖼️ Choisir dans la galerie', onPress: handlePickGallery },
      avatarUri ? { text: '🗑️ Supprimer', onPress: () => setAvatarUri(null), style: 'destructive' } : null,
    ].filter(Boolean) as any);
  };
  
  const handleContinue = async () => {
    Keyboard.dismiss();
    const trimmed = displayName.trim();
    if (!trimmed) { setError('Veuillez entrer un pseudo'); return; }
    if (trimmed.length < 2) { setError('Le pseudo doit contenir au moins 2 caractères'); return; }
    setLoading(true); setError(null);
    try {
      await setGlobalDisplayName(trimmed);
      if (avatarUri) await setGlobalAvatar(avatarUri);
      await sessionService.updateMyProfileDirect({
        displayName: trimmed,
        avatarBase64: avatarUri || undefined,
      });
      onComplete();
    } catch (e) { console.error('[SetupProfile] Error:', e); setError('Erreur lors de la sauvegarde'); setLoading(false); }
  };
  
  const canContinue = displayName.trim().length > 0 && !loading && !processingImage;
  const remaining = 30 - displayName.length;
  
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
        <ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} bounces={false}>
          <Animated.View style={{ opacity: contentOpacity }}>
            <View style={styles.header}>
              <Text style={styles.stepLabel}>VOTRE PROFIL</Text>
              <Text style={styles.title}>Créez votre identité</Text>
              <Text style={styles.subtitle}>Choisissez un pseudo et une photo{'\n'}pour vous identifier auprès de vos contacts</Text>
            </View>
            
            <View style={[styles.avatarSection, isKeyboardVisible && { marginBottom: 16 }]}>
              <TouchableOpacity onPress={handleAvatarPress} onPressIn={() => Animated.spring(avatarScale, { toValue: 0.93, useNativeDriver: true }).start()} onPressOut={() => Animated.spring(avatarScale, { toValue: 1, useNativeDriver: true }).start()} activeOpacity={0.9} disabled={processingImage}>
                <Animated.View style={[styles.avatarOuter, { transform: [{ scale: avatarScale }, { translateY: isKeyboardVisible ? 0 : avatarFloat }] }]}>
                  {processingImage ? (
                    <View style={[styles.avatar, styles.avatarLoading]}><ActivityIndicator size="large" color={theme.colors.primary} /></View>
                  ) : avatarUri ? (
                    <Image source={{ uri: avatarUri }} style={styles.avatar} />
                  ) : (
                    <View style={[styles.avatar, styles.avatarPlaceholder, { backgroundColor: getAvatarColor(displayName) }]}><Text style={styles.avatarInitials}>{getInitials(displayName)}</Text></View>
                  )}
                  <View style={styles.cameraBadge}><Text style={{ fontSize: 16 }}>📷</Text></View>
                </Animated.View>
              </TouchableOpacity>
              {!isKeyboardVisible && <Text style={styles.avatarHint}>Appuyez pour ajouter une photo</Text>}
            </View>
            
            <View style={styles.inputSection}>
              <Text style={styles.inputLabel}>Votre pseudo</Text>
              <View style={[styles.inputRow, error && { borderColor: theme.colors.danger }]}>
                <TextInput style={styles.input} value={displayName} onChangeText={t => { setDisplayName(t); setError(null); }} placeholder="Entrez votre pseudo" placeholderTextColor={theme.colors.placeholder} maxLength={30} returnKeyType="done" blurOnSubmit autoCorrect={false} spellCheck={false} autoCapitalize="words" />
                <Text style={[styles.counter, remaining <= 5 && { color: theme.colors.warning }]}>{remaining}</Text>
              </View>
              {error && <Text style={styles.errorText}>{error}</Text>}
              <Text style={styles.inputHint}>Ce pseudo sera visible par vos contacts</Text>
            </View>
          </Animated.View>
        </ScrollView>
        
        <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
          <Button title="Continuer" onPress={handleContinue} variant="primary" size="large" fullWidth loading={loading} disabled={!canContinue} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 24, flexGrow: 1 },
  header: { alignItems: 'center', marginBottom: 28 },
  stepLabel: { fontSize: 12, fontWeight: '700', color: theme.colors.primary, letterSpacing: 1.5, marginBottom: 12 },
  title: { fontSize: 28, fontWeight: '700', color: theme.colors.text, marginBottom: 12, textAlign: 'center', letterSpacing: -0.5 },
  subtitle: { fontSize: 15, color: theme.colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  avatarSection: { alignItems: 'center', marginBottom: 32 },
  avatarOuter: { position: 'relative', marginBottom: 12 },
  avatar: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2, borderWidth: 3, borderColor: theme.colors.primary },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  avatarLoading: { backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { fontSize: 38, fontWeight: '600', color: '#FFF', letterSpacing: 1 },
  cameraBadge: { position: 'absolute', bottom: 0, right: 0, width: 36, height: 36, borderRadius: 18, backgroundColor: theme.colors.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: theme.colors.background },
  avatarHint: { fontSize: 13, color: theme.colors.textMuted },
  inputSection: { marginBottom: 20 },
  inputLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary, marginBottom: 10, marginLeft: 4, letterSpacing: 0.3 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.inputBackground, borderRadius: 14, borderWidth: 1.5, borderColor: theme.colors.inputBorder, paddingRight: 14 },
  input: { flex: 1, paddingHorizontal: 18, paddingVertical: Platform.OS === 'ios' ? 16 : 14, fontSize: 17, color: theme.colors.text },
  counter: { fontSize: 12, color: theme.colors.textMuted, fontWeight: '500' },
  errorText: { fontSize: 13, color: theme.colors.danger, marginTop: 8, marginLeft: 4 },
  inputHint: { fontSize: 13, color: theme.colors.textMuted, marginTop: 10, marginLeft: 4 },
  bottomBar: { paddingHorizontal: 24, paddingTop: 12, backgroundColor: theme.colors.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
});

export default SetupProfileScreen;