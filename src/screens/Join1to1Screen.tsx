// src/screens/Join1to1Screen.tsx
// v4.0 - Uses ConnectionSuccessScreen for success + SplashScreen for processing
//
// Changes from v3:
// - Processing step uses SplashScreen component for consistent loading UX
// - Success step navigates to ConnectionSuccessScreen (same design as creator)
// - Removed inline success UI (was inconsistent with ConnectionSuccessScreen)

import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Platform, ScrollView, KeyboardAvoidingView, BackHandler, AppState } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { sessionService } from '../services/tripleRatchet';
import { Header, Button, useTheme, useThemedStyles, type ColorPalette, showAlert, showConfirm } from '../components/ui';
import { isBlockedFingerprint, unblockFingerprint } from '../services/blockService';
import { SplashScreen } from './SplashScreen';
import { suppressLock, releaseLock } from '../services/lockGuard';
import { openAppSettings } from '../services/permissions';
import { parseInviteString, parseGroupInvite } from '../services/inviteUrl';
import { GROUPS_ENABLED } from '../config/features';
import { waitForSealedSenderReady } from '../services/api1to1';

type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { conversationId: string; conversationName: string };
  ConnectionSuccess: { sessionId: string; contactName: string; inviteLabel: string; inviteTag?: string };
  Join1to1: { pendingInviteString?: string } | undefined;
  JoinGroup: { inviteString: string };
};

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Join1to1'>;
type Join1to1RouteProp = RouteProp<RootStackParamList, 'Join1to1'>;

type Step = 'choose' | 'scan' | 'manual' | 'processing';

// Budget total pour la phase « connexion sécurisée » avant traitement de
// l'invitation. Identique à Create1to1Screen pour cohérence UX.
// 60s couvre les devices Hermes lents (cf. Create1to1Screen pour rationale).
const SS_BOOTSTRAP_TIMEOUT_MS = 60_000;

export function Join1to1Screen() {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<Join1to1RouteProp>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [permission, requestPermission, getPermission] = useCameraPermissions();

  // Nombre de dialogs système réellement tentés sur cet écran.
  // C'est ce compteur — et non le `canAskAgain` renvoyé par le get initial —
  // qui autorise l'écran à basculer sur "Ouvrir les paramètres". Sur Android,
  // `canAskAgain` vaut false à tort dans plusieurs situations courantes
  // (cache expo restauré par Auto Backup après réinstallation, permission
  // réglée sur "Toujours demander", dialog simplement annulé avec le bouton
  // retour) : s'y fier avant d'avoir essayé envoyait l'utilisateur dans les
  // Réglages système sans lui avoir jamais montré le moindre dialog.
  // Cf. le bloc "canAskAgain non fiable" dans services/permissions.ts, qui
  // applique la même règle aux autres permissions.
  const [permissionAttempts, setPermissionAttempts] = useState(0);

  const [step, setStep] = useState<Step>('choose');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  
  // Torche du scanner. Rejoindre une conversation se fait très souvent en
  // scannant l'écran de quelqu'un d'autre dans un contexte peu éclairé
  // (bar, rue le soir, salle de réunion). Sans torche, l'autofocus rame et
  // le QR n'est jamais détecté — l'utilisateur conclut que le scan est
  // cassé alors qu'il manque juste de lumière.
  const [torchOn, setTorchOn] = useState(false);

  // Manual input
  const [codeInput, setCodeInput] = useState('');
  
  const scannedRef = useRef(false);
  const lastInviteStringRef = useRef<string>('');
  // Garde anti double-traitement du pendingInviteString reçu via deep link.
  // Sans ça, un re-render du screen pourrait déclencher processInvite deux
  // fois et tenter d'accepter la même invitation deux fois (état sessionService
  // se retrouverait corrompu, OTPK consommée deux fois).
  const deepLinkProcessedRef = useRef<string | null>(null);

  // ──────────────────────────────────────────────────────────────────────
  // CLEANUP REFS — éviter setState/navigate après unmount
  // ──────────────────────────────────────────────────────────────────────
  // Sur un flow long (pré-bootstrap SS 5-30s + acceptInvite réseau), il est
  // tout à fait possible que l'utilisateur quitte l'écran (back gesture
  // bloqué pendant 'processing' mais possible avant ; deep link relance ;
  // app forcée en background → kill). Sans mountedRef, setState provoque
  // un warning React et navigation.replace tente d'aller sur un screen mort.
  // L'abortController court-circuite proprement le wait du SS.
  const mountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Abort tout pré-bootstrap en cours pour libérer la promesse
      try { abortControllerRef.current?.abort(); } catch {}
    };
  }, []);

  useEffect(() => {
    sessionService.initialize().catch(console.error);
  }, []);

  // ═══════════════════════════════════════════════════════════════════
  // RETOUR DES RÉGLAGES SYSTÈME : relire l'état de la permission caméra
  // ═══════════════════════════════════════════════════════════════════
  // useCameraPermissions ne relit l'autorisation qu'au mount. Si l'utilisateur
  // part dans les Réglages, active la caméra et revient, l'écran resterait
  // figé sur le message de refus jusqu'à un remount complet — il conclurait
  // que l'app est cassée alors qu'il vient justement de faire ce qu'on lui
  // demandait. On relit donc l'état à chaque retour au premier plan, tant
  // qu'on est sur l'étape scan et que la permission n'est pas accordée.
  useEffect(() => {
    if (step !== 'scan' || permission?.granted) return;

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      getPermission()
        .then((result) => {
          // Permission accordée depuis les Réglages : on repart d'un état
          // neuf, sinon le bouton "Ouvrir les paramètres" resterait affiché
          // si l'utilisateur la retirait ensuite.
          if (result.granted && mountedRef.current) setPermissionAttempts(0);
        })
        .catch(() => {});
    });

    return () => subscription.remove();
  }, [step, permission?.granted, getPermission]);

  // ═══════════════════════════════════════════════════════════════════
  // DEEP LINK : traitement automatique d'un inviteString reçu en param
  // ═══════════════════════════════════════════════════════════════════
  // Quand l'app est ouverte via Universal Link / App Link / scheme natif,
  // useDeepLinkInvite (côté App.tsx) navigue ici avec pendingInviteString
  // déjà extrait du fragment URL. On le traite immédiatement, sans passer
  // par l'écran de choix scan/manuel.
  useEffect(() => {
    const pending = route.params?.pendingInviteString;
    if (!pending) return;
    if (deepLinkProcessedRef.current === pending) return; // déjà traité
    deepLinkProcessedRef.current = pending;

    // Une invitation de GROUPE emprunte le MÊME lien `/i#…` qu'une invitation
    // 1:1 (cf. inviteUrl.buildInviteUrl) : ce chemin doit donc faire le même
    // tri que le scanner et la saisie manuelle. Sans lui, un lien de groupe
    // partait dans processInvite, qui attend le bootstrap SealedSender
    // (jusqu'à 60 s) avant d'échouer sur un payload qui n'est pas une
    // invitation 1:1.
    //
    // [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. On refuse via
    // showAlert et non setError : le useEffect de reset d'étape, déclaré
    // juste après celui-ci, exécute `setError(null)` au même mount et
    // effacerait la bannière avant qu'elle ne soit lue.
    const pendingGroupInvite = parseGroupInvite(pending);
    if (pendingGroupInvite) {
      if (!GROUPS_ENABLED) {
        console.log('[Join1to1] Deep-link group invite ignored — groups disabled');
        void showAlert({ title: t('join.title'), message: t('errors.qrCodeError') });
        return;
      }
      navigation.replace('JoinGroup', { inviteString: pending });
      return;
    }

    // processInvite est défini ci-dessous ; on l'appelle dans un microtask
    // pour s'assurer que les autres useEffect du mount ont eu lieu.
    Promise.resolve().then(() => processInvite(pending));
  }, [route.params?.pendingInviteString]);

  useEffect(() => {
    if (step === 'choose' || step === 'scan' || step === 'manual') {
      scannedRef.current = false;
      setError(null);
    }
    // Block back button during processing
    if (step === 'processing') {
      const backHandler = BackHandler.addEventListener('hardwareBackPress', () => true);
      return () => backHandler.remove();
    }
  }, [step]);

  // ==========================================
  // PROCESS INVITE → ConnectionSuccessScreen
  // ==========================================
  //
  // v2.0 — Refactor robustesse :
  //   • Pré-bootstrap SealedSender AVANT acceptInvite : si le SS n'est pas
  //     prêt, on échoue ICI sans consommer d'OTPK ni créer de session
  //     locale orpheline. L'utilisateur peut réessayer proprement.
  //   • sessionService.acceptInviteAndRespond throw `JOIN_SEND_FAILED` si
  //     l'envoi de la réponse échoue → on l'affiche clairement, l'utilisateur
  //     n'aura PAS l'illusion d'une session établie qui n'existe que de son côté.
  //   • mountedRef bloque tous les setState/navigate après unmount.
  //   • abortControllerRef permet d'annuler le pré-bootstrap si l'utilisateur
  //     quitte l'écran (back gesture, deep link relance, etc.).
  
  const safeSetStatus = (msg: string) => {
    if (mountedRef.current) setStatusMessage(msg);
  };

  /**
   * Garde anti-reconnexion d'un contact bloqué (guideline 1.2).
   *
   * L'empreinte d'identité n'est connue qu'APRÈS le handshake — on vérifie
   * donc une fois la session créée. Si le contact est bloqué :
   *   - déblocage explicite → la connexion continue normalement ;
   *   - refus → la session fraîchement créée est supprimée, retour au choix.
   *
   * @returns true si la connexion peut continuer.
   */
  const ensureNotBlocked = async (session: {
    id: string;
    theirIdentityKeyFingerprint?: string;
    theirProfile?: { displayName?: string };
  }): Promise<boolean> => {
    const fp = session?.theirIdentityKeyFingerprint;
    if (!(await isBlockedFingerprint(fp))) return true;

    const name = session?.theirProfile?.displayName || t('common.contact');
    const unblock = await showConfirm({
      title: t('join.blockedContactTitle'),
      message: t('join.blockedContactMessage', { name }),
      confirmText: t('join.unblockAndAccept'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (unblock && fp) {
      await unblockFingerprint(fp);
      return true;
    }
    try { await sessionService.deleteSession(session.id); } catch {}
    if (mountedRef.current) setStep('choose');
    return false;
  };
  
  const processInvite = async (inviteString: string) => {
    if (!mountedRef.current) return;
    
    setStep('processing');
    setLoading(true);
    setError(null);
    safeSetStatus(t('appBoot.preparingSecureConnection'));
    lastInviteStringRef.current = inviteString;
    
    // Reset l'AbortController pour cette tentative (peut être appelé plusieurs
    // fois si l'utilisateur retry après un échec : ancien abort signal serait
    // déjà déclenché).
    try { abortControllerRef.current?.abort(); } catch {}
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    
    try {
      // ── Phase 0 : sessionService.initialize() — local, rapide ──
      // Idempotent grâce au cache interne ; sera no-op si déjà initialisé
      // par le useEffect au mount.
      await sessionService.initialize();
      if (!mountedRef.current || signal.aborted) return;
      
      // ── Phase 1 : pré-bootstrap SealedSender ──
      // CRITIQUE : il faut que le SS soit prêt AVANT acceptInviteAndRespond,
      // sinon `sendAcceptResponseToServer` échouera après que la session
      // ait été créée + l'OTPK consommée → session orpheline silencieuse.
      // En cas d'échec ici, AUCUN état crypto n'est touché → retry safe.
      const ssReady = await waitForSealedSenderReady({
        timeoutMs: SS_BOOTSTRAP_TIMEOUT_MS,
        onStatus: safeSetStatus,
        signal,
      });
      if (!mountedRef.current || signal.aborted) return;
      
      if (!ssReady) {
        setError(t('errors.secureConnectionTimeout'));
        setStep('choose');
        return;
      }
      
      // ── Phase 2 : décodage + PQXDH + envoi réponse (atomique) ──
      // À ce stade SS est prêt → acceptInviteAndRespond ne re-fera pas
      // d'attente. Si l'envoi échoue malgré tout (réseau qui tombe pile
      // pendant l'opération), la fonction throw `JOIN_SEND_FAILED` après
      // avoir rollback la session locale.
      safeSetStatus(t('join.decoding'));
      
      safeSetStatus(t('join.establishingSecure'));
      const result = await sessionService.acceptInviteAndRespond(inviteString);
      if (!mountedRef.current || signal.aborted) return;

      // Guideline 1.2 : refuser la reconnexion d'un contact bloqué
      if (!(await ensureNotBlocked(result.session))) return;
      if (!mountedRef.current || signal.aborted) return;

      // Envoyer notre push token au nouveau pair via E2E (best-effort)
      try {
        const { sendPushTokenToPeer } = require('../services/api1to1');
        sendPushTokenToPeer(result.session.id).catch(() => {});
      } catch {}
      
      safeSetStatus(t('join.connectionEstablished'));
      
      const contactName = result.session.theirProfile.displayName || t('common.contact');
      
      if (mountedRef.current) {
        navigation.replace('ConnectionSuccess', {
          sessionId: result.session.id,
          contactName,
          inviteLabel: t('join.inviteLabelDefault'),
          contactAvatarBase64: result.session.theirProfile.avatarBase64,
        });
      }
      
    } catch (e: any) {
      if (!mountedRef.current) return;
      console.error('[Join1to1] Error:', e);

      // Bug #3 fix: sessionService.acceptInvite() now rejects when the
      // invite was generated by THIS device (either via the local tag
      // lookup against pendingInviteStore, or by comparing the bundle's
      // identity key against our own). Show a friendly alert and bail.
      // The check happens before any OTPK is consumed, so this is a
      // pure no-op on the cryptographic side.
      if (e.isSelfInvite) {
        showAlert({
          title: t('join.selfInviteTitle'),
          message: t('join.selfInviteMessage'),
        });
        setStep('choose');
        return;
      }

      // Existing session detected → auto-replace silently
      if (e.isExistingSession) {
        console.log(`[Join1to1] Session exists with ${e.existingContactName}, auto-replacing...`);
        setLoading(false);
        processInviteReplace(inviteString, e.existingSessionId);
        return;
      }
      
      // JOIN_SEND_FAILED : la session locale a été rollback par
      // acceptInviteAndRespond. On informe clairement l'utilisateur que
      // la connexion n'a PAS été établie (vs erreur réseau générique qui
      // pourrait laisser penser que c'est juste un problème transitoire).
      if (e.code === 'JOIN_SEND_FAILED' || e.wasRollback) {
        setError(t('errors.joinSendFailed'));
        setStep('choose');
        return;
      }
      
      setError(e.message || t('join.connectionError'));
      setStep('choose');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };
  
  const processInviteReplace = async (inviteString: string, existingSessionId: string) => {
    if (!mountedRef.current) return;
    
    setStep('processing');
    setLoading(true);
    setError(null);
    safeSetStatus(t('join.replacingSession'));
    
    // Reset AbortController pour cette nouvelle tentative
    try { abortControllerRef.current?.abort(); } catch {}
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    
    try {
      await sessionService.initialize();
      if (!mountedRef.current || signal.aborted) return;
      
      // Pré-bootstrap SS aussi pour le replace : même invariant, l'envoi
      // de la réponse échouera sans SS prêt. On échoue tôt avant de toucher
      // à quoi que ce soit côté session locale.
      const ssReady = await waitForSealedSenderReady({
        timeoutMs: SS_BOOTSTRAP_TIMEOUT_MS,
        onStatus: safeSetStatus,
        signal,
      });
      if (!mountedRef.current || signal.aborted) return;
      
      if (!ssReady) {
        setError(t('errors.secureConnectionTimeout'));
        setStep('choose');
        return;
      }
      
      // FIX (mai 2026) : nettoyer UNIQUEMENT les caches de transport, PAS les
      // messages. Le sessionId est déterministe (`session_v2_<sortedFingerprints>`)
      // — la conversation cible reste la même personne (mêmes clés d'identité
      // long-terme), donc l'historique des messages, réactions, médias et
      // préférences mute sont toujours pertinents et doivent être préservés.
      //
      // Avant : `clearLocalMessages1to1` effaçait tout l'historique côté
      // scanner, créant une asymétrie avec `finalizeSession` côté inviteur
      // qui ne touche pas aux messages. Du point de vue utilisateur, le
      // re-handshake faisait disparaître une conversation (côté scanner) et
      // donnait l'impression d'une "nouvelle conversation" alors que c'est
      // sémantiquement la même (mêmes clés long-terme).
      const { clearTransportState1to1 } = await import('../services/api1to1');
      await clearTransportState1to1(existingSessionId);
      if (!mountedRef.current || signal.aborted) return;
      
      safeSetStatus(t('join.establishingSecure'));
      
      const result = await sessionService.acceptInviteAndReplace(inviteString, existingSessionId);
      if (!mountedRef.current || signal.aborted) return;

      // Guideline 1.2 : refuser la reconnexion d'un contact bloqué
      if (!(await ensureNotBlocked(result.session))) return;
      if (!mountedRef.current || signal.aborted) return;

      const contactName = result.session.theirProfile.displayName || t('common.contact');
      
      if (mountedRef.current) {
        navigation.replace('ConnectionSuccess', {
          sessionId: result.session.id,
          contactName,
          inviteLabel: t('join.inviteLabelDefault'),
          contactAvatarBase64: result.session.theirProfile.avatarBase64,
        });
      }
      
    } catch (e: any) {
      if (!mountedRef.current) return;
      console.error('[Join1to1] Replace error:', e);
      
      if (e.code === 'JOIN_SEND_FAILED' || e.wasRollback) {
        setError(t('errors.joinSendFailed'));
        setStep('choose');
        return;
      }
      
      setError(e.message || t('join.reconnectionError'));
      setStep('choose');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  // ==========================================
  // SCAN QR CODE
  // ==========================================
  
  const handleQRScanned = useCallback(async (result: BarcodeScanningResult) => {
    if (scannedRef.current) return;
    
    const { data } = result;
    
    // [DEBUG] Log brut du scan pour diagnostic — peut être retiré une fois validé
    console.log('[Join1to1] RAW SCAN:', {
      data: data?.substring(0, 80) + (data && data.length > 80 ? '...' : ''),
      length: data?.length,
      type: result.type,
    });
    
    // Accepte les trois formats : URL Universal Link, scheme natif, code brut.
    // parseInviteString extrait le inviteString quel que soit le wrapping.
    const parsed = parseInviteString(data);
    
    console.log('[Join1to1] PARSED:', {
      hasParsed: !!parsed,
      parsedLength: parsed?.length,
      parsedPrefix: parsed?.substring(0, 40),
    });
    
    if (!parsed || parsed.length < 20) {
      console.log('[Join1to1] REJECTED — parsed empty or too short');
      return;
    }
    
    console.log('[Join1to1] QR scanned, parsed length:', parsed.length);
    
    scannedRef.current = true;

    // v30.0 — Si c'est une invitation de GROUPE, rediriger vers l'écran dédié.
    //
    // [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. L'écran `JoinGroup`
    // n'est plus enregistré dans le Stack : rediriger dessus ne ferait rien du
    // tout (react-navigation ignore une route inconnue) et le scanner
    // resterait figé, `scannedRef` déjà armé — l'utilisateur croirait à un
    // plantage. On refuse donc explicitement, avec le message d'erreur générique
    // de code illisible, et on RÉARME le scanner pour qu'un autre QR (1:1)
    // puisse être scanné dans la foulée.
    //
    // Ne PAS laisser filer vers `processInvite` : il attendrait le bootstrap
    // SealedSender (jusqu'à 60 s) avant d'échouer sur un blob qui n'est pas
    // une invitation 1:1.
    const groupInvite = parseGroupInvite(parsed);
    if (groupInvite) {
      if (!GROUPS_ENABLED) {
        console.log('[Join1to1] Group invite ignored — groups disabled');
        // Dialogue, PAS `setError` : la vue caméra ne rend aucune bannière
        // d'erreur (le bandeau n'existe que sur les étapes « choose » et
        // « manual »), et basculer sur « choose » pour la montrer ne
        // marcherait pas non plus — le useEffect de reset d'étape fait
        // justement `setError(null)`. `showAlert` s'affiche par-dessus la
        // caméra, quel que soit l'état de l'écran.
        showAlert({ title: t('join.scanTitle'), message: t('errors.qrCodeError') });
        // Réarmer : sans ça le scanner reste sourd à tout QR suivant, y
        // compris une invitation 1:1 parfaitement valide.
        scannedRef.current = false;
        return;
      }
      console.log('[Join1to1] Group invite detected → JoinGroup');
      navigation.replace('JoinGroup', { inviteString: parsed });
      return;
    }

    await processInvite(parsed);
  }, [navigation, t]);

  // ==========================================
  // PASTE FROM CLIPBOARD
  // ==========================================

  const handlePaste = useCallback(async () => {
    try {
      const clip = (await Clipboard.getStringAsync())?.trim();
      if (!clip) {
        // Presse-papiers vide : on le DIT au lieu de ne rien faire. Un
        // bouton qui ne réagit pas est lu comme un bug.
        setError(t('join.clipboardEmpty'));
        return;
      }
      setCodeInput(clip);
      // On efface l'erreur précédente : le contenu du champ a changé, le
      // message d'erreur qui l'accompagnait ne le décrit plus.
      setError(null);
    } catch {
      // `getStringAsync` peut échouer si l'OS refuse l'accès au
      // presse-papiers (Android 13+ avec certaines politiques d'entreprise).
      setError(t('join.clipboardError'));
    }
  }, [t]);

  // ==========================================
  // MANUAL SUBMIT
  // ==========================================

  const handleManualSubmit = async () => {
    // Accepte une URL collée (https://ghostr.app/i#…) ou un code brut.
    const parsed = parseInviteString(codeInput);
    
    if (!parsed) {
      setError(t('join.enterCode'));
      return;
    }
    
    if (parsed.length < 20) {
      setError(t('join.codeTooShort'));
      return;
    }
    
    console.log('[Join1to1] Manual input, parsed length:', parsed.length);

    // Si c'est une invitation de GROUPE collée (lien/texte), rediriger vers
    // l'écran dédié — symétrique du scanner. Indispensable car les invitations
    // de groupe post-quantiques se partagent par lien (trop volumineuses pour
    // un QR).
    //
    // [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. Même refus explicite
    // que côté scanner : le champ de saisie reste sur place et affiche
    // l'erreur, au lieu d'une navigation qui n'aboutit nulle part.
    const groupInvite = parseGroupInvite(parsed);
    if (groupInvite) {
      if (!GROUPS_ENABLED) {
        console.log('[Join1to1] Manual group invite ignored — groups disabled');
        setError(t('errors.qrCodeError'));
        return;
      }
      console.log('[Join1to1] Manual group invite detected → JoinGroup');
      navigation.replace('JoinGroup', { inviteString: parsed });
      return;
    }

    await processInvite(parsed);
  };

  // ==========================================
  // CHOOSE METHOD
  // ==========================================
  
  if (step === 'choose') {
    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <Header title={t('join.title')} onBackPress={() => navigation.goBack()} />
        
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
          <View style={styles.headerSection}>
            <View style={styles.iconContainer}>
              <Ionicons name="link-outline" size={36} color={colors.primary} />
            </View>
            <Text style={styles.title}>{t('join.joinConversationTitle')}</Text>
            <Text style={styles.subtitle}>
              {t('join.joinConversationSubtitle')}
            </Text>
          </View>

          <View style={styles.options}>
            <TouchableOpacity style={styles.optionCard} onPress={() => setStep('scan')} activeOpacity={0.7}>
              <View style={styles.optionIconWrapper}>
                <Ionicons name="scan-outline" size={24} color={colors.primary} />
              </View>
              <View style={styles.optionContent}>
                <Text style={styles.optionTitle} numberOfLines={1}>{t('join.scanQRTitle')}</Text>
                <Text style={styles.optionSubtitle} numberOfLines={2}>{t('join.scanQRSubtitle')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>

            <TouchableOpacity style={styles.optionCard} onPress={() => setStep('manual')} activeOpacity={0.7}>
              <View style={styles.optionIconWrapper}>
                <Ionicons name="clipboard-outline" size={24} color={colors.primary} />
              </View>
              <View style={styles.optionContent}>
                <Text style={styles.optionTitle} numberOfLines={1}>{t('join.pasteCodeTitle')}</Text>
                <Text style={styles.optionSubtitle} numberOfLines={2}>{t('join.pasteCodeSubtitle')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={styles.infoBox}>
            <Text style={styles.infoTitle}><Ionicons name="shield-checkmark" size={14} color={colors.primary} />  {t('join.autoSecurity')}</Text>
            <Text style={styles.infoText}>
              {t('join.autoSecurityDesc')}
            </Text>

          </View>

          {error && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  // ==========================================
  // SCAN QR
  // ==========================================
  
  if (step === 'scan') {
    if (!permission) {
      return (
        <View style={[styles.container, { paddingBottom: insets.bottom }]}>
          <Header title={t('join.scanTitle')} onBackPress={() => setStep('choose')} />
          <View style={styles.centerContent}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        </View>
      );
    }

    if (!permission.granted) {
      // PERM FIX : différencier "jamais demandé / refusé une fois" (le dialog
      // OS peut encore s'ouvrir) de "refusé définitivement" (il ne s'ouvrira
      // plus → seuls les Paramètres système débloquent la situation).
      //
      // On ne conclut au refus définitif qu'APRÈS avoir réellement tenté le
      // dialog : `canAskAgain` seul est un faux négatif fréquent sur Android
      // (cf. commentaire sur permissionPrompted plus haut). Tant qu'aucune
      // tentative n'a eu lieu, on propose le bouton qui déclenche le dialog —
      // s'il s'avère que l'OS refuse de l'afficher, le tap suivant basculera
      // sur "Ouvrir les paramètres".
      // Combien de tentatives avant d'accepter le verdict "bloqué" ?
      //   - iOS : 1. Le refus y est définitif dès le premier "Ne pas autoriser"
      //     et `canAskAgain` est alors fiable — insister n'afficherait rien.
      //   - Android : 2. Un dialog annulé (bouton retour, tap à côté) ne laisse
      //     AUCUNE trace côté OS mais fait quand même passer `canAskAgain` à
      //     false. Avec une seule tentative, une annulation involontaire
      //     condamnerait l'utilisateur aux Réglages système alors qu'un
      //     nouveau dialog s'afficherait parfaitement. Deux tentatives lèvent
      //     l'ambiguïté : après un vrai premier refus, l'OS repasse
      //     `canAskAgain` à true et ce bloc n'est de toute façon pas atteint.
      const attemptsBeforeSettings = Platform.OS === 'android' ? 2 : 1;
      const isBlocked = permissionAttempts >= attemptsBeforeSettings && !permission.canAskAgain;

      return (
        <View style={[styles.container, { paddingBottom: insets.bottom }]}>
          <Header title={t('join.scanTitle')} onBackPress={() => setStep('choose')} />
          <View style={styles.permissionContent}>
            <View style={styles.iconContainer}>
              <Ionicons name="camera-outline" size={36} color={colors.primary} />
            </View>
            <Text style={styles.title}>{t('join.cameraAccess')}</Text>
            <Text style={styles.subtitle}>
              {isBlocked
                ? t('permissions.camera.blockedMessage')
                : t('join.cameraAccessDesc')}
            </Text>
            <View style={{ marginTop: 24, width: '100%', paddingHorizontal: 40 }}>
              {isBlocked ? (
                // Refus permanent : pointer vers les Paramètres système.
                // openAppSettings() ouvre directement la page de l'app dans
                // les Settings du téléphone (iOS et Android).
                <Button
                  title={t('permissions.openSettings')}
                  onPress={openAppSettings}
                  variant="primary"
                  size="large"
                  fullWidth
                />
              ) : (
                // Refus simple ou première demande : re-prompt l'OS.
                // suppressLock pendant le dialog (cf. commentaire ci-dessous).
                <Button
                  title={t('join.continue')}
                  onPress={async () => {
                    // CRITIQUE : suppressLock() pendant le dialog système de
                    // permission caméra. Sur Android, ce dialog fait passer
                    // l'app en 'background'. Sans cette protection, l'app se
                    // verrouillerait pendant que l'utilisateur lit le dialog
                    // (avec BACKGROUND_CONFIRMATION_MS = 250ms).
                    // Délai de release de 1500ms pour couvrir le retour
                    // 'active' post-permission sur ROMs lentes.
                    suppressLock();
                    try {
                      const result = await requestPermission();
                      // Tentative comptabilisée : une fois le quota atteint et
                      // l'OS confirmant qu'il ne redemandera plus, le prochain
                      // rendu proposera les Réglages système.
                      if (!result.granted && mountedRef.current) {
                        setPermissionAttempts((n) => n + 1);
                      }
                    } catch {
                      // Échec du module natif : on laisse l'écran en l'état
                      // plutôt que de basculer à tort sur "Ouvrir les
                      // paramètres" — l'utilisateur peut retaper le bouton.
                    } finally {
                      setTimeout(() => releaseLock(), 1500);
                    }
                  }}
                  variant="primary"
                  size="large"
                  fullWidth
                />
              )}
            </View>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.container}>
        <CameraView
          style={styles.camera}
          facing="back"
          enableTorch={torchOn}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleQRScanned}
        >
          <View style={[styles.scannerOverlay, { paddingTop: insets.top }]}>
            <View style={styles.scannerHeader}>
              <TouchableOpacity
                style={styles.scannerBackButton}
                onPress={() => setStep('choose')}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
              >
                <Ionicons name="chevron-back" size={26} color="#FFFFFF" />
              </TouchableOpacity>
              <Text style={styles.scannerTitle}>{t('join.scanQRTitle')}</Text>
              <TouchableOpacity
                style={styles.scannerBackButton}
                onPress={() => setTorchOn((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ selected: torchOn }}
                accessibilityLabel={torchOn ? t('join.torchOff') : t('join.torchOn')}
              >
                <Ionicons
                  name={torchOn ? 'flashlight' : 'flashlight-outline'}
                  size={24}
                  color={torchOn ? '#FFD54F' : '#FFFFFF'}
                />
              </TouchableOpacity>
            </View>
            
            <View style={styles.scanFrameContainer}>
              <View style={styles.scanFrame}>
                <View style={[styles.corner, styles.topLeft]} />
                <View style={[styles.corner, styles.topRight]} />
                <View style={[styles.corner, styles.bottomLeft]} />
                <View style={[styles.corner, styles.bottomRight]} />
              </View>
            </View>
            
            <View style={[styles.scannerFooter, { paddingBottom: insets.bottom + 20 }]}>
              <Text style={styles.scannerHint}>
                {t('join.placeQRInFrame')}
              </Text>
            </View>
          </View>
        </CameraView>
      </View>
    );
  }

  // ==========================================
  // MANUAL INPUT
  // ==========================================
  
  if (step === 'manual') {
    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <Header title={t('join.pasteTitle')} onBackPress={() => setStep('choose')} />
        
        <KeyboardAvoidingView 
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        >
          <ScrollView style={styles.scrollView} contentContainerStyle={[styles.content, { paddingBottom: 40 }]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.headerSection}>
            <Text style={styles.title}>{t('join.codeLabel')}</Text>
            <Text style={styles.subtitle}>
              {t('join.pasteCode')}
            </Text>
          </View>

          <View style={styles.form}>
            <TextInput
              style={styles.codeInput}
              value={codeInput}
              onChangeText={setCodeInput}
              placeholder={t('join.pasteHere')}
              placeholderTextColor={colors.textMuted}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t('join.codeLabel')}
            />
            {/*
              Bouton Coller explicite. Un code d'invitation fait plusieurs
              centaines de caractères : personne ne le tape. Le chemin par
              défaut (appui long → attendre le menu système → « Coller »)
              est fiable sur iOS mais capricieux sur Android dans un
              TextInput multiline, et invisible pour beaucoup
              d'utilisateurs. Un bouton dédié rend l'action évidente et
              atteignable en un tap.
            */}
            <View style={styles.pasteRow}>
              <TouchableOpacity
                style={styles.pasteButton}
                onPress={handlePaste}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={t('join.pasteFromClipboard')}
              >
                <Ionicons name="clipboard-outline" size={18} color={colors.primary} />
                <Text style={styles.pasteButtonText}>{t('join.pasteFromClipboard')}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>
              {t('join.codeHint')}
            </Text>
          </View>

          {error && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <View style={styles.inlineAction}>
            <Button
              title={t('join.connect')}
              onPress={handleManualSubmit}
              variant="primary"
              size="large"
              fullWidth
              loading={loading}
            />
          </View>
        </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ==========================================
  // PROCESSING → Uses SplashScreen for consistent UX
  // ==========================================
  
  if (step === 'processing') {
    return <SplashScreen statusMessage={statusMessage} />;
  }

  return null;
}

const makeStyles = (colors: ColorPalette) => ({
  container: { flex: 1, backgroundColor: colors.background },
  scrollView: { flex: 1 },
  content: { padding: 24 },
  centerContent: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  permissionContent: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  
  headerSection: { alignItems: 'center', marginBottom: 24 },
  iconContainer: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: colors.primary + '20',
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  icon: { fontSize: 36 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text, marginBottom: 8, textAlign: 'center' },
  subtitle: { fontSize: 15, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  
  options: { gap: 12, marginBottom: 24 },
  optionCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: colors.border,
  },
  optionIconWrapper: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: colors.primary + '15',
    alignItems: 'center', justifyContent: 'center', marginRight: 14,
  },
  optionIcon: { fontSize: 22 },
  optionContent: { flex: 1 },
  optionTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 2 },
  optionSubtitle: { fontSize: 13, color: colors.textSecondary },
  optionChevron: { fontSize: 24, color: colors.textMuted },
  
  infoBox: {
    backgroundColor: colors.primary + '10',
    borderRadius: 12, padding: 16,
  },
  infoTitle: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 8 },
  infoText: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  infoTagline: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.primary + '30',
    alignItems: 'center',
  },
  infoTaglineText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.primary,
    opacity: 0.7,
  },
  
  // Scanner
  camera: { flex: 1 },
  scannerOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  scannerHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: 'rgba(0,0,0,0.5)',
  },
  // 44×44 = cible tactile minimale recommandée par iOS et Android. Les
  // boutons du scanner faisaient 40×40 et se manipulent à une main, souvent
  // en tendant le bras vers l'écran d'en face.
  scannerBackButton: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
  },
  scannerTitle: { fontSize: 17, fontWeight: '600', color: '#FFF' },
  scanFrameContainer: { alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: 250, height: 250 },
  corner: { position: 'absolute', width: 40, height: 40, borderColor: colors.primary },
  topLeft: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 12 },
  topRight: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 12 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 12 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 12 },
  scannerFooter: {
    alignItems: 'center', backgroundColor: colors.background,
    paddingTop: 24, borderTopLeftRadius: 24, borderTopRightRadius: 24,
  },
  scannerHint: { fontSize: 15, color: colors.text },
  
  // Form
  form: { marginBottom: 20 },
  codeInput: {
    backgroundColor: colors.inputBackground,
    borderRadius: 16, borderWidth: 1.5, borderColor: colors.inputBorder,
    paddingHorizontal: 16, paddingVertical: 14,
    fontSize: 13, color: colors.text,
    minHeight: 140, textAlignVertical: 'top',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // Bouton Coller — aligné à droite sous le champ, en retrait visuel pour
  // ne pas concurrencer le CTA « Se connecter ». 44 px de haut (12 + 20 + 12).
  pasteRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 8,
  },
  pasteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.primary + '15',
  },
  pasteButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.primary,
  },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: 8, marginLeft: 4 },

  // Error
  errorBanner: {
    backgroundColor: colors.danger + '15',
    borderRadius: 12, padding: 16, marginTop: 16,
  },
  errorText: { fontSize: 14, color: colors.danger, textAlign: 'center' },
  
  // Inline action button (inside scroll)
  inlineAction: { marginTop: 8 },
}) as const;

export default Join1to1Screen;