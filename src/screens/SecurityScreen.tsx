// src/screens/SecurityScreen.tsx
// v9.0 - Cleaned up UI, min 8 chars, strength is advisory only

import { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Keyboard, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { getLockSettings, setupLock, disableLock, updateLockSettings, changePassword, getEncryptionKeys, LockSettings, estimatePasswordStrength, ArgonUnavailableError } from '../services/appLock';
import { setEncryptionKeys } from '../services/storage';
import { sessionService } from '../services/tripleRatchet/sessionService';
import { Header, Button, AlertModal, useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import { SplashScreen } from './SplashScreen';

interface Props {
  onBack: () => void;
  /**
   * Appelée IMMÉDIATEMENT après chaque modification des paramètres de
   * verrouillage (activation, désactivation, changement de PIN, timeout).
   * Permet à App.tsx de rafraîchir son état de verrouillage sans attendre
   * que l'utilisateur clique sur Back — évite qu'un Home press juste après
   * une activation du PIN ne soit pas pris en compte.
   */
  onSettingsChanged?: () => void;
}
type Screen = 'main' | 'setup-password' | 'setup-timeout' | 'change-password' | 'disable';

const MIN_PASSWORD_LENGTH = 8;

// Les labels sont calculés via i18n dans le composant.
// On garde uniquement les valeurs et le flag "recommended" au niveau module.
const TIMEOUT_VALUES: ReadonlyArray<{ value: number; recommended?: boolean; labelKey: string }> = [
  { value: 0, labelKey: 'security.timeout.immediate' },
  { value: 1, recommended: true, labelKey: 'security.timeout.1min' },
  { value: 5, labelKey: 'security.timeout.5min' },
  { value: 15, labelKey: 'security.timeout.15min' },
  { value: 30, labelKey: 'security.timeout.30min' },
];

export function SecurityScreen({ onBack, onSettingsChanged }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  // Reconstruit les options de timeout avec les labels traduits.
  // Recalculé à chaque render — peu coûteux et garantit la mise à jour
  // immédiate au changement de langue.
  const TIMEOUT_OPTIONS = TIMEOUT_VALUES.map(o => ({
    ...o,
    label: t(o.labelKey as any),
  }));
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
    } catch (e) { console.error('Load settings error:', e); }
    finally { setLoading(false); }
  };

  const handlePasswordNext = () => {
    Keyboard.dismiss();
    setFormError(null);
    if (!newPassword.trim()) { setFormError(t('security.errors.enterPassword')); return; }
    if (newPassword.length < MIN_PASSWORD_LENGTH) { setFormError(t('security.errors.tooShort', { count: MIN_PASSWORD_LENGTH })); return; }
    if (newPassword !== confirmPassword) { setFormError(t('security.errors.noMatch')); return; }
    setTimeout(1);
    setScreen('setup-timeout');
  };

  const handleSetupLock = async () => {
    setLoadingMessage(t('security.loading.activating'));
    setActionLoading(true);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      const success = await setupLock(newPassword, false, timeout, p => setUpgradeProgress(p));
      if (success) {
        setLoadingMessage(t('security.loading.encrypting'));
        try { const keys = await getEncryptionKeys(newPassword); if (keys) { await setEncryptionKeys(keys.localKey, keys.conversationsKey); await sessionService.reEncryptAllPlaintextData(); } } catch {}
        // Notifier App.tsx IMMÉDIATEMENT que le PIN est actif : si l'utilisateur
        // ferme l'app tout de suite après (sans cliquer Back), le handler
        // AppState d'App.tsx doit déjà connaître le nouveau lockEnabled=true
        // pour verrouiller correctement au prochain retour.
        onSettingsChanged?.();
        setScreen('main'); loadSettings(); resetForm();
        setSuccessMessage(t('security.protectionEnabled')); setShowSuccessModal(true);
      } else setFormError(t('security.errors.enableFailed'));
    } catch (e) {
      if (e instanceof ArgonUnavailableError) {
        setFormError(t('security.errors.cryptoMissing'));
      } else {
        setFormError(t('security.errors.generic'));
      }
    }
    finally { setActionLoading(false); setUpgradeProgress(0); }
  };

  const handleDisableLock = async () => {
    Keyboard.dismiss();
    if (!disablePassword) return;
    setLoadingMessage(t('security.loading.verifying'));
    setActionLoading(true);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      // Étape 1: Valider le mot de passe AVANT toute modification
      const keys = await getEncryptionKeys(disablePassword);
      if (!keys) { setFormError(t('security.errors.incorrect')); setActionLoading(false); return; }
      keys.localKey.fill(0);
      keys.conversationsKey.fill(0);

      // Étape 2: Re-chiffrer TOUTES les données du PIN vers les clés hardware
      // AVANT de supprimer la config du verrou. Si un crash survient ici,
      // les données restent lisibles et le verrou est toujours en place.
      setLoadingMessage(t('security.loading.migrating'));
      const { transitionToHardwareEncryption } = await import('../services/storage');
      await transitionToHardwareEncryption();

      // Étape 3: Supprimer la configuration du verrou (safe — données déjà hardware-encrypted)
      const success = await disableLock(disablePassword);
      if (success) {
        onSettingsChanged?.();
        setDisablePassword('');
        setScreen('main');
        loadSettings();
        setSuccessMessage(t('security.protectionDisabled'));
        setShowSuccessModal(true);
      } else {
        setFormError(t('security.errors.disableFailed'));
      }
    } catch (e) {
      if (e instanceof ArgonUnavailableError) {
        setFormError(t('security.errors.cryptoMissing'));
      } else {
        setFormError(t('security.errors.generic'));
      }
    }
    finally { setActionLoading(false); }
  };

  const handleChangePassword = async () => {
    Keyboard.dismiss();
    setFormError(null);
    if (!currentPassword.trim() || !newPassword.trim()) { setFormError(t('security.errors.fillAllFields')); return; }
    if (newPassword.length < MIN_PASSWORD_LENGTH) { setFormError(t('security.errors.tooShort', { count: MIN_PASSWORD_LENGTH })); return; }
    if (newPassword !== confirmPassword) { setFormError(t('security.errors.noMatch')); return; }
    setLoadingMessage(t('security.loading.changing'));
    setActionLoading(true);
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    try {
      const success = await changePassword(currentPassword, newPassword, p => setUpgradeProgress(p));
      if (success) {
        onSettingsChanged?.();
        setScreen('main'); loadSettings(); resetForm();
        setSuccessMessage(t('security.passwordChanged')); setShowSuccessModal(true);
      }
      else setFormError(t('security.errors.currentIncorrect'));
    } catch (e) {
      if (e instanceof ArgonUnavailableError) {
        setFormError(t('security.errors.cryptoMissing'));
      } else {
        setFormError(t('security.errors.generic'));
      }
    }
    finally { setActionLoading(false); setUpgradeProgress(0); }
  };

  const handleUpdateSettings = async (v: number) => {
    try {
      await updateLockSettings(false, v);
      setSettings(prev => prev ? { ...prev, timeoutMinutes: v } : null);
      // Notifier App.tsx du changement de timeout pour que le prochain
      // passage en background applique la bonne durée sans attendre Back.
      onSettingsChanged?.();
    } catch {}
  };

  const resetForm = () => { setNewPassword(''); setConfirmPassword(''); setCurrentPassword(''); setTimeout(1); setFormError(null); };

  // Strength indicator (advisory only)
  const getStrength = (pw: string) => {
    if (!pw || pw.length < MIN_PASSWORD_LENGTH) return null;
    const s = estimatePasswordStrength(pw);
    const strengthColors = [colors.danger, colors.danger, colors.warning, colors.primary, colors.success];
    const labels = ['', t('security.strength.weak'), t('security.strength.medium'), t('security.strength.good'), t('security.strength.excellent')];
    return { level: s.score, color: strengthColors[s.score], label: labels[s.score] };
  };

  if (loading) return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header title={t('security.title')} onBackPress={onBack} />
      <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
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

            <Text style={[styles.formTitle, kbVisible && styles.formTitleStandalone]}>{t('security.createPassword')}</Text>
            {!kbVisible && <Text style={styles.formSub}>{t('security.createPasswordDesc')}</Text>}

            {/* Password */}
            <View style={styles.fieldGroup}>
              <TextInput
                style={[styles.input, formError && !newPassword.trim() && styles.inputErr]}
                value={newPassword}
                onChangeText={t => { setNewPassword(t); setFormError(null); }}
                placeholder={t('security.minCharsPlaceholder', { count: MIN_PASSWORD_LENGTH })}
                placeholderTextColor={colors.placeholder}
                secureTextEntry autoCapitalize="none" autoCorrect={false}
                textContentType="newPassword" autoComplete="new-password"
                returnKeyType="next"
              />
              {strength && (
                <View style={styles.strengthRow}>
                  <View style={styles.strengthBar}>
                    {[1,2,3,4].map(i => (
                      <View key={i} style={[styles.strengthSeg, { backgroundColor: i <= strength.level ? strength.color : colors.border }]} />
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
                  onChangeText={txt => { setConfirmPassword(txt); setFormError(null); }}
                  placeholder={t('security.confirmPasswordPlaceholder')}
                  placeholderTextColor={colors.placeholder}
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
                  {t('security.forgotWarning')}
                </Text>
              </View>
            )}

            <View style={styles.inlineAction}>
              <Button title={t('security.continue')} onPress={handlePasswordNext} variant="primary" size="large" fullWidth />
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

          <Text style={styles.formTitle}>{t('security.autoLockTitle')}</Text>
          <Text style={styles.formSub}>{t('security.autoLockDesc')}</Text>

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
                      {o.recommended && <View style={styles.recBadge}><Text style={styles.recText}>{t('security.recommended')}</Text></View>}
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
            <Button title={t('security.enableProtection')} onPress={handleSetupLock} variant="primary" size="large" fullWidth />
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
      <Header title={t('security.changePassword')} onBackPress={() => { setScreen('main'); resetForm(); }} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
        <ScrollView style={styles.flex} contentContainerStyle={[styles.formContent, kbVisible && styles.formContentCompact]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.fieldGroup}>
            <Text style={styles.inputLabel}>{t('security.currentPasswordLabel')}</Text>
            <TextInput style={styles.input} value={currentPassword} onChangeText={txt => { setCurrentPassword(txt); setFormError(null); }} placeholder={t('security.currentPasswordPlaceholder')} placeholderTextColor={colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" autoComplete="password" returnKeyType="next" />
          </View>
          <View style={styles.sep} />
          <View style={styles.fieldGroup}>
            <Text style={styles.inputLabel}>{t('security.newPasswordLabel')}</Text>
            <TextInput style={styles.input} value={newPassword} onChangeText={txt => { setNewPassword(txt); setFormError(null); }} placeholder={t('security.minCharsPlaceholder', { count: MIN_PASSWORD_LENGTH })} placeholderTextColor={colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" autoComplete="new-password" returnKeyType="next" />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.inputLabel}>{t('security.confirmLabel')}</Text>
            <TextInput style={styles.input} value={confirmPassword} onChangeText={txt => { setConfirmPassword(txt); setFormError(null); }} placeholder={t('security.newPasswordRetypePlaceholder')} placeholderTextColor={colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" autoComplete="new-password" returnKeyType="done" blurOnSubmit />
          </View>
          {formError && <Text style={styles.errorText}>{formError}</Text>}

          <View style={styles.inlineAction}>
            <Button title={t('security.changePassword')} onPress={handleChangePassword} variant="primary" size="large" fullWidth />
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
      <Header title={t('security.disableProtection')} onBackPress={() => { setScreen('main'); setDisablePassword(''); setFormError(null); }} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.flexCenter}>
          {!kbVisible && <Text style={styles.formTitle}>{t('security.confirmDisable')}</Text>}
          {!kbVisible && <Text style={styles.formSub}>{t('security.confirmDisableDesc')}</Text>}

          <View style={[styles.fieldGroup, kbVisible && { marginTop: 0 }]}>
            <TextInput
              style={styles.input}
              value={disablePassword}
              onChangeText={txt => { setDisablePassword(txt); setFormError(null); }}
              placeholder={t('security.yourPasswordPlaceholder')}
              placeholderTextColor={colors.placeholder}
              secureTextEntry autoCapitalize="none" autoCorrect={false}
              textContentType="password" autoComplete="password"
              returnKeyType="done" onSubmitEditing={handleDisableLock} blurOnSubmit
            />
          </View>

          {formError && <Text style={styles.errorText}>{formError}</Text>}

          {!kbVisible && (
            <View style={styles.warningCard}>
              <View style={[styles.warningAccent, { backgroundColor: colors.danger }]} />
              <Text style={styles.warningText}>
                {t('security.noProtectionWarning')}
              </Text>
            </View>
          )}

          <View style={styles.inlineAction}>
            <Button title={t('security.disableProtection')} onPress={handleDisableLock} variant="danger" size="large" fullWidth />
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
      <Header title={t('security.title')} onBackPress={onBack} />
      <ScrollView style={styles.flex} contentContainerStyle={styles.mainContent} showsVerticalScrollIndicator={false}>

        {/* Status */}
        <View style={[styles.statusCard, settings?.enabled ? styles.statusOn : styles.statusOff]}>
          <View style={styles.flex}>
            <Text style={styles.statusTitle}>{settings?.enabled ? t('security.protectionEnabled') : t('security.protectionDisabled')}</Text>
            <Text style={styles.statusSub}>{settings?.enabled ? t('security.dataEncrypted') : t('security.enableToSecure')}</Text>
          </View>
          <View style={[styles.statusDot, settings?.enabled && styles.statusDotOn]} />
        </View>

        {settings?.enabled ? (
          <>
            {/* Timeout settings */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t('security.autoLockSection')}</Text>
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
              <Text style={styles.sectionTitle}>{t('security.actionsSection')}</Text>
              <TouchableOpacity style={styles.actionRow} onPress={() => setScreen('change-password')} activeOpacity={0.7}>
                <Text style={styles.actionLabel} numberOfLines={1}>{t('security.changePassword')}</Text>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionRow, styles.actionRowDanger]} onPress={() => { setDisablePassword(''); setFormError(null); setScreen('disable'); }} activeOpacity={0.7}>
                <Text style={[styles.actionLabel, { color: colors.danger }]} numberOfLines={1}>{t('security.disableProtection')}</Text>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <View style={styles.enableSection}>
            <Text style={styles.enableDesc}>
              {t('security.protectDesc')}
            </Text>
            <Button title={t('security.enableProtection')} onPress={() => setScreen('setup-password')} variant="primary" size="large" fullWidth />
          </View>
        )}
      </ScrollView>

      <AlertModal visible={showSuccessModal} title={t('security.successTitle')} message={successMessage} primaryButton={{ title: t('common.ok'), onPress: () => setShowSuccessModal(false) }} onClose={() => setShowSuccessModal(false)} />
    </View>
  );
}

const makeStyles = (colors: ColorPalette) => ({
  container: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  flexCenter: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  mainContent: { padding: 20 },
  formContent: { padding: 24, paddingBottom: 40 },
  formContentCompact: { paddingTop: 16, paddingBottom: 24 },

  // Steps
  steps: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 32, gap: 0 },
  stepDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  stepDotActive: { borderColor: colors.primary, backgroundColor: colors.primary + '15' },
  stepDotDone: { borderColor: colors.success, backgroundColor: colors.success },
  stepNum: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  stepCheck: { fontSize: 13, color: '#fff', fontWeight: '700' },
  stepLine: { width: 40, height: 1.5, backgroundColor: colors.border },
  stepLineDone: { backgroundColor: colors.success },

  // Form header
  formTitle: { fontSize: 22, fontWeight: '700', color: colors.text, textAlign: 'center', marginBottom: 8 },
  formTitleStandalone: { marginBottom: 24 },
  formSub: { fontSize: 15, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 28 },

  // Fields
  fieldGroup: { marginBottom: 16 },
  inputLabel: { fontSize: 14, fontWeight: '600', color: colors.textSecondary, marginBottom: 8, marginLeft: 4 },
  input: { backgroundColor: colors.inputBackground, borderRadius: 16, borderWidth: 1.5, borderColor: colors.inputBorder, paddingHorizontal: 18, paddingVertical: Platform.OS === 'ios' ? 16 : 14, fontSize: 16, color: colors.text },
  inputErr: { borderColor: colors.danger + '60' },
  inputOk: { borderColor: colors.success + '60' },
  matchIcon: { position: 'absolute', right: 18, top: Platform.OS === 'ios' ? 16 : 14, fontSize: 18, color: colors.success },
  sep: { height: 1, backgroundColor: colors.divider, marginVertical: 8 },

  // Strength
  strengthRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 10 },
  strengthBar: { flex: 1, flexDirection: 'row', gap: 4 },
  strengthSeg: { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 12, fontWeight: '600', minWidth: 60 },

  // Error
  errorText: { color: colors.danger, fontSize: 14, fontWeight: '500', textAlign: 'center', marginBottom: 16 },

  // Warning
  warningCard: { flexDirection: 'row', backgroundColor: colors.warning + '10', borderRadius: 12, padding: 14, marginTop: 8, gap: 0, overflow: 'hidden' },
  warningAccent: { width: 3, backgroundColor: colors.warning, borderRadius: 2, marginRight: 14 },
  warningText: { flex: 1, fontSize: 14, color: colors.textSecondary, lineHeight: 20 },

  // Timeout
  timeoutList: { gap: 8, marginBottom: 24 },
  timeoutRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 14, padding: 16, borderWidth: 1.5, borderColor: colors.border },
  timeoutRowSel: { borderColor: colors.primary, backgroundColor: colors.primary + '08' },
  timeoutLabel: { fontSize: 16, fontWeight: '500', color: colors.text },
  timeoutLabelSel: { color: colors.primary },
  recBadge: { backgroundColor: colors.primary + '20', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  recText: { fontSize: 11, fontWeight: '600', color: colors.primary },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  radioSel: { borderColor: colors.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },

  // Inline action button (inside scroll, not floating)
  inlineAction: { marginTop: 24 },

  // ── Main screen ──
  statusCard: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, padding: 18, marginBottom: 24 },
  statusOn: { backgroundColor: colors.success + '12', borderWidth: 1, borderColor: colors.success + '25' },
  statusOff: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  statusTitle: { fontSize: 17, fontWeight: '600', color: colors.text, marginBottom: 2 },
  statusSub: { fontSize: 14, color: colors.textSecondary },
  statusDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.textMuted, marginLeft: 12 },
  statusDotOn: { backgroundColor: colors.success },

  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textMuted, letterSpacing: 0.5, marginBottom: 12, marginLeft: 4 },
  optionsCard: { backgroundColor: colors.surface, borderRadius: 16, overflow: 'hidden' },
  optionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.divider },
  optionRowLast: { borderBottomWidth: 0 },
  optionLabel: { fontSize: 16, color: colors.text },
  checkBadge: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.primary + '20', alignItems: 'center', justifyContent: 'center' },
  checkMark: { fontSize: 13, color: colors.primary, fontWeight: '700' },

  actionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderRadius: 14, padding: 16, marginBottom: 10 },
  actionRowDanger: { backgroundColor: colors.danger + '08', borderWidth: 1, borderColor: colors.danger + '15' },
  actionLabel: { fontSize: 16, fontWeight: '500', color: colors.text },
  chevron: { fontSize: 22, color: colors.textMuted },

  enableSection: { marginTop: 8 },
  enableDesc: { fontSize: 15, color: colors.textSecondary, lineHeight: 22, marginBottom: 12 },
  enableTagline: { fontSize: 13, fontWeight: '500', color: colors.primary, textAlign: 'center', marginBottom: 20, opacity: 0.7 },
}) as const;

export default SecurityScreen;