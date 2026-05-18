// src/screens/MigrationExportScreen.tsx
// Export flow: choose backup password → generate encrypted dump → share → freeze.
//
// UI: mirrors the exact pattern of SecurityScreen's lock setup flow:
//   - Step indicators (stepDot/stepDotActive/stepLine)
//   - Same form layout (formContent, formContentCompact when keyboard up)
//   - Same input style + strength indicator + match icon
//   - Same warning card with accent
//   - Same "hidden when keyboard up" decorative elements pattern
//
// FLOW:
//   Step 1 of 2 — set + confirm password (single screen, like SecurityScreen)
//   Step 2 of 2 — generate, share, freeze (multi-state share screen)

import { useState, useRef, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Animated, Platform, Keyboard, KeyboardAvoidingView, BackHandler } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Header, Button, AlertModal, useTheme, useThemedStyles, type ColorPalette } from '../components/ui';
import { createMigrationFile, wipeAfterExport } from '../services/migrationService';
import { markWiping } from '../services/migrationState';
import { estimatePasswordStrength, ArgonUnavailableError } from '../services/appLock';
import { encodeBase64 } from 'tweetnacl-util';
import { SplashScreen } from './SplashScreen';

interface Props {
  onBack: () => void;
  /** Called once the device has been wiped (no intermediate freeze).
   *  The parent should re-route to onboarding. */
  onWiped: () => void;
  /** App version string injected by the parent */
  appVersion: string;
}

type Step = 'set-password' | 'generating' | 'share' | 'wiping';

const MIN_PASSWORD_LENGTH = 8;

export function MigrationExportScreen({ onBack, onWiped, appVersion }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const [step, setStep] = useState<Step>('set-password');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');

  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number>(0);
  const [shareDone, setShareDone] = useState(false);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);

  // The user can only wipe if they've actually shared/saved (shareDone)
  // AND explicitly confirmed they have the file in a safe place (savedConfirmed).
  // Two gates because the OS doesn't tell us whether a "share" actually
  // resulted in a saved file — the user might have cancelled the picker.
  const canWipe = shareDone && savedConfirmed;

  // ════════════════════════════════════════════════════════════════════════
  // RETOUR MATÉRIEL ANDROID — protection multi-étapes
  // ════════════════════════════════════════════════════════════════════════
  // L'app.tsx définit déjà gestureEnabled: false (bloque le swipe iOS), mais
  // pas le hardware back Android. On ajoute la protection ici :
  //
  //   - 'generating' (Argon2id + chiffrement de la sauvegarde) : BLOQUÉ
  //   - 'share' (fichier généré, en cours de partage) : BLOQUÉ — revenir en
  //     arrière à ce stade laisserait un fichier .ghostr sur le disque sans
  //     possibilité de le re-générer (clés déjà rotées) → l'utilisateur DOIT
  //     explicitement valider via la modale de confirmation wipe ou kill l'app.
  //   - 'wiping' (nuclearReset + suppression du cache) : BLOQUÉ — interrompre
  //     un wipe en cours laisse un device dans un état partiellement effacé.
  //     Si l'app est tuée pendant cette étape, le marker 'wiping' persiste
  //     en SecureStore et le prochain boot déclenche resumePendingWipe().
  //   - 'set-password' (saisie du mot de passe) : autorisé → onBack()
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'set-password') {
        onBack();
        return true;
      }
      // generating / share / wiping : on bloque, l'utilisateur doit utiliser
      // les boutons d'action explicites ou la modale de confirmation wipe.
      return true;
    });
    return () => sub.remove();
  }, [step, onBack]);

  const [kbVisible, setKbVisible] = useState(false);

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

  const goToStep = (next: Step) => {
    setStep(next);
    setFormError(null);
  };

  // Strength indicator — clone of SecurityScreen.getStrength()
  const getStrength = (pw: string) => {
    if (!pw || pw.length < MIN_PASSWORD_LENGTH) return null;
    const s = estimatePasswordStrength(pw);
    const strengthColors = [
      colors.danger,
      colors.danger,
      colors.warning,
      colors.primary,
      colors.success,
    ];
    const labels = [
      '',
      t('security.strength.weak'),
      t('security.strength.medium'),
      t('security.strength.good'),
      t('security.strength.excellent'),
    ];
    return { level: s.score, color: strengthColors[s.score], label: labels[s.score] };
  };

  const resetForm = () => {
    setNewPassword('');
    setConfirmPassword('');
    setFormError(null);
  };

  // ─── Step 1: validate password + start generation ────────────────────
  const handlePasswordNext = async () => {
    Keyboard.dismiss();

    if (!newPassword.trim()) {
      setFormError(t('migrationExport.errorEmpty'));
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setFormError(t('security.errors.tooShort', { count: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError(t('migrationExport.errorMismatch'));
      return;
    }

    setFormError(null);
    setProgress(0);
    setProgressLabel(t('migrationExport.preparing'));
    goToStep('generating');

    // Yield a frame so the splash paints before Argon2id blocks the JS thread
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    try {
      const result = await createMigrationFile(newPassword, appVersion, (p, label) => {
        setProgress(p);
        if (label === 'collect') setProgressLabel(t('migrationExport.collecting'));
        else if (label === 'kdf') setProgressLabel(t('migrationExport.derivingKey'));
        else if (label === 'encrypt') setProgressLabel(t('migrationExport.encrypting'));
        else if (label === 'finalizing') setProgressLabel(t('migrationExport.finalizing'));
      });

      // Write to disk for sharing
      const filename = `ghostr-migration-${formatStamp(Date.now())}.ghostrbk`;
      const cacheDir = FileSystem.cacheDirectory;
      if (!cacheDir) {
        throw new Error('Cache directory not available on this device');
      }
      const path = cacheDir + filename;
      const base64 = encodeBase64(result.bytes);
      await FileSystem.writeAsStringAsync(path, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      setFilePath(path);
      setFileHash(result.hash);
      setFileSize(result.size);

      // Clear sensitive in-memory password copies
      resetForm();

      goToStep('share');
    } catch (e) {
      __DEV__ && console.error('[MigrationExport] generate error:', e);
      if (e instanceof ArgonUnavailableError) {
        setFormError(t('migrationExport.errorCryptoMissing'));
      } else {
        setFormError(t('migrationExport.errorGeneric'));
      }
      goToStep('set-password');
    }
  };

  const handleShare = async () => {
    if (!filePath) return;
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        setFormError(t('migrationExport.sharingUnavailable'));
        return;
      }
      await Sharing.shareAsync(filePath, {
        mimeType: 'application/octet-stream',
        dialogTitle: t('migrationExport.shareDialogTitle'),
      });
      setShareDone(true);
    } catch (e) {
      __DEV__ && console.error('[MigrationExport] share error:', e);
      setShareDone(true);
    }
  };

  /**
   * Android-only: explicit "Save to a folder" action using Storage Access
   * Framework. iOS doesn't need this — the standard Sharing.shareAsync sheet
   * already includes "Save to Files" natively. On Android, the share intent
   * doesn't always surface "Save to..." prominently, so this gives a clear
   * direct path to a Files-app-equivalent destination.
   */
  const handleSaveToFolder = async () => {
    if (!filePath || Platform.OS !== 'android') return;
    try {
      const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!permissions.granted) {
        return; // user cancelled — silent
      }

      // Read the cached file as base64
      const base64 = await FileSystem.readAsStringAsync(filePath, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Create a new file in the chosen directory
      const filename = filePath.split('/').pop() || 'ghostr-migration.ghostrbk';
      const newUri = await FileSystem.StorageAccessFramework.createFileAsync(
        permissions.directoryUri,
        filename,
        'application/octet-stream'
      );

      // Write the bytes
      await FileSystem.writeAsStringAsync(newUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      setShareDone(true);
    } catch (e) {
      __DEV__ && console.error('[MigrationExport] saveToFolder error:', e);
      setFormError(t('migrationExport.saveToFolderError'));
    }
  };

  const handleFinalizeWipe = async () => {
    if (!fileHash) return;
    setShowWipeConfirm(false);
    setProgressLabel(t('migrationExport.wipingDevice') || t('migrationLockdown.wiping'));
    goToStep('wiping');

    // Yield a frame so the splash paints before the heavy work begins.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    // ────────────────────────────────────────────────────────────────────
    // CONCURRENCY: We DO NOT call wipeAfterExport here. Reason:
    //   1. wipeAfterExport's first step is markWiping(), which mutates the
    //      migration state machine.
    //   2. App.tsx subscribes to that state — once 'wiping' lands, the App
    //      re-renders and switches to MigrationLockdownScreen.
    //   3. MigrationLockdownScreen on mount calls resumePendingWipe() which
    //      ALSO calls wipeAfterExport().
    //   4. The result would be two concurrent nuclearReset / AsyncStorage.clear
    //      / SecureStore.deleteItemAsync calls racing each other.
    //
    // Instead we ONLY persist the "wipe pending" marker here. The parent
    // unmounts this screen, MigrationLockdownScreen takes over and runs the
    // single authoritative wipe pipeline. This screen will be unmounted
    // before the next line executes anyway — anything after markWiping is
    // defensive fallback if the React re-render somehow doesn't happen.
    // ────────────────────────────────────────────────────────────────────
    try {
      await markWiping(fileHash, appVersion, filePath ?? undefined, fileSize);
      // Component is about to be unmounted by the App-level listener.
      // We intentionally do NOT call onWiped() — that's the lockdown screen's
      // responsibility once the wipe pipeline completes.
    } catch (markErr) {
      __DEV__ && console.error('[MigrationExport] markWiping failed, falling back to in-place wipe:', markErr);
      // Defensive fallback: SecureStore is unavailable or some other
      // catastrophic failure. Run the wipe pipeline in-place so the user
      // is not stranded with their dump but no path forward.
      try {
        await wipeAfterExport(fileHash, appVersion, filePath ?? undefined, fileSize);
      } catch (wipeErr) {
        __DEV__ && console.error('[MigrationExport] in-place wipe error:', wipeErr);
      }
      onWiped();
    }
  };

  // ───────────────────────────────────────────────────────────────────
  // RENDERS
  // ───────────────────────────────────────────────────────────────────

  if (step === 'generating') {
    return (
      <SplashScreen
        statusMessage={progressLabel}
        progress={progress > 0 ? progress : undefined}
      />
    );
  }

  if (step === 'wiping') {
    // Splash while wipeAfterExport runs. Once it returns, onWiped() is
    // called and the parent unmounts this screen.
    return <SplashScreen statusMessage={progressLabel} />;
  }

  // ── STEP 1 — Set + Confirm Password (mirror SecurityScreen layout) ──
  if (step === 'set-password') {
    const strength = getStrength(newPassword);
    const passwordsMatch = confirmPassword.length > 0 && newPassword === confirmPassword;

    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <Header title="" onBackPress={onBack} />
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
            {/* Steps — hidden when keyboard up (same as SecurityScreen) */}
            {!kbVisible && (
              <View style={styles.steps}>
                <View style={[styles.stepDot, styles.stepDotActive]}>
                  <Text style={styles.stepNum}>1</Text>
                </View>
                <View style={styles.stepLine} />
                <View style={styles.stepDot}>
                  <Text style={styles.stepNum}>2</Text>
                </View>
              </View>
            )}

            <Text style={[styles.formTitle, kbVisible && styles.formTitleStandalone]}>
              {t('migrationExport.createPasswordTitle')}
            </Text>
            {!kbVisible && (
              <Text style={styles.formSub}>
                {t('migrationExport.createPasswordDesc')}
              </Text>
            )}

            {/* Password */}
            <View style={styles.fieldGroup}>
              <TextInput
                style={[styles.input, formError && !newPassword.trim() && styles.inputErr]}
                value={newPassword}
                onChangeText={txt => { setNewPassword(txt); setFormError(null); }}
                placeholder={t('security.minCharsPlaceholder', { count: MIN_PASSWORD_LENGTH })}
                placeholderTextColor={colors.placeholder}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                autoComplete="new-password"
                returnKeyType="next"
              />
              {strength && (
                <View style={styles.strengthRow}>
                  <View style={styles.strengthBar}>
                    {[1, 2, 3, 4].map(i => (
                      <View
                        key={i}
                        style={[
                          styles.strengthSeg,
                          { backgroundColor: i <= strength.level ? strength.color : colors.border },
                        ]}
                      />
                    ))}
                  </View>
                  <Text style={[styles.strengthLabel, { color: strength.color }]}>
                    {strength.label}
                  </Text>
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
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  autoComplete="new-password"
                  returnKeyType="done"
                  blurOnSubmit
                  onSubmitEditing={handlePasswordNext}
                />
                {passwordsMatch && <Text style={styles.matchIcon}>✓</Text>}
              </View>
            </View>

            {!kbVisible && formError && (
              <Text style={styles.errorText}>{formError}</Text>
            )}

            {!kbVisible && (
              <View style={styles.warningCard}>
                <View style={styles.warningAccent} />
                <Text style={styles.warningText}>
                  {t('migrationExport.forgotWarning')}
                </Text>
              </View>
            )}

            <View style={styles.inlineAction}>
              <Button
                title={t('migrationExport.createBackupButton')}
                onPress={handlePasswordNext}
                variant="primary"
                size="large"
                fullWidth
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ── STEP 2 — Share + Freeze (also mirrors SecurityScreen visual language) ──
  if (step === 'share') {
    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <Header title="" />
        <Animated.View style={[styles.flex, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.formContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Steps — step 1 done, step 2 active */}
            <View style={styles.steps}>
              <View style={[styles.stepDot, styles.stepDotDone]}>
                <Text style={styles.stepCheck}>✓</Text>
              </View>
              <View style={[styles.stepLine, styles.stepLineDone]} />
              <View style={[styles.stepDot, styles.stepDotActive]}>
                <Text style={styles.stepNum}>2</Text>
              </View>
            </View>

            <Text style={styles.formTitle}>{t('migrationExport.readyTitle')}</Text>
            <Text style={styles.formSub}>{t('migrationExport.readyLead')}</Text>

            {/* File card */}
            <View style={styles.fileCard}>
              <View style={styles.fileIconWrap}>
                <Ionicons name="document-lock-outline" size={22} color={colors.primary} />
              </View>
              <View style={styles.fileInfo}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {filePath ? filePath.split('/').pop() : '—'}
                </Text>
                <Text style={styles.fileSize}>{formatBytes(fileSize)}</Text>
              </View>
            </View>

            <View style={styles.inlineAction}>
              <Button
                title={t('migrationExport.shareButton')}
                onPress={handleShare}
                variant="primary"
                size="large"
                fullWidth
                icon={<Ionicons name="share-outline" size={20} color={colors.background} />}
              />
              {Platform.OS === 'android' && (
                <View style={{ marginTop: 12 }}>
                  <Button
                    title={t('migrationExport.saveToFolderButton')}
                    onPress={handleSaveToFolder}
                    variant="secondary"
                    size="large"
                    fullWidth
                    icon={<Ionicons name="folder-open-outline" size={20} color={colors.text} />}
                  />
                </View>
              )}
              <Text style={styles.shareHint}>
                {Platform.OS === 'ios'
                  ? t('migrationExport.shareHintBody')
                  : t('migrationExport.shareHintBodyAndroid')}
              </Text>
            </View>

            {/* Where to put the file */}
            <View style={styles.howCard}>
              <Text style={styles.howTitle}>{t('migrationExport.optionsTitle')}</Text>
              <View style={styles.howStep}>
                <Ionicons
                  name="folder-outline"
                  size={18}
                  color={colors.primary}
                  style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.howStepLabel}>{t('migrationExport.option1Label')}</Text>
                  <Text style={styles.howStepText}>{t('migrationExport.option1Desc')}</Text>
                </View>
              </View>
              <View style={styles.howStep}>
                <Ionicons
                  name="cloud-upload-outline"
                  size={18}
                  color={colors.primary}
                  style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.howStepLabel}>{t('migrationExport.option2Label')}</Text>
                  <Text style={styles.howStepText}>{t('migrationExport.option2Desc')}</Text>
                </View>
              </View>
              <View style={styles.howStep}>
                <Ionicons
                  name="paper-plane-outline"
                  size={18}
                  color={colors.primary}
                  style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.howStepLabel}>{t('migrationExport.option3Label')}</Text>
                  <Text style={styles.howStepText}>{t('migrationExport.option3Desc')}</Text>
                </View>
              </View>
            </View>

            {/* Confirmation checkbox before allowing freeze */}
            {shareDone && (
              <TouchableOpacity
                style={styles.confirmCheck}
                onPress={() => setSavedConfirmed(!savedConfirmed)}
                activeOpacity={0.7}
              >
                <View style={[styles.checkbox, savedConfirmed && styles.checkboxChecked]}>
                  {savedConfirmed && <Ionicons name="checkmark" size={14} color="#FFF" />}
                </View>
                <Text style={styles.confirmCheckText}>
                  {t('migrationExport.savedConfirmation')}
                </Text>
              </TouchableOpacity>
            )}

            {formError && <Text style={styles.errorText}>{formError}</Text>}

            {/* Wipe warning + button */}
            <View style={styles.warningCard}>
              <View style={[styles.warningAccent, { backgroundColor: colors.danger }]} />
              <Text style={styles.warningText}>{t('migrationExport.wipeWarning') || t('migrationExport.freezeWarning')}</Text>
            </View>

            <View style={styles.inlineAction}>
              <TouchableOpacity
                style={[styles.lockBtn, !canWipe && styles.lockBtnDisabled]}
                onPress={() => canWipe && setShowWipeConfirm(true)}
                activeOpacity={canWipe ? 0.8 : 1}
                disabled={!canWipe}
              >
                <Ionicons
                  name="trash-outline"
                  size={18}
                  color={canWipe ? '#FFF' : colors.textMuted}
                  style={{ marginRight: 8 }}
                />
                <Text style={[styles.lockBtnLabel, !canWipe && { color: colors.textMuted }]}>
                  {t('migrationExport.wipeButton') || t('migrationExport.freezeButton')}
                </Text>
              </TouchableOpacity>
              {!canWipe && (
                <Text style={styles.lockHint}>
                  {!shareDone
                    ? t('migrationExport.freezeHint')
                    : t('migrationExport.freezeHintNeedConfirm')}
                </Text>
              )}
            </View>
          </ScrollView>
        </Animated.View>

        <AlertModal
          visible={showWipeConfirm}
          title={t('migrationExport.confirmWipeTitle') || t('migrationExport.confirmFreezeTitle')}
          message={t('migrationExport.confirmWipeBody') || t('migrationExport.confirmFreezeBody')}
          primaryButton={{
            title: t('migrationExport.confirmWipeYes') || t('migrationExport.confirmFreezeYes'),
            onPress: handleFinalizeWipe,
            variant: 'danger',
          }}
          secondaryButton={{
            title: t('migrationExport.confirmFreezeNo'),
            onPress: () => setShowWipeConfirm(false),
          }}
          onClose={() => setShowWipeConfirm(false)}
        />
      </View>
    );
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────

function formatStamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ────────────────────────────────────────────────────────────────────────
// STYLES — exact mirror of SecurityScreen's setup-password layout
// ────────────────────────────────────────────────────────────────────────

const makeStyles = (colors: ColorPalette) => ({
  container: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },

  formContent: { padding: 24, paddingBottom: 40 },
  formContentCompact: { paddingTop: 16, paddingBottom: 24 },

  // Step indicators (mirrors SecurityScreen)
  steps: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
    gap: 0,
  },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '15',
  },
  stepDotDone: {
    borderColor: colors.success,
    backgroundColor: colors.success,
  },
  stepNum: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  stepCheck: { fontSize: 13, color: '#fff', fontWeight: '700' },
  stepLine: { width: 40, height: 1.5, backgroundColor: colors.border },
  stepLineDone: { backgroundColor: colors.success },

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
  inputOk: { borderColor: colors.success + '60' },
  matchIcon: {
    position: 'absolute',
    right: 18,
    top: Platform.OS === 'ios' ? 16 : 14,
    fontSize: 18,
    color: colors.success,
  },

  strengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 10,
  },
  strengthBar: { flex: 1, flexDirection: 'row', gap: 4 },
  strengthSeg: { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 12, fontWeight: '600', minWidth: 60 },

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
  warningText: {
    flex: 1,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },

  inlineAction: { marginTop: 24 },

  shareHint: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 17,
    paddingHorizontal: 8,
  },

  confirmCheck: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 14,
    paddingHorizontal: 4,
    marginTop: 16,
    gap: 12,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  confirmCheckText: {
    flex: 1,
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
    fontWeight: '500',
  },

  // ── Step 2 (share) — option list (replaces old how1/how2/how3) ──
  howStepLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 2,
  },

  // ── Step 2 (share) specific ──
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fileIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary + '15',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  fileInfo: { flex: 1 },
  fileName: { fontSize: 14, fontWeight: '500', color: colors.text },
  fileSize: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  howCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    marginTop: 24,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  howTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 12,
  },
  howStep: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
    gap: 12,
  },
  howNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary + '20',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  howNumText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  howStepText: {
    flex: 1,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 19,
  },

  lockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: colors.danger,
  },
  lockBtnDisabled: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  lockBtnLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  lockHint: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 10,
    fontStyle: 'italic',
  },
}) as const;
