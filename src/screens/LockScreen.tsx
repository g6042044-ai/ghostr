// src/screens/LockScreen.tsx
// v6.0 - Proper keyboard handling on both platforms

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, StyleSheet, Vibration, Animated, Platform,
  StatusBar, Keyboard, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Image, Easing, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getEncryptionKeysWithInfo, getLockState, getSecurityInfo, SecurityInfo } from '../services/appLock';
import { setEncryptionKeys } from '../services/storage';
import { theme } from '../components/ui';

interface Props { onUnlock: () => void; }

export function LockScreen({ onUnlock }: Props) {
  const insets = useSafeAreaInsets();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [securityInfo, setSecurityInfo] = useState<SecurityInfo | null>(null);
  const [showMigrationSuccess, setShowMigrationSuccess] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  
  const shakeAnimation = useRef(new Animated.Value(0)).current;
  const fadeAnimation = useRef(new Animated.Value(0)).current;
  const scaleAnimation = useRef(new Animated.Value(0.9)).current;
  const logoFloatAnimation = useRef(new Animated.Value(0)).current;
  const inputRef = useRef<TextInput>(null);

  useEffect(() => { getSecurityInfo().then(setSecurityInfo); }, []);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnimation, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(scaleAnimation, { toValue: 1, tension: 50, friction: 8, useNativeDriver: true }),
    ]).start();
  }, []);

  useEffect(() => {
    const f = Animated.loop(Animated.sequence([
      Animated.timing(logoFloatAnimation, { toValue: -4, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(logoFloatAnimation, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    f.start();
    return () => f.stop();
  }, []);

  useEffect(() => {
    if (!lockedUntil) { setRemainingSeconds(0); return; }
    const update = () => {
      const now = Date.now();
      if (now >= lockedUntil) { setLockedUntil(null); setRemainingSeconds(0); setError(null); }
      else setRemainingSeconds(Math.ceil((lockedUntil - now) / 1000));
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [lockedUntil]);

  const shake = () => {
    if (Platform.OS !== 'web') Vibration.vibrate(100);
    Animated.sequence([
      Animated.timing(shakeAnimation, { toValue: 15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnimation, { toValue: -15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnimation, { toValue: 15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnimation, { toValue: -15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnimation, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const handleUnlock = async () => {
    Keyboard.dismiss();
    if (lockedUntil && Date.now() < lockedUntil) { setError(`Trop de tentatives. Attendez ${remainingSeconds}s.`); shake(); return; }
    if (!password.trim()) { setError('Veuillez entrer votre mot de passe'); shake(); return; }
    setLoading(true); setError(null); setProgress(0); setProgressText('Dérivation de la clé...');
    try {
      const result = await getEncryptionKeysWithInfo(password, (p) => {
        setProgress(p);
        if (p < 0.3) setProgressText('Initialisation...');
        else if (p < 0.7) setProgressText('Dérivation de la clé...');
        else if (p < 0.95) setProgressText('Vérification...');
        else setProgressText('Finalisation...');
      });
      if (result.keys) {
        setAttempts(0); setLockedUntil(null);
        await setEncryptionKeys(result.keys.localKey, result.keys.conversationsKey);
        if (result.migrated) { setShowMigrationSuccess(true); setProgressText('Sécurité renforcée ! ✅'); await new Promise(r => setTimeout(r, 1500)); }
        onUnlock();
      } else {
        const state = await getLockState();
        setAttempts(state.failedAttempts);
        if (state.remainingLockoutSeconds > 0) { setLockedUntil(Date.now() + (state.remainingLockoutSeconds * 1000)); setRemainingSeconds(state.remainingLockoutSeconds); setError(`Trop de tentatives. Attendez ${state.remainingLockoutSeconds}s.`); }
        else setError('Mot de passe incorrect');
        shake(); setPassword('');
      }
    } catch { setError('Une erreur est survenue'); shake(); } finally { setLoading(false); setProgress(0); setProgressText(''); }
  };

  const isBlocked = lockedUntil !== null && Date.now() < lockedUntil;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} bounces={false}>
          <Animated.View style={[styles.content, { opacity: fadeAnimation, transform: [{ scale: scaleAnimation }] }]}>
            <View style={styles.logoSection}>
              <View style={styles.logoWrapper}>
                <Animated.View style={{ transform: [{ translateY: logoFloatAnimation }] }}>
                  <Image source={require('../../assets/icon_nobg.png')} style={styles.logoImage} />
                </Animated.View>
              </View>
              <Text style={styles.title}>Ghostr</Text>
              <View style={styles.secureBadge}><View style={styles.secureDot} /><Text style={styles.secureLabel}>Messagerie sécurisée</Text></View>
            </View>

            {securityInfo && (
              <View style={[styles.securityBadge, { borderColor: (securityInfo.strength === 'high' ? theme.colors.success : securityInfo.strength === 'standard' ? theme.colors.primary : theme.colors.warning) + '40' }]}>
                <Text style={{ fontSize: 24, marginRight: 12 }}>{securityInfo.strength === 'high' ? '🛡️' : securityInfo.strength === 'standard' ? '🔒' : '⚠️'}</Text>
                <View style={styles.flex}>
                  <Text style={[styles.securityAlgo, { color: securityInfo.strength === 'high' ? theme.colors.success : securityInfo.strength === 'standard' ? theme.colors.primary : theme.colors.warning }]}>{securityInfo.algorithmName}</Text>
                  <Text style={styles.securityStrength}>{securityInfo.strength === 'high' ? 'Protection maximale' : securityInfo.strength === 'standard' ? `${securityInfo.iterations?.toLocaleString() || ''} itérations` : 'Mise à jour recommandée'}</Text>
                </View>
              </View>
            )}

            <Text style={styles.instructions}>{isBlocked ? 'Compte temporairement bloqué' : 'Entrez votre mot de passe'}</Text>

            <Animated.View style={[styles.inputSection, { transform: [{ translateX: shakeAnimation }] }]}>
              <View style={[styles.inputWrapper, error && styles.inputWrapperError, isBlocked && styles.inputWrapperDisabled]}>
                <TextInput ref={inputRef} style={[styles.input, isBlocked && { color: theme.colors.textMuted }]} placeholder="••••••••" placeholderTextColor={theme.colors.textMuted} secureTextEntry value={password} onChangeText={t => { setPassword(t); if (!isBlocked) setError(null); }} editable={!loading && !isBlocked} autoCapitalize="none" autoCorrect={false} autoComplete="password" textContentType="password" returnKeyType="done" blurOnSubmit />
              </View>
              {error && <View style={styles.errorRow}><Text style={{ fontSize: 16 }}>⚠️</Text><Text style={styles.errorText}>{error}</Text></View>}
              {isBlocked && remainingSeconds > 0 && <View style={styles.countdown}><Text style={styles.countdownText}>Réessayez dans {remainingSeconds}s</Text></View>}
              {loading && progress > 0 && (
                <View style={styles.progressWrap}>
                  <View style={styles.progressBg}><View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} /></View>
                  <Text style={styles.progressLabel}>{progressText}</Text>
                </View>
              )}
              {showMigrationSuccess && <View style={styles.migrationRow}><Text style={{ fontSize: 18 }}>🔐</Text><Text style={styles.migrationText}>Sécurité renforcée automatiquement</Text></View>}
            </Animated.View>

            <TouchableOpacity style={[styles.unlockBtn, (loading || isBlocked) && { opacity: 0.6 }]} onPress={handleUnlock} disabled={loading || isBlocked} activeOpacity={0.8}>
              {loading ? (
                <View style={styles.loadingRow}><ActivityIndicator color={theme.colors.textOnPrimary} size="small" /><Text style={styles.loadingLabel}>{progress > 0 ? `${Math.round(progress * 100)}%` : 'Chargement...'}</Text></View>
              ) : (
                <><Text style={{ fontSize: 20 }}>{isBlocked ? '🔒' : '🔓'}</Text><Text style={styles.unlockLabel}>{isBlocked ? 'Bloqué' : 'Déverrouiller'}</Text></>
              )}
            </TouchableOpacity>
            {attempts > 0 && attempts < 5 && !isBlocked && <Text style={styles.attemptsText}>{5 - attempts} tentative{5 - attempts > 1 ? 's' : ''} restante{5 - attempts > 1 ? 's' : ''}</Text>}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
        <View style={styles.footerBadge}><Text style={{ fontSize: 16 }}>🔐</Text><Text style={styles.footerText}>Triple Ratchet · Post-Quantique</Text></View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: 'center' },
  content: { alignItems: 'center', paddingHorizontal: 32 },
  logoSection: { alignItems: 'center', marginBottom: 24 },
  logoWrapper: { width: 110, height: 110, borderRadius: 28, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 24, ...theme.shadow.md },
  logoImage: { width: 72, height: 72, borderRadius: 18 },
  title: { fontSize: 36, fontWeight: '700', color: theme.colors.text, letterSpacing: -0.5, marginBottom: 12 },
  secureBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.success + '15', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  secureDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.success, marginRight: 8 },
  secureLabel: { fontSize: 14, color: theme.colors.success, fontWeight: '600' },
  securityBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.surface, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, borderWidth: 1, marginBottom: 20, ...theme.shadow.sm },
  securityAlgo: { fontSize: 14, fontWeight: '600' },
  securityStrength: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 2 },
  instructions: { fontSize: 16, color: theme.colors.textSecondary, marginBottom: 28 },
  inputSection: { width: '100%', marginBottom: 24 },
  inputWrapper: { backgroundColor: theme.colors.surface, borderRadius: 20, borderWidth: 2, borderColor: theme.colors.border, overflow: 'hidden' },
  inputWrapperError: { borderColor: theme.colors.danger },
  inputWrapperDisabled: { backgroundColor: theme.colors.surface + '80', borderColor: theme.colors.textMuted },
  input: { paddingHorizontal: 24, paddingVertical: 18, fontSize: 20, color: theme.colors.text, textAlign: 'center', letterSpacing: 4 },
  errorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 16, gap: 8 },
  errorText: { color: theme.colors.danger, fontSize: 14, fontWeight: '500' },
  countdown: { alignItems: 'center', marginTop: 12, paddingVertical: 8, paddingHorizontal: 16, backgroundColor: theme.colors.warning + '20', borderRadius: 12 },
  countdownText: { color: theme.colors.warning, fontSize: 15, fontWeight: '600' },
  progressWrap: { marginTop: 16, alignItems: 'center' },
  progressBg: { width: '100%', height: 6, backgroundColor: theme.colors.border, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: theme.colors.primary, borderRadius: 3 },
  progressLabel: { marginTop: 8, fontSize: 13, color: theme.colors.textSecondary },
  migrationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 16, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: theme.colors.success + '20', borderRadius: 12, gap: 8 },
  migrationText: { color: theme.colors.success, fontSize: 14, fontWeight: '600' },
  unlockBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primary, paddingVertical: 18, paddingHorizontal: 48, borderRadius: 28, gap: 12, minWidth: 220, ...theme.shadow.md },
  unlockLabel: { color: theme.colors.textOnPrimary, fontSize: 18, fontWeight: '600' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  loadingLabel: { color: theme.colors.textOnPrimary, fontSize: 16, fontWeight: '500' },
  attemptsText: { marginTop: 16, fontSize: 13, color: theme.colors.warning },
  footer: { alignItems: 'center', paddingTop: 20 },
  footerBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.success + '15', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, gap: 10 },
  footerText: { color: theme.colors.success, fontSize: 13, fontWeight: '500' },
});

export default LockScreen;