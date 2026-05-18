// src/screens/MigrationImportScreen.tsx
// Import flow: pick a .ghostrbk file → enter password → decrypt → apply.
//
// UI: mirrors SecurityScreen's password setup look:
//   - Same formContent / formContentCompact pattern
//   - Same formTitle / formSub typography
//   - Same input + warning card styles
//   - "Hidden when keyboard up" decorative pattern for the password screen
//
// PRECONDITIONS:
//   - Device is "fresh" (no profile yet) OR user has explicitly chosen restore.
//   - Mounted from App.tsx outside the normal onboarding/lock branches.
//
// FLOW:
//   1. (intro) explanation + "Pick file" button
//   2. (file-info) header peek + "Continue" button
//   3. (password) ask backup password (mirrors SecurityScreen UI)
//   4. (decrypting) splash with progress
//   5. (applying) splash with progress
//   6. (done) success card with "wipe your old device" reminder

import { useState, useRef, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TextInput, Animated, Platform, Keyboard, KeyboardAvoidingView, BackHandler } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { decodeBase64 } from 'tweetnacl-util';
import { Header, Button, useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import { decryptAndValidateMigrationFile, applyMigrationDump, MigrationDump } from '../services/migrationService';
import { DumpDecryptError, peekDumpHeader, DumpHeader } from '../services/secureBackup';
import { ArgonUnavailableError } from '../services/appLock';
import { SplashScreen } from './SplashScreen';

interface Props {
  /** Called once import completes — App.tsx should fully re-init */
  onImported: () => void;
  /** Called when user backs out of the import flow */
  onCancel: () => void;
}

type Step = 'intro' | 'file-info' | 'password' | 'decrypting' | 'applying' | 'done';

const MAX_FILE_SIZE = 200 * 1024 * 1024;

export function MigrationImportScreen({ onImported, onCancel }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const [step, setStep] = useState<Step>('intro');
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [header, setHeader] = useState<DumpHeader | null>(null);
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [kbVisible, setKbVisible] = useState(false);

  const dumpRef = useRef<MigrationDump | null>(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;

  // Keyboard listener — same pattern as SecurityScreen
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(show, () => setKbVisible(true));
    const s2 = Keyboard.addListener(hide, () => setKbVisible(false));
    return () => { s1.remove(); s2.remove(); };
  }, []);

  // Entrance animation per step
  useEffect(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(20);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 350, useNativeDriver: true }),
    ]).start();
  }, [step]);

  // ════════════════════════════════════════════════════════════════════════
  // RETOUR MATÉRIEL ANDROID — protection multi-étapes
  // ════════════════════════════════════════════════════════════════════════
  // Étapes "actives" (decrypting, applying) : Argon2 + déchiffrement +
  //   réinjection des données dans le storage chiffré tournent. Couper en
  //   plein milieu corrompt l'état de l'app (sessions partiellement importées,
  //   clés non rotées, etc.). On bloque strictement le retour.
  //
  // Étapes "navigation" (intro, file-info, password, done) : on délègue à
  //   onCancel() qui ramène proprement l'utilisateur en arrière. Sur 'done',
  //   onCancel() équivaut à valider et sortir du flow d'import.
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'decrypting' || step === 'applying') {
        // Ops cryptographiques en cours → BLOQUÉ
        return true;
      }
      if (step === 'password' && password.length > 0) {
        // L'utilisateur a commencé à taper son mot de passe → on revient à
        // l'étape précédente plutôt que de tout annuler, comportement plus
        // doux que l'annulation complète.
        setStep('file-info');
        setPassword('');
        setFormError(null);
        return true;
      }
      // intro / file-info / password vide / done → annuler proprement
      onCancel();
      return true;
    });
    return () => sub.remove();
  }, [step, password, onCancel]);

  useEffect(() => () => { dumpRef.current = null; }, []);

  const goToStep = (next: Step) => {
    setStep(next);
    setFormError(null);
  };

  // ─── 1. Pick file ────────────────────────────────────────────────────
  const handlePickFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) {
        setFormError(t('migrationImport.errorNoFile'));
        return;
      }

      const info = await FileSystem.getInfoAsync(asset.uri, { size: true });
      if (!info.exists) {
        setFormError(t('migrationImport.errorNoFile'));
        return;
      }
      const size = (info as any).size as number | undefined;
      if (size != null && size > MAX_FILE_SIZE) {
        setFormError(t('migrationImport.errorTooLarge'));
        return;
      }

      const base64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const bytes = decodeBase64(base64);

      let parsedHeader: DumpHeader;
      try {
        parsedHeader = peekDumpHeader(bytes);
      } catch (e) {
        if (e instanceof DumpDecryptError) {
          if (e.reason === 'unsupported_version') {
            setFormError(t('migrationImport.errorVersion'));
          } else {
            setFormError(t('migrationImport.errorInvalid'));
          }
        } else {
          setFormError(t('migrationImport.errorInvalid'));
        }
        return;
      }

      setFileBytes(bytes);
      setHeader(parsedHeader);
      goToStep('file-info');
    } catch (e) {
      __DEV__ && console.error('[MigrationImport] pick error:', e);
      setFormError(t('migrationImport.errorPick'));
    }
  }, [t]);

  // ─── 2. Decrypt + apply ──────────────────────────────────────────────
  const handleDecryptAndApply = useCallback(async () => {
    Keyboard.dismiss();
    if (!fileBytes) {
      setFormError(t('migrationImport.errorNoFile'));
      return;
    }
    if (!password) {
      setFormError(t('migrationImport.errorEmptyPassword'));
      return;
    }

    setFormError(null);
    setProgress(0);
    setProgressLabel(t('migrationImport.preparing'));
    goToStep('decrypting');

    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    try {
      const dump = await decryptAndValidateMigrationFile(
        fileBytes,
        password,
        (p, label) => {
          setProgress(p);
          if (label === 'kdf') setProgressLabel(t('migrationImport.derivingKey'));
          else if (label === 'verify') setProgressLabel(t('migrationImport.verifying'));
          else if (label === 'decrypt') setProgressLabel(t('migrationImport.decrypting'));
          else if (label === 'parsing') setProgressLabel(t('migrationImport.parsing'));
        }
      );

      dumpRef.current = dump;
      setPassword('');

      goToStep('applying');
      setProgress(0);
      setProgressLabel(t('migrationImport.wiping'));

      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

      await applyMigrationDump(dump, (p, label) => {
        setProgress(p);
        if (label === 'wipe') setProgressLabel(t('migrationImport.wiping'));
        else if (label === 'init_keys') setProgressLabel(t('migrationImport.initKeys'));
        else if (label === 'identity') setProgressLabel(t('migrationImport.restoringIdentity'));
        else if (label === 'prekeys') setProgressLabel(t('migrationImport.restoringPreKeys'));
        else if (label === 'sessions') setProgressLabel(t('migrationImport.restoringSessions'));
        else if (label === 'profile') setProgressLabel(t('migrationImport.restoringProfile'));
        else if (label === 'conversations') setProgressLabel(t('migrationImport.restoringMessages'));
        else if (label === 'finalize') setProgressLabel(t('migrationImport.finalizing'));
      });

      setFileBytes(null);
      dumpRef.current = null;

      goToStep('done');
    } catch (e) {
      __DEV__ && console.error('[MigrationImport] decrypt/apply error:', e);
      if (e instanceof DumpDecryptError) {
        if (e.reason === 'wrong_password') {
          setFormError(t('migrationImport.errorWrongPassword'));
        } else if (e.reason === 'unsupported_version') {
          setFormError(t('migrationImport.errorVersion'));
        } else {
          setFormError(t('migrationImport.errorInvalid'));
        }
      } else if (e instanceof ArgonUnavailableError) {
        setFormError(t('migrationImport.errorCryptoMissing'));
      } else if (
        e instanceof Error &&
        e.message.includes('Hardware encryption initialization failed')
      ) {
        // applyMigrationDump aborts cleanly when the OS keystore is
        // unavailable rather than writing data in plaintext. Direct the
        // user to reboot and retry — this is almost always transient
        // (boot-time keystore not yet ready, biometric/locker quirk).
        setFormError(
          t('migrationImport.errorHardwareKeyInit') ||
          t('migrationImport.errorGeneric')
        );
      } else {
        setFormError(t('migrationImport.errorGeneric'));
      }
      goToStep('password');
    }
  }, [fileBytes, password, t]);

  const formatExportedAt = (ts: number) => {
    try {
      return new Date(ts).toLocaleString(undefined, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return new Date(ts).toISOString();
    }
  };

  // ──────────────────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────────────────

  if (step === 'decrypting' || step === 'applying') {
    return (
      <SplashScreen
        statusMessage={progressLabel}
        progress={progress > 0 ? progress : undefined}
      />
    );
  }

  // ── INTRO ─────────────────────────────────────────────────────────────
  if (step === 'intro') {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Header title="" onBackPress={onCancel} />
        <Animated.View style={[styles.flex, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
          <ScrollView style={styles.flex} contentContainerStyle={styles.formContent} showsVerticalScrollIndicator={false}>
            <View style={styles.heroIcon}>
              <Ionicons name="cloud-download-outline" size={36} color={colors.primary} />
            </View>

            <Text style={styles.formTitle}>{t('migrationImport.introTitle')}</Text>
            <Text style={styles.formSub}>{t('migrationImport.introLead')}</Text>

            <View style={styles.warningCard}>
              <View style={styles.warningAccent} />
              <View style={{ flex: 1 }}>
                <Text style={styles.warningTitle}>{t('migrationImport.beforeYouStartTitle')}</Text>
                <Text style={styles.warningText}>{t('migrationImport.beforeYouStartBody')}</Text>
              </View>
            </View>

            {formError && <Text style={styles.errorText}>{formError}</Text>}

            <View style={styles.inlineAction}>
              <Button
                title={t('migrationImport.pickFileButton')}
                onPress={handlePickFile}
                variant="primary"
                size="large"
                fullWidth
                icon={<Ionicons name="folder-open-outline" size={20} color={colors.background} />}
              />
            </View>
          </ScrollView>
        </Animated.View>
      </View>
    );
  }

  // ── FILE INFO ─────────────────────────────────────────────────────────
  if (step === 'file-info') {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Header title="" onBackPress={() => goToStep('intro')} />
        <Animated.View style={[styles.flex, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
          <ScrollView style={styles.flex} contentContainerStyle={styles.formContent} showsVerticalScrollIndicator={false}>
            <View style={[styles.heroIcon, styles.heroIconSuccess]}>
              <Ionicons name="document-lock-outline" size={36} color={colors.success} />
            </View>

            <Text style={styles.formTitle}>{t('migrationImport.fileFoundTitle')}</Text>
            <Text style={styles.formSub}>{t('migrationImport.fileFoundLead')}</Text>

            <View style={styles.metaCard}>
              <View style={styles.metaRow}>
                <Ionicons name="time-outline" size={18} color={colors.textSecondary} />
                <Text style={styles.metaLabel}>{t('migrationImport.metaCreatedAt')}</Text>
              </View>
              <Text style={styles.metaValue}>
                {header?.createdAt ? formatExportedAt(header.createdAt) : '—'}
              </Text>

              <View style={styles.divider} />

              <View style={styles.metaRow}>
                <Ionicons name="apps-outline" size={18} color={colors.textSecondary} />
                <Text style={styles.metaLabel}>{t('migrationImport.metaAppVersion')}</Text>
              </View>
              <Text style={styles.metaValue}>{header?.appVersion ?? '—'}</Text>

              <View style={styles.divider} />

              <View style={styles.metaRow}>
                <Ionicons name="lock-closed" size={18} color={colors.textSecondary} />
                <Text style={styles.metaLabel}>{t('migrationImport.metaProtected')}</Text>
              </View>
              <Text style={[styles.metaValue, { color: colors.success }]}>
                {t('migrationImport.metaArgon2id')}
              </Text>
            </View>

            <View style={styles.inlineAction}>
              <Button
                title={t('migrationImport.continueButton')}
                onPress={() => goToStep('password')}
                variant="primary"
                size="large"
                fullWidth
              />
            </View>
          </ScrollView>
        </Animated.View>
      </View>
    );
  }

  // ── PASSWORD (mirrors SecurityScreen pattern) ─────────────────────────
  if (step === 'password') {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Header title="" onBackPress={() => goToStep('file-info')} />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        >
          <ScrollView
            style={styles.flex}
            contentContainerStyle={[styles.formContent, kbVisible && styles.formContentCompact]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {!kbVisible && (
              <View style={[styles.heroIcon, { borderColor: colors.primary + '40', backgroundColor: colors.primary + '15' }]}>
                <Ionicons name="key" size={32} color={colors.primary} />
              </View>
            )}

            <Text style={[styles.formTitle, kbVisible && styles.formTitleStandalone]}>
              {t('migrationImport.pwdTitle')}
            </Text>
            {!kbVisible && (
              <Text style={styles.formSub}>{t('migrationImport.pwdLead')}</Text>
            )}

            <View style={styles.fieldGroup}>
              <TextInput
                style={[styles.input, formError && styles.inputErr]}
                value={password}
                onChangeText={(v) => {
                  setPassword(v);
                  if (formError) setFormError(null);
                }}
                placeholder={t('migrationImport.pwdPlaceholder')}
                placeholderTextColor={colors.placeholder}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="password"
                textContentType="password"
                returnKeyType="done"
                onSubmitEditing={handleDecryptAndApply}
                autoFocus
              />
            </View>

            {!kbVisible && formError && <Text style={styles.errorText}>{formError}</Text>}
            {kbVisible && formError && <Text style={[styles.errorText, { marginBottom: 8 }]}>{formError}</Text>}

            {!kbVisible && (
              <View style={styles.warningCard}>
                <View style={styles.warningAccent} />
                <Text style={styles.warningText}>{t('migrationImport.pwdHint')}</Text>
              </View>
            )}

            <View style={styles.inlineAction}>
              <Button
                title={t('migrationImport.restoreButton')}
                onPress={handleDecryptAndApply}
                variant="primary"
                size="large"
                fullWidth
                disabled={!password}
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ── DONE ──────────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Animated.View style={[styles.flex, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
          <ScrollView style={styles.flex} contentContainerStyle={styles.formContent} showsVerticalScrollIndicator={false}>
            <View style={[styles.heroIcon, styles.heroIconSuccess]}>
              <Ionicons name="checkmark-circle" size={44} color={colors.success} />
            </View>

            <Text style={styles.formTitle}>{t('migrationImport.doneTitle')}</Text>
            <Text style={styles.formSub}>{t('migrationImport.doneLead')}</Text>

            <View style={[styles.warningCard, { backgroundColor: colors.danger + '10' }]}>
              <View style={[styles.warningAccent, { backgroundColor: colors.danger }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.warningTitle}>{t('migrationImport.wipeOldTitle')}</Text>
                <Text style={styles.warningText}>{t('migrationImport.wipeOldBody')}</Text>
              </View>
            </View>

            <View style={styles.inlineAction}>
              <Button
                title={t('migrationImport.openAppButton')}
                onPress={onImported}
                variant="primary"
                size="large"
                fullWidth
              />
            </View>
          </ScrollView>
        </Animated.View>
      </View>
    );
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────
// STYLES — mirror of SecurityScreen
// ────────────────────────────────────────────────────────────────────────

const makeStyles = (colors: ColorPalette) => ({
  container: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },

  formContent: { padding: 24, paddingBottom: 40 },
  formContentCompact: { paddingTop: 16, paddingBottom: 24 },

  heroIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 24,
    borderWidth: 1.5,
    backgroundColor: colors.primary + '15',
    borderColor: colors.primary + '40',
  },
  heroIconSuccess: {
    backgroundColor: colors.success + '15',
    borderColor: colors.success + '40',
  },

  formTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  formTitleStandalone: { marginBottom: 24 },
  formSub: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
  },

  fieldGroup: { marginBottom: 16 },

  input: {
    backgroundColor: colors.inputBackground,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.inputBorder,
    paddingHorizontal: 18,
    paddingVertical: Platform.OS === 'ios' ? 16 : 14,
    fontSize: 16,
    color: colors.text,
  },
  inputErr: { borderColor: colors.danger + '60' },

  errorText: {
    color: colors.danger,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
    marginBottom: 16,
  },

  warningCard: {
    flexDirection: 'row',
    backgroundColor: colors.warning + '10',
    borderRadius: 12,
    padding: 14,
    marginTop: 8,
    gap: 0,
    overflow: 'hidden',
  },
  warningAccent: {
    width: 3,
    backgroundColor: colors.warning,
    borderRadius: 2,
    marginRight: 14,
  },
  warningTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 4,
  },
  warningText: {
    flex: 1,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },

  inlineAction: { marginTop: 24 },

  // file-info specific
  metaCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 18,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  metaLabel: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  metaValue: {
    fontSize: 15,
    color: colors.text,
    fontWeight: '600',
    marginLeft: 26,
  },
  divider: {
    height: 1,
    backgroundColor: colors.divider,
    marginVertical: 12,
  },
}) as const;
