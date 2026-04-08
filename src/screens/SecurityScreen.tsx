// src/screens/SecurityScreen.tsx
// v9.0 - Cleaned up UI, min 8 chars, strength is advisory only

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Keyboard, Animated, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getLockSettings, setupLock, disableLock, updateLockSettings, changePassword,
  getSecurityInfo, getEncryptionKeys, LockSettings, SecurityInfo,
  estimatePasswordStrength,
} from '../services/appLock';
import { setEncryptionKeys } from '../services/storage';
import { sessionService } from '../services/tripleRatchet/sessionService';
import { theme, Header, Button, AlertModal } from '../components/ui';
import { SplashScreen } from './SplashScreen';

interface Props { onBack: () => void; }
type Screen = 'main' | 'setup-password' | 'setup-timeout' | 'change-password' | 'disable';

const MIN_PASSWORD_LENGTH = 8;

const TIMEOUT_OPTIONS = [
  { label: 'Immédiatement', value: 0 },
  { label: '1 minute', value: 1, recommended: true },
  { label: '5 minutes', value: 5 },
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
];

export function SecurityScreen({ onBack }: Props) {
  const insets = useSafeAreaInsets();
  const [screen, setScreen] = useState<Screen>('main');
  const [settings, setSettings] = useState<LockSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [timeout, setTimeout] = useState(1);
  const [currentPassword, setCurrentPassword] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [securityInfo, setSecurityInfo] = useState<SecurityInfo | null>(null);
  const [upgradeProgress, setUpgradeProgress] = useState(0);
  const [kbVisible, setKbVisible] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => { loadSettings(); }, []);

  // Keyboard listener — hide decorative elements
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(show, () => setKbVisible(true));
    const s2 = Keyboard.addListener(hide, () => setKbVisible(false));
    return () => { s1.remove(); s2.remove(); };
  }, []);

  useEffect(() => {
    if (screen === 'setup-timeout') {
      fadeAnim.setValue(0);
      slideAnim.setValue(30);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 0, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start();
    }
  }, [screen]);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const ls = await getLockSettings();
      setSettings(ls);
      setTimeout(ls.timeoutMinutes);
      if (ls.enabled) { const info = await getSecurityInfo(); setSecurityInfo(info); }
    } catch (e) { console.error('Load settings error:', e); }
    finally { setLoading(false); }
  };

  const handlePasswordNext = () => {
    Keyboard.dismiss();
    setFormError(null);
    if (!newPassword.trim()) { setFormError('Veuillez entrer un mot de passe'); return; }
    if (newPassword.length < MIN_PASSWORD_LENGTH) { setFormError(`Minimum ${MIN_PASSWORD_LENGTH} caractères`); return; }
    if (newPassword !== confirmPassword) { setFormError('Les mots de passe ne correspondent pas'); return; }
    setTimeout(1);
    setScreen('setup-timeout');
  };

  const handleSetupLock = async () => {
    setLoadingMessage('Activation de la protection…');
    setActionLoading(true);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      const success = await setupLock(newPassword, false, timeout, p => setUpgradeProgress(p));
      if (success) {
        setLoadingMessage('Chiffrement des données…');
        try { const keys = await getEncryptionKeys(newPassword); if (keys) { await setEncryptionKeys(keys.localKey, keys.conversationsKey); await sessionService.reEncryptAllPlaintextData(); } } catch {}
        setScreen('main'); loadSettings(); resetForm();
        setSuccessMessage('Protection activée'); setShowSuccessModal(true);
      } else setFormError('Échec de l\'activation');
    } catch { setFormError('Une erreur est survenue'); }
    finally { setActionLoading(false); setUpgradeProgress(0); }
  };

  const handleDisableLock = async () => {
    Keyboard.dismiss();
    if (!disablePassword) return;
    setLoadingMessage('Vérification du mot de passe…');
    setActionLoading(true);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      // Étape 1: Valider le mot de passe AVANT toute modification
      const keys = await getEncryptionKeys(disablePassword);
      if (!keys) { setFormError('Mot de passe incorrect'); setActionLoading(false); return; }
      keys.localKey.fill(0);
      keys.conversationsKey.fill(0);

      // Étape 2: Re-chiffrer TOUTES les données du PIN vers les clés hardware
      // AVANT de supprimer la config du verrou. Si un crash survient ici,
      // les données restent lisibles et le verrou est toujours en place.
      setLoadingMessage('Migration du chiffrement…');
      const { transitionToHardwareEncryption } = await import('../services/storage');
      await transitionToHardwareEncryption();

      // Étape 3: Supprimer la configuration du verrou (safe — données déjà hardware-encrypted)
      const success = await disableLock(disablePassword);
      if (success) {
        setDisablePassword('');
        setScreen('main');
        loadSettings();
        setSuccessMessage('Protection désactivée');
        setShowSuccessModal(true);
      } else {
        setFormError('Erreur lors de la désactivation');
      }
    } catch { setFormError('Une erreur est survenue'); }
    finally { setActionLoading(false); }
  };

  const handleChangePassword = async () => {
    Keyboard.dismiss();
    setFormError(null);
    if (!currentPassword.trim() || !newPassword.trim()) { setFormError('Veuillez remplir tous les champs'); return; }
    if (newPassword.length < MIN_PASSWORD_LENGTH) { setFormError(`Minimum ${MIN_PASSWORD_LENGTH} caractères`); return; }
    if (newPassword !== confirmPassword) { setFormError('Les mots de passe ne correspondent pas'); return; }
    setLoadingMessage('Changement du mot de passe…');
    setActionLoading(true);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      const success = await changePassword(currentPassword, newPassword, p => setUpgradeProgress(p));
      if (success) { setScreen('main'); loadSettings(); resetForm(); setSuccessMessage('Mot de passe modifié'); setShowSuccessModal(true); }
      else setFormError('Mot de passe actuel incorrect');
    } catch { setFormError('Une erreur est survenue'); }
    finally { setActionLoading(false); setUpgradeProgress(0); }
  };

  const handleUpdateSettings = async (v: number) => {
    try { await updateLockSettings(false, v); setSettings(prev => prev ? { ...prev, timeoutMinutes: v } : null); } catch {}
  };

  const resetForm = () => { setNewPassword(''); setConfirmPassword(''); setCurrentPassword(''); setTimeout(1); setFormError(null); };

  // Strength indicator (advisory only)
  const getStrength = (pw: string) => {
    if (!pw || pw.length < MIN_PASSWORD_LENGTH) return null;
    const s = estimatePasswordStrength(pw);
    const colors = [theme.colors.danger, theme.colors.danger, theme.colors.warning, theme.colors.primary, theme.colors.success];
    const labels = ['', 'Faible', 'Moyen', 'Bon', 'Excellent'];
    return { level: s.score, color: colors[s.score], label: labels[s.score] };
  };

  if (loading) return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header title="Sécurité" onBackPress={onBack} />
      <View style={styles.center}><ActivityIndicator size="large" color={theme.colors.primary} /></View>
    </View>
  );

  // Full-screen splash during crypto operations
  if (actionLoading) return (
    <SplashScreen
      statusMessage={loadingMessage}
      progress={upgradeProgress > 0 ? upgradeProgress : undefined}
    />
  );

  // ════════════════════════════════════════════
  // STEP 1: PASSWORD
  // ════════════════════════════════════════════
  if (screen === 'setup-password') {
    const strength = getStrength(newPassword);
    const passwordsMatch = confirmPassword.length > 0 && newPassword === confirmPassword;

    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <Header title="" onBackPress={() => { setScreen('main'); resetForm(); }} />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
          <ScrollView style={styles.flex} contentContainerStyle={[styles.formContent, kbVisible && styles.formContentCompact]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

            {/* Steps — hidden when keyboard up */}
            {!kbVisible && (
              <View style={styles.steps}>
                <View style={[styles.stepDot, styles.stepDotActive]}><Text style={styles.stepNum}>1</Text></View>
                <View style={styles.stepLine} />
                <View style={styles.stepDot}><Text style={styles.stepNum}>2</Text></View>
              </View>
            )}

            <Text style={[styles.formTitle, kbVisible && styles.formTitleStandalone]}>Créer un mot de passe</Text>
            {!kbVisible && <Text style={styles.formSub}>Il protégera l'accès à vos conversations</Text>}

            {/* Password */}
            <View style={styles.fieldGroup}>
              <TextInput
                style={[styles.input, formError && !newPassword.trim() && styles.inputErr]}
                value={newPassword}
                onChangeText={t => { setNewPassword(t); setFormError(null); }}
                placeholder={`Minimum ${MIN_PASSWORD_LENGTH} caractères`}
                placeholderTextColor={theme.colors.placeholder}
                secureTextEntry autoCapitalize="none" autoCorrect={false}
                textContentType="newPassword" autoComplete="new-password"
                returnKeyType="next"
              />
              {strength && (
                <View style={styles.strengthRow}>
                  <View style={styles.strengthBar}>
                    {[1,2,3,4].map(i => (
                      <View key={i} style={[styles.strengthSeg, { backgroundColor: i <= strength.level ? strength.color : theme.colors.border }]} />
                    ))}
                  </View>
                  <Text style={[styles.strengthLabel, { color: strength.color }]}>{strength.label}</Text>
                </View>
              )}
            </View>

            {/* Confirm */}
            <View style={styles.fieldGroup}>
              <View style={{ position: 'relative' }}>
                <TextInput
                  style={[styles.input, passwordsMatch && styles.inputOk]}
                  value={confirmPassword}
                  onChangeText={t => { setConfirmPassword(t); setFormError(null); }}
                  placeholder="Confirmer le mot de passe"
                  placeholderTextColor={theme.colors.placeholder}
                  secureTextEntry autoCapitalize="none" autoCorrect={false}
                  textContentType="newPassword" autoComplete="new-password"
                  returnKeyType="done" blurOnSubmit
                />
                {passwordsMatch && <Text style={styles.matchIcon}>✓</Text>}
              </View>
            </View>

            {!kbVisible && formError && <Text style={styles.errorText}>{formError}</Text>}

            {!kbVisible && (
              <View style={styles.warningCard}>
                <View style={styles.warningAccent} />
                <Text style={styles.warningText}>
                  Si vous oubliez ce mot de passe, vos données seront irrécupérables.
                </Text>
              </View>
            )}

            <View style={styles.inlineAction}>
              <Button title="Continuer" onPress={handlePasswordNext} variant="primary" size="large" fullWidth />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ════════════════════════════════════════════
  // STEP 2: TIMEOUT
  // ════════════════════════════════════════════
  if (screen === 'setup-timeout') return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header title="" onBackPress={() => setScreen('setup-password')} />
      <Animated.View style={[styles.flex, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.formContent} showsVerticalScrollIndicator={false}>

          {/* Steps */}
          <View style={styles.steps}>
            <View style={[styles.stepDot, styles.stepDotDone]}><Text style={styles.stepCheck}>✓</Text></View>
            <View style={[styles.stepLine, styles.stepLineDone]} />
            <View style={[styles.stepDot, styles.stepDotActive]}><Text style={styles.stepNum}>2</Text></View>
          </View>

          <Text style={styles.formTitle}>Verrouillage automatique</Text>
          <Text style={styles.formSub}>Délai avant verrouillage quand vous quittez l'app</Text>

          <View style={styles.timeoutList}>
            {TIMEOUT_OPTIONS.map((o) => {
              const sel = timeout === o.value;
              return (
                <TouchableOpacity
                  key={o.value}
                  style={[styles.timeoutRow, sel && styles.timeoutRowSel]}
                  onPress={() => setTimeout(o.value)}
                  activeOpacity={0.7}
                >
                  <View style={styles.flex}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={[styles.timeoutLabel, sel && styles.timeoutLabelSel]}>{o.label}</Text>
                      {o.recommended && <View style={styles.recBadge}><Text style={styles.recText}>Recommandé</Text></View>}
                    </View>
                  </View>
                  <View style={[styles.radio, sel && styles.radioSel]}>
                    {sel && <View style={styles.radioInner} />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {formError && <Text style={styles.errorText}>{formError}</Text>}

          <View style={styles.inlineAction}>
            <Button title="Activer la protection" onPress={handleSetupLock} variant="primary" size="large" fullWidth />
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  );

  // ════════════════════════════════════════════
  // CHANGE PASSWORD
  // ════════════════════════════════════════════
  if (screen === 'change-password') return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header title="Changer le mot de passe" onBackPress={() => { setScreen('main'); resetForm(); }} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
        <ScrollView style={styles.flex} contentContainerStyle={[styles.formContent, kbVisible && styles.formContentCompact]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.fieldGroup}>
            <Text style={styles.inputLabel}>Mot de passe actuel</Text>
            <TextInput style={styles.input} value={currentPassword} onChangeText={t => { setCurrentPassword(t); setFormError(null); }} placeholder="Votre mot de passe actuel" placeholderTextColor={theme.colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" autoComplete="password" returnKeyType="next" />
          </View>
          <View style={styles.sep} />
          <View style={styles.fieldGroup}>
            <Text style={styles.inputLabel}>Nouveau mot de passe</Text>
            <TextInput style={styles.input} value={newPassword} onChangeText={t => { setNewPassword(t); setFormError(null); }} placeholder={`Minimum ${MIN_PASSWORD_LENGTH} caractères`} placeholderTextColor={theme.colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" autoComplete="new-password" returnKeyType="next" />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.inputLabel}>Confirmer</Text>
            <TextInput style={styles.input} value={confirmPassword} onChangeText={t => { setConfirmPassword(t); setFormError(null); }} placeholder="Retapez le nouveau mot de passe" placeholderTextColor={theme.colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" autoComplete="new-password" returnKeyType="done" blurOnSubmit />
          </View>
          {formError && <Text style={styles.errorText}>{formError}</Text>}

          <View style={styles.inlineAction}>
            <Button title="Changer le mot de passe" onPress={handleChangePassword} variant="primary" size="large" fullWidth />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );

  // ════════════════════════════════════════════
  // DISABLE PROTECTION
  // ════════════════════════════════════════════
  if (screen === 'disable') return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header title="Désactiver la protection" onBackPress={() => { setScreen('main'); setDisablePassword(''); setFormError(null); }} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.flexCenter}>
          {!kbVisible && <Text style={styles.formTitle}>Confirmer la désactivation</Text>}
          {!kbVisible && <Text style={styles.formSub}>Entrez votre mot de passe pour supprimer la protection.</Text>}

          <View style={[styles.fieldGroup, kbVisible && { marginTop: 0 }]}>
            <TextInput
              style={styles.input}
              value={disablePassword}
              onChangeText={t => { setDisablePassword(t); setFormError(null); }}
              placeholder="Votre mot de passe"
              placeholderTextColor={theme.colors.placeholder}
              secureTextEntry autoCapitalize="none" autoCorrect={false}
              textContentType="password" autoComplete="password"
              returnKeyType="done" onSubmitEditing={handleDisableLock} blurOnSubmit
            />
          </View>

          {formError && <Text style={styles.errorText}>{formError}</Text>}

          {!kbVisible && (
            <View style={styles.warningCard}>
              <View style={[styles.warningAccent, { backgroundColor: theme.colors.danger }]} />
              <Text style={styles.warningText}>
                Sans protection, toute personne ayant accès à votre téléphone pourra lire vos conversations.
              </Text>
            </View>
          )}

          <View style={styles.inlineAction}>
            <Button title="Désactiver la protection" onPress={handleDisableLock} variant="danger" size="large" fullWidth />
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );

  // ════════════════════════════════════════════
  // MAIN
  // ════════════════════════════════════════════
  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header title="Sécurité" onBackPress={onBack} />
      <ScrollView style={styles.flex} contentContainerStyle={styles.mainContent} showsVerticalScrollIndicator={false}>

        {/* Status */}
        <View style={[styles.statusCard, settings?.enabled ? styles.statusOn : styles.statusOff]}>
          <View style={styles.flex}>
            <Text style={styles.statusTitle}>{settings?.enabled ? 'Protection activée' : 'Protection désactivée'}</Text>
            <Text style={styles.statusSub}>{settings?.enabled ? 'Vos données sont chiffrées' : 'Activez pour sécuriser vos données'}</Text>
          </View>
          <View style={[styles.statusDot, settings?.enabled && styles.statusDotOn]} />
        </View>

        {settings?.enabled ? (
          <>
            {/* Timeout settings */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>VERROUILLAGE AUTOMATIQUE</Text>
              <View style={styles.optionsCard}>
                {TIMEOUT_OPTIONS.map((o, i) => (
                  <TouchableOpacity key={o.value} style={[styles.optionRow, i === TIMEOUT_OPTIONS.length - 1 && styles.optionRowLast]} onPress={() => handleUpdateSettings(o.value)} activeOpacity={0.7}>
                    <Text style={styles.optionLabel}>{o.label}</Text>
                    {settings.timeoutMinutes === o.value && <View style={styles.checkBadge}><Text style={styles.checkMark}>✓</Text></View>}
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Actions */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>ACTIONS</Text>
              <TouchableOpacity style={styles.actionRow} onPress={() => setScreen('change-password')} activeOpacity={0.7}>
                <Text style={styles.actionLabel}>Changer le mot de passe</Text>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionRow, styles.actionRowDanger]} onPress={() => { setDisablePassword(''); setFormError(null); setScreen('disable'); }} activeOpacity={0.7}>
                <Text style={[styles.actionLabel, { color: theme.colors.danger }]}>Désactiver la protection</Text>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <View style={styles.enableSection}>
            <Text style={styles.enableDesc}>
              Protégez vos conversations avec un mot de passe. Vos données seront chiffrées localement.
            </Text>
            <Button title="Activer la protection" onPress={() => setScreen('setup-password')} variant="primary" size="large" fullWidth />
          </View>
        )}
      </ScrollView>

      <AlertModal visible={showSuccessModal} title="Succès" message={successMessage} primaryButton={{ title: 'OK', onPress: () => setShowSuccessModal(false) }} onClose={() => setShowSuccessModal(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  flexCenter: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  mainContent: { padding: 20 },
  formContent: { padding: 24, paddingBottom: 40 },
  formContentCompact: { paddingTop: 16, paddingBottom: 24 },

  // Steps
  steps: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 32, gap: 0 },
  stepDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.surface, borderWidth: 1.5, borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center' },
  stepDotActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary + '15' },
  stepDotDone: { borderColor: theme.colors.success, backgroundColor: theme.colors.success },
  stepNum: { fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary },
  stepCheck: { fontSize: 13, color: '#fff', fontWeight: '700' },
  stepLine: { width: 40, height: 1.5, backgroundColor: theme.colors.border },
  stepLineDone: { backgroundColor: theme.colors.success },

  // Form header
  formTitle: { fontSize: 22, fontWeight: '700', color: theme.colors.text, textAlign: 'center', marginBottom: 8 },
  formTitleStandalone: { marginBottom: 24 },
  formSub: { fontSize: 15, color: theme.colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 28 },

  // Fields
  fieldGroup: { marginBottom: 16 },
  inputLabel: { fontSize: 14, fontWeight: '600', color: theme.colors.textSecondary, marginBottom: 8, marginLeft: 4 },
  input: { backgroundColor: theme.colors.inputBackground, borderRadius: 16, borderWidth: 1.5, borderColor: theme.colors.inputBorder, paddingHorizontal: 18, paddingVertical: Platform.OS === 'ios' ? 16 : 14, fontSize: 16, color: theme.colors.text },
  inputErr: { borderColor: theme.colors.danger + '60' },
  inputOk: { borderColor: theme.colors.success + '60' },
  matchIcon: { position: 'absolute', right: 18, top: Platform.OS === 'ios' ? 16 : 14, fontSize: 18, color: theme.colors.success },
  sep: { height: 1, backgroundColor: theme.colors.divider, marginVertical: 8 },

  // Strength
  strengthRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 10 },
  strengthBar: { flex: 1, flexDirection: 'row', gap: 4 },
  strengthSeg: { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 12, fontWeight: '600', minWidth: 60 },

  // Error
  errorText: { color: theme.colors.danger, fontSize: 14, fontWeight: '500', textAlign: 'center', marginBottom: 16 },

  // Warning
  warningCard: { flexDirection: 'row', backgroundColor: theme.colors.warning + '10', borderRadius: 12, padding: 14, marginTop: 8, gap: 0, overflow: 'hidden' },
  warningAccent: { width: 3, backgroundColor: theme.colors.warning, borderRadius: 2, marginRight: 14 },
  warningText: { flex: 1, fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 },

  // Timeout
  timeoutList: { gap: 8, marginBottom: 24 },
  timeoutRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.surface, borderRadius: 14, padding: 16, borderWidth: 1.5, borderColor: theme.colors.border },
  timeoutRowSel: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary + '08' },
  timeoutLabel: { fontSize: 16, fontWeight: '500', color: theme.colors.text },
  timeoutLabelSel: { color: theme.colors.primary },
  recBadge: { backgroundColor: theme.colors.primary + '20', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  recText: { fontSize: 11, fontWeight: '600', color: theme.colors.primary },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center' },
  radioSel: { borderColor: theme.colors.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.primary },

  // Inline action button (inside scroll, not floating)
  inlineAction: { marginTop: 24 },

  // ── Main screen ──
  statusCard: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, padding: 18, marginBottom: 24 },
  statusOn: { backgroundColor: theme.colors.success + '12', borderWidth: 1, borderColor: theme.colors.success + '25' },
  statusOff: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  statusTitle: { fontSize: 17, fontWeight: '600', color: theme.colors.text, marginBottom: 2 },
  statusSub: { fontSize: 14, color: theme.colors.textSecondary },
  statusDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.textMuted, marginLeft: 12 },
  statusDotOn: { backgroundColor: theme.colors.success },

  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: theme.colors.textMuted, letterSpacing: 0.5, marginBottom: 12, marginLeft: 4 },
  optionsCard: { backgroundColor: theme.colors.surface, borderRadius: 16, overflow: 'hidden' },
  optionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: theme.colors.divider },
  optionRowLast: { borderBottomWidth: 0 },
  optionLabel: { fontSize: 16, color: theme.colors.text },
  checkBadge: { width: 24, height: 24, borderRadius: 12, backgroundColor: theme.colors.primary + '20', alignItems: 'center', justifyContent: 'center' },
  checkMark: { fontSize: 13, color: theme.colors.primary, fontWeight: '700' },

  actionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme.colors.surface, borderRadius: 14, padding: 16, marginBottom: 10 },
  actionRowDanger: { backgroundColor: theme.colors.danger + '08', borderWidth: 1, borderColor: theme.colors.danger + '15' },
  actionLabel: { fontSize: 16, fontWeight: '500', color: theme.colors.text },
  chevron: { fontSize: 22, color: theme.colors.textMuted },

  enableSection: { marginTop: 8 },
  enableDesc: { fontSize: 15, color: theme.colors.textSecondary, lineHeight: 22, marginBottom: 12 },
  enableTagline: { fontSize: 13, fontWeight: '500', color: theme.colors.primary, textAlign: 'center', marginBottom: 20, opacity: 0.7 },
});

export default SecurityScreen;