// src/screens/LockScreen.tsx
// Signal-style: flex-based, logo shrinks with keyboard, no scroll

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, StyleSheet, Vibration, Animated, Platform,
  StatusBar, Keyboard, KeyboardAvoidingView, Image, Easing, TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getEncryptionKeysWithInfo, getLockState } from '../services/appLock';
import { setEncryptionKeys } from '../services/storage';
import { precomputePoW } from '../services/api1to1';
import { theme } from '../components/ui';
import { SplashScreen } from './SplashScreen';

interface Props { onUnlock: () => void; }

const LOGO_FULL = 90;
const LOGO_SMALL = 52;

export function LockScreen({ onUnlock }: Props) {
  const insets = useSafeAreaInsets();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [kbVisible, setKbVisible] = useState(false);

  const inputRef = useRef<TextInput>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const logoSizeAnim = useRef(new Animated.Value(LOGO_FULL)).current;
  const decorOpacity = useRef(new Animated.Value(1)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;

  // PERF A4: Lancer le PoW dès que l'utilisateur commence à taper son PIN.
  // Le PoW est un pur calcul CPU (SHA-256 itératif, ~200ms-1s) sans aucune
  // dépendance sur les clés secrètes ou les données utilisateur.
  // En le lançant ici au lieu d'après la validation du PIN, on gagne 200ms-1s
  // sur le temps total de déverrouillage.
  const powStartedRef = useRef(false);

  // Entrance
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, []);

  // Keyboard → shrink logo, hide decor
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(show, () => {
      setKbVisible(true);
      Animated.parallel([
        Animated.timing(logoSizeAnim, { toValue: LOGO_SMALL, duration: 250, useNativeDriver: false }),
        Animated.timing(decorOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    });
    const s2 = Keyboard.addListener(hide, () => {
      setKbVisible(false);
      Animated.parallel([
        Animated.timing(logoSizeAnim, { toValue: LOGO_FULL, duration: 250, useNativeDriver: false }),
        Animated.timing(decorOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    });
    return () => { s1.remove(); s2.remove(); };
  }, []);

  // Lockout countdown
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

  const formatLockout = (s: number) => s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}` : `${s}s`;

  const shake = useCallback(() => {
    if (Platform.OS !== 'web') Vibration.vibrate(100);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, []);

  const handleUnlock = useCallback(async () => {
    Keyboard.dismiss();
    if (lockedUntil && Date.now() < lockedUntil) { shake(); return; }
    if (!password.trim()) { setError('Veuillez entrer votre mot de passe'); shake(); return; }
    setLoading(true); setError(null);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      const result = await getEncryptionKeysWithInfo(password);
      if (result.keys) {
        await setEncryptionKeys(result.keys.localKey, result.keys.conversationsKey);
        onUnlock();
      } else {
        const state = await getLockState();
        if (state.remainingLockoutSeconds > 0) {
          setLockedUntil(Date.now() + (state.remainingLockoutSeconds * 1000));
          setRemainingSeconds(state.remainingLockoutSeconds);
        } else { setError('Mot de passe incorrect'); }
        shake(); setPassword('');
      }
    } catch { setError('Une erreur est survenue'); shake(); }
    finally { setLoading(false); }
  }, [password, lockedUntil, onUnlock]);

  const isBlocked = lockedUntil !== null && Date.now() < lockedUntil;
  if (loading) return <SplashScreen statusMessage="Déverrouillage en cours…" />;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Animated.View style={[styles.mainContent, { opacity: fadeAnim }]}>

          {/* Logo — shrinks when keyboard is up */}
          <View style={styles.logoSection}>
            <Animated.View style={[styles.logoCard, {
              width: Animated.add(logoSizeAnim, 28),
              height: Animated.add(logoSizeAnim, 28),
              borderRadius: 24,
            }]}>
              <Animated.Image
                source={require('../../assets/icon_nobg.png')}
                style={{ width: logoSizeAnim, height: logoSizeAnim, borderRadius: 18 }}
                resizeMode="contain"
              />
            </Animated.View>
            {!kbVisible && <Text style={styles.title}>Ghostr</Text>}
          </View>

          {/* Input + Error + Button */}
          <View style={styles.formSection}>
            <Animated.View style={{ transform: [{ translateX: shakeAnim }] }}>
              <View style={[
                styles.inputWrapper,
                error && styles.inputWrapperError,
                isBlocked && styles.inputWrapperDisabled,
              ]}>
                <TextInput
                  ref={inputRef}
                  style={[styles.input, isBlocked && { color: theme.colors.textMuted }]}
                  placeholder="••••••••"
                  placeholderTextColor={theme.colors.textMuted}
                  secureTextEntry
                  value={password}
                  onChangeText={(t) => {
                    setPassword(t);
                    if (!isBlocked) setError(null);
                    // PERF A4: Lancer le calcul PoW dès la première frappe.
                    // C'est du pur CPU (SHA-256 itératif, ~200ms-1s) sans aucune
                    // dépendance sur les clés ou données utilisateur.
                    if (t.length > 0 && !powStartedRef.current) {
                      powStartedRef.current = true;
                      precomputePoW();
                    }
                  }}
                  editable={!isBlocked}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="password"
                  textContentType="password"
                  returnKeyType="done"
                  onSubmitEditing={handleUnlock}
                  blurOnSubmit
                />
              </View>
            </Animated.View>

            {error && <Text style={styles.errorText}>{error}</Text>}

            {isBlocked && remainingSeconds > 0 && (
              <View style={styles.lockoutPill}>
                <Text style={styles.lockoutText}>Réessayez dans {formatLockout(remainingSeconds)}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.unlockBtn, isBlocked && styles.unlockBtnDisabled]}
              onPress={handleUnlock}
              disabled={isBlocked}
              activeOpacity={0.8}
            >
              <Text style={styles.unlockLabel}>{isBlocked ? 'Verrouillé' : 'Déverrouiller'}</Text>
            </TouchableOpacity>
          </View>

        </Animated.View>

        {/* Footer — hidden when keyboard is up */}
        {!kbVisible && (
          <Animated.View style={[styles.footer, { paddingBottom: insets.bottom + 20, opacity: decorOpacity }]}>
            <Text style={styles.footerText}>Chiffrement de bout en bout</Text>
          </Animated.View>
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
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },

  // Logo
  logoSection: { alignItems: 'center', marginBottom: 32 },
  logoCard: {
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    ...theme.shadow.md,
  },
  title: { fontSize: 30, fontWeight: '700', color: theme.colors.text, letterSpacing: -0.5 },

  // Form
  formSection: { width: '100%' },
  inputWrapper: {
    backgroundColor: theme.colors.surface,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  inputWrapperError: { borderColor: theme.colors.danger },
  inputWrapperDisabled: { backgroundColor: theme.colors.surface + '80', borderColor: theme.colors.textMuted + '40' },
  input: {
    paddingHorizontal: 24, paddingVertical: 18,
    fontSize: 20, color: theme.colors.text, textAlign: 'center', letterSpacing: 4,
  },
  errorText: { color: theme.colors.danger, fontSize: 14, fontWeight: '500', textAlign: 'center', marginTop: 12 },
  lockoutPill: {
    alignSelf: 'center', marginTop: 10,
    paddingVertical: 8, paddingHorizontal: 20,
    backgroundColor: theme.colors.warning + '18', borderRadius: 20,
  },
  lockoutText: { color: theme.colors.warning, fontSize: 14, fontWeight: '600' },

  unlockBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    paddingVertical: 18, borderRadius: 18,
    marginTop: 20,
    ...theme.shadow.md,
  },
  unlockBtnDisabled: { opacity: 0.5 },
  unlockLabel: { color: theme.colors.textOnPrimary, fontSize: 17, fontWeight: '600' },

  // Footer
  footer: { alignItems: 'center' },
  footerTagline: { fontSize: 14, color: theme.colors.textSecondary, fontWeight: '500', marginBottom: 4 },
  footerText: { fontSize: 13, color: theme.colors.textMuted, fontWeight: '500' },
});

export default LockScreen;