// src/components/AppNoticeOverlay.tsx
// ════════════════════════════════════════════════════════════════════════════
// APP NOTICE OVERLAY — Kill-switch avec export inline.
// ════════════════════════════════════════════════════════════════════════════
//
// IMPLEMENTATION CHOICE — View instead of RN Modal
//
//   On utilise un <View> en absolute fill plutôt qu'un <Modal> :
//   1. RN <Modal> sur Android Samsung One UI a des glitches d'affichage
//      quand le clavier apparaît (la fenêtre native ne propage pas bien
//      les events). Le résultat : la modale "disparaît" en cliquant un
//      input.
//   2. Le <View> vit dans l'arbre React normal, donc le clavier marche
//      normalement, et les animations React Native (opacity/scale) sont
//      stables même si le JS thread est sous pression (cas PoW + Argon2).
//
//   Le <View> doit être monté dans CHAQUE render path de App.tsx (onboarding,
//   profile setup, main) — sauf LockScreen (export impossible, app locked).
//
// FLUX
//   idle      : Modale de base — Télécharger TheGhostr / Exporter.
//   password1 : Saisie du mot de passe.   [Retour] / [Suivant]
//   password2 : Confirmation.              [Retour] / [Créer]
//   generating: Spinner + progression, puis sauvegarde plateforme-spécifique
//               (SAF Android / share iOS), puis retour automatique à idle.
// ════════════════════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Dimensions,
  Keyboard,
  type KeyboardEvent,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { encodeBase64 } from 'tweetnacl-util';
import type { NavigationContainerRef } from '@react-navigation/native';

import { useTheme, useThemedStyles, type ColorPalette } from './ui';
import {
  type AppNotice,
  getCurrentAppNotice,
  pickLocalized,
  subscribeAppNotice,
} from '../services/appNotice';
import { collectExportData } from '../services/migrationService';
import { buildEncryptedDump } from '../services/secureBackup';
import { clearMarker, getMigrationMarkerSync } from '../services/migrationState';
import { ArgonUnavailableError } from '../services/appLock';
import { suppressLock, releaseLock, withExternalActivity } from '../services/lockGuard';

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navigationRef?: React.RefObject<NavigationContainerRef<any> | null>;
}

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ════════════════════════════════════════════════════════════════════════════
const MIN_PASSWORD_LENGTH = 8;
const SNOOZE_KEY = 'app_notice_snooze_v1';
const SNOOZE_DURATION_MS = 24 * 3600 * 1000;

interface SnoozeRecord {
  issued_at: number;
  until: number;
}

async function readSnooze(): Promise<SnoozeRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(SNOOZE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.issued_at === 'number' && typeof parsed?.until === 'number') {
      return parsed;
    }
  } catch {}
  return null;
}

async function writeSnooze(issued_at: number): Promise<void> {
  try {
    const rec: SnoozeRecord = { issued_at, until: Date.now() + SNOOZE_DURATION_MS };
    await AsyncStorage.setItem(SNOOZE_KEY, JSON.stringify(rec));
  } catch {}
}

function formatStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

type FlowStep = 'idle' | 'password1' | 'password2' | 'generating';

// ════════════════════════════════════════════════════════════════════════════
// COMPOSANT
// ════════════════════════════════════════════════════════════════════════════
export function AppNoticeOverlay(_props: Props): React.ReactElement | null {
  const { t, i18n } = useTranslation();
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const [notice, setNotice] = useState<AppNotice | null>(() => getCurrentAppNotice());
  const [snoozed, setSnoozed] = useState<boolean>(false);

  // Flow state
  const [step, setStep] = useState<FlowStep>('idle');
  const [password, setPassword] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [genProgress, setGenProgress] = useState(0);
  const [genLabel, setGenLabel] = useState('');

  // Clavier — plain state, sans animation (les anims risquent de freezer
  // sous pression JS thread, et un re-render simple est suffisamment rapide).
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // SAF en cours — hide complet de l'overlay pendant que le picker système
  // s'ouvre. Sur Samsung One UI, garder notre View en absolute fill au-dessus
  // de l'écran pendant que le picker SAF revient peut crasher l'app
  // (interférence avec le rendu de la popup système).
  const [isSafActive, setIsSafActive] = useState(false);

  // Animation d'entrée — seulement à l'apparition initiale de la modale.
  // PAS d'animation entre les étapes du flow : c'est une source de bug si
  // le JS thread est saturé (l'opacité reste à 0 = carte invisible).
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.96)).current;

  const password1Ref = useRef<TextInput | null>(null);
  const password2Ref = useRef<TextInput | null>(null);

  const goIdle = useCallback(() => {
    Keyboard.dismiss();
    setStep('idle');
    setPassword('');
    setConfirmPwd('');
    setFormError(null);
    setGenProgress(0);
    setGenLabel('');
  }, []);

  // Nettoyage défensif d'un marqueur 'exporting' orphelin au mount.
  useEffect(() => {
    const marker = getMigrationMarkerSync();
    if (marker?.state === 'exporting') {
      __DEV__ &&
        console.log('[AppNoticeOverlay] cleaning up stale exporting marker on mount');
      clearMarker().catch(() => {});
    }
  }, []);

  // ── Subscribe au service
  useEffect(() => {
    const unsub = subscribeAppNotice((n) => {
      setNotice(n);
      if (!n) goIdle();
    });
    return unsub;
  }, [goIdle]);

  // ── Snooze logic
  useEffect(() => {
    let cancelled = false;
    if (!notice || notice.severity === 'critical') {
      setSnoozed(false);
      return;
    }
    (async () => {
      const rec = await readSnooze();
      if (cancelled) return;
      if (rec && rec.issued_at === notice.issued_at && rec.until > Date.now()) {
        setSnoozed(true);
      } else {
        setSnoozed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notice]);

  // ── Animation d'apparition (une seule fois, à l'arrivée du notice)
  const visible = notice !== null && !snoozed;
  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 90,
          friction: 12,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.96);
    }
  }, [visible, fadeAnim, scaleAnim]);

  // ── Lock suppression
  // On NE manipule PAS notre propre tag ScreenCapture ici. Le tag global
  // 'ghostr-global' posé par App.tsx au boot suffit (un seul tag actif
  // maintient FLAG_SECURE). Manipuler plusieurs tags simultanément peut
  // créer des race conditions natives sur Android Samsung.
  useEffect(() => {
    if (!visible) return;
    suppressLock();
    return () => {
      releaseLock();
    };
  }, [visible]);

  // ── Hardware back (Android) — remplace l'ancien Modal.onRequestClose
  useEffect(() => {
    if (!visible || Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'idle') {
        if (notice && notice.severity !== 'critical') {
          writeSnooze(notice.issued_at).then(() => setSnoozed(true));
        }
        return true;
      }
      if (step === 'password1') {
        goIdle();
        return true;
      }
      if (step === 'password2') {
        setFormError(null);
        setConfirmPwd('');
        setStep('password1');
        return true;
      }
      // generating → on bloque le back
      return true;
    });
    return () => sub.remove();
  }, [visible, step, notice, goIdle]);

  // ── Keyboard listener — gestion manuelle, plain state
  useEffect(() => {
    const onShow = (e: KeyboardEvent) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    };
    const onHide = () => {
      setKeyboardHeight(0);
    };
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, onShow);
    const hideSub = Keyboard.addListener(hideEvt, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // ── Auto-focus inputs
  useEffect(() => {
    if (step === 'password1') {
      const id = setTimeout(() => password1Ref.current?.focus(), 250);
      return () => clearTimeout(id);
    }
    if (step === 'password2') {
      const id = setTimeout(() => password2Ref.current?.focus(), 250);
      return () => clearTimeout(id);
    }
  }, [step]);

  // ════════════════════════════════════════════════════════════════════════
  // HANDLERS
  // ════════════════════════════════════════════════════════════════════════

  const handleDownloadStore = useCallback(() => {
    if (!notice) return;
    const url = Platform.OS === 'ios' ? notice.store.ios : notice.store.android;
    if (!url) return;
    Linking.openURL(url).catch((e) => {
      __DEV__ && console.warn('[AppNoticeOverlay] openURL failed:', e);
    });
  }, [notice]);

  const handleStartExport = useCallback(() => {
    setFormError(null);
    setPassword('');
    setConfirmPwd('');
    setStep('password1');
  }, []);

  const handleSnooze = useCallback(async () => {
    if (!notice) return;
    await writeSnooze(notice.issued_at);
    setSnoozed(true);
  }, [notice]);

  const handlePassword1Next = useCallback(() => {
    if (!password.trim()) {
      setFormError(t('migrationExport.errorEmpty'));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFormError(
        t('security.errors.tooShort', { count: MIN_PASSWORD_LENGTH }) ||
          `Min ${MIN_PASSWORD_LENGTH}`,
      );
      return;
    }
    setFormError(null);
    setConfirmPwd('');
    setStep('password2');
  }, [password, t]);

  const handlePassword2Confirm = useCallback(async () => {
    if (password !== confirmPwd) {
      setFormError(t('migrationExport.errorMismatch'));
      return;
    }
    setFormError(null);

    setGenProgress(0);
    setGenLabel(t('migrationExport.preparing'));
    setStep('generating');
    Keyboard.dismiss();

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    let appVersion = '1.0.0';
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      appVersion = require('../../package.json').version || appVersion;
    } catch {}

    try {
      __DEV__ && console.log('[AppNotice/export] step: collecting');
      setGenLabel(t('migrationExport.collecting'));
      setGenProgress(0.05);
      const dump = await collectExportData(appVersion);

      __DEV__ && console.log('[AppNotice/export] step: yield before kdf');
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      __DEV__ && console.log('[AppNotice/export] step: encrypt');
      const result = await buildEncryptedDump(dump, password, appVersion, (p, label) => {
        setGenProgress(0.10 + 0.85 * p);
        if (label === 'kdf' || label === 'derive_subkeys') {
          setGenLabel(t('migrationExport.derivingKey'));
        } else if (label === 'encrypt') {
          setGenLabel(t('migrationExport.encrypting'));
        } else if (label === 'finalizing') {
          setGenLabel(t('migrationExport.finalizing'));
        }
      });
      __DEV__ &&
        console.log('[AppNotice/export] step: encrypted, size=', result.bytes.length);

      const filename = `ghostr-migration-${formatStamp(Date.now())}.ghostrbk`;
      const base64Data = encodeBase64(result.bytes);

      setPassword('');
      setConfirmPwd('');

      try {
        if (Platform.OS === 'android') {
          // ──────────────────────────────────────────────────────────────
          // ANDROID — Storage Access Framework
          //
          // Stratégie :
          //   1. Hide complet de notre overlay (setIsSafActive(true)) AVANT
          //      d'appeler le picker. Samsung One UI peut crasher si une
          //      View absolute fill reste au-dessus pendant que le picker
          //      système revient.
          //   2. PAS de withExternalActivity : on a déjà suppressLock()
          //      actif depuis le mount de l'overlay (count=1). withExternal
          //      l'incrémenterait à 2 et déclencherait un releaseLockDeferred
          //      après 5s qui pourrait casser des choses.
          //   3. SAF directement, dans son propre try/catch.
          //   4. Remontage de l'overlay (setIsSafActive(false)) APRÈS, dans
          //      tous les cas (succès, refus, erreur).
          // ──────────────────────────────────────────────────────────────
          __DEV__ && console.log('[AppNotice/export] step: hide overlay before SAF');
          setIsSafActive(true);
          // Yield un frame pour que le hide soit effectif avant d'ouvrir SAF.
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );

          try {
            __DEV__ && console.log('[AppNotice/export] step: SAF requesting permission');
            const perms =
              await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
            __DEV__ &&
              console.log('[AppNotice/export] SAF perms.granted =', perms.granted);

            if (perms.granted) {
              __DEV__ && console.log('[AppNotice/export] step: SAF creating file');
              const fileUri =
                await FileSystem.StorageAccessFramework.createFileAsync(
                  perms.directoryUri,
                  filename,
                  'application/octet-stream',
                );
              __DEV__ &&
                console.log('[AppNotice/export] step: SAF writing data, uri=', fileUri);
              await FileSystem.writeAsStringAsync(fileUri, base64Data, {
                encoding: FileSystem.EncodingType.Base64,
              });
              __DEV__ && console.log('[AppNotice/export] saved to SAF →', fileUri);
            }
          } catch (safErr) {
            __DEV__ && console.warn('[AppNotice/export] SAF error:', safErr);
          } finally {
            __DEV__ && console.log('[AppNotice/export] step: restore overlay after SAF');
            setIsSafActive(false);
          }
        } else {
          // iOS — write to cache then share sheet
          const cacheDir = FileSystem.cacheDirectory;
          if (!cacheDir) throw new Error('Cache directory not available');
          const cachePath = cacheDir + filename;
          await FileSystem.writeAsStringAsync(cachePath, base64Data, {
            encoding: FileSystem.EncodingType.Base64,
          });
          const isAvailable = await Sharing.isAvailableAsync();
          if (isAvailable) {
            __DEV__ && console.log('[AppNotice/export] step: iOS share sheet');
            await withExternalActivity(() =>
              Sharing.shareAsync(cachePath, {
                mimeType: 'application/octet-stream',
                dialogTitle: t('migrationExport.shareDialogTitle'),
              }),
            );
          }
        }
      } catch (saveErr) {
        __DEV__ && console.warn('[AppNoticeOverlay] save/share outer error:', saveErr);
        setIsSafActive(false);
      }

      __DEV__ && console.log('[AppNotice/export] step: done, returning to idle');
      goIdle();
    } catch (e) {
      __DEV__ && console.error('[AppNoticeOverlay] generation error:', e);
      if (e instanceof ArgonUnavailableError) {
        setFormError(t('migrationExport.errorCryptoMissing'));
      } else {
        setFormError(t('migrationExport.errorGeneric'));
      }
      setStep('password1');
    }
  }, [password, confirmPwd, t, goIdle]);

  // ════════════════════════════════════════════════════════════════════════
  // STYLE / COULEUR
  // ════════════════════════════════════════════════════════════════════════

  const accent = useMemo<string>(() => {
    if (!notice) return colors.error;
    switch (notice.severity) {
      case 'info':
        return colors.info;
      case 'warning':
        return colors.warning;
      case 'critical':
      default:
        return colors.error;
    }
  }, [notice, colors]);

  const iconName = useMemo<keyof typeof Ionicons.glyphMap>(() => {
    if (!notice) return 'warning';
    switch (notice.severity) {
      case 'info':
        return 'information-circle';
      case 'warning':
        return 'alert-circle';
      case 'critical':
      default:
        return 'warning';
    }
  }, [notice]);

  // ════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════

  if (!visible || !notice) return null;

  // Hide complet pendant l'opération SAF : on rend null pour ne pas avoir
  // d'overlay au-dessus de la popup de permission Android native qui
  // pourrait perturber son rendu sur certaines ROMs (Samsung One UI).
  if (isSafActive) return null;

  const localeKey = i18n.language || 'en';
  const titleText = pickLocalized(notice.title, localeKey);
  const bodyText = pickLocalized(notice.body, localeKey);
  const platformStoreUrl =
    Platform.OS === 'ios' ? notice.store.ios : notice.store.android;
  const hasStore = !!platformStoreUrl;
  const isCritical = notice.severity === 'critical';
  const password1Valid = password.length >= MIN_PASSWORD_LENGTH;
  const password2Valid =
    confirmPwd.length >= MIN_PASSWORD_LENGTH && password === confirmPwd;

  // Cap du keyboardHeight pour éviter de pousser la carte off-screen sur
  // appareils exotiques où l'event renvoie une hauteur farfelue.
  const screenHeight = Dimensions.get('window').height;
  const safeKbHeight = Math.min(keyboardHeight, screenHeight * 0.55);

  let body: React.ReactNode;

  if (step === 'idle') {
    body = (
      <>
        <View style={[styles.iconBadge, { backgroundColor: accent + '22' }]}>
          <Ionicons name={iconName} size={36} color={accent} />
        </View>
        <Text style={[styles.kicker, { color: accent }]}>
          {t('appNotice.kicker').toUpperCase()}
        </Text>
        <Text style={styles.title}>{titleText}</Text>
        <Text style={styles.bodyText}>{bodyText}</Text>

        <View style={styles.buttons}>
          {hasStore && (
            <TouchableOpacity
              onPress={handleDownloadStore}
              activeOpacity={0.85}
              style={[styles.btn, { backgroundColor: accent }]}
              accessibilityRole="button"
              accessibilityLabel={t('appNotice.downloadButton')}
            >
              <Ionicons
                name="download-outline"
                size={18}
                color="#FFFFFF"
                style={styles.btnIcon}
              />
              <Text style={styles.btnPrimaryText} numberOfLines={1} adjustsFontSizeToFit>
                {t('appNotice.downloadButton')}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={handleStartExport}
            activeOpacity={0.85}
            style={[styles.btn, styles.btnSecondary]}
            accessibilityRole="button"
            accessibilityLabel={t('appNotice.migrateButton')}
          >
            <Ionicons
              name="archive-outline"
              size={18}
              color={colors.text}
              style={styles.btnIcon}
            />
            <Text style={styles.btnSecondaryText} numberOfLines={1} adjustsFontSizeToFit>
              {t('appNotice.migrateButton')}
            </Text>
          </TouchableOpacity>
          {!isCritical && (
            <Pressable
              onPress={handleSnooze}
              style={styles.linkBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('appNotice.dismissButton')}
            >
              <Text style={styles.linkText}>{t('appNotice.dismissButton')}</Text>
            </Pressable>
          )}
        </View>
        <Text style={styles.footer}>{t('appNotice.footer')}</Text>
      </>
    );
  } else if (step === 'password1') {
    body = (
      <>
        <View style={styles.stepDots}>
          <View style={[styles.dot, { backgroundColor: accent }]} />
          <View style={styles.dot} />
        </View>
        <Text style={styles.title}>{t('migrationExport.createPasswordTitle')}</Text>

        <View style={styles.inputBlock}>
          <View style={styles.inputRow}>
            <Ionicons
              name="lock-closed-outline"
              size={18}
              color={colors.textMuted}
              style={styles.inputIcon}
            />
            <TextInput
              ref={password1Ref}
              value={password}
              onChangeText={(v) => {
                setPassword(v);
                if (formError) setFormError(null);
              }}
              placeholder="••••••••"
              placeholderTextColor={colors.placeholder}
              style={styles.input}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password-new"
              textContentType="newPassword"
              returnKeyType="next"
              onSubmitEditing={handlePassword1Next}
              blurOnSubmit={false}
            />
          </View>
          {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
        </View>

        <View style={styles.buttons}>
          <TouchableOpacity
            onPress={handlePassword1Next}
            activeOpacity={0.85}
            disabled={!password1Valid}
            style={[
              styles.btn,
              { backgroundColor: password1Valid ? accent : colors.surfaceElevated },
            ]}
          >
            <Text
              style={[
                styles.btnPrimaryText,
                !password1Valid && { color: colors.textMuted },
              ]}
              numberOfLines={1}
            >
              {t('common.next')}
            </Text>
            <Ionicons
              name="arrow-forward"
              size={18}
              color={password1Valid ? '#FFFFFF' : colors.textMuted}
              style={styles.btnIconRight}
            />
          </TouchableOpacity>
          <Pressable onPress={goIdle} style={styles.linkBtn} hitSlop={8}>
            <Text style={styles.linkText}>{t('common.back')}</Text>
          </Pressable>
        </View>
      </>
    );
  } else if (step === 'password2') {
    body = (
      <>
        <View style={styles.stepDots}>
          <View style={[styles.dot, { backgroundColor: accent }]} />
          <View style={[styles.dot, { backgroundColor: accent }]} />
        </View>
        <Text style={styles.title}>{t('appNotice.confirmPasswordTitle')}</Text>
        <Text style={styles.bodyText}>{t('appNotice.confirmPasswordDesc')}</Text>

        <View style={styles.inputBlock}>
          <View
            style={[
              styles.inputRow,
              password2Valid && { borderColor: colors.success },
            ]}
          >
            <Ionicons
              name="lock-closed-outline"
              size={18}
              color={password2Valid ? colors.success : colors.textMuted}
              style={styles.inputIcon}
            />
            <TextInput
              ref={password2Ref}
              value={confirmPwd}
              onChangeText={(v) => {
                setConfirmPwd(v);
                if (formError) setFormError(null);
              }}
              placeholder="••••••••"
              placeholderTextColor={colors.placeholder}
              style={styles.input}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password-new"
              textContentType="newPassword"
              returnKeyType="done"
              onSubmitEditing={handlePassword2Confirm}
            />
            {password2Valid && (
              <Ionicons
                name="checkmark-circle"
                size={20}
                color={colors.success}
                style={styles.inputCheckmark}
              />
            )}
          </View>
          {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
        </View>

        <View style={styles.buttons}>
          <TouchableOpacity
            onPress={handlePassword2Confirm}
            activeOpacity={0.85}
            disabled={!password2Valid}
            style={[
              styles.btn,
              { backgroundColor: password2Valid ? accent : colors.surfaceElevated },
            ]}
          >
            <Ionicons
              name="shield-checkmark-outline"
              size={18}
              color={password2Valid ? '#FFFFFF' : colors.textMuted}
              style={styles.btnIcon}
            />
            <Text
              style={[
                styles.btnPrimaryText,
                !password2Valid && { color: colors.textMuted },
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {t('migrationExport.createBackupButton')}
            </Text>
          </TouchableOpacity>
          <Pressable
            onPress={() => {
              setFormError(null);
              setConfirmPwd('');
              setStep('password1');
            }}
            style={styles.linkBtn}
            hitSlop={8}
          >
            <Text style={styles.linkText}>{t('common.back')}</Text>
          </Pressable>
        </View>
      </>
    );
  } else {
    // 'generating'
    body = (
      <>
        <View style={[styles.iconBadge, { backgroundColor: accent + '22' }]}>
          <ActivityIndicator size="large" color={accent} />
        </View>
        <Text style={styles.title}>{genLabel || t('migrationExport.preparing')}</Text>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${Math.max(2, Math.min(100, Math.round(genProgress * 100)))}%`,
                backgroundColor: accent,
              },
            ]}
          />
        </View>
        <Text style={styles.progressText}>{Math.round(genProgress * 100)}%</Text>
      </>
    );
  }

  // ── RENDER : <View> en absolute fill, AU LIEU d'un <Modal>.
  // Le composant doit être monté en tant que dernier enfant d'un
  // GestureHandlerRootView (ou équivalent) pour être au-dessus de tout.
  return (
    <View
      style={styles.root}
      pointerEvents="auto"
      accessibilityViewIsModal
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: fadeAnim }]}>
        {/*
          BlurView UNIQUEMENT sur iOS.
          Sur Android (surtout Samsung One UI), expo-blur a des bugs connus
          de re-render après backgrounding (quand le picker SAF backgrounde
          l'app pour la permission, le retour foreground crashait la BlurView).
          Solution : sur Android on utilise uniquement le scrim solide.
        */}
        {Platform.OS === 'ios' ? (
          <BlurView
            intensity={60}
            tint={isDark ? 'dark' : 'light'}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <View style={[StyleSheet.absoluteFill, styles.scrim]} />
      </Animated.View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + 16,
            paddingBottom: Math.max(insets.bottom + 16, safeKbHeight + 16),
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <Animated.View
          style={[
            styles.cardWrapper,
            { opacity: fadeAnim, transform: [{ scale: scaleAnim }] },
          ]}
        >
          <View style={styles.card}>{body}</View>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════════════════════
const makeStyles = (colors: ColorPalette) =>
  StyleSheet.create({
    root: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      // zIndex et elevation au max pour passer au-dessus du privacyOverlay
      // (9999) et de tout le reste. Sur Android, elevation domine.
      zIndex: 10000,
      elevation: 10000,
    },
    scrim: {
      // Plus opaque sur Android (pas de BlurView pour adoucir).
      backgroundColor:
        Platform.OS === 'ios' ? 'rgba(0, 0, 0, 0.55)' : 'rgba(0, 0, 0, 0.78)',
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: 20,
    },
    cardWrapper: {
      alignSelf: 'center',
      width: '100%',
      maxWidth: 440,
    },
    card: {
      width: '100%',
      backgroundColor: colors.surface,
      borderRadius: 28,
      paddingHorizontal: 26,
      paddingTop: 30,
      paddingBottom: 24,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      alignItems: 'center',
      shadowColor: '#000000',
      shadowOpacity: 0.55,
      shadowOffset: { width: 0, height: 18 },
      shadowRadius: 32,
      elevation: 24,
    },

    stepDots: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 18,
      gap: 6,
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.border,
    },

    iconBadge: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 14,
    },

    kicker: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.6,
      marginBottom: 8,
    },
    title: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.text,
      textAlign: 'center',
      marginBottom: 10,
      lineHeight: 28,
      letterSpacing: -0.3,
    },
    bodyText: {
      fontSize: 15,
      lineHeight: 22,
      color: colors.textSecondary,
      textAlign: 'center',
      paddingHorizontal: 4,
    },

    inputBlock: {
      width: '100%',
      marginTop: 22,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.inputBackground,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.inputBorder,
      paddingHorizontal: 14,
      height: 52,
    },
    inputIcon: {
      marginRight: 10,
    },
    input: {
      flex: 1,
      color: colors.text,
      fontSize: 16,
      paddingVertical: 0,
    },
    inputCheckmark: {
      marginLeft: 8,
    },
    errorText: {
      color: colors.error,
      fontSize: 13,
      marginTop: 10,
      textAlign: 'center',
      lineHeight: 18,
    },

    progressTrack: {
      width: '100%',
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.surfaceElevated,
      overflow: 'hidden',
      marginTop: 18,
    },
    progressFill: {
      height: '100%',
      borderRadius: 3,
    },
    progressText: {
      color: colors.textMuted,
      fontSize: 13,
      marginTop: 10,
      fontVariant: ['tabular-nums'],
    },

    buttons: {
      width: '100%',
      marginTop: 24,
    },
    btn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 14,
      paddingVertical: 15,
      paddingHorizontal: 18,
      marginBottom: 10,
    },
    btnIcon: {
      marginRight: 8,
    },
    btnIconRight: {
      marginLeft: 8,
    },
    btnPrimaryText: {
      color: '#FFFFFF',
      fontSize: 15,
      fontWeight: '700',
      flexShrink: 1,
      letterSpacing: 0.2,
    },
    btnSecondary: {
      backgroundColor: colors.surfaceElevated,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    btnSecondaryText: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
      flexShrink: 1,
    },

    linkBtn: {
      alignSelf: 'center',
      paddingVertical: 10,
      paddingHorizontal: 12,
      marginTop: 2,
    },
    linkText: {
      color: colors.textMuted,
      fontSize: 13,
      fontWeight: '500',
    },

    footer: {
      marginTop: 16,
      fontSize: 11,
      color: colors.textMuted,
      letterSpacing: 0.4,
      textAlign: 'center',
    },
  });
