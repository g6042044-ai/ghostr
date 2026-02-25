// src/screens/SecurityScreen.tsx
// v8.0 - Two-step setup: password → timeout selection

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Keyboard, Animated, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getLockSettings, setupLock, disableLock, updateLockSettings, changePassword,
  getSecurityInfo, getEncryptionKeys, LockSettings, SecurityInfo,
} from '../services/appLock';
import { setEncryptionKeys } from '../services/storage';
import { sessionService } from '../services/tripleRatchet/sessionService';
import { theme, Header, Button, AlertModal, BottomSheet } from '../components/ui';

interface Props { onBack: () => void; }
type Screen = 'main' | 'setup-password' | 'setup-timeout' | 'change-password';

const TIMEOUT_OPTIONS = [
  { label: 'Immédiatement', desc: 'Dès que vous quittez l\'app', value: 0, icon: '⚡' },
  { label: 'Après 1 minute', desc: 'Recommandé', value: 1, icon: '⏱️' },
  { label: 'Après 5 minutes', desc: 'Utilisation fréquente', value: 5, icon: '🕐' },
  { label: 'Après 15 minutes', desc: 'Moins sécurisé', value: 15, icon: '🕑' },
  { label: 'Après 30 minutes', desc: 'Sécurité minimale', value: 30, icon: '🕓' },
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
  const [formError, setFormError] = useState<string | null>(null);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [securityInfo, setSecurityInfo] = useState<SecurityInfo | null>(null);
  const [upgradeProgress, setUpgradeProgress] = useState(0);

  // Step 2 animation
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => { loadSettings(); }, []);

  // Animate step 2 entrance
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

  // Step 1 → Step 2: validate password then go to timeout selection
  const handlePasswordNext = () => {
    Keyboard.dismiss();
    setFormError(null);
    if (!newPassword.trim()) { setFormError('Veuillez entrer un mot de passe'); return; }
    if (newPassword.length < 6) { setFormError('Le mot de passe doit contenir au moins 6 caractères'); return; }
    if (newPassword !== confirmPassword) { setFormError('Les mots de passe ne correspondent pas'); return; }
    setTimeout(1); // Reset to default
    setScreen('setup-timeout');
  };

  // Step 2: activate with chosen timeout
  const handleSetupLock = async () => {
    setActionLoading(true);
    try {
      const success = await setupLock(newPassword, false, timeout, p => setUpgradeProgress(p));
      if (success) {
        try { const keys = await getEncryptionKeys(newPassword); if (keys) { await setEncryptionKeys(keys.localKey, keys.conversationsKey); await sessionService.reEncryptAllPlaintextData(); } } catch {}
        setScreen('main'); loadSettings(); resetForm();
        setSuccessMessage('Protection activée ! Vos données sont maintenant protégées.'); setShowSuccessModal(true);
      } else setFormError('Échec de l\'activation');
    } catch { setFormError('Une erreur est survenue'); }
    finally { setActionLoading(false); setUpgradeProgress(0); }
  };

  const handleDisableLock = async () => {
    Keyboard.dismiss();
    if (!disablePassword) return;
    setActionLoading(true);
    try {
      const success = await disableLock(disablePassword);
      if (success) { setShowDisableConfirm(false); setDisablePassword(''); loadSettings(); setSuccessMessage('Protection désactivée'); setShowSuccessModal(true); }
      else setFormError('Mot de passe incorrect');
    } catch { setFormError('Une erreur est survenue'); }
    finally { setActionLoading(false); }
  };

  const handleChangePassword = async () => {
    Keyboard.dismiss();
    setFormError(null);
    if (!currentPassword.trim() || !newPassword.trim()) { setFormError('Veuillez remplir tous les champs'); return; }
    if (newPassword.length < 6) { setFormError('Le mot de passe doit contenir au moins 6 caractères'); return; }
    if (newPassword !== confirmPassword) { setFormError('Les nouveaux mots de passe ne correspondent pas'); return; }
    setActionLoading(true);
    try {
      const success = await changePassword(currentPassword, newPassword, p => setUpgradeProgress(p));
      if (success) { setScreen('main'); loadSettings(); resetForm(); setSuccessMessage('Mot de passe modifié avec succès.'); setShowSuccessModal(true); }
      else setFormError('Mot de passe actuel incorrect');
    } catch { setFormError('Une erreur est survenue'); }
    finally { setActionLoading(false); setUpgradeProgress(0); }
  };

  const handleUpdateSettings = async (v: number) => {
    try { await updateLockSettings(false, v); setSettings(prev => prev ? { ...prev, timeoutMinutes: v } : null); } catch {}
  };

  const resetForm = () => { setNewPassword(''); setConfirmPassword(''); setCurrentPassword(''); setTimeout(1); setFormError(null); };

  // Password strength indicator
  const getPasswordStrength = (pw: string) => {
    if (!pw) return { level: 0, label: '', color: 'transparent' };
    let score = 0;
    if (pw.length >= 6) score++;
    if (pw.length >= 10) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    if (score <= 1) return { level: 1, label: 'Faible', color: theme.colors.danger };
    if (score <= 2) return { level: 2, label: 'Moyen', color: theme.colors.warning };
    if (score <= 3) return { level: 3, label: 'Bon', color: theme.colors.primary };
    return { level: 4, label: 'Excellent', color: theme.colors.success };
  };

  if (loading) return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header title="Sécurité" onBackPress={onBack} />
      <View style={styles.center}><ActivityIndicator size="large" color={theme.colors.primary} /></View>
    </View>
  );

  // ── STEP 1: PASSWORD ──
  if (screen === 'setup-password') {
    const strength = getPasswordStrength(newPassword);
    const passwordsMatch = confirmPassword.length > 0 && newPassword === confirmPassword;
    const passwordsMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <Header title="Étape 1 sur 2" onBackPress={() => { setScreen('main'); resetForm(); }} />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
          <ScrollView style={styles.flex} contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <View style={styles.headerSection}>
              <View style={styles.stepIndicator}>
                <View style={[styles.stepDot, styles.stepDotActive]} />
                <View style={styles.stepLine} />
                <View style={styles.stepDot} />
              </View>
              <Text style={styles.formTitle}>Choisissez un mot de passe</Text>
              <Text style={styles.formSubtitle}>Il protégera l'accès à toutes vos conversations</Text>
            </View>

            <View style={styles.form}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Mot de passe</Text>
                <TextInput style={styles.input} value={newPassword} onChangeText={t => { setNewPassword(t); setFormError(null); }} placeholder="Minimum 6 caractères" placeholderTextColor={theme.colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" autoComplete="new-password" returnKeyType="next" />
                {/* Password strength bar */}
                {newPassword.length > 0 && (
                  <View style={styles.strengthRow}>
                    <View style={styles.strengthBar}>
                      {[1,2,3,4].map(i => (
                        <View key={i} style={[styles.strengthSegment, { backgroundColor: i <= strength.level ? strength.color : theme.colors.border }]} />
                      ))}
                    </View>
                    <Text style={[styles.strengthLabel, { color: strength.color }]}>{strength.label}</Text>
                  </View>
                )}
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Confirmer le mot de passe</Text>
                <View style={{ position: 'relative' }}>
                  <TextInput style={[styles.input, passwordsMismatch && styles.inputError, passwordsMatch && styles.inputSuccess]} value={confirmPassword} onChangeText={t => { setConfirmPassword(t); setFormError(null); }} placeholder="Retapez le mot de passe" placeholderTextColor={theme.colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" autoComplete="new-password" returnKeyType="done" blurOnSubmit />
                  {passwordsMatch && <Text style={styles.matchIcon}>✓</Text>}
                </View>
              </View>
              {formError && <View style={styles.errorBanner}><Text style={{ fontSize: 18 }}>⚠️</Text><Text style={styles.errorText}>{formError}</Text></View>}
            </View>

            <View style={styles.warningCard}>
              <Text style={{ fontSize: 24 }}>⚠️</Text>
              <View style={styles.flex}><Text style={styles.warningTitle}>Important</Text><Text style={styles.warningText}>Si vous oubliez ce mot de passe, vos données seront irrécupérables.</Text></View>
            </View>
          </ScrollView>
          <View style={styles.bottomActions}>
            <Button title="Continuer" onPress={handlePasswordNext} variant="primary" size="large" fullWidth />
          </View>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ── STEP 2: TIMEOUT SELECTION ──
  if (screen === 'setup-timeout') return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header title="Étape 2 sur 2" onBackPress={() => setScreen('setup-password')} />
      <Animated.View style={[styles.flex, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.formContent} showsVerticalScrollIndicator={false}>
          <View style={styles.headerSection}>
            <View style={styles.stepIndicator}>
              <View style={[styles.stepDot, styles.stepDotDone]}>
                <Text style={styles.stepDoneCheck}>✓</Text>
              </View>
              <View style={[styles.stepLine, styles.stepLineDone]} />
              <View style={[styles.stepDot, styles.stepDotActive]} />
            </View>
            <Text style={styles.formTitle}>Verrouillage automatique</Text>
            <Text style={styles.formSubtitle}>Après combien de temps l'app se verrouille quand vous la quittez ?</Text>
          </View>

          <View style={styles.timeoutCards}>
            {TIMEOUT_OPTIONS.map((o, i) => {
              const isSelected = timeout === o.value;
              const isRecommended = o.value === 1;
              return (
                <TouchableOpacity
                  key={o.value}
                  style={[styles.timeoutCard, isSelected && styles.timeoutCardActive]}
                  onPress={() => setTimeout(o.value)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.timeoutCardIcon}>{o.icon}</Text>
                  <View style={styles.flex}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={[styles.timeoutCardLabel, isSelected && styles.timeoutCardLabelActive]}>{o.label}</Text>
                      {isRecommended && <View style={styles.recommendedBadge}><Text style={styles.recommendedText}>Recommandé</Text></View>}
                    </View>
                    <Text style={styles.timeoutCardDesc}>{o.desc}</Text>
                  </View>
                  <View style={[styles.radioOuter, isSelected && styles.radioOuterActive]}>
                    {isSelected && <View style={styles.radioInner} />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {formError && <View style={styles.errorBanner}><Text style={{ fontSize: 18 }}>⚠️</Text><Text style={styles.errorText}>{formError}</Text></View>}
        </ScrollView>
        <View style={styles.bottomActions}>
          <Button title="Activer la protection" onPress={handleSetupLock} variant="primary" size="large" fullWidth loading={actionLoading} />
        </View>
      </Animated.View>
    </View>
  );

  // ── CHANGE PASSWORD SCREEN ──
  if (screen === 'change-password') return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header title="Changer le mot de passe" onBackPress={() => { setScreen('main'); resetForm(); }} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.headerSection}>
            <View style={styles.iconContainer}><Text style={{ fontSize: 40 }}>🔐</Text></View>
            <Text style={styles.formTitle}>Nouveau mot de passe</Text>
            <Text style={styles.formSubtitle}>Entrez votre mot de passe actuel puis le nouveau</Text>
          </View>
          <View style={styles.form}>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Mot de passe actuel</Text>
              <TextInput style={styles.input} value={currentPassword} onChangeText={t => { setCurrentPassword(t); setFormError(null); }} placeholder="Votre mot de passe actuel" placeholderTextColor={theme.colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" autoComplete="password" returnKeyType="next" />
            </View>
            <View style={styles.divider} />
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Nouveau mot de passe</Text>
              <TextInput style={styles.input} value={newPassword} onChangeText={t => { setNewPassword(t); setFormError(null); }} placeholder="Minimum 6 caractères" placeholderTextColor={theme.colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" autoComplete="new-password" returnKeyType="next" />
            </View>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Confirmer</Text>
              <TextInput style={styles.input} value={confirmPassword} onChangeText={t => { setConfirmPassword(t); setFormError(null); }} placeholder="Retapez le nouveau mot de passe" placeholderTextColor={theme.colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" autoComplete="new-password" returnKeyType="done" blurOnSubmit />
            </View>
            {formError && <View style={styles.errorBanner}><Text style={{ fontSize: 18 }}>⚠️</Text><Text style={styles.errorText}>{formError}</Text></View>}
          </View>
        </ScrollView>
        <View style={styles.bottomActions}><Button title="Changer le mot de passe" onPress={handleChangePassword} variant="primary" size="large" fullWidth loading={actionLoading} /></View>
      </KeyboardAvoidingView>
    </View>
  );

  // ── MAIN SCREEN ──
  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Header title="Sécurité" onBackPress={onBack} />
      <ScrollView style={styles.flex} contentContainerStyle={styles.mainContent} showsVerticalScrollIndicator={false}>
        <View style={[styles.statusCard, settings?.enabled ? styles.statusEnabled : styles.statusDisabled]}>
          <View style={[styles.statusIcon, settings?.enabled ? styles.statusIconOn : styles.statusIconOff]}><Text style={{ fontSize: 24 }}>{settings?.enabled ? '🔐' : '🔓'}</Text></View>
          <View style={styles.flex}><Text style={styles.statusTitle}>{settings?.enabled ? 'Protection activée' : 'Protection désactivée'}</Text><Text style={styles.statusSub}>{settings?.enabled ? 'Vos données sont chiffrées' : 'Activez pour sécuriser vos données'}</Text></View>
        </View>

        {settings?.enabled ? (
          <>
            {securityInfo && (
              <View style={[styles.statusCard, { marginBottom: 16, borderLeftWidth: 3, borderLeftColor: securityInfo.strength === 'high' ? theme.colors.success : securityInfo.strength === 'standard' ? theme.colors.primary : theme.colors.warning }]}>
                <View style={[styles.statusIcon, { backgroundColor: (securityInfo.strength === 'low' ? theme.colors.warning : theme.colors.success) + '20' }]}><Text style={{ fontSize: 24 }}>{securityInfo.strength === 'high' ? '🛡️' : securityInfo.strength === 'standard' ? '🔒' : '⚠️'}</Text></View>
                <View style={styles.flex}>
                  <Text style={styles.statusTitle}>{securityInfo.algorithmName}</Text>
                  <Text style={styles.statusSub}>{securityInfo.strength === 'high' ? 'Protection maximale' : securityInfo.strength === 'standard' ? `${securityInfo.iterations?.toLocaleString() || ''} itérations` : 'Mise à jour recommandée'}</Text>
                  {securityInfo.needsUpgrade && <Text style={[styles.statusSub, { color: theme.colors.warning, marginTop: 4, fontSize: 12 }]}>💡 Changez votre mot de passe pour renforcer la sécurité</Text>}
                </View>
              </View>
            )}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>VERROUILLAGE AUTOMATIQUE</Text>
              <View style={styles.optionsCard}>
                {TIMEOUT_OPTIONS.map((o, i) => (
                  <TouchableOpacity key={o.value} style={[styles.optionRow, i === TIMEOUT_OPTIONS.length - 1 && styles.optionRowLast]} onPress={() => handleUpdateSettings(o.value)} activeOpacity={0.7}>
                    <Text style={styles.optionLabel}>{o.label}</Text>
                    {settings.timeoutMinutes === o.value && <View style={styles.checkBadge}><Text style={styles.checkIconText}>✓</Text></View>}
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>ACTIONS</Text>
              <TouchableOpacity style={styles.actionCard} onPress={() => setScreen('change-password')} activeOpacity={0.7}>
                <View style={[styles.actionIcon, { backgroundColor: theme.colors.primary + '15' }]}><Text style={{ fontSize: 20 }}>🔐</Text></View>
                <View style={styles.flex}><Text style={styles.actionTitle}>Changer le mot de passe</Text><Text style={styles.actionSubtitle}>Modifier votre mot de passe actuel</Text></View>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionCard, styles.actionCardDanger]} onPress={() => setShowDisableConfirm(true)} activeOpacity={0.7}>
                <View style={[styles.actionIcon, { backgroundColor: theme.colors.danger + '15' }]}><Text style={{ fontSize: 20 }}>🔓</Text></View>
                <View style={styles.flex}><Text style={[styles.actionTitle, { color: theme.colors.danger }]}>Désactiver la protection</Text><Text style={styles.actionSubtitle}>Supprimer le verrouillage</Text></View>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.infoCard}><Text style={{ fontSize: 20 }}>💡</Text><Text style={[styles.flex, styles.infoText]}>Le verrouillage s'active automatiquement quand vous quittez l'app ou verrouillez votre écran.</Text></View>
          </>
        ) : (
          <View style={styles.enableSection}>
            <Text style={styles.enableDesc}>Protégez vos conversations avec un mot de passe. Vos données seront chiffrées localement et inaccessibles sans authentification.</Text>
            <View style={styles.featuresCard}>
              {['Chiffrement local des données', 'Verrouillage automatique', 'Protection après fermeture'].map((f, i) => (
                <View key={i} style={styles.featureRow}><Text style={styles.featureCheck}>✓</Text><Text style={styles.featureText}>{f}</Text></View>
              ))}
            </View>
            <Button title="Activer la protection" onPress={() => setScreen('setup-password')} variant="primary" size="large" fullWidth />
          </View>
        )}
      </ScrollView>

      <BottomSheet visible={showDisableConfirm} onClose={() => { setShowDisableConfirm(false); setDisablePassword(''); setFormError(null); }} title="Désactiver la protection">
        <View style={{ paddingBottom: 20 }}>
          <Text style={styles.formSubtitle}>Entrez votre mot de passe pour confirmer</Text>
          <TextInput style={[styles.input, { marginTop: 16 }]} value={disablePassword} onChangeText={t => { setDisablePassword(t); setFormError(null); }} placeholder="Votre mot de passe" placeholderTextColor={theme.colors.placeholder} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" autoComplete="password" returnKeyType="done" blurOnSubmit />
          {formError && <View style={[styles.errorBanner, { marginTop: 12 }]}><Text style={{ fontSize: 18 }}>⚠️</Text><Text style={styles.errorText}>{formError}</Text></View>}
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 20 }}>
            <Button title="Annuler" onPress={() => { setShowDisableConfirm(false); setDisablePassword(''); setFormError(null); }} variant="secondary" size="medium" style={{ flex: 1 }} />
            <Button title="Désactiver" onPress={handleDisableLock} variant="danger" size="medium" loading={actionLoading} style={{ flex: 1 }} />
          </View>
        </View>
      </BottomSheet>
      <AlertModal visible={showSuccessModal} title="Succès" message={successMessage} primaryButton={{ title: 'OK', onPress: () => setShowSuccessModal(false) }} onClose={() => setShowSuccessModal(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  mainContent: { padding: 20 },
  formContent: { padding: 20, paddingBottom: 40 },

  // Step indicator
  stepIndicator: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 28, gap: 0 },
  stepDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: theme.colors.surface, borderWidth: 2, borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center' },
  stepDotActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary + '15' },
  stepDotDone: { borderColor: theme.colors.success, backgroundColor: theme.colors.success },
  stepDoneCheck: { fontSize: 14, color: '#fff', fontWeight: '700' },
  stepLine: { width: 48, height: 2, backgroundColor: theme.colors.border },
  stepLineDone: { backgroundColor: theme.colors.success },

  headerSection: { alignItems: 'center', marginBottom: 32 },
  iconContainer: { width: 80, height: 80, borderRadius: 20, backgroundColor: theme.colors.primary + '15', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  formTitle: { fontSize: 24, fontWeight: '700', color: theme.colors.text, marginBottom: 8, textAlign: 'center' },
  formSubtitle: { fontSize: 15, color: theme.colors.textSecondary, textAlign: 'center', lineHeight: 22, paddingHorizontal: 12 },

  // Status cards
  statusCard: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, padding: 18, marginBottom: 24, gap: 14 },
  statusEnabled: { backgroundColor: theme.colors.success + '15', borderWidth: 1, borderColor: theme.colors.success + '30' },
  statusDisabled: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  statusIcon: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  statusIconOn: { backgroundColor: theme.colors.success + '25' },
  statusIconOff: { backgroundColor: theme.colors.surfaceLight },
  statusTitle: { fontSize: 17, fontWeight: '600', color: theme.colors.text, marginBottom: 2 },
  statusSub: { fontSize: 14, color: theme.colors.textSecondary },

  // Sections
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: theme.colors.textMuted, letterSpacing: 0.5, marginBottom: 12, marginLeft: 4 },
  optionsCard: { backgroundColor: theme.colors.surface, borderRadius: 16, overflow: 'hidden' },
  optionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: theme.colors.divider },
  optionRowLast: { borderBottomWidth: 0 },
  optionLabel: { fontSize: 16, color: theme.colors.text },
  checkBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.primary + '20', alignItems: 'center', justifyContent: 'center' },
  checkIconText: { fontSize: 14, color: theme.colors.primary, fontWeight: '700' },

  // Action cards
  actionCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.surface, borderRadius: 16, padding: 16, marginBottom: 12 },
  actionCardDanger: { backgroundColor: theme.colors.danger + '10', borderWidth: 1, borderColor: theme.colors.danger + '20' },
  actionIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  actionTitle: { fontSize: 16, fontWeight: '500', color: theme.colors.text, marginBottom: 2 },
  actionSubtitle: { fontSize: 13, color: theme.colors.textSecondary },
  chevron: { fontSize: 24, color: theme.colors.textMuted },

  // Enable section
  enableSection: { marginBottom: 24 },
  enableDesc: { fontSize: 15, color: theme.colors.textSecondary, lineHeight: 22, marginBottom: 20 },
  featuresCard: { backgroundColor: theme.colors.surface, borderRadius: 16, padding: 16, marginBottom: 20, borderLeftWidth: 3, borderLeftColor: theme.colors.success },
  featureRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  featureCheck: { fontSize: 14, color: theme.colors.success, fontWeight: '700', marginRight: 12 },
  featureText: { fontSize: 15, color: theme.colors.text },

  // Form
  form: { marginBottom: 24 },
  inputGroup: { marginBottom: 20 },
  inputLabel: { fontSize: 14, fontWeight: '600', color: theme.colors.textSecondary, marginBottom: 10, marginLeft: 4 },
  input: { backgroundColor: theme.colors.inputBackground, borderRadius: 16, borderWidth: 1.5, borderColor: theme.colors.inputBorder, paddingHorizontal: 18, paddingVertical: Platform.OS === 'ios' ? 16 : 14, fontSize: 16, color: theme.colors.text },
  inputError: { borderColor: theme.colors.danger + '60' },
  inputSuccess: { borderColor: theme.colors.success + '60' },
  matchIcon: { position: 'absolute', right: 18, top: Platform.OS === 'ios' ? 16 : 14, fontSize: 18, color: theme.colors.success },
  divider: { height: 1, backgroundColor: theme.colors.divider, marginVertical: 8 },

  // Password strength
  strengthRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 10 },
  strengthBar: { flex: 1, flexDirection: 'row', gap: 4 },
  strengthSegment: { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 12, fontWeight: '600', minWidth: 60 },

  // Timeout cards (step 2)
  timeoutCards: { gap: 10, marginBottom: 24 },
  timeoutCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.surface,
    borderRadius: 16, padding: 16, gap: 14,
    borderWidth: 1.5, borderColor: theme.colors.border,
  },
  timeoutCardActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary + '08' },
  timeoutCardIcon: { fontSize: 24 },
  timeoutCardLabel: { fontSize: 16, fontWeight: '600', color: theme.colors.text },
  timeoutCardLabelActive: { color: theme.colors.primary },
  timeoutCardDesc: { fontSize: 13, color: theme.colors.textSecondary, marginTop: 2 },
  recommendedBadge: { backgroundColor: theme.colors.primary + '20', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  recommendedText: { fontSize: 11, fontWeight: '600', color: theme.colors.primary },
  radioOuter: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center' },
  radioOuterActive: { borderColor: theme.colors.primary },
  radioInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: theme.colors.primary },

  // Misc
  warningCard: { flexDirection: 'row', backgroundColor: theme.colors.warning + '15', borderRadius: 16, padding: 16, marginBottom: 20, gap: 12, borderLeftWidth: 3, borderLeftColor: theme.colors.warning },
  warningTitle: { fontSize: 15, fontWeight: '600', color: theme.colors.warning, marginBottom: 4 },
  warningText: { fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 },
  infoCard: { flexDirection: 'row', backgroundColor: theme.colors.surface, borderRadius: 16, padding: 16, gap: 12, marginTop: 8 },
  infoText: { fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 },
  errorBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.danger + '15', borderRadius: 12, padding: 14, marginBottom: 16, gap: 10 },
  errorText: { fontSize: 14, color: theme.colors.danger, flex: 1 },
  bottomActions: { padding: 20, paddingTop: 12, backgroundColor: theme.colors.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
});

export default SecurityScreen;