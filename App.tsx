// App.tsx
// Point d'entrée principal - Ghostr
// Conversations 1-à-1 uniquement
// Triple Ratchet + Appels vocaux + Vérification sécurité
import 'react-native-get-random-values';
import React, { useEffect, useState, useRef, useMemo } from 'react';
import { StatusBar, View, StyleSheet, Text, AppState, AppStateStatus, Platform, Image } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { NavigationContainer, DefaultTheme, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import 'react-native-gesture-handler';

// Push Notifications
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
// Screen capture protection: bloque screenshots Android (FLAG_SECURE),
// scrcpy, enregistrement d'écran, casting. Sur iOS, l'enregistrement d'écran
// est bloqué, le screenshot seulement gêné (aucune API iOS ne l'interdit) —
// l'overlay privacy reste la protection complémentaire.
// La décision d'armer ou non vit dans screenCaptureGuard (allowlist de profils
// de build) : NE JAMAIS appeler expo-screen-capture directement depuis ici.
import { armScreenCaptureProtection, SCREEN_CAPTURE_ALLOWED } from './src/services/screenCaptureGuard';
import { initPushNotifications, showIncomingCallNotification, BACKGROUND_NOTIFICATION_TASK, hasCompletedNotificationOnboarding, purgeAllPeerPushTokens, refreshOwnTokenIfChanged } from './src/services/pushNotificationService';

// Import des composants d'appels vocaux
import { Call1to1Provider } from './src/hooks/useCall1to1';

// Notification onboarding (écran de configuration affiché une seule fois)
import { NotificationOnboarding } from './src/components/NotificationOnboarding';

// Import des services de sécurité
import { performSecurityCheck, getSecurityWarningMessage, getSecurityAlertTitle, applySecurityPolicy } from './src/services/deviceSecurity';
import { securityLogger } from './src/services/securityLogger';

// ============================================
// FIX GLOBAL SAMSUNG/ANDROID: Texte tronqué
// ============================================
if (Platform.OS === 'android') {
  const oldTextRender = (Text as any).render;
  if (oldTextRender) {
    (Text as any).render = function(...args: any[]) {
      const origin = oldTextRender.call(this, ...args);
      return React.cloneElement(origin, {
        style: [{ fontFamily: 'Roboto' }, origin.props.style],
        allowFontScaling: false,
        textBreakStrategy: 'simple',
      });
    };
  }
}

// Screens
import { ConversationListScreen } from './src/screens/ConversationListScreen';
import { ConversationScreen } from './src/screens/ConversationScreen';
import { ContactInfoScreen } from './src/screens/ContactInfoScreen';
import { Create1to1Screen } from './src/screens/Create1to1Screen';
import { InviteDetailScreen } from './src/screens/InviteDetailScreen';
import { InvitationsScreen } from './src/screens/InvitationsScreen';
import { ConnectionSuccessScreen } from './src/screens/ConnectionSuccessScreen';
import { InAppNotificationHost } from './src/components/InAppNotification';
import { Join1to1Screen } from './src/screens/Join1to1Screen';
import { CreateGroupScreen } from './src/screens/CreateGroupScreen';
import { GroupInfoScreen } from './src/screens/GroupInfoScreen';
import { AddGroupMembersScreen } from './src/screens/AddGroupMembersScreen';
import { GroupInviteQRScreen } from './src/screens/GroupInviteQRScreen';
import { JoinGroupScreen } from './src/screens/JoinGroupScreen';
import { GROUPS_ENABLED } from './src/config/features';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { LockScreen } from './src/screens/LockScreen';
import { MigrationLockdownScreen } from './src/screens/MigrationLockdownScreen';
import { MigrationImportScreen } from './src/screens/MigrationImportScreen';
import { MigrationExportScreen } from './src/screens/MigrationExportScreen';
import { SecurityScreen } from './src/screens/SecurityScreen';
import { SetupProfileScreen } from './src/screens/SetupProfileScreen';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { TermsScreen } from './src/screens/TermsScreen';
import { EditProfileScreen } from './src/screens/EditProfileScreen';
import { LanguageScreen } from './src/screens/LanguageScreen';
import { ThemeScreen } from './src/screens/ThemeScreen';
import { SplashScreen } from './src/screens/SplashScreen';

// Services
import { getOrCreateDeviceState, clearEncryptionKey, hasGlobalDisplayName, initHardwareEncryptionAll, nuclearReset } from './src/services/storage';
// api.ts ne contient plus que la config réseau (API_URL, isRelayEnabled, getApiUrl)
import { startGlobalPolling1to1, stopGlobalPolling1to1, pollAllSessions, waitForSealedSender, precomputePoW, recoverOrphanedSendingMessages, flushLastMessagePreviews } from './src/services/api1to1';
// Chargement des groupes persistés : sur le chemin critique du boot, au même
// titre que sessionService.initialize(). Une seule lecture AsyncStorage +
// déchiffrement d'un JSON de rosters (aucun message), donc quelques ms.
// Avant, loadGroups n'était appelé QUE comme effet de bord de
// recoverOrphanedSendingMessages(), lui-même déféré de 5 s : les groupes
// étaient absents de la liste de conversations et des handlers de réception
// pendant toute cette fenêtre. Cf. ConversationListScreen.
// [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts. `loadGroups()` est
// CONSERVÉ sur le chemin de boot : c'est une opération de données, pas une
// surface UI. La couper laisserait la Map RAM vide alors que les services
// (migration, réconciliation de roster) supposent qu'elle reflète le disque —
// et sur un profil sans groupe, ce qui est le cas de toute installation de
// cette version, c'est un no-op. Rien de ce qui est chargé ici n'atteint
// l'écran : la liste de conversations filtre les groupes en amont.
import { loadGroups } from './src/services/groupService';
import { inviteWatcher } from './src/services/inviteWatcher';
import { useDeepLinkInvite } from './src/services/deepLinkInvite';
import { loadSilentMode, ensureInCallStarted, stopInCallManager } from './src/services/callTones';
import { isInCall1to1, addCall1to1StateListener } from './src/services/call1to1Service';
import { preWarmNativeAudio } from './src/services/audioService';
import { isLockEnabled, isLockEnabledFast, getLockSettings, getLockHint } from './src/services/appLock';
import { loadMarkerFromDisk, getMigrationHint, getMigrationMarkerSync, subscribeMigrationStateChange } from './src/services/migrationState';
import { isArgon2Available } from './src/services/kdf';
import { isLockSuppressed } from './src/services/lockGuard';
// FIX iOS — détection de réinstallation et purge du Keychain.
// Voir src/services/firstLaunchGuard.ts pour le rationale complet.
import { checkAndHandleReinstall } from './src/services/firstLaunchGuard';
import { initializePrivacyServices, pausePrivacyServices, resumePrivacyServices } from './src/services/privacySettings';
import { initializePinning, listenForPinningErrors } from './src/services/networkSecurity';
import { initRelay } from './src/services/relayTransport';
import { sessionService } from './src/services/tripleRatchet';
import { initSodiumZeroize } from './src/services/sodiumZeroize';
// R-13: Zeroize sealed sender state on lock
import { clearSealedSenderState } from './src/services/sealedSender';

// App notice (kill-switch / deprecation banner) — payload signé Ed25519,
// affiché en overlay au-dessus de tous les écrans si activé côté serveur.
// Le bootstrap est lancé au top-level (cf. plus bas) ; l'overlay est monté
// dans le render path principal (après NavigationContainer).
import { bootstrapAppNotice, refetchAppNotice, subscribeAppNotice, getCurrentAppNotice } from './src/services/appNotice';
import { resetSealedSenderBootstrap } from './src/services/sealedSender';
import { AppNoticeOverlay } from './src/components/AppNoticeOverlay';

// i18n — DOIT être importé tôt pour que l'init parte avant le 1er render.
// L'init est asynchrone (lecture AsyncStorage) mais démarre au module load,
// même pattern que _lockHintPromise. Cf. src/i18n/index.ts.
import i18n, { initI18n } from './src/i18n';

// Theme
import {
  ThemeProvider,
  useTheme,
  useThemedStyles,
  ToastHost,
  AlertHost,
  showAlert,
  type ColorPalette,
} from './src/components/ui';
import { appearanceBootPromise, loadStoredAppearanceSync } from './src/services/themeStorage';
import { ErrorBoundary } from './src/components/ErrorBoundary';

// ════════════════════════════════════════════════════════════════════════════
// TIMING LOGGER GLOBAL — CHEMIN CRITIQUE DU BOOT
// ════════════════════════════════════════════════════════════════════════════
// Marque T0 au tout premier instant de l'évaluation de ce module. Permet de
// mesurer précisément où va le temps depuis « bundle JS chargé » jusqu'à
// « LockScreen affiché et clavier ouvert ».
//
// Usage : `bootlog('label')` → log avec timestamp relatif. Les vrais devices
// donnent typiquement :
//   [boot +0ms]    module load
//   [boot +XXms]   hint resolved (target: < 50ms)
//   [boot +XXms]   App component first render
//   [boot +XXms]   isLockEnabledFast resolved
//   [boot +XXms]   LockScreen first render
//   [boot +XXms]   LockScreen first paint (rAF)
//
// __DEV__ uniquement (zéro overhead en prod).
// ════════════════════════════════════════════════════════════════════════════
const _BOOT_T0 = Date.now();
function bootlog(label: string) {
  if (__DEV__) console.log(`[boot +${Date.now() - _BOOT_T0}ms] ${label}`);
}
bootlog('App.tsx module evaluation start');

// ════════════════════════════════════════════════════════════════════════════
// PREFETCH AU TOP-LEVEL — DÉMARRER AVANT LE MOUNT REACT
// ════════════════════════════════════════════════════════════════════════════
// Ces opérations démarrent dès l'import d'App.tsx, donc en parallèle de
// l'évaluation des autres modules JS et avant que React ne mount le composant
// App. Quand App finit de mount (typiquement 50-500 ms plus tard selon la
// taille du bundle), ces promesses sont souvent déjà résolues → l'état
// initial du composant peut faire la BONNE décision sans phase d'attente.
// ════════════════════════════════════════════════════════════════════════════

// (1) HINT DE LOCK — lecture AsyncStorage rapide (~5-30 ms cold)
//     Stocke le résultat dans un cache module-level lu par useState initializer.
//     Cf. src/services/appLock.ts pour le rationale et la sécurité du hint.
let _lockHintCache: boolean | null | 'pending' = 'pending';
const _lockHintPromise: Promise<boolean | null> = getLockHint()
  .then(hint => {
    _lockHintCache = hint;
    bootlog(`lock hint resolved: ${hint === null ? 'null (no hint stored)' : hint}`);
    return hint;
  })
  .catch(() => {
    _lockHintCache = null;
    bootlog('lock hint resolution failed → null');
    return null;
  });

// (1ter) HINT DE MIGRATION — même pattern que le hint de lock.
//     Permet au tout 1er render de App.tsx de savoir s'il doit afficher
//     MigrationLockdownScreen (cas le plus prioritaire) sans attendre la
//     résolution SecureStore (la source de vérité). La SecureStore est lue
//     ensuite via loadMarkerFromDisk() dans le bootstrap useEffect, et
//     corrige l'état si nécessaire (rare).
let _migrationHintCache: boolean | null | 'pending' = 'pending';
const _migrationHintPromise: Promise<boolean | null> = getMigrationHint()
  .then(hint => {
    _migrationHintCache = hint;
    bootlog(`migration hint resolved: ${hint === null ? 'null' : hint}`);
    return hint;
  })
  .catch(() => {
    _migrationHintCache = null;
    return null;
  });

// (1bis) FIX iOS — DÉTECTION DE RÉINSTALLATION
// ════════════════════════════════════════════════════════════════════════════
// Sur iOS, le Keychain (utilisé par expo-secure-store) survit à la
// désinstallation de l'app. Conséquence : `whisper_lock_data_v6` et
// consorts persistent entre installations → après réinstallation, l'app
// affiche le LockScreen avec l'ancien mot de passe alors que toutes les
// vraies données (AsyncStorage) ont été détruites avec la désinstallation.
//
// On démarre la détection au top-level pour qu'elle s'exécute en parallèle
// du `_lockHintPromise`. Le bootstrap useEffect attendra cette promesse
// AVANT d'appeler `isLockEnabledFast` (source de vérité SecureStore), de
// sorte que les éventuels résidus auront été purgés.
//
// Sur Android, c'est un no-op rapide (juste une lecture AsyncStorage).
// Voir src/services/firstLaunchGuard.ts pour le détail.
// ════════════════════════════════════════════════════════════════════════════
const _firstLaunchPromise: Promise<boolean> = checkAndHandleReinstall()
  .then(wasReinstall => {
    bootlog(`first-launch guard resolved: wasReinstall=${wasReinstall}`);
    return wasReinstall;
  })
  .catch(e => {
    bootlog(`first-launch guard failed: ${String(e)}`);
    return false;
  });

// (2) DÉCODAGE DE L'ICÔNE LOCKSCREEN — pré-chauffage du cache d'images natif.
//     `Image.prefetch` télécharge ET décode le PNG en RAM. Sans ça, le 1er
//     <Image source={require('icon_nobg.png')} /> du LockScreen fait un décodage
//     synchrone au premier render → frame drop visible (50-200 ms).
//     Pour les assets bundlés, on utilise resolveAssetSource pour obtenir l'URI
//     puis prefetch. Idempotent et silencieux en cas d'échec.
try {
  const iconAsset = Image.resolveAssetSource(require('./assets/icon_nobg.png'));
  if (iconAsset?.uri) {
    Image.prefetch(iconAsset.uri)
      .then(() => bootlog('lock icon prefetched'))
      .catch(() => {});
  }
} catch {}

// (3) i18n — démarrer la lecture AsyncStorage de la langue stockée dès l'import.
//     Init = lecture d'1 clé AsyncStorage + appel sync expo-localization +
//     i18next.init() avec resources bundlées. Typiquement résolu < 30ms.
//     Quand le 1er render arrive, i18n est généralement prêt → pas de flash
//     de la mauvaise langue. Si encore en cours, i18next renvoie le fallback
//     temporaire ; useTranslation re-render dès résolution.
//     Aucun appel réseau, aucune fuite langue côté serveur.
void initI18n()
  .then(() => bootlog('i18n initialized'))
  .catch(e => bootlog(`i18n init failed: ${String(e)}`));

// (3.5) Apparence — la promesse top-level dans themeStorage.ts démarre
//       déjà au moment de son import (cf. son commentaire). Ici on se
//       contente de l'attendre pour logger, ce qui force aussi son
//       inclusion dans le graphe de modules sans dépendre de l'ordre
//       d'import de ThemeProvider. Aucune mutation de `theme.colors`
//       n'est tentée : cf. commentaire en tête de `theme.ts`, section
//       BOOT-TIME SCHEME RESOLUTION.
void appearanceBootPromise()
  .then(pref => bootlog(`appearance pref loaded: ${pref}`))
  .catch(e => bootlog(`appearance init failed: ${String(e)}`));

// (4) App notice — kill-switch / avis de dépréciation. Lance le fetch en
//     arrière-plan dès le module load, jamais attendu par le boot. Le
//     service lit son cache AsyncStorage en parallèle pour montrer
//     instantanément un avis déjà vu (mode offline OK). Coût quand pas
//     d'avis : 1 lecture AsyncStorage + 1 RPC avec timeout strict 5s.
//     Cf. src/services/appNotice.ts.
bootstrapAppNotice();

// ============================================
// CONSTANTES
// ============================================

// ⚠️ METTRE À TRUE POUR EFFACER TOUTES LES DONNÉES AU DÉMARRAGE
// ⚠️ REMETTRE À FALSE APRÈS LE TEST !
const RESET_ALL_DATA = false;

const LAST_BACKGROUND_TIME_KEY = '@whisper_last_background_time';
const SECURITY_CHECK_SHOWN_KEY = '@whisper_security_check_shown';
const ONBOARDING_COMPLETED_KEY = '@ghostr_onboarding_completed';
// Guideline 1.2 : acceptation des conditions d'utilisation (EULA). La valeur
// stockée est la version des CGU acceptée — incrémenter TERMS_VERSION pour
// re-présenter l'écran après un changement substantiel des conditions.
const TERMS_ACCEPTED_KEY = '@ghostr_terms_accepted';
const TERMS_VERSION = '1';

// ═══════════════════════════════════════════════════════════════════════════
// DÉTECTION VRAI vs FAUX BACKGROUND — STRATÉGIE EXPLICITE
// ═══════════════════════════════════════════════════════════════════════════
// Stratégie : on s'appuie sur des MARQUEURS EXPLICITES (lockGuard) plutôt que
// sur une fenêtre temporelle large pour décider si un background est faux.
//
// Trois sources de "ne pas verrouiller" :
//   1. lockGuard.suppressLock()   → pickers, permissions, share, caméra…
//      (utilisé via suppressLock/releaseLock ou withExternalActivity)
//   2. isInCall1to1()              → appel vocal en cours
//   3. Marqueur de navigation modale Android (lastModalNavTime)
//      → écrans avec presentation: 'modal' ou 'fullScreenModal' qui ouvrent
//        une nouvelle Activity Android et provoquent un faux 'background'.
//        On marque l'instant de la navigation et on accorde 800 ms pour que
//        la nouvelle Activity prenne le foreground.
//
// Tout ce qui n'entre pas dans ces trois cas est traité comme un VRAI départ
// de l'utilisateur. Le verrouillage est alors quasi instantané, modulo une
// micro-fenêtre de 250 ms pour absorber les hiccups OS (services natifs qui
// se réveillent, transitions internes non couvertes).
//
// Avantage : un attaquant qui prend le téléphone et le rouvre vite est bloqué
// dès la 250e ms. Précédemment la fenêtre de 5000 ms laissait passer les
// retours rapides — on supprime ce trou de sécurité.
// ═══════════════════════════════════════════════════════════════════════════
const BACKGROUND_CONFIRMATION_MS = 250;

// Fenêtre de grâce après une navigation vers un écran modal Android.
// Couvre la transition d'Activity (typiquement 200-500 ms sur ROMs lentes).
// 800 ms = marge confortable, encore largement insuffisant pour qu'un attaquant
// puisse exploiter (il faudrait ouvrir un modal puis basculer en < 800 ms).
const MODAL_NAV_GRACE_MS = 800;

// Liste des écrans qui ouvrent une nouvelle Activity Android via
// react-native-screens. À maintenir en sync avec les `presentation: 'modal'`
// et `presentation: 'fullScreenModal'` dans le Stack.Navigator ci-dessous.
// Les écrans `presentation: 'card'` (défaut) ne déclenchent PAS de background
// et n'ont donc pas besoin d'être listés.
//
// ATTENTION : cette liste avait divergé du Stack. `GroupInviteQR` et
// `JoinGroup` ont été déclarés `presentation: 'modal'` sans être ajoutés
// ici, si bien que la transition d'Activity qu'ils provoquent était lue
// comme un vrai passage en arrière-plan → l'app se verrouillait toute
// seule au milieu du partage d'une invitation de groupe. Toute nouvelle
// entrée `presentation: 'modal' | 'fullScreenModal'` DOIT être ajoutée ici.
const ANDROID_MODAL_SCREENS = new Set<string>([
  'Create1to1',         // fullScreenModal
  'ConnectionSuccess',  // fullScreenModal
  'Join1to1',           // modal
  'Security',           // modal
  // [GROUPES DÉSACTIVÉS] Conservés volontairement : ces deux écrans ne sont
  // plus enregistrés dans le Stack (cf. GROUPS_ENABLED plus bas), donc ces
  // entrées sont inertes. Les retirer ferait juste réapparaître le bug de
  // verrouillage intempestif le jour de la réactivation.
  'GroupInviteQR',      // modal
  'JoinGroup',          // modal
]);

export type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { conversationId: string; conversationName: string };
  ContactInfo: { sessionId: string };
  Create1to1: undefined;
  Join1to1: { pendingInviteString?: string } | undefined;
  // v30.0 — Groupes
  // [GROUPES DÉSACTIVÉS] Les types de routes sont CONSERVÉS même si les écrans
  // ne sont pas enregistrés : ils typent encore les appels `navigate()` gardés
  // par `GROUPS_ENABLED` dans les écrans appelants. Les supprimer ne
  // désactiverait rien de plus et casserait la compilation de code par ailleurs
  // correct.
  CreateGroup: undefined;
  GroupInfo: { groupId: string };
  AddGroupMembers: { groupId: string };
  GroupInviteQR: { groupId: string };
  JoinGroup: { inviteString: string };
  Invitations: undefined;
  InviteDetail: { tag: string };
  ConnectionSuccess: { sessionId: string; contactName: string; inviteLabel: string; inviteTag?: string; contactAvatarBase64?: string };
  Settings: undefined;
  Security: undefined;
  EditProfile: undefined;
  Language: undefined;
  Theme: undefined;
  MigrationExport: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// NavigationTheme is computed reactively from `useTheme()` so the
// NavigationContainer (and its native header bars / card transitions) follow
// the user's choice. Hoisted to a hook so each ancestor render that uses it
// is the source of truth — there's no stale module-level snapshot.
function useNavigationTheme() {
  const { colors, isDark } = useTheme();
  return useMemo(() => ({
    ...DefaultTheme,
    dark: isDark,
    colors: {
      ...DefaultTheme.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      notification: colors.primary,
    },
  }), [colors, isDark]);
}

/**
 * StatusBar wrapper that derives its appearance from the current theme.
 * Replaces the previous pattern of `<StatusBar barStyle="light-content" … />`
 * scattered across every render branch — those were hardcoded for dark
 * theme and would have inverted text on a light background.
 *
 * `transparent` is for screens like WelcomeScreen that lay their own
 * gradient under the status bar. Defaults to false.
 */
function ThemedStatusBar({ transparent = false }: { transparent?: boolean }) {
  const { isDark, colors } = useTheme();
  return (
    <StatusBar
      barStyle={isDark ? 'light-content' : 'dark-content'}
      backgroundColor={transparent ? 'transparent' : colors.background}
      translucent={transparent}
    />
  );
}

/**
 * NavigationContainer that pulls its theme from `useNavigationTheme()`.
 * Wraps the navigation tree so `card`, `border`, `text` etc. (consumed by
 * react-navigation internals like the native header bars and the
 * card-style transitions) reflect the user's choice live.
 *
 * Implementation note: we accept `navigationRef` as a regular prop rather
 * than using `forwardRef` to dodge the variance mismatch between
 * `useNavigationContainerRef<RootStackParamList>()` (parameterised) and
 * `NavigationContainer`'s built-in `ref` type (unparameterised). Passing
 * the ref through as a prop bypasses React's ref forwarding without
 * losing any functionality — `NavigationContainer` still gets the same
 * ref object directly.
 */
function ThemedNavigationContainer({
  navigationRef,
  children,
}: {
  navigationRef: React.Ref<unknown>;
  children: React.ReactNode;
}) {
  const navTheme = useNavigationTheme();
  return (
    // The original (pre-refactor) call site passed this same ref to
    // NavigationContainer directly without an explicit type annotation, so
    // we use `any` for the cast — preserving the historical behaviour
    // exactly without re-typing react-navigation's ref shape.
    <NavigationContainer ref={navigationRef as any} theme={navTheme}>
      {children}
    </NavigationContainer>
  );
}

// ============================================
// CONTENU PRINCIPAL
// ============================================

function AppContent({ onSecurityChange, onRequestRestore }: { onSecurityChange: () => void; onRequestRestore: () => void; }) {
  // contentStyle is consumed by react-navigation between screen transitions —
  // a fresh value each render ensures the background colour follows the
  // current theme (no inheritance from the legacy module-level palette).
  const { colors } = useTheme();
  return (
    <Call1to1Provider>
      <Stack.Navigator
        initialRouteName="ConversationList"
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="ConversationList" component={ConversationListScreen} />
        <Stack.Screen name="Conversation" component={ConversationScreen} />
        <Stack.Screen 
          name="ContactInfo" 
          component={ContactInfoScreen}
          options={{ presentation: 'card' }}
        />
        <Stack.Screen 
          name="Create1to1" 
          component={Create1to1Screen} 
          options={{ 
            presentation: 'fullScreenModal',
            animation: 'fade',
            gestureEnabled: false,
            headerShown: false,
          }} 
        />
        <Stack.Screen 
          name="Invitations" 
          component={InvitationsScreen}
          options={{ presentation: 'card' }}
        />
        <Stack.Screen 
          name="InviteDetail" 
          component={InviteDetailScreen}
          options={{ presentation: 'card' }}
        />
        <Stack.Screen 
          name="ConnectionSuccess" 
          component={ConnectionSuccessScreen}
          options={{ 
            presentation: 'fullScreenModal',
            animation: 'fade',
            headerShown: false,
            gestureEnabled: false,
          }}
        />
        <Stack.Screen 
          name="Join1to1" 
          component={Join1to1Screen} 
          options={{ 
            presentation: 'modal',
            gestureEnabled: true,
          }} 
        />
        {/* v30.0 — Groupes */}
        {/*
          [GROUPES DÉSACTIVÉS] — cf. src/config/features.ts.
          Les 5 écrans de groupe ne sont PAS enregistrés dans le Stack tant que
          `GROUPS_ENABLED` est faux : aucune route n'existe, donc aucun chemin
          de navigation ne peut les atteindre, même par un deep link forgé ou
          un `navigate()` oublié — react-navigation ignore une route inconnue
          au lieu d'ouvrir un écran. C'est le verrou de dernier recours, en
          plus du gating de chaque point d'entrée dans les écrans appelants.

          Les composants restent IMPORTÉS et donc compilés/typés : ils ne
          peuvent pas pourrir silencieusement pendant que la fonctionnalité
          dort. Le fragment est conditionnel (et non commenté) pour que la
          réactivation ne demande qu'un basculement du drapeau.
        */}
        {GROUPS_ENABLED && (
          <>
            <Stack.Screen name="CreateGroup" component={CreateGroupScreen} />
            <Stack.Screen name="GroupInfo" component={GroupInfoScreen} />
            <Stack.Screen name="AddGroupMembers" component={AddGroupMembersScreen} />
            <Stack.Screen
              name="GroupInviteQR"
              component={GroupInviteQRScreen}
              options={{ presentation: 'modal', gestureEnabled: true }}
            />
            <Stack.Screen
              name="JoinGroup"
              component={JoinGroupScreen}
              options={{ presentation: 'modal', gestureEnabled: true }}
            />
          </>
        )}
        <Stack.Screen name="Settings">
          {(props) => (
            <SettingsScreen
              {...props}
              onSecurityChange={onSecurityChange}
              onRequestRestore={onRequestRestore}
            />
          )}
        </Stack.Screen>
        <Stack.Screen 
          name="EditProfile" 
          component={EditProfileScreen}
          options={{ presentation: 'card' }}
        />
        <Stack.Screen 
          name="Language" 
          component={LanguageScreen}
          options={{ presentation: 'card' }}
        />
        <Stack.Screen
          name="Theme"
          component={ThemeScreen}
          options={{ presentation: 'card' }}
        />
        <Stack.Screen name="Security" options={{ presentation: 'modal' }}>
          {(props) => (
            <SecurityScreen
              onBack={() => {
                onSecurityChange();
                props.navigation.goBack();
              }}
              onSettingsChanged={onSecurityChange}
            />
          )}
        </Stack.Screen>
        <Stack.Screen
          name="MigrationExport"
          options={{
            // Card presentation (default) suits a multi-step flow better than
            // a modal: feels like a deeper navigation, and the back gesture
            // matches the in-screen "Back" button. We disable gestures so
            // the user can't accidentally swipe away mid-export.
            presentation: 'card',
            gestureEnabled: false,
          }}
        >
          {(props) => (
            <MigrationExportScreen
              appVersion={require('./package.json').version || '3.0.0'}
              onBack={() => props.navigation.goBack()}
              onWiped={() => {
                // After the wipe, the device is a blank slate. We pop this
                // screen — App.tsx's outer state subscriber will see that
                // there is no marker and no profile, and route to onboarding
                // on the next bootstrap pass.
                props.navigation.goBack();
              }}
            />
          )}
        </Stack.Screen>
      </Stack.Navigator>
      <NotificationOnboarding onComplete={(accepted) => {
        if (accepted) {
          initPushNotifications(async () => {
            try {
              const { pollAllSessions } = require('./src/services/api1to1');
              await pollAllSessions();
            } catch {}
          }).then(async (ready) => {
            if (ready) {
              __DEV__ && console.log('[App] ✅ Push notifications active (from onboarding)');
              try { await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK); } catch {}
              const { sendPushTokenToAllPeers } = require('./src/services/api1to1');
              sendPushTokenToAllPeers().catch(() => {});
            }
          }).catch(() => {});
        }
      }} />
    </Call1to1Provider>
  );
}

// ============================================
// PUSH NOTIFICATIONS — Background Task
// ============================================
// DOIT être au top level (hors composant) pour fonctionner
// quand l'app est tuée. Le ping wake-up déclenche un poll
// via le pipeline OHTTP chiffré existant.
TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error('[BackgroundPush] Error:', error);
    return;
  }
  if (data) {
    const pushData = (data as any).data;
    
    if (pushData?.t === 'c') {
      // ============================================
      // APPEL ENTRANT — notification persistante + vibration continue
      // ============================================
      // Le push FCM est data-only (pas de clé "notification") donc
      // Android ne crée rien automatiquement. On crée localement
      // une notification d'appel avec vibration continue, comme WhatsApp.
      try {
        await showIncomingCallNotification();
        // Aussi poll pour que l'app traite le signal d'appel
        const { pollAllSessions } = require('./src/services/api1to1');
        await pollAllSessions();
      } catch (err) {
        console.error('[BackgroundPush] Call notification error:', err);
      }
    } else if (pushData?.t === 'h') {
      // ============================================
      // ANNULATION D'APPEL — l'appelant a raccroché avant réponse
      // ============================================
      // Push data-only (silencieux). On stoppe la sonnerie et on poll
      // pour récupérer le signal hangup chiffré E2E. Le traitement
      // du signal dans notifyCallSignal() affichera "Appel manqué"
      // avec le nom de l'appelant déchiffré, sans exposer de métadonnées.
      try {
        const { stopRinging } = require('./src/services/pushNotificationService');
        // Stopper la sonnerie immédiatement (foreground service natif)
        await stopRinging();
        // Poll pour traiter le signal hangup chiffré E2E
        // → notifyCallSignal() affichera "Appel manqué" avec le nom déchiffré
        const { pollAllSessions } = require('./src/services/api1to1');
        await pollAllSessions();
      } catch (err) {
        console.error('[BackgroundPush] Call cancel error:', err);
      }
    } else if (pushData?.t === 'w') {
      // ============================================
      // MESSAGE — poll seulement (la notif FCM est déjà affichée)
      // ============================================
      try {
        const { pollAllSessions } = require('./src/services/api1to1');
        await pollAllSessions();
      } catch (err) {
        console.error('[BackgroundPush] Poll error:', err);
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PINNING READY — promesse singleton, idempotente
// ═══════════════════════════════════════════════════════════════════════════
// `initializePinning` est lui-même idempotent via `pinningInitialized`, mais on
// encapsule l'appel dans une Promise mémoïsée pour :
//   (1) éviter des logs / `listenForPinningErrors` dupliqués si deux chemins
//       (pré-check + initializeApp, ou pré-check + handleUnlock) l'invoquent
//       en parallèle au cold start ;
//   (2) offrir à handleUnlock une primitive await-able garantissant que le
//       pinning est ACTIF avant toute requête réseau post-unlock (sealed
//       sender bootstrap, polling).
//
// Safety : un échec d'init du pinning n'est PAS bloquant pour l'UX. L'Alert
// de warning est déjà affiché en non-__DEV__ (comportement existant). Si le
// pinning est inactif, les requêtes réseau passeront mais la couche TLS
// système reste en place. C'est au user de voir l'alerte.
// ═══════════════════════════════════════════════════════════════════════════
let _pinningReadyPromise: Promise<void> | null = null;
function ensurePinningReady(): Promise<void> {
  if (_pinningReadyPromise) return _pinningReadyPromise;
  _pinningReadyPromise = (async () => {
    try {
      const pinStatus = await initializePinning();
      console.log(`🔒 Pinning: ${pinStatus.active ? 'ACTIF' : 'INACTIF'} — ${pinStatus.reason}`);
      if (pinStatus.active) {
        __DEV__ && console.log(`🔒 Domaines pinnés: ${pinStatus.domains.join(', ')}`);
        listenForPinningErrors((error) => {
          console.error('🚨 SSL Pinning error:', error.serverHostname);
        });
      }
      if (!pinStatus.active && !__DEV__) {
        void showAlert({
          title: i18n.t('app.pinningInactiveTitle'),
          message: i18n.t('app.pinningInactiveMessage', { reason: pinStatus.reason }),
        });
      }
    } catch (e) {
      console.error('[App] ensurePinningReady error:', e);
    }
  })();
  return _pinningReadyPromise;
}

// ============================================
// APP PRINCIPALE
// ============================================

// Outer wrapper: provides the ThemeContext to the entire app tree so
// `useTheme()` works from anywhere — including the StatusBar, Navigation
// theme, all screens, modals, and the in-app notification host.
//
// The initial preference is read SYNCHRONOUSLY from the themeStorage cache.
// If the async load (kicked off at module import) has resolved, this is
// the user's stored choice. If not, it defaults to 'system' and the
// ThemeProvider's own useEffect will re-load and update if needed — this
// only happens for the very first render at very cold start.
export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider initialPreference={loadStoredAppearanceSync()}>
        <AppInner />
      </ThemeProvider>
    </ErrorBoundary>
  );
}

function AppInner() {
  // Prevent screen from auto-locking while the app is in the foreground.
  // iOS: isIdleTimerDisabled = true / Android: FLAG_KEEP_SCREEN_ON.
  // User can still lock manually via power button.
  useKeepAwake();
  bootlog('App component function entered');

  // Styles racine, reconstruits à chaque changement de palette. Ce hook doit
  // rester AVANT tout retour anticipé (il y en a une dizaine plus bas) pour
  // que l'ordre des hooks soit stable d'un rendu à l'autre.
  const styles = useThemedStyles(makeStyles);

  // ════════════════════════════════════════════════════════════════════════
  // ÉTATS INITIAUX BASÉS SUR LE HINT — ÉLIMINATION DE LA PHASE D'ATTENTE
  // ════════════════════════════════════════════════════════════════════════
  // Si `_lockHintCache` est déjà résolu au moment du 1er rendu (cas le plus
  // fréquent : 5-30 ms entre import et mount, vs ~10 ms typique pour la
  // lecture AsyncStorage), on bénéficie immédiatement de l'information :
  //
  //   • hint === true  → lockEnabled=true, isLocked=true, lockDetected=true
  //                       isInitializing=false → render LockScreen DIRECT
  //   • hint === false → lockDetected=true (pas besoin d'attendre la conf)
  //                       → tombe dans isInitializing=true → SplashScreen
  //   • hint === null  → comportement actuel (initialCover puis détection)
  //   • hint === pending → comportement actuel (mais usuellement résolu au
  //                         2e rendu, déclenché par l'effect ci-dessous)
  //
  // La vérification SecureStore (source de vérité) tourne ensuite en tâche
  // de fond via le useEffect d'init et corrige si désaccord (cas rarissime,
  // typiquement seulement après une modification externe des données).
  // ════════════════════════════════════════════════════════════════════════
  const initialHint = _lockHintCache;  // snapshot à l'instant du 1er render
  const hintIsPending = initialHint === 'pending';
  const hintSaysLocked = initialHint === true;
  bootlog(`first render — hint snapshot: ${hintIsPending ? 'pending' : initialHint === null ? 'null' : initialHint}`);

  // isInitializing : true au boot SAUF si le hint dit qu'il y a un lock
  // (auquel cas on ne rend PAS le SplashScreen, on rend le LockScreen direct).
  const [isInitializing, setIsInitializing] = useState(!hintSaysLocked);
  const [initError, setInitError] = useState<string | null>(null);

  // lockDetected : true dès le 1er rendu si le hint a déjà répondu
  // (true OU false — dans les deux cas, on sait quoi rendre). Reste false
  // uniquement si le hint est encore en cours (cas rare, résolution rapide).
  // Quand true, on saute le `<View>` initialCover et on rend directement
  // soit le LockScreen, soit le SplashScreen, selon les autres flags.
  const [lockDetected, setLockDetected] = useState(!hintIsPending);

  // isLocked + lockEnabled : initialisés à true si le hint dit lock=true.
  // Cela permet au render `if (isLocked && lockEnabled)` plus bas de
  // sélectionner le LockScreen au tout premier paint, sans attendre que
  // `isLockEnabledFast` confirme — la confirmation tourne en arrière-plan.
  const [isLocked, setIsLocked] = useState(hintSaysLocked);
  // `lockSessionId` : compteur incrémenté à chaque ÉVÉNEMENT de verrouillage.
  // Utilisé comme `key` du LockScreen → React le démonte/remonte à chaque
  // changement, ce qui reset son state local (TextInput, error, lockedUntil…)
  // — comportement identique à un kill+relaunch du point de vue du LockScreen.
  //
  // Pourquoi indispensable : si l'utilisateur est DÉJÀ sur le LockScreen
  // (par ex. cold start avec lock, ou re-lock précédent) et background +
  // retour après timeout, le handler AppState fait setIsLocked(true) — mais
  // isLocked était déjà true → React bail-out (Object.is), pas de re-render
  // du sous-arbre LockScreen → l'utilisateur garderait la valeur précédemment
  // tapée dans le TextInput. Avec un key qui change, React force le remount
  // et le LockScreen repart d'un state vierge.
  const [lockSessionId, setLockSessionId] = useState(0);
  // `splashInstant` : passé en prop au SplashScreen rendu en post-unlock.
  //
  // Pendant Argon2 (1-2s), LockScreen rend son PROPRE <SplashScreen instant />
  // (instance A, déjà en plein bloom — pas de fade-in : tap sur "Déverrouiller"
  // → splash visible immédiatement, retour visuel instantané).
  //
  // Une fois Argon2 terminé, App.tsx bascule de la branche LockScreen vers
  // la branche isInitializing → instance A unmount, instance B (App.tsx) mount.
  // Sans précaution, l'instance B redémarrerait toutes ses Animated.Value
  // d'entrée à 0 et referait un fade-in de 700-1200ms — l'utilisateur
  // percevrait un « flash sombre » entre deux SplashScreens visuellement
  // identiques.
  //
  // setSplashInstant(true) (dans handleUnlock, AVANT setIsInitializing) propage
  // l'info à l'instance B : initialise textOpacity, bottomOpacity, GhostLogo
  // entrance values directement à leurs valeurs finales (1, 1, 1, …). L'instance
  // B paraît identique à l'instance A en plein bloom → continuité parfaite.
  //
  // Reset à false dans le finally pour que les utilisations ultérieures du
  // SplashScreen (cold start, post-onboarding, post-setup-profile) gardent
  // leur fade-in normal — celui-ci est attendu et naturel quand le SplashScreen
  // n'est pas précédé d'une autre instance déjà en bloom.
  const [splashInstant, setSplashInstant] = useState(false);
  // lockEnabled : initialisé depuis le hint pour que la condition `isLocked &&
  // lockEnabled` du render branche LockScreen soit vraie au tout 1er paint.
  // Confirmé par initializeApp ou par le useEffect de bootstrap principal,
  // qui appelle isLockEnabledFast (SecureStore, source de vérité).
  const [lockEnabled, setLockEnabled] = useState(hintSaysLocked);
  const [lockTimeout, setLockTimeout] = useState(1);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  // Guideline 1.2 : CGU non acceptées → écran TermsScreen bloquant.
  // Vrai pour les nouveaux utilisateurs (entre le carrousel et le profil)
  // ET pour les utilisateurs existants après mise à jour (une seule fois).
  const [needsTerms, setNeedsTerms] = useState(false);
  const [needsProfileSetup, setNeedsProfileSetup] = useState(false);

  // ── Migration state ─────────────────────────────────────────────────────
  // Initial value uses the AsyncStorage hint (fast, ~5-30ms). The SecureStore
  // truth is loaded async in the bootstrap and corrects this if needed.
  const initialMigrationHint = _migrationHintCache;
  const [migrationFrozen, setMigrationFrozen] = useState<boolean>(
    initialMigrationHint === true
  );
  const [migrationCheckDone, setMigrationCheckDone] = useState<boolean>(
    initialMigrationHint !== 'pending'
  );

  // "Restoring migration" mode: when the user picks "Restore" on Welcome,
  // we mount MigrationImportScreen instead of the normal onboarding.
  const [restoringMigration, setRestoringMigration] = useState<boolean>(false);
  const [splashStatus, setSplashStatus] = useState<string | undefined>(undefined);

  // Privacy overlay: masque le contenu pendant 'inactive'/'background' afin
  // qu'aucune donnée ne fuite dans l'App Switcher / Recents.
  const [showPrivacyOverlay, setShowPrivacyOverlay] = useState(false);

  const previousAppState = useRef<AppStateStatus>(AppState.currentState);
  const inactiveStartTime = useRef<number | null>(null);
  const wentToBackground = useRef(false);
  const initStartedRef = useRef(false);

  // Timestamp du dernier passage en `background` (pour mesurer elapsed au retour).
  //
  // POURQUOI AU NIVEAU COMPOSANT (et non en local du useEffect AppState) :
  // Le listener `addCall1to1StateListener` (effet séparé plus bas) doit pouvoir
  // ÉCRIRE cette ref pour réparer le marqueur de verrouillage si un appel se
  // termine alors que l'app est en background. Sans ce hissage, le listener n'a
  // pas accès à la closure du useEffect AppState et ne peut pas reposer le
  // marqueur — l'app reste alors déverrouillée arbitrairement longtemps après
  // la fin d'un appel en background. Cf. fix scénarios C/G/L/M/N (call-end-in-bg).
  const lastBgEnterTime = useRef(0);

  // Ref de navigation : permet à App de connaître l'écran courant pour
  // détecter les transitions vers des écrans modaux Android (qui provoquent
  // un faux 'background' le temps que la nouvelle Activity prenne le foreground).
  const navigationRef = useNavigationContainerRef<RootStackParamList>();

  // ═══════════════════════════════════════════════════════════════════════
  // DEEP LINKS : Universal Links iOS / App Links Android / scheme natif
  // ═══════════════════════════════════════════════════════════════════════
  // Branche les listeners Linking dès le mount. Quand un lien d'invitation
  // est reçu (cold-start ou runtime), le inviteString est extrait du
  // fragment URL et stocké en mémoire, puis consommé dès que l'app est
  // entièrement bootée et déverrouillée (appReady=true).
  //
  // Le inviteString N'EST JAMAIS persisté sur disque. Si l'app est killée
  // avant déverrouillage, l'invitation est perdue (l'utilisateur peut
  // recliquer le lien) — c'est intentionnel pour limiter la surface.
  //
  // appReady = état où NavigationContainer est monté ET sessionService est
  // initialisé ET l'utilisateur n'est ni en onboarding, ni en setup, ni
  // verrouillé. C'est exactement le set de conditions sous lesquelles le
  // render principal retourne <NavigationContainer>.
  const appReady =
    !isInitializing &&
    !initError &&
    !needsOnboarding &&
    !needsProfileSetup &&
    !(isLocked && lockEnabled);
  useDeepLinkInvite({ navigationRef, appReady });

  // Timestamp de la dernière navigation vers un écran de ANDROID_MODAL_SCREENS.
  // Lu par le handler AppState : si un 'background' survient dans la fenêtre
  // MODAL_NAV_GRACE_MS après cette navigation, c'est la transition d'Activity
  // → on suppress le verrouillage. Au-delà, c'est un vrai départ utilisateur.
  const lastModalNavTime = useRef<number>(0);

  // Refs miroirs pour que le handler AppState puisse lire les valeurs à jour
  // sans que son useEffect soit recréé à chaque changement de state. Sans
  // ces miroirs, chaque setIsLocked/setLockEnabled/setLockTimeout recrée le
  // listener AppState, ce qui peut (1) rater un event en transition, (2)
  // causer un double-handling si l'ancien listener n'est pas retiré à temps
  // sur certaines ROMs Android.
  const lockEnabledRef = useRef(lockEnabled);
  const lockTimeoutRef = useRef(lockTimeout);
  const isLockedRef = useRef(isLocked);
  useEffect(() => { lockEnabledRef.current = lockEnabled; }, [lockEnabled]);
  useEffect(() => { lockTimeoutRef.current = lockTimeout; }, [lockTimeout]);
  useEffect(() => { isLockedRef.current = isLocked; }, [isLocked]);

  // ═══════════════════════════════════════════════════════════════════════
  // MIGRATION STATE SUBSCRIBER
  // ═══════════════════════════════════════════════════════════════════════
  // Synchronize React state with the marker. Fires on every marker mutation
  // (after export → freeze, after wipe, after cancel) without polling.
  useEffect(() => {
    const unsub = subscribeMigrationStateChange(() => {
      const m = getMigrationMarkerSync();
      const frozen = m?.state === 'frozen' || m?.state === 'wiping';
      setMigrationFrozen(frozen);
      setMigrationCheckDone(true);
    });
    return unsub;
  }, []);

  // Handle the case where the AsyncStorage hint resolved AFTER the first
  // render (i.e. _migrationHintCache was 'pending' at mount).
  useEffect(() => {
    if (migrationCheckDone) return;
    let cancelled = false;
    _migrationHintPromise.then(v => {
      if (cancelled) return;
      if (v === true) setMigrationFrozen(true);
    });
    return () => { cancelled = true; };
  }, [migrationCheckDone]);
  // ═══════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════
  // APP NOTICE — STOP HEAVY SERVICES WHEN KILL-SWITCH IS ACTIVE
  // ═══════════════════════════════════════════════════════════════════════
  // Quand un kill-switch est actif, on STOPPE le polling, le sealed sender
  // bootstrap (qui déclenche PoW lourd) et le constant traffic. C'est inutile
  // — l'utilisateur doit migrer, pas envoyer/recevoir de messages. Et ça
  // saturait le JS thread pendant 20+ secondes (visible dans les logs).
  //
  // Le redémarrage est manuel : si l'utilisateur snooze (warning) ou si
  // l'avis est révoqué côté serveur, il faudra rebooter l'app. C'est une
  // limitation acceptable car (a) snooze est rare (24h) et l'app se relance
  // souvent, (b) une révocation serveur est aussi rare.
  // ═══════════════════════════════════════════════════════════════════════
  useEffect(() => {
    // Check initial: si on a déjà un notice dans le cache au mount, stopper
    // immédiatement (avant même que startGlobalPolling1to1 ne tourne).
    if (getCurrentAppNotice()) {
      __DEV__ && console.log('[App] AppNotice already active at mount — stopping heavy services');
      try { stopGlobalPolling1to1(); } catch {}
      try { resetSealedSenderBootstrap(); } catch {}
    }
    const unsub = subscribeAppNotice((n) => {
      if (n) {
        __DEV__ && console.log('[App] AppNotice activated — stopping polling/sealedSender/PoW');
        try { stopGlobalPolling1to1(); } catch {}
        try { resetSealedSenderBootstrap(); } catch {}
      }
    });
    return unsub;
  }, []);
  // ═══════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════
  // TRACKING DES NAVIGATIONS VERS LES ÉCRANS MODAUX ANDROID
  // ═══════════════════════════════════════════════════════════════════════
  // Sur Android, react-native-screens ouvre les écrans `presentation: 'modal'`
  // / `'fullScreenModal'` dans une nouvelle Activity. La transition fait
  // brièvement passer l'app en 'background'. Pour éviter de verrouiller à
  // tort, on enregistre l'instant de la navigation vers ces écrans : si un
  // 'background' survient dans la grâce MODAL_NAV_GRACE_MS, on l'ignore.
  //
  // On ne marque QUE l'entrée dans un écran modal (pas le retour). On ne
  // marque QU'AU CHANGEMENT D'ÉCRAN (pas si l'utilisateur reste sur un écran
  // modal pendant longtemps), pour éviter qu'un Home button pressé après un
  // long séjour dans Settings soit traité comme une transition modale.
  //
  // Sur iOS : ces écrans modaux ne déclenchent pas de background, donc le
  // marqueur est posé mais inutile (et inoffensif).
  // ═══════════════════════════════════════════════════════════════════════
  useEffect(() => {
    let lastFocusedRoute: string | null = null;
    const unsubscribe = navigationRef.addListener('state', () => {
      if (!navigationRef.isReady()) return;
      const state = navigationRef.getRootState();
      if (!state) return;
      // Descendre dans les navigateurs imbriqués jusqu'à la feuille focus
      let route: any = state.routes[state.index];
      while (route?.state) {
        route = route.state.routes[route.state.index];
      }
      const currentName = route?.name ?? null;
      // Marquer UNIQUEMENT à l'entrée dans un écran modal (transition).
      // Si l'utilisateur reste sur Settings et que le state change pour une
      // autre raison (params, focus), on ne re-marque pas.
      if (
        currentName !== lastFocusedRoute &&
        currentName != null &&
        ANDROID_MODAL_SCREENS.has(currentName)
      ) {
        lastModalNavTime.current = Date.now();
      }
      lastFocusedRoute = currentName;
    });
    return unsubscribe;
  }, [navigationRef]);
  // ═══════════════════════════════════════════════════════════════════════

  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;
    bootlog('useEffect bootstrap start');

    // ═══════════════════════════════════════════════════════════════════════
    // MICRO-PHASE -1 — MIGRATION MARKER (highest priority, runs before lock)
    // ═══════════════════════════════════════════════════════════════════════
    // The migration marker overrides every other state. If the device is in
    // 'frozen' or 'wiping' state, MigrationLockdownScreen is rendered and ALL
    // crypto / network init is skipped. This is the primary enforcement of
    // the single-active-device invariant for Triple Ratchet.
    //
    // GUARANTEES IN FROZEN STATE:
    //   - sessionService.initialize() is NOT called (no ratchet state load)
    //   - initHardwareEncryptionAll() is NOT called
    //   - No polling, no background tasks, no network operations
    //   - Even if a stray timer fires secureRpc, the guard in
    //     relayTransport.ts catches it (defense in depth).
    //
    // The frozen state is propagated via React state (`migrationFrozen`);
    // the render branch picks MigrationLockdownScreen on the next commit.
    // ═══════════════════════════════════════════════════════════════════════
    loadMarkerFromDisk().then(marker => {
      const frozen = marker?.state === 'frozen' || marker?.state === 'wiping';
      setMigrationFrozen(frozen);
      setMigrationCheckDone(true);
      if (frozen) {
        bootlog('migration marker indicates frozen — bootstrap will short-circuit');
      }
    }).catch(() => {
      setMigrationCheckDone(true);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // MICRO-PHASE 0 — DÉTECTION RAPIDE DU VERROUILLAGE
    // ═══════════════════════════════════════════════════════════════════════
    // Trois sources d'information sur la présence du lock, par ordre de
    // rapidité décroissante :
    //
    //   (a) `_lockHintCache` (AsyncStorage, déjà résolu via top-level promise) :
    //       réponse INSTANTANÉE si le hint est résolu au moment du 1er render.
    //       Cas typique : 5-30 ms entre import du module et mount → hint quasi
    //       toujours résolu. L'état initial du composant a déjà sélectionné
    //       le LockScreen ou le SplashScreen → AUCUNE phase d'attente visible.
    //
    //   (b) `_lockHintPromise` (encore en cours) : on l'attend si nécessaire,
    //       puis on bascule l'UI. Délai typique : < 30 ms supplémentaires.
    //
    //   (c) `isLockEnabledFast` (SecureStore, source de vérité) : appelé pour
    //       CONFIRMER le hint et corriger en cas de désaccord (très rare,
    //       typiquement seulement au premier boot post-installation du fix
    //       quand le hint n'existe pas encore, ou si quelque chose a écrit
    //       les données SecureStore sans passer par setupLock/disableLock).
    //
    // GARANTIES SÉCURITÉ pendant la phase locked :
    //   - `encryptionKey` dans localCrypto reste `null` (module-level, pristine
    //     au cold start).
    //   - `conversationsEncryptionKey` dans storage reste `null`.
    //   - `sessionService.initialize()` n'est PAS appelé (serait destructeur
    //     sans clé : il lirait des données chiffrées avec une clé absente et
    //     écraserait l'état ratchet avec des valeurs vides).
    //   - Aucun polling, aucun fetch, aucune tentative de déchiffrement.
    //   - Le hint est juste un booléen plaintext, JAMAIS source de vérité —
    //     SecureStore reste l'autorité finale.
    // ═══════════════════════════════════════════════════════════════════════

    // Protection capture d'écran — à activer au plus tôt. Idempotent.
    // No-op dans les builds development/preview qui posent explicitement
    // EXPO_PUBLIC_ALLOW_SCREEN_CAPTURE=1 (vidéo de démo App Review, cf.
    // APP_REVIEW_RESUBMISSION.md §4). Toute autre configuration — production
    // en tête — arme la protection : le défaut est le comportement strict.
    armScreenCaptureProtection();
    bootlog(`screen capture protection: ${SCREEN_CAPTURE_ALLOWED ? 'DISABLED (build de démo)' : 'armed'}`);

    // Pinning : dispatch en fire-and-forget. Idempotent.
    ensurePinningReady().catch(() => {});

    // Security check + silent-mode — DISPATCH INCONDITIONNEL (locked ET unlocked).
    performDeviceSecurityCheck();
    loadSilentMode().catch(() => {});

    // ──────────────────────────────────────────────────────────────────────
    // WARM-UPS LÉGERS (NON-BLOQUANTS) AU BOOT SI LE HINT DIT « LOCK » :
    // ──────────────────────────────────────────────────────────────────────
    // SEULS les warm-ups qui ne bloquent PAS le thread JS sont lancés ici :
    //   - initSodiumZeroize : init libsodium NATIF (le pont JS est libre)
    //   - isArgon2Available : probe natif (instant)
    //   - getLockSettings   : lecture SecureStore (~50ms, async)
    //
    // Le PoW (`precomputePoW`) est volontairement ABSENT — il est dispatché
    // par le LockScreen lui-même à la 1ère interaction utilisateur (focus
    // sur le TextInput). Pourquoi : le PoW est un calcul SHA-256 itératif
    // synchrone qui bloque le JS thread ~3 secondes. S'il est lancé au boot :
    //
    //   - Le 1er paint du LockScreen se fait, mais...
    //   - L'utilisateur tape sur le TextInput → keyboardDidShow déclenché en JS
    //   - Le JS thread est bloqué par le PoW → l'événement reste en queue
    //   - Le logo ne se réduit pas, KeyboardAvoidingView ne réagit pas, les
    //     éléments ne remontent pas au-dessus du clavier → UX cassée
    //
    // En déplaçant le dispatch dans LockScreen.onFocus, le PoW démarre PENDANT
    // que le clavier monte (animation native, n'utilise pas le JS thread)
    // et tourne pendant que l'utilisateur tape (3-10s humaine de saisie =
    // largement assez pour absorber les 3s de PoW). Au moment du tap sur
    // « Déverrouiller », le PoW est généralement déjà prêt.
    //
    // Si l'utilisateur reste figé sur l'écran sans toucher le TextInput, un
    // safety net dans LockScreen lance le PoW après 1500ms — il sera donc
    // prêt même dans ce cas extrême.
    // ──────────────────────────────────────────────────────────────────────
    if (hintSaysLocked) {
      bootlog('hint=true → dispatching lightweight warm-ups (PoW deferred to user interaction)');
      // Lecture SecureStore légère — async, ne bloque pas le JS thread.
      getLockSettings()
        .then(s => setLockTimeout(s.timeoutMinutes))
        .catch(() => {});
      // Sodium init et Argon2 probe sont natifs : init JS instantané, le
      // travail réel se fait sur le thread natif. Aucun blocage du JS thread.
      // On les lance après 2 rAF par précaution (au cas où une init lance
      // accidentellement du travail JS), mais en pratique c'est immédiat.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          bootlog('post-paint → dispatching native warm-ups (sodium, argon2)');
          initSodiumZeroize();
          isArgon2Available();
        });
      });
    }

    (async () => {
      // Étape 1 : si le hint était pending au 1er render, on l'attend ici
      // avant d'appeler isLockEnabledFast. Évite un double aller-retour de
      // décision (basculer rapidement sur isInitializing puis sur LockScreen).
      let hint = _lockHintCache;
      if (hint === 'pending') {
        bootlog('awaiting lock hint promise (was pending at first render)');
        hint = await _lockHintPromise;
        bootlog(`hint resolved post-mount: ${hint}`);
        // Si le hint dit lock=true et qu'on n'a pas encore rendu LockScreen,
        // on bascule TOUT DE SUITE — sans attendre la confirmation SecureStore.
        if (hint === true && !isLockedRef.current) {
          bootlog('post-mount hint=true → switching to LockScreen optimistically');
          // Setstate d'abord pour que le rendu LockScreen se déclenche.
          // PoW NON dispatché ici — voir le bloc principal plus haut pour le
          // rationale. Le LockScreen lance le PoW lui-même au focus du TextInput.
          setLockEnabled(true);
          setIsLocked(true);
          setIsInitializing(false);
          setLockDetected(true);
          getLockSettings().then(s => setLockTimeout(s.timeoutMinutes)).catch(() => {});
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              bootlog('post-paint → dispatching native warm-ups (post-mount path)');
              initSodiumZeroize();
              isArgon2Available();
            });
          });
        } else if (hint === false && !lockDetected) {
          // Hint dit pas de lock : on confirme lockDetected pour passer au
          // SplashScreen normal. La confirmation SecureStore tourne en
          // background ci-dessous au cas où le hint serait obsolète.
          setLockDetected(true);
        }
      }

      // Étape 1bis (FIX iOS) : attendre le firstLaunchGuard AVANT toute
      // lecture SecureStore (source de vérité). Sur iOS, le Keychain survit
      // à la désinstallation de l'app — sans cette attente, `isLockEnabledFast`
      // ci-dessous trouverait des résidus de l'installation précédente et
      // ferait basculer l'UI sur le LockScreen avec un faux mot de passe.
      // Sur Android, c'est un no-op rapide (~5-30ms AsyncStorage).
      // En cas de vraie réinstallation détectée, la purge a déjà eu lieu et
      // les `isLockEnabled*` qui suivent renverront false.
      try {
        await _firstLaunchPromise;
      } catch {
        // Catché en interne ; ne devrait jamais throw, mais par défense.
      }

      // Étape 2 : confirmation SecureStore (source de vérité). Cet appel sert
      // à détecter les désaccords avec le hint (cas rares : 1er boot post-
      // installation, ou modifications externes des données).
      bootlog('calling isLockEnabledFast (SecureStore confirmation)');
      const _t = Date.now();
      let fastLocked: boolean | null = null;
      try {
        fastLocked = await isLockEnabledFast(1500);
      } catch {
        fastLocked = null;
      }
      bootlog(`isLockEnabledFast resolved in ${Date.now() - _t}ms → ${fastLocked}`);

      // ════════════════════════════════════════════════════════════════════
      // CAS A : SecureStore confirme « lock activé »
      // ════════════════════════════════════════════════════════════════════
      if (fastLocked === true) {
        // Si on est déjà sur le LockScreen optimiste, c'est un no-op silencieux
        // (les setState identiques sont bail-out par React via Object.is).
        // Sinon (hint était false ou null), on bascule maintenant.
        if (!hintSaysLocked) {
          bootlog('SecureStore says lock=true but hint disagreed → switching to LockScreen');
          getLockSettings().then(s => setLockTimeout(s.timeoutMinutes)).catch(() => {});
          // PoW NON dispatché ici — laissé au LockScreen.onFocus.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              bootlog('post-paint → dispatching native warm-ups (SecureStore-confirmed path)');
              initSodiumZeroize();
              isArgon2Available();
            });
          });
        }
        setLockEnabled(true);
        setIsLocked(true);
        setIsInitializing(false);
        setLockDetected(true);
        return;
      }

      // ════════════════════════════════════════════════════════════════════
      // CAS B : SecureStore dit « pas de lock » OU timeout
      // ════════════════════════════════════════════════════════════════════
      // Si le hint disait lock=true mais SecureStore dit non, on a affiché un
      // LockScreen à tort. C'est extrêmement rare (uniquement si quelqu'un a
      // supprimé les données SecureStore sans passer par disableLock). On
      // bascule sur le boot normal — l'utilisateur ne perdra rien, juste un
      // affichage transitoire d'un LockScreen.
      if (hintSaysLocked && fastLocked === false) {
        bootlog('hint said lock=true but SecureStore says false → reverting to normal boot');
        setIsLocked(false);
        setLockEnabled(false);
      }

      bootlog('starting normal initializeApp() (no lock, or timeout)');
      setLockDetected(true);
      initializeApp();
    })();
  }, []);

  useEffect(() => {
    // ═══════════════════════════════════════════════════════════════════════
    // LOGIQUE DE VERROUILLAGE — Décision au RETOUR, pas au départ
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Principe : on n'efface les clés QUE lorsqu'on a la CERTITUDE que
    // l'utilisateur a vraiment quitté l'application. Tant qu'on est en doute
    // (transition, permission système, modal Android, hiccup OS), on laisse
    // les clés en place.
    //
    // Cas de verrouillage légitimes :
    //   1. Vrai départ vers une autre app (Home, App Switcher, autre app
    //      ouverte) → retour `active` après > BACKGROUND_CONFIRMATION_MS
    //   2. Écran verrouillé pendant l'absence → durée du background > seuil
    //      (on ne peut pas le savoir avec certitude depuis JS, mais toute
    //      absence longue l'implique probablement)
    //   3. App tuée par l'utilisateur ou l'OS → cold start, flag persisté
    //      dans AsyncStorage détecté par initializeApp
    //
    // Cas où on NE DOIT PAS verrouiller :
    //   - Navigation interne entre écrans (même card, même modal)
    //   - Permission système affichée (camera, galerie, notifications)
    //   - ImagePicker, DocumentPicker, caméra (suppressLock explicite)
    //   - Share.share système (suppressLock via withExternalActivity)
    //   - Appel vocal en cours (isInCall1to1)
    //   - Control Center iOS, Notification Center, volet Android
    //   - FaceID / empreinte digitale prompt
    //   - Hiccup OS quelconque (< 1.2s)
    //
    // Stratégie : au passage en `background`, on POSE juste les marqueurs.
    // Au retour `active`, on lit l'élapsed time et on décide :
    //   - < 1.2s → faux background, on annule silencieusement
    //   - ≥ 1.2s → vrai départ, on efface les clés et on verrouille
    //
    // Pour le cas kill + relance : AsyncStorage est écrit immédiatement au
    // départ, donc initializeApp peut détecter le flag au cold start.
    // ═══════════════════════════════════════════════════════════════════════

    // Fenêtre en-dessous de laquelle un retour `active` est considéré comme
    // un faux background (permission, modal, transition, hiccup).
    const FAKE_BG_WINDOW_MS = BACKGROUND_CONFIRMATION_MS;

    // NOTE: `lastBgEnterTime` est désormais une useRef hissée au niveau composant
    // (cf. déclaration plus haut), pour permettre au listener call-end de la
    // réparer si un appel se termine en background.

    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
      const prevState = previousAppState.current;

      // ═══════════════════════════════════════════════════════════════════════
      // INACTIVE (iOS) — overlay privacy uniquement, rien d'autre
      // ═══════════════════════════════════════════════════════════════════════
      if (nextAppState === 'inactive' && prevState === 'active') {
        inactiveStartTime.current = Date.now();
        setShowPrivacyOverlay(true);
      }

      // ═══════════════════════════════════════════════════════════════════════
      // BACKGROUND — ON NE DÉCIDE PAS, ON POSE DES MARQUEURS
      // ═══════════════════════════════════════════════════════════════════════
      if (nextAppState === 'background') {
        bootlog(`AppState change → 'background' (from ${previousAppState.current})`);
        setShowPrivacyOverlay(true);

        // ─────────────────────────────────────────────────────────────────
        // Persister l'index d'aperçus de conversation PENDANT que la clé de
        // chiffrement est encore chargée.
        //
        // L'index est écrit de façon groupée (250 ms) pour ne pas déclencher
        // une écriture par message reçu. Un passage en arrière-plan peut donc
        // survenir avec des aperçus encore en mémoire. On force l'écriture
        // ici, en tout premier : tout le code de `flushLastMessagePreviews`
        // jusqu'à son premier `await` — y compris le chiffrement — s'exécute
        // de façon synchrone, donc AVANT tout `clearEncryptionKey()` déclenché
        // plus bas dans ce même handler.
        //
        // Volontairement fire-and-forget : le seul travail asynchrone restant
        // est le `setItem` sur des données DÉJÀ chiffrées. Ne jamais awaiter
        // ici — bloquer le handler AppState retarderait l'affichage de
        // l'overlay de confidentialité, donc exposerait le contenu de l'écran
        // dans le sélecteur d'applications.
        //
        // Si la clé a déjà disparu, le flush s'abstient d'écrire plutôt que de
        // persister des extraits de messages en clair (garde interne).
        void flushLastMessagePreviews();
        // ─────────────────────────────────────────────────────────────────

        // Le "moment du départ" : sur iOS on a vu un 'inactive' juste avant
        // le 'background', et c'est ce moment-là qu'on veut compter comme
        // début de l'absence (pour ne pas perdre 50-200 ms de précision).
        // Sur Android pas d'inactive intermédiaire → fallback Date.now().
        const departureTime = inactiveStartTime.current || Date.now();
        lastBgEnterTime.current = departureTime;

        // Trois cas où ce 'background' est FAUX (transition interne) et où
        // on doit tout simplement l'ignorer — aucun marqueur posé, aucun
        // verrouillage envisagé :
        //   1. lockGuard.suppressLock() en cours (picker, permission, share,
        //      caméra, document picker… toutes les opérations explicitement
        //      protégées par les écrans/services qui les déclenchent)
        //   2. Appel vocal en cours (audio en background autorisé)
        //   3. Navigation récente vers un écran modal Android
        //      (presentation: 'modal'/'fullScreenModal' → nouvelle Activity →
        //       transition de quelques centaines de ms)
        const recentModalNav =
          Date.now() - lastModalNavTime.current < MODAL_NAV_GRACE_MS;

        if (isLockSuppressed() || isInCall1to1() || recentModalNav) {
          // ────────────────────────────────────────────────────────────────
          // BRANCHE « FAUX BACKGROUND » — TRANSITION INTERNE
          // ────────────────────────────────────────────────────────────────
          // L'app passe brièvement en background pour une raison interne
          // (picker système, permission dialog, modal Android…). L'utilisateur
          // n'a pas réellement quitté l'app, le retour 'active' arrivera
          // dans quelques secondes.
          //
          // BUG FIX : on NE coupe PAS les services réseau ici.
          //
          // L'ancien code appelait `stopGlobalPolling1to1()` + `inviteWatcher.stop()`
          // dans cette branche pour économiser la batterie pendant la
          // suppression. Mais comme `wentToBackground.current` n'était PAS
          // mis à true (cette ligne se trouvant plus bas, après le return),
          // au retour 'active' la branche `if (!wentToBackground.current)`
          // était prise → exit immédiat SANS redémarrer les services →
          // ConstantTraffic restait stoppé jusqu'au prochain VRAI cycle
          // background→active. Symptôme : tous les messages envoyés après
          // un picker/permission échouaient avec « ConstantTraffic stopped
          // — message dropped », et les appels (signaux urgents) ne
          // partaient plus.
          //
          // CHOIX DESIGN : laisser les services tourner pendant les
          // suppressions courtes (typiquement 1-30s pour un picker, < 1s
          // pour un modal). L'économie batterie potentielle est négligeable
          // sur cette durée vs le coût UX d'avoir des messages qui échouent
          // silencieusement. Si l'utilisateur reste dans le picker très
          // longtemps, le système Android tuera de toute façon le process
          // ou l'app passera en VRAI background avec un nouveau changement
          // d'AppState.
          //
          // `pausePrivacyServices()` reste appelé : c'est une fonction
          // métier qui suspend des animations/timers locaux non-réseau.
          // ────────────────────────────────────────────────────────────────
          pausePrivacyServices();
          previousAppState.current = nextAppState;
          return;
        }

        // Cas général : VRAI départ probable. On pose les marqueurs.
        //   - `wentToBackground` (ref RAM) : lu au retour `active` pour
        //     calculer le temps écoulé et décider du verrouillage.
        //   - `LAST_BACKGROUND_TIME_KEY` (AsyncStorage persistant) : lu au
        //     cold start par `initializeApp` (via `checkIfShouldLock`) pour
        //     détecter le cas "app tuée par l'OS pendant qu'on était en
        //     background" → verrouillage au relancement.
        //
        // Les clés restent en RAM à ce stade. On NE LES EFFACE PAS — c'est
        // au handler `active` qu'on décide selon le temps écoulé.
        wentToBackground.current = true;
        try {
          await AsyncStorage.setItem(LAST_BACKGROUND_TIME_KEY, departureTime.toString());
        } catch {}

        // On pause le polling pour économiser la batterie mais on ne stoppe
        // PAS les services qui auraient besoin de recevoir un retour rapide.
        pausePrivacyServices();
        if (!isInCall1to1()) {
          stopGlobalPolling1to1();
          inviteWatcher.stop();
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // ACTIVE — retour au premier plan, C'EST ICI QU'ON DÉCIDE
      // ═══════════════════════════════════════════════════════════════════════
      if (nextAppState === 'active') {
        bootlog(`AppState change → 'active' (from ${previousAppState.current})`);
        inactiveStartTime.current = null;

        // App notice — re-check en fire-and-forget. Permet d'activer/lever
        // un avis sans cold restart. Échec silencieux si réseau KO.
        refetchAppNotice().catch(() => {});

        // Si aucun départ n'avait été enregistré (cas : arrivée directe en
        // active sans background préalable, début d'app, etc.), rien à faire.
        if (!wentToBackground.current) {
          setShowPrivacyOverlay(false);
          previousAppState.current = nextAppState;
          return;
        }

        // Calculer la durée qu'on a passée hors du premier plan
        const elapsedSinceBg = Date.now() - lastBgEnterTime.current;
        const wasFastReturn = elapsedSinceBg < FAKE_BG_WINDOW_MS;

        // Nettoyer les marqueurs dans TOUS les cas (on ne veut pas que le
        // prochain retour re-verrouille sur la base d'anciens marqueurs)
        wentToBackground.current = false;
        try { await AsyncStorage.removeItem(LAST_BACKGROUND_TIME_KEY); } catch {}

        // ── Retour rapide = faux background (permission, modal, hiccup) ──
        // L'app n'a jamais vraiment été quittée par l'utilisateur.
        // Rien à verrouiller. On restaure juste les services.
        if (wasFastReturn) {
          setShowPrivacyOverlay(false);
          if (!isLockedRef.current) {
            resumePrivacyServices();
            startGlobalPolling1to1();
            inviteWatcher.start().catch(console.error);
            // Token rotation safety net : si FCM/APNs a roulé notre token
            // pendant ce micro-background sans déclencher addPushTokenListener,
            // re-fetch et propage aux pairs. No-op si le token est inchangé.
            refreshOwnTokenIfChanged().catch(() => {});
          }
          previousAppState.current = nextAppState;
          return;
        }

        // ── Retour après ≥ FAKE_BG_WINDOW_MS = vrai départ détecté ──
        // Maintenant on consulte le timeout utilisateur pour décider.
        if (lockEnabledRef.current) {
          // ────────────────────────────────────────────────────────────────
          // BUG FIX : on calcule directement depuis `elapsedSinceBg` (déjà
          // calculé ligne 597 depuis lastBgEnterTime.current en RAM).
          //
          // Avant : on appelait `await checkIfShouldLock(lockTimeoutRef.current)`
          // qui re-lisait `LAST_BACKGROUND_TIME_KEY` dans AsyncStorage —
          // mais cette clé venait d'être effacée 6 lignes plus haut
          // (ligne 603 : `removeItem(LAST_BACKGROUND_TIME_KEY)`).
          // → `checkIfShouldLock` retournait toujours `false` pour
          //   tout timeout > 0 → l'app ne verrouillait JAMAIS via le
          //   handler AppState pour les timeouts 1, 5, 15, 30 minutes.
          //   Seul timeout = 0 ("Immédiatement") fonctionnait.
          //
          // Le calcul RAM est aussi plus rapide (pas d'I/O AsyncStorage)
          // et plus précis (pas de risque d'avoir lu/écrit la clé entre-
          // temps depuis un autre code path).
          //
          // `checkIfShouldLock` reste utilisée dans `initializeApp` au
          // cold start où la clé AsyncStorage est l'unique source.
          // ────────────────────────────────────────────────────────────────
          const elapsedMinutes = elapsedSinceBg / 1000 / 60;
          const shouldLock = lockTimeoutRef.current === 0
            ? true
            : elapsedMinutes >= lockTimeoutRef.current;

          if (shouldLock) {
            bootlog(`AppState 'active' → shouldLock=true (elapsed ${(elapsedSinceBg/1000).toFixed(1)}s) — switching to LockScreen`);
            try { clearEncryptionKey(); } catch {}
            // Ne PAS clear clearSealedSenderState() ici !
            // Le sealed sender est un certificat d'authentification auprès du
            // relay qui expire d'elle-même (pas de donnée sensible exposée).
            // Le conserver en RAM entre lock/unlock évite de devoir
            // re-calculer le PoW (SHA-256 itératif lourd) et refaire le
            // bootstrap OHTTP à chaque unlock → gain 2-5s par unlock.
            // Le code existant (ligne ~4586 de api1to1.ts) vérifie déjà
            // isSealedSenderReady() et skip le bootstrap si encore valide.
            // Au unlock, on rentrera dans la branche "skip bootstrap".

            // ──────────────────────────────────────────────────────────────
            // RETIRER L'OVERLAY PRIVACY DANS LE MÊME COMMIT REACT
            // ──────────────────────────────────────────────────────────────
            // Sans cette ligne, l'overlay privacy (posé par le handler
            // 'background' juste avant) resterait affiché par-dessus le
            // LockScreen pendant tout le temps de mount + paint du LockScreen
            // — typiquement 1-2 frames sur device rapide, 100-500ms quand
            // le JS thread est chargé (unmount NavigationContainer, etc.).
            // Comme l'overlay est un <View> uni de couleur theme.colors.background
            // (#0A0F14), l'utilisateur perçoit cet intervalle comme un
            // « écran noir » bloquant avant de pouvoir taper son mot de passe.
            //
            // En clearant l'overlay dans le MÊME batch que setIsLocked(true)
            // et setLockSessionId(id+1), React commit un seul snapshot
            // "LockScreen sans overlay". Le compositeur natif passe
            // directement de l'ancienne frame (overlay sur main app — déjà
            // sombre, donc pas de flash) à la nouvelle frame (LockScreen
            // contenu visible).
            //
            // Le LockScreen ayant déjà été refactoré pour rendre à opacity=1
            // sans fade-in d'entrée, son 1er paint expose immédiatement le
            // TextInput. Aucun masquage intermédiaire n'est nécessaire.
            // ──────────────────────────────────────────────────────────────
            setShowPrivacyOverlay(false);
            setIsLocked(true);
            // ──────────────────────────────────────────────────────────────
            // CRITIQUE : forcer le remount du LockScreen.
            // ──────────────────────────────────────────────────────────────
            // Quand `isLocked` était DÉJÀ true (utilisateur sur LockScreen,
            // background, retour après timeout), `setIsLocked(true)` est un
            // no-op (Object.is bail-out). Le LockScreen ne se re-monte pas
            // → son state local (password tapé, errors, lockedUntil) reste.
            // Incrémenter lockSessionId fait changer le `key` du LockScreen
            // → React démonte l'instance courante et en monte une nouvelle
            // avec un état vierge (TextInput vidé, errors effacées, etc.),
            // exactement comme un kill+relaunch.
            // ──────────────────────────────────────────────────────────────
            setLockSessionId(id => id + 1);
            previousAppState.current = nextAppState;
            return;
          }
        }

        // Verrouillage non requis (pas de lock configuré, ou timeout non dépassé)
        setShowPrivacyOverlay(false);
        if (!isLockedRef.current) {
          resumePrivacyServices();
          startGlobalPolling1to1();
          inviteWatcher.start().catch(console.error);

          // PERF A3 : poll immédiat au retour pour récupérer les messages
          // arrivés pendant l'absence.
          pollAllSessions().catch(() => {});

          // Token rotation safety net : un long passage en background peut
          // déclencher une rotation FCM/APNs sans que le listener fire (l'app
          // était suspendue). On re-fetch le token courant et propage aux
          // pairs si différent. No-op si inchangé. Fire-and-forget : ne
          // bloque pas la reprise du polling.
          refreshOwnTokenIfChanged().catch(() => {});
        }
      }

      previousAppState.current = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription.remove();
    };
  }, []); // Deps vides : le handler lit tout via les refs, donc il reste stable

  // ═══════════════════════════════════════════════════════════════════════════
  // RÉPARATION DU MARQUEUR DE VERROUILLAGE À LA FIN D'UN APPEL EN BACKGROUND
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // PROBLÈME RÉSOLU :
  // Dans le handler AppState ('background', plus haut), un early return est
  // effectué quand `isInCall1to1()` est true au moment du passage en background
  // — ce qui est nécessaire pour que les appels ne soient pas interrompus quand
  // l'utilisateur quitte temporairement l'app pendant une conversation.
  //
  // Conséquence du early return : `wentToBackground.current` reste `false` et
  // `LAST_BACKGROUND_TIME_KEY` n'est pas écrit dans AsyncStorage. Si l'appel
  // se TERMINE ensuite alors que l'app est encore en background (l'autre
  // partie raccroche, timeout, perte réseau, double hangup, decline tardif…),
  // AUCUN événement AppState n'est émis (l'app est déjà background, elle y
  // reste). Quand l'utilisateur revient `active` plus tard, le handler tombe
  // sur l'early return ligne 1024 (`if (!wentToBackground.current)`) → aucun
  // calcul d'elapsed, aucun verrouillage. L'app reste déverrouillée même
  // après plusieurs heures.
  //
  // Scénarios concernés :
  //   C — appel en cours, background, l'autre raccroche, retour > timeout
  //   G — appel décroché depuis notification, background pendant l'appel,
  //       l'autre raccroche, retour > timeout
  //   L — appel coupé par mauvaise connexion (`endCall('error')`) en background
  //   M — appel sortant, background, l'autre ne décroche pas (`endCall('timeout')`)
  //   N — double raccroché simultané en background
  //
  // FIX :
  // On écoute les transitions d'état d'appel via `addCall1to1StateListener`.
  // À chaque fois qu'un appel passe à `state === 'ended'` ALORS QUE l'app
  // n'est pas active, on simule rétroactivement le marqueur que le handler
  // AppState aurait posé si l'appel n'avait pas suspendu sa décision.
  //
  // Le timestamp utilisé est `Date.now()` (et non l'instant du passage en
  // background original) parce que pendant toute la durée de l'appel
  // l'utilisateur ÉTAIT actif dans l'app (en train de parler) — l'inactivité
  // ne commence vraiment qu'au raccroché. Mesurer depuis le passage en bg
  // verrouillerait trop tôt (ex: appel de 30 min + 30 sec après hangup +
  // timeout = 1 min → on ne devrait PAS lock, mais avec l'ancien timestamp
  // on aurait elapsed = 30 min 30 sec → lock immédiat).
  //
  // Comportement quand l'utilisateur revient ensuite `active` :
  //   - elapsed = (now - lastBgEnterTime) = (now - callEndTime)
  //   - Si elapsed >= timeout → lock (chemin existant ligne 1080)
  //   - Si elapsed < timeout → no lock (chemin existant ligne 1138)
  //   - Comportement identique à un background "normal" sans appel
  //
  // Stop polling : pendant l'appel, le handler 'background' a explicitement
  // LAISSÉ le polling tourner (ligne 1009-1013, `if (!isInCall1to1())`).
  // Maintenant que l'appel est fini, on stoppe ces services pour éviter
  // de drainer la batterie pendant que l'utilisateur est absent.
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const unsubscribeCallState = addCall1to1StateListener((info) => {
      // L'event `state === 'ended'` est émis par endCall() (call1to1Service.ts
      // ligne 1983) dans TOUS les chemins de terminaison : local_hangup,
      // remote_hangup, timeout, error, declined, busy.
      if (info?.state !== 'ended') return;

      // Si on est en foreground, l'utilisateur va voir l'écran post-appel
      // ("Appel terminé") et continuer à interagir normalement. Le prochain
      // passage en background posera son marqueur via le chemin habituel.
      // Rien à faire ici.
      if (AppState.currentState === 'active') return;

      // On est en background ET l'appel vient de se terminer.
      // Reposer le marqueur comme si AppState 'background' venait de se
      // déclencher à l'instant T = maintenant.
      const now = Date.now();
      lastBgEnterTime.current = now;
      wentToBackground.current = true;

      // Persister aussi en AsyncStorage pour que le cas "OS kill l'app
      // entre maintenant et le retour de l'utilisateur" soit géré par
      // initializeApp / checkIfShouldLock au cold start (App.tsx ligne 1389).
      // Fire-and-forget : si l'écriture échoue, le cold start re-locke
      // de toute façon inconditionnellement quand lockEnabled=true (ligne 1408).
      AsyncStorage.setItem(LAST_BACKGROUND_TIME_KEY, String(now)).catch(() => {});

      // Stopper les services réseau qui avaient été laissés actifs pendant
      // l'appel. Idempotent : si déjà stoppés, no-op silencieux.
      // Garde défensive : double-check qu'aucune autre suppression n'est
      // active (cas tordu : appel fini mais picker ouvert simultanément).
      if (!isInCall1to1() && !isLockSuppressed()) {
        try { stopGlobalPolling1to1(); } catch {}
        try { inviteWatcher.stop(); } catch {}
      }

      __DEV__ && console.log(
        '[App] 📞→🔒 Call ended in background — lock marker repaired (will eval timeout on next active)'
      );
    });

    return () => {
      try { unsubscribeCallState(); } catch {}
    };
  }, []); // Deps vides : tout est lu via refs / fonctions globales.

  const checkIfShouldLock = async (timeoutMinutes: number): Promise<boolean> => {
    try {
      const backgroundTimeStr = await AsyncStorage.getItem(LAST_BACKGROUND_TIME_KEY);
      
      if (!backgroundTimeStr) {
        return false;
      }
      
      const backgroundTime = parseInt(backgroundTimeStr, 10);
      if (isNaN(backgroundTime)) return false;
      
      const elapsedMinutes = (Date.now() - backgroundTime) / 1000 / 60;
      return elapsedMinutes >= timeoutMinutes;
    } catch (error) {
      console.error('Error checking lock status:', error);
      return false;
    }
  };

  const performDeviceSecurityCheck = async (): Promise<void> => {
    try {
      const lastShown = await AsyncStorage.getItem(SECURITY_CHECK_SHOWN_KEY);
      const today = new Date().toDateString();
      
      const result = await performSecurityCheck();

      const policy = applySecurityPolicy(result);
      
      // ACTION 08: Bloquer l'app si l'appareil est compromis (pas juste un warning)
      if (policy.shouldBlock) {
        const message = getSecurityWarningMessage(result);

        void showAlert({
          title: i18n.t('app.compromisedTitle'),
          message: i18n.t('app.compromisedMessage', { base: message || '' }),
          buttons: [{ text: i18n.t('app.compromisedClose'), style: 'destructive' }],
          // Non refermable par un tap à côté : l'utilisateur doit avoir vu
          // que son appareil est compromis. (Reprend le `cancelable: false`
          // de l'appel natif d'origine.)
          dismissible: false,
        });
        // L'app restera bloquée sur cet écran — l'utilisateur ne peut pas continuer
        return;
      }
      
      if (policy.shouldWarn && lastShown !== today) {
        const message = getSecurityWarningMessage(result);
        const title = getSecurityAlertTitle(result);
        
        if (message) {
          await AsyncStorage.setItem(SECURITY_CHECK_SHOWN_KEY, today);
          
          void showAlert({
            title,
            message,
            buttons: [{ text: i18n.t('app.understandRisks'), style: 'default' }],
            dismissible: false,
          });
        }
      }
      
      await securityLogger.log('SESSION_STARTED', { source: 'app' });
      
    } catch (error) {
      console.error('Security check failed:', error);
    }
  };

  const initializeApp = async () => {
    try {
      console.log('[App] initializeApp: starting...');

      // ═══════════════════════════════════════════════════════════════════
      // MIGRATION GUARD — short-circuit if device is frozen
      // ═══════════════════════════════════════════════════════════════════
      // Even though the bootstrap useEffect's micro-phase -1 sets
      // migrationFrozen=true, that's an ASYNC state update — the render
      // branch that picks MigrationLockdownScreen will fire on the next
      // commit, but THIS function (started by initializeApp() in the
      // bootstrap effect) might already be running. Re-check here to
      // avoid touching crypto / network if frozen.
      try {
        const marker = await loadMarkerFromDisk();
        if (marker?.state === 'frozen' || marker?.state === 'wiping') {
          console.log('[App] initializeApp: migration frozen — abort');
          setMigrationFrozen(true);
          setMigrationCheckDone(true);
          setIsInitializing(false);
          return;
        }
      } catch {
        // SecureStore read failed — continue normally rather than block.
      }

      // ═══════════════════════════════════════════════
      // PHASE 1 — RAPIDE (~100ms) : Checks AsyncStorage
      // Objectif : afficher onboarding/profile IMMÉDIATEMENT
      // sans attendre la génération crypto (5-12s sur émulateur)
      // ═══════════════════════════════════════════════

      // Reset data si flag actif
      if (RESET_ALL_DATA) {
        console.log('[App] ⚠️ RESET_ALL_DATA is TRUE - NUCLEAR RESET...');
        try {
          await nuclearReset();
        } catch (e) {
          console.error('[App] Nuclear reset error:', e);
        }
        console.log('[App] ☢️ Nuclear reset complete. App will start fresh.');
        console.log('[App] ⚠️ REMEMBER TO SET RESET_ALL_DATA = false AFTER TESTING!');
      }

      // ─────────────────────────────────────────────────────────────────────
      // ONE-SHOT PURGE OF STALE PEER PUSH TOKENS
      // ─────────────────────────────────────────────────────────────────────
      // Push tokens (FCM/APNs) can rotate silently and our previous client
      // builds did not always propagate the new token to peers — leaving
      // peers' cache of OUR token stale, while still being accepted (200) by
      // FCM/APNs and silently dropped on the device. Bumping the version
      // string below forces a one-time wipe of every cached peer token on
      // next launch; both peers then re-exchange fresh tokens via
      // sendPushTokenToAllPeers() during the regular boot sequence.
      //
      // The call is idempotent across cold starts of the same app version
      // (it stores the version it last processed in AsyncStorage), so leaving
      // it here permanently has zero ongoing cost. Bump the constant when a
      // new fleet-wide recovery is needed.
      //
      // This MUST run before startGlobalPolling1to1 / any push send path so
      // that the first push attempts produce decoy blobs (silently dropped at
      // the proxy) rather than pushes to known-stale tokens.
      //
      // ═══════════════════════════════════════════════════════════════════
      // PERF — LECTURES INDÉPENDANTES EN PARALLÈLE
      // ═══════════════════════════════════════════════════════════════════
      // Ces cinq opérations n'ont aucune dépendance de données entre elles :
      //   - ensurePinningReady : idempotent (promesse singleton, déjà
      //     dispatchée dans le useEffect de montage — on l'await seulement
      //     pour le chemin "timeout fastDetect" où le réseau serait
      //     immédiatement sollicité). Ne PAS la re-déclencher ailleurs :
      //     double listenForPinningErrors = double Alert en prod.
      //   - purgeAllPeerPushTokens : cleanup AsyncStorage idempotent, doit
      //     seulement précéder startGlobalPolling1to1 (bien plus bas).
      //   - onboarding / displayName : lectures AsyncStorage pures.
      //   - isLockEnabled : lecture SecureStore (source de vérité PIN),
      //     nécessaire à la branche crypto de la Phase 2.
      // Avant : six allers-retours I/O séquentiels (~50-100ms chacun au
      // cold start). Après : un seul round-trip du plus lent.
      // ═══════════════════════════════════════════════════════════════════
      const [, , onboardingCompleted, hasDisplayName, locked, termsAccepted] = await Promise.all([
        ensurePinningReady(),
        purgeAllPeerPushTokens('2025-05-token-rotation-fix').catch((e) => {
          __DEV__ && console.warn('[App] Peer token purge failed (non-fatal):', e);
        }),
        AsyncStorage.getItem(ONBOARDING_COMPLETED_KEY),
        hasGlobalDisplayName(),
        isLockEnabled(),
        AsyncStorage.getItem(TERMS_ACCEPTED_KEY),
      ]);
      console.log('[App] initializeApp: onboardingCompleted =', onboardingCompleted);
      console.log('[App] initializeApp: hasDisplayName =', hasDisplayName);

      // Guideline 1.2 : CGU acceptées ? (version courante uniquement)
      const termsOk = termsAccepted === TERMS_VERSION;

      // Fast path : si l'onboarding ou le profil n'est pas fait,
      // on affiche l'écran correspondant SANS attendre la crypto.
      // sessionService.initialize() sera appelé dans handleProfileSetupComplete.
      if (!hasDisplayName) {
        if (!onboardingCompleted) {
          console.log('[App] initializeApp: → onboarding (no crypto needed yet)');
          setNeedsOnboarding(true);
          setIsInitializing(false);
          return;
        }
        if (!termsOk) {
          // Interruption entre le carrousel et le profil (kill de l'app) :
          // on reprend au niveau des CGU, pas au carrousel.
          console.log('[App] initializeApp: → terms (no crypto needed yet)');
          setNeedsTerms(true);
          setIsInitializing(false);
          return;
        }
        console.log('[App] initializeApp: → profile setup (no crypto needed yet)');
        setNeedsProfileSetup(true);
        setIsInitializing(false);
        return;
      }

      // Utilisateur existant (mise à jour de l'app) : les CGU n'existaient
      // pas quand il a créé son profil → écran bloquant une seule fois,
      // rendu APRÈS le LockScreen (cf. render path). L'init crypto continue
      // normalement en dessous.
      if (!termsOk) {
        console.log('[App] initializeApp: existing user must accept terms');
        setNeedsTerms(true);
      }
      
      // ═══════════════════════════════════════════════
      // PHASE 2 — LENTE : Utilisateur de retour
      // La crypto est nécessaire. Le SplashScreen est visible.
      // ═══════════════════════════════════════════════
      
      console.log('[App] initializeApp: returning user, initializing crypto...');
      const _t0 = Date.now();
      const _ts = (label: string) => console.log(`[App] ⏱️ ${label}: ${Date.now() - _t0}ms`);
      
      // Attendre UN frame pour laisser le splash se peindre avant de bloquer
      // le thread JS sur la crypto. requestAnimationFrame > setTimeout(50) :
      // attend le vrai vsync au lieu d'un délai arbitraire.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      
      // ═══════════════════════════════════════════════════════════════════
      // LANCEMENTS ASYNC NON-BLOQUANTS
      // ═══════════════════════════════════════════════════════════════════
      // Ces appels démarrent en arrière-plan. Ils ne sont pas attendus ici
      // car ils ne sont pas nécessaires à l'affichage du LockScreen ni du
      // post-unlock. Ils termineront en parallèle des opérations awaitées.
      //
      // - precomputePoW : DÉPLACÉ après les gros awaits de la branche no-PIN
      //   (cf. plus bas) — le SHA-256 itératif tournait sur le thread JS en
      //   concurrence avec sessionService.initialize/initHardwareEncryption,
      //   volant des tranches CPU au chemin critique du splash (même
      //   doctrine que le chemin lock, où le PoW est délégué à
      //   LockScreen.onFocus). Le cache interne le rend idempotent.
      //
      // - preWarmNativeAudio : chauffage modules audio (speechmatics +
      //   expo-audio-stream) pour éviter cold-start lors du premier appel.
      //   Uniquement utile si l'utilisateur fait un appel, donc aucun impact
      //   sur l'UX lock/unlock — peut tourner en background.
      //
      // - ensureInCallStarted/stop : cycle warm-up InCallManager Android.
      //   Pareil, aucun impact sur lock/unlock.
      // ═══════════════════════════════════════════════════════════════════
      //
      // KILL-SWITCH GUARD : si un avis app est déjà connu (cache local), on
      // skip TOUT le pré-chauffage. L'utilisateur va voir le kill-switch,
      // pas envoyer de messages ni démarrer un appel. Inutile de gaspiller
      // 20s de CPU sur PoW.
      if (getCurrentAppNotice()) {
        console.log('[App] AppNotice present → skipping preWarmAudio');
      } else {
        if (Platform.OS !== 'web') {
          ensureInCallStarted();
          setTimeout(() => stopInCallManager(), 500);
        }

        preWarmNativeAudio();
      }

      // ACTION-04 FIX: Check lock status FIRST, then init hardware encryption
      // BEFORE sessionService.initialize() reads ratchet states from AsyncStorage.
      // Without this, encryptionKey is null when sessionService loads encrypted data
      // → ratchet states unreadable → AEAD failures → messages invisible.
      // PERF : `locked` provient du Promise.all de la Phase 1 (isLockEnabled,
      // source de vérité SecureStore) — plus de re-lecture séquentielle ici.
      setLockEnabled(locked);

      // Initialize sodium always, but sessionService ONLY when not locked.
      // When locked, sessionService.initialize() would run without an encryption key,
      // fail to read encrypted data, and overwrite it with empty state → data loss.
      // handleUnlock() calls sessionService.initialize() after PIN entry instead.
      if (locked) {
        // ═══════════════════════════════════════════════════════════════════
        // COLD START UX — AFFICHER LE LOCKSCREEN AU PLUS VITE
        // ═══════════════════════════════════════════════════════════════════
        // Avant : on awaitait initSodiumZeroize (500ms-2s cold start) +
        //   Promise.all([getLockSettings, waitForPrecomputedPoW, isArgon2Available])
        //   (200ms-1s) AVANT d'afficher le LockScreen. L'utilisateur voyait
        //   le SplashScreen pendant 1.5-4 s au cold start — un trou visuel
        //   qui n'existait pas au warm reopen (où initializeApp n'est pas
        //   rejoué), d'où l'asymétrie perçue : "noir la 1re fois, instant
        //   ensuite".
        //
        // Après : on lance les warm-ups en FIRE-AND-FORGET. Ils tournent en
        // parallèle pendant le fade-in du LockScreen (500 ms) et pendant
        // la saisie du PIN (plusieurs secondes). Tous trois sont idempotents
        // par design :
        //   - initSodiumZeroize : cache `_initPromise` (sodiumZeroize.ts)
        //   - precomputePoW     : cache `_precomputedPowPromise` (api1to1.ts)
        //   - isArgon2Available : cache interne dans kdf.ts
        // Donc quand handleUnlock les rappellera après la saisie du PIN,
        // ils seront soit déjà résolus (coût zéro), soit awaités à la fin
        // de leur exécution déjà en cours — JAMAIS exécutés deux fois.
        //
        // Safety : PoW est le seul qui tourne en JS (SHA-256 itératif).
        // Il yield toutes les 50k itérations. Lancé ici (t~150ms), il finit
        // typiquement avant que l'utilisateur ne commence à taper (fade-in
        // 500ms + temps de réaction). Sur un device très lent où il tournerait
        // encore pendant la saisie, le yielding évite un freeze, au pire un
        // lag intermittent de 30-100ms entre les yields — toujours mieux que
        // 1 s d'attente bloquante avant d'afficher l'input.
        // ═══════════════════════════════════════════════════════════════════
        initSodiumZeroize();   // fire-and-forget (idempotent)
        isArgon2Available();   // fire-and-forget (warm module natif, idempotent)
        // precomputePoW : délégué à LockScreen.onFocus (post-paint), cf. la
        // doctrine documentée dans le useEffect de montage. Idempotent.
        _ts('warm-ups dispatched (non-blocking)');

        // Attendre UNIQUEMENT les lectures nécessaires pour afficher
        // correctement le LockScreen (timer de lockout, décision shouldLock).
        // Ces deux lectures sont rapides (AsyncStorage + SecureStore, ~50-100ms
        // total au cold start) et sans elles on ne sait pas quoi afficher.
        setSplashStatus(i18n.t('appBoot.preparingSecure'));
        const settings = await getLockSettings();
        setLockTimeout(settings.timeoutMinutes);
        _ts('getLockSettings');

        const shouldLock = await checkIfShouldLock(settings.timeoutMinutes);
        _ts('checkIfShouldLock');
        
        if (shouldLock) {
          clearEncryptionKey();
          clearSealedSenderState();
          setIsLocked(true);
          await AsyncStorage.removeItem(LAST_BACKGROUND_TIME_KEY);
        } else {
          const backgroundTimeStr = await AsyncStorage.getItem(LAST_BACKGROUND_TIME_KEY);
          
          if (backgroundTimeStr) {
            // App was killed while in background → lock
            clearEncryptionKey();
            clearSealedSenderState();
            setIsLocked(true);
            await AsyncStorage.removeItem(LAST_BACKGROUND_TIME_KEY);
          } else {
            // Fresh start or no background time → lock (always lock on cold start when enabled)
            setIsLocked(true);
          }
        }
      } else {
        // Pas de verrouillage : on va directement à l'app principale qui
        // a besoin que sodium et sessionService soient prêts pour lire les
        // conversations. On attend donc ces trois init avant de continuer.
        //
        // PERF — getOrCreateDeviceState est désormais DANS le Promise.all
        // (au lieu d'être séquentiel après) : il est totalement indépendant
        // de sodium et sessionService (lecture/écriture AsyncStorage de
        // l'identifiant device + état hardware encryption). Le mettre en
        // parallèle aligne ce path sur handleUnlock et économise 50-200 ms
        // au cold start no-PIN. Cf. Phase 2 / Action 2.1 du plan d'action.
        //
        // PERF — initHardwareEncryptionAll est chaîné DEVANT sessionService
        // et getOrCreateDeviceState (qui lisent des données chiffrées par la
        // clé hardware qu'il installe — cf. ACTION-04 ci-dessus) mais tourne
        // en PARALLÈLE d'initSodiumZeroize qui n'en dépend pas. Avant : les
        // deux étages étaient strictement séquentiels.
        const [sodiumOk] = await Promise.all([
          initSodiumZeroize(),
          initHardwareEncryptionAll().then((hwOk) => {
            _ts(`initHardwareEncryptionAll (ok=${hwOk})`);
            // ════════════════════════════════════════════════════════════
            // loadGroups DOIT être chaîné APRÈS sessionService.initialize()
            // ════════════════════════════════════════════════════════════
            // En mode sans PIN, la clé qui déchiffre réellement AsyncStorage
            // est la clé DEVICE-LEVEL, installée dans `encryptionKey` par
            // `ensureDeviceLevelEncryption()` — première étape de
            // `sessionService.initialize()`, qui fait un await SecureStore.
            // La `hardwareKey` posée juste au-dessus par
            // initHardwareEncryptionAll est une clé DIFFÉRENTE (cf. la
            // docstring de transitionPinToHardware dans localCrypto) : elle
            // ne sert que de repli à getActiveKey().
            //
            // En parallèle, loadGroups gagnait la course (un simple getItem
            // contre SecureStore + clés d'identité), passait le garde
            // `!hasAnyEncryptionKey()` — puisque hardwareKey est présente —
            // et échouait sur le MAC Poly1305. Son catch pose `_loaded`,
            // donc les groupes disparaissaient pour TOUTE la session.
            // Ne jamais remettre loadGroups en parallèle d'initialize().
            return Promise.all([
              sessionService.initialize().then(() => loadGroups()),
              getOrCreateDeviceState(),
            ]);
          }),
        ]);
        _ts(`parallel init (sodium=${sodiumOk ? 'libsodium' : 'JS fallback'} + hw→((session→groups) ∥ deviceState))`);

        // ── PoW anti-spam : lancé APRÈS les gros awaits crypto ──
        // Il tourne en fire-and-forget pendant que le splash se libère.
        // startGlobalPolling1to1 (ci-dessous) diffère de toute façon le
        // polling jusqu'à ce que le sealed sender soit prêt, donc le PoW
        // dispose du thread JS sans contention. Guard kill-switch : si un
        // AppNotice est actif, inutile de chauffer le PoW.
        if (!getCurrentAppNotice()) {
          precomputePoW();
        }
        
        // P3 FIX: Récupérer les messages orphelins en status 'sending' avant de démarrer
        // PERF A10: Déféré à 5s après le démarrage — cas d'erreur rare (~1/10000),
        // pas besoin de bloquer le splash screen pour ça.
        setTimeout(() => recoverOrphanedSendingMessages().catch(() => {}), 5000);
        _ts('recoverOrphanedSendingMessages (deferred 5s)');
        
        // ════════════════════════════════════════════════════════════════
        // PERF — SEALED SENDER HORS DU CHEMIN CRITIQUE DU BOOT (no-PIN)
        // ════════════════════════════════════════════════════════════════
        // Cf. handleUnlock pour le rationale complet et l'analyse de
        // sécurité. Résumé :
        //   • Le sealed sender ne sert QU'À l'envoi (anonymisation outbound).
        //   • Tous les paths d'envoi ont leur propre garde
        //     `isSealedSenderReady()` + `await ensureSealedSenderBootstrap()`.
        //   • `secureRpc` rejette tout RPC non-scellé (defense in depth).
        //   • La lecture/déchiffrement des messages locaux n'en dépend pas.
        //
        // L'utilisateur arrive instantanément à sa liste de conversations
        // car (1) sessionService.initialize() ci-dessus a chargé toutes les
        // sessions en RAM et (2) ConversationListScreen pré-remplit son état
        // initial depuis cette RAM via getInitialConversationsSnapshot() —
        // le 1er paint affiche déjà la liste structurée. loadConversations()
        // enrichit ensuite avec les lastMessage/unreadCount lus en async.
        // Le bootstrap réseau (sealed sender, initRelay, premier poll) se
        // fait pendant ce temps en arrière-plan.
        // ════════════════════════════════════════════════════════════════

        setSplashStatus(i18n.t('appBoot.startingServices'));
        initializePrivacyServices();
        startGlobalPolling1to1();
        inviteWatcher.start().catch(console.error);
        _ts('startGlobalPolling + inviteWatcher');

        // Push notifications — si l'onboarding notifications est déjà fait,
        // initialiser directement. Sinon, le composant NotificationOnboarding
        // dans le JSX s'en chargera lors de sa première apparition.
        hasCompletedNotificationOnboarding().then(async (done) => {
          if (!done) {
            __DEV__ && console.log('[App] 📋 Notification onboarding not done yet — waiting for user');
            return;
          }
          initPushNotifications(async () => {
            try {
              await pollAllSessions();
            } catch (err) {
              __DEV__ && console.warn('[App] Push wake-up poll error:', err);
            }
          }).then(async (ready) => {
            if (ready) {
              __DEV__ && console.log('[App] ✅ Push notifications active');
              try {
                await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
              } catch (e) {
                __DEV__ && console.warn('[App] Background task registration:', e);
              }
              const { sendPushTokenToAllPeers } = require('./src/services/api1to1');
              sendPushTokenToAllPeers().catch(() => {});
            }
          }).catch(() => {});
        }).catch(() => {});

        // ────────────────────────────────────────────────────────────────
        // CHAÎNE BOOTSTRAP RÉSEAU EN ARRIÈRE-PLAN
        // ────────────────────────────────────────────────────────────────
        // KT registration nécessite sealed sender → enchaîné après. Le
        // bootstrap est maintenant un orchestrateur unique avec retry
        // interne (3 tentatives, ~15s max, voir sealedSender.ts). Si toutes
        // les tentatives échouent, l'app reste utilisable en lecture ; le
        // prochain envoi (ou re-tap "Créer") relancera un cycle propre
        // automatiquement — pas besoin de `resetSealedSenderBootstrap` ici.
        // ────────────────────────────────────────────────────────────────
        // PRÉCHAUFFAGE DU RELAY OHTTP : voir handleUnlock pour le rationale
        // complet. Critique pour que le scan QR rapide après ouverture
        // n'ait pas à attendre `initRelay` (gain 1-3s sur 4G).
        // ────────────────────────────────────────────────────────────────
        initRelay().catch(e => {
          __DEV__ && console.warn('[App] Background initRelay pre-warm error:', e);
        });

        waitForSealedSender()
          .then(sealedReady => {
            _ts(`waitForSealedSender bg (ready=${sealedReady})`);
            if (!sealedReady) {
              __DEV__ && console.warn(
                '[App] ⚠️ Sealed sender bootstrap failed in background — ' +
                'reads work, sends will retry on user action'
              );
              return;
            }
            // KT registration une fois sealed sender confirmé
            sessionService.registerKeyInTransparencyLog().catch(e => {
              __DEV__ && console.warn('[App] 🌳 KT registration deferred:', e.message);
            });
          })
          .catch(e => {
            __DEV__ && console.warn('[App] Background bootstrap chain error:', e);
          });

        // ────────────────────────────────────────────────────────────────
        // PERF — PAS DE POLL ANTICIPÉ ICI (ancienne 3e source supprimée)
        // ────────────────────────────────────────────────────────────────
        // Avant Phase 2 / Action 2.2, trois sources poll-aient en parallèle
        // au cold start :
        //   1. startGlobalPolling1to1() ci-dessus appelle performGlobalPoll()
        //      immédiat (api1to1.ts → premier poll dans startConstantTraffic).
        //   2. ConversationListScreen.useFocusEffect lance pollAllSessions()
        //      en background (depuis Phase 1 / Action 1.1).
        //   3. Un troisième pollAllSessions() fire-and-forget était dispatché
        //      ICI ; il a été retiré.
        //
        // Trois RPC OHTTP concurrents sur les MÊMES tags : aucun bénéfice.
        // Les messages reviennent une seule fois quoi qu'il arrive ; la
        // dédup côté client (processedIds + dedup transport) absorbe tout.
        // Coût pur : 3× la bande passante et 3× les events que voit le
        // serveur côté analytics OHTTP au démarrage de chaque session.
        //
        // Cf. Phase 2 / Action 2.2 du plan d'action.
        // ────────────────────────────────────────────────────────────────
        console.log(`[App] ⏱️ TOTAL init: ${Date.now() - _t0}ms`);
      }
    } catch (error) {
      console.error('App initialization error:', error);
      setInitError(i18n.t('appBoot.initFailed'));
    } finally {
      setIsInitializing(false);
    }
  };

  const handleUnlock = async () => {
    try {
      // ────────────────────────────────────────────────────────────────────
      // CONTINUITÉ VISUELLE LockScreen.SplashScreen → App.SplashScreen
      // ────────────────────────────────────────────────────────────────────
      // Pendant Argon2 (1-2s), LockScreen rend SON propre <SplashScreen> en
      // plein bloom (instance A, fade-in 700ms terminé). Quand on appelle
      // ci-dessous setIsLocked(false) + setIsInitializing(true), React
      // bascule de la branche LockScreen vers la branche isInitializing
      // → instance A unmount, instance B (App.tsx) mount. Sans précaution,
      // l'instance B redémarre toutes ses Animated.Value d'entrée à 0 et
      // refait un fade-in de 700ms — l'utilisateur perçoit un flash sombre
      // de 700ms entre deux SplashScreens visuellement identiques.
      //
      // setSplashInstant(true) propage l'info au SplashScreen : initialise
      // textOpacity, bottomOpacity, GhostLogo entrance values directement à
      // leurs valeurs finales (1, 1, …). L'instance B paraît parfaitement
      // identique à l'instance A en plein bloom → continuité parfaite.
      //
      // Reset à false dans le finally pour que les utilisations ultérieures
      // du SplashScreen (cold start, post-onboarding, post-setup-profile)
      // gardent leur fade-in normal.
      // ────────────────────────────────────────────────────────────────────
      setSplashInstant(true);
      setIsLocked(false);
      setSplashStatus(i18n.t('appBoot.unlocking'));
      setIsInitializing(true);

      // Attendre UN frame pour que React ait commit les 3 setState et peint
      // le SplashScreen avant de lancer les opérations lourdes qui suivent
      // (sessionService.initialize lit et déchiffre tous les états Triple
      // Ratchet, ça peut bloquer le JS thread plusieurs secondes).
      // requestAnimationFrame > setTimeout(50) : attend le vrai vsync.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

      await AsyncStorage.removeItem(LAST_BACKGROUND_TIME_KEY);
      
      setSplashStatus(i18n.t('appBoot.loadingConversations'));
      // loadGroups est chaîné APRÈS sessionService.initialize() — même règle
      // que dans initializeApp : c'est initialize() qui garantit qu'une clé
      // capable de déchiffrer AsyncStorage est active. Ici la clé PIN est déjà
      // posée par le LockScreen (await setEncryptionKeys avant onUnlock), donc
      // le chaînage est une ceinture ; on l'applique quand même pour n'avoir
      // qu'UNE règle valable sur les trois chemins de boot.
      await Promise.all([
        initSodiumZeroize(),
        getOrCreateDeviceState(),
        sessionService.initialize().then(() => loadGroups()),
      ]);

      // PoW anti-spam : lancé APRÈS les gros awaits (même doctrine que le
      // boot no-PIN) — avant, il concourait avec sessionService.initialize
      // sur le thread JS et rallongeait le splash post-PIN. Idempotent
      // (souvent déjà résolu si LockScreen.onFocus l'a lancé pendant la
      // saisie). Guard kill-switch inchangé.
      if (!getCurrentAppNotice()) {
        precomputePoW();
      }

      // P3 FIX: Récupérer les messages orphelins après déverrouillage
      // PERF A10: Déféré — ne pas bloquer le splash post-PIN pour un cas d'erreur rare.
      setTimeout(() => recoverOrphanedSendingMessages().catch(() => {}), 5000);

      // ════════════════════════════════════════════════════════════════════
      // PERF — SEALED SENDER HORS DU CHEMIN CRITIQUE D'UNLOCK
      // ════════════════════════════════════════════════════════════════════
      // Avant ce changement, on awaitait `waitForSealedSender` (qui inclut
      // initRelay + PoW + RPC OHTTP double-hop) AVANT de cacher le splash.
      // Sur réseau dégradé, cette phase pouvait dépasser 10 s et avec ses
      // 5 retries × pause 2 s atteindre 15-20 s, alors que :
      //   • Le sealed sender ne sert QU'À l'envoi (anonymisation outbound).
      //   • La lecture des conversations existantes et le déchiffrement
      //     Triple Ratchet local n'en dépendent en RIEN.
      //
      // SÉCURITÉ — INVARIANT PRÉSERVÉ :
      // Tout chemin d'envoi (sendSingleChunk, prepareChunkRpcFunction,
      // SessionService.createInvite, sendPushTokenToAllPeers, decoys, etc.)
      // a sa propre garde `isSealedSenderReady()` + `await
      // ensureSealedSenderBootstrap()` avec timeout 45 s. Si l'utilisateur
      // tente d'envoyer pendant la fenêtre de bootstrap, son envoi attend
      // proprement le certificat anonyme — aucun message ne peut partir
      // sans sealed sender. La couche `secureRpc` (relayTransport.ts)
      // bloque aussi tout RPC envoyant un payload non-scellé.
      //
      // L'utilisateur perçoit un unlock instantané, peut consulter et
      // déchiffrer ses conversations existantes ; les premiers envois
      // (rares dans les premières secondes après unlock) attendent au
      // niveau de leur propre path d'envoi sans bloquer toute l'UI.
      // ════════════════════════════════════════════════════════════════════

      setSplashStatus(i18n.t('appBoot.startingServices'));
      initializePrivacyServices();
      startGlobalPolling1to1();
      inviteWatcher.start().catch(console.error);

      // Push notifications (après déverrouillage)
      initPushNotifications(async () => {
        try { await pollAllSessions(); } catch {}
      }).then(async (ready) => {
        if (ready) {
          try {
            await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
          } catch {}
          const { sendPushTokenToAllPeers } = require('./src/services/api1to1');
          sendPushTokenToAllPeers().catch(() => {});
        }
      }).catch(() => {});

      // ────────────────────────────────────────────────────────────────────
      // CHAÎNE DE BOOTSTRAP RÉSEAU — EN ARRIÈRE-PLAN
      // ────────────────────────────────────────────────────────────────────
      // Le pinning, le sealed sender et la KT registration s'exécutent en
      // tâche de fond pendant que l'UI est déjà interactive. La KT
      // registration nécessite un sealed sender actif (cf. son guard
      // interne) — on l'enchaîne donc APRÈS le sealed sender.
      //
      // Si le bootstrap échoue de façon persistante (5 retries épuisés),
      // on log mais on ne bloque PAS l'UI : l'utilisateur peut toujours
      // lire ses messages. Ses tentatives d'envoi attendront leur propre
      // bootstrap qui retentera (chaque sendSingleChunk appelle
      // `ensureSealedSenderBootstrap()` qui est idempotent et reset-able).
      //
      // ────────────────────────────────────────────────────────────────────
      // PRÉCHAUFFAGE DU RELAY OHTTP (PERF — fix scan QR rapide)
      // ────────────────────────────────────────────────────────────────────
      // `initRelay()` fetch les manifests gateway + vérifie 3 signatures
      // Ed25519. Coût typique : 1-3 s sur 4G. Toutes les fonctions qui
      // appellent `secureRpc(...)` (lectures, fetchInviteFromServer pour le
      // scan QR, etc.) déclenchent un lazy-init si pas déjà fait — ce qui
      // ajoute cette latence à la première opération réseau de l'utilisateur.
      //
      // En lançant `initRelay()` ici en background dès l'unlock, on prépare
      // le relay AVANT que l'utilisateur ait l'occasion d'agir. Quand il
      // scanne un QR à T+2s, le relay est déjà prêt → secureRpc instantané.
      //
      // SÉCURITÉ : aucun impact. La fonction `initRelay` valide TOUS les
      // manifests Ed25519 (P1-A6) et le pinning d'identité avant de marquer
      // le relay disponible. Le préchauffage suit exactement le même chemin.
      //
      // CONCURRENCE : grâce au singleton `_initRelayPromise` (cf. Fix 1
      // dans relayTransport.ts), si `ensureSealedSenderBootstrap` ou
      // `fetchInviteFromServer` appellent aussi `initRelay()` pendant ce
      // pré-warm, tous convergent sur la MÊME promesse — pas de duplication
      // de fetch ni de vérifications crypto.
      // ────────────────────────────────────────────────────────────────────
      initRelay().catch(e => {
        __DEV__ && console.warn('[App] Background initRelay pre-warm error:', e);
      });

      ensurePinningReady()
        .then(() => waitForSealedSender())
        .then(sealedReady => {
          if (!sealedReady) {
            __DEV__ && console.warn(
              '[App] ⚠️ Sealed sender bootstrap failed in background — ' +
              'reads work, sends will retry on user action'
            );
            // Aucun reset nécessaire ici : l'orchestrateur sealedSender.ts
            // libère automatiquement son singleton à la fin de chaque cycle
            // (succès ou échec). Le prochain `ensureSealedSenderBootstrap()`
            // (déclenché par un envoi, un re-tap "Créer/Rejoindre" ou tout
            // autre call-site) démarrera un cycle frais sans coordination
            // externe.
            return;
          }
          // Sealed sender OK → KT registration peut maintenant procéder.
          sessionService.registerKeyInTransparencyLog().catch(e => {
            __DEV__ && console.warn('[App] 🌳 KT registration deferred:', e.message);
          });
        })
        .catch(e => {
          __DEV__ && console.warn('[App] Background bootstrap chain error:', e);
          // Pas de reset nécessaire (orchestrateur auto-clean en .finally).
        });
    } catch (error) {
      console.error('Post-unlock error:', error);
    } finally {
      setSplashStatus(undefined);
      setIsInitializing(false);
      // Reset pour que le prochain SplashScreen (autre contexte) garde son
      // fade-in normal. Idempotent si déjà false.
      setSplashInstant(false);
    }
  };

  const refreshLockState = async () => {
    const locked = await isLockEnabled();
    setLockEnabled(locked);
    if (locked) {
      const settings = await getLockSettings();
      setLockTimeout(settings.timeoutMinutes);
    }
  };

  const handleProfileSetupComplete = async () => {
    try {
      // Profile has been written to disk by SetupProfileScreen. NOW it is safe
      // to mark onboarding as complete: the next launch will go straight to the
      // main app (or to lock screen). If we crash from this point on, the next
      // boot still sees a valid display name and skips both Welcome and
      // SetupProfile correctly.
      try {
        await AsyncStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
      } catch (e) {
        // Non-fatal: hasGlobalDisplayName() is the primary signal anyway. The
        // flag is mostly used by firstLaunchGuard to distinguish updates from
        // reinstalls. Worst case: a future update is treated as a reinstall.
        console.warn('[App] failed to persist onboarding flag:', e);
      }

      setNeedsProfileSetup(false);
      
      // Show SplashScreen with status messages during crypto init
      setSplashStatus(i18n.t('appBoot.generatingKeys'));
      setIsInitializing(true);
      
      // Attendre UN frame pour laisser le splash se peindre avant de bloquer
      // le thread JS. requestAnimationFrame > setTimeout(50) : attend le vrai
      // vsync au lieu d'un délai arbitraire.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      
      setSplashStatus(i18n.t('appBoot.initializingEncryption'));
      // FIX 2.2: Paralléliser sodium + session — sauf si kill-switch
      if (!getCurrentAppNotice()) {
        precomputePoW();
      }

      setSplashStatus(i18n.t('appBoot.creatingPostQuantumKeys'));
      // loadGroups : normalement vide sur un profil neuf, mais pas après un
      // import de migration (replaceGroupsFromImport a écrit l'enregistrement).
      // Chaîné APRÈS initialize() — cf. la règle expliquée dans initializeApp.
      await Promise.all([
        initSodiumZeroize(),
        sessionService.initialize().then(() => loadGroups()),
      ]);
      
      const locked = await isLockEnabled();
      setLockEnabled(locked);
      
      if (locked) {
        const settings = await getLockSettings();
        setLockTimeout(settings.timeoutMinutes);
        setIsLocked(true);
      } else {
        await getOrCreateDeviceState();
        
        // P3 FIX: Récupérer les messages orphelins (edge case: données pré-existantes)
        // PERF A10: Déféré — nouveau profil, quasi impossible d'avoir des orphelins.
        setTimeout(() => recoverOrphanedSendingMessages().catch(() => {}), 5000);
        
        // ════════════════════════════════════════════════════════════════
        // PERF — SEALED SENDER HORS DU CHEMIN CRITIQUE (post-setup)
        // ════════════════════════════════════════════════════════════════
        // Cf. handleUnlock pour le rationale complet et l'analyse de
        // sécurité. Pour une création de profil, l'utilisateur va
        // probablement créer ou rejoindre une invitation immédiatement —
        // ces flows (sessionService.createInvite, etc.) ont leur propre
        // `await ensureSealedSenderBootstrap()` qui les bloque jusqu'à
        // ce que le sealed sender soit prêt. Aucune fuite possible.
        // ════════════════════════════════════════════════════════════════
        setSplashStatus(i18n.t('appBoot.startingServices'));
        initializePrivacyServices();
        startGlobalPolling1to1();
        inviteWatcher.start().catch(console.error);
        
        // Push notifications (dès la création du compte)
        initPushNotifications(async () => {
          try { await pollAllSessions(); } catch {}
        }).then(async (ready) => {
          if (ready) {
            __DEV__ && console.log('[App] ✅ Push notifications active (new account)');
            try {
              await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
            } catch (e) {
              __DEV__ && console.warn('[App] Background task registration:', e);
            }
          }
        }).catch(() => {});
        
        // PRÉCHAUFFAGE DU RELAY OHTTP : voir handleUnlock pour le rationale.
        // Particulièrement critique post-setup car l'utilisateur va probablement
        // créer ou rejoindre une invitation immédiatement après — flows qui
        // appellent `secureRpc` (lecture de bundle pour fetchInviteFromServer
        // côté joigneur, send_sealed_message côté créateur).
        initRelay().catch(e => {
          __DEV__ && console.warn('[App] Background initRelay pre-warm error (post-setup):', e);
        });

        // Bootstrap réseau en arrière-plan + KT registration enchaînée
        waitForSealedSender()
          .then(sealedReady => {
            if (!sealedReady) {
              __DEV__ && console.warn(
                '[App] ⚠️ Sealed sender bootstrap failed in background (post-setup) — ' +
                'invitation creation/join will retry on user action'
              );
              // Pas de reset : l'orchestrateur libère son singleton en .finally,
              // le prochain call démarrera un cycle frais automatiquement.
              return;
            }
            sessionService.registerKeyInTransparencyLog().catch(e => {
              __DEV__ && console.warn('[App] 🌳 KT registration deferred:', e.message);
            });
          })
          .catch(e => {
            __DEV__ && console.warn('[App] Background bootstrap chain error (post-setup):', e);
          });
      }
    } catch (error) {
      console.error('Post-setup error:', error);
    } finally {
      setSplashStatus(undefined);
      setIsInitializing(false);
    }
  };

  const handleOnboardingComplete = async () => {
    // The Welcome carousel finished. We do NOT persist the onboarding flag here:
    // if the user closes the app at the next step (profile setup), they would
    // come back to the profile setup screen on relaunch, not to the Welcome
    // carousel — confusing UX.
    //
    // The flag is set later in handleProfileSetupComplete, when the profile is
    // actually created. The semantics of ONBOARDING_COMPLETED_KEY become "user
    // has a working account", not "user has seen the slides". This is also the
    // semantic firstLaunchGuard.ts relies on — only an account that exists on
    // disk should make the device skip the fresh-install purge.
    //
    // Guideline 1.2 : les CGU s'intercalent entre le carrousel et la création
    // du profil — l'EULA doit être accepté AVANT toute utilisation du service.
    // Déjà acceptées (aller-retour via le back de SetupProfileScreen) → on
    // saute directement au profil.
    setNeedsOnboarding(false);
    let alreadyAccepted = false;
    try {
      alreadyAccepted = (await AsyncStorage.getItem(TERMS_ACCEPTED_KEY)) === TERMS_VERSION;
    } catch {}
    if (alreadyAccepted) {
      setNeedsProfileSetup(true);
    } else {
      setNeedsTerms(true);
    }
  };

  /**
   * Guideline 1.2 : l'utilisateur a accepté les CGU (TermsScreen).
   * Persiste la version acceptée puis route vers l'étape suivante :
   *   - nouvel utilisateur → création du profil ;
   *   - utilisateur existant (mise à jour) → app principale.
   */
  const handleTermsAccepted = async () => {
    try {
      await AsyncStorage.setItem(TERMS_ACCEPTED_KEY, TERMS_VERSION);
    } catch (e) {
      // Non-fatal : au pire, l'écran sera re-présenté au prochain launch.
      console.warn('[App] failed to persist terms acceptance:', e);
    }
    setNeedsTerms(false);
    const hasProfile = await hasGlobalDisplayName();
    if (!hasProfile) {
      setNeedsProfileSetup(true);
    }
  };

  // ============================================
  // ÉCRANS DE CHARGEMENT / ERREUR / SETUP
  // ============================================

  // ═══════════════════════════════════════════════════════════════════════
  // COUVERTURE INITIALE — avant que le hint ait été lu
  // ═══════════════════════════════════════════════════════════════════════
  // Cas atteint UNIQUEMENT quand le hint AsyncStorage n'était pas encore
  // résolu au tout 1er render (extrêmement rare, fenêtre de quelques ms
  // entre l'import du module et le mount React). Habituellement, l'état
  // initial du composant (`useState(!hintIsPending)`) a déjà fixé
  // lockDetected=true → on saute directement au rendu LockScreen ou
  // SplashScreen plus bas.
  //
  // Pourquoi un SplashScreen instant et pas un <View> noir :
  //   - Au cold start déclenché par Android (kill mémoire), le launch theme
  //     natif d'Expo n'est PAS toujours rejoué — Android peut afficher la
  //     dernière frame de l'activité ou un fond noir nu, sans logo. Si on
  //     rend ensuite un <View> uni, l'utilisateur voit du noir continu →
  //     « écran noir bizarre ».
  //   - <SplashScreen instant /> rend le logo + texte EN PLEIN BLOOM dès
  //     le 1er paint (pas de fade-in, voir SplashScreen.tsx prop instant).
  //     L'utilisateur perçoit un splash cohérent qui se transforme en
  //     LockScreen ou continue d'afficher la progression de boot.
  //   - Cohérent visuellement avec le splash natif Expo (logo centré sur
  //     fond sombre).
  //
  // Dès que le hint résout via le useEffect (`<30ms typiquement) :
  //   - hint=true  → bascule sur LockScreen
  //   - hint=false → reste sur SplashScreen pour le boot normal
  //   - hint=null  → bascule vers le chemin SecureStore qui finira de décider
  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════
  // RENDER PATH: MIGRATION FROZEN
  // Highest priority — bypasses everything else.
  // ═══════════════════════════════════════════════════════════════════════
  if (migrationFrozen) {
    bootlog('render path: MigrationLockdownScreen (device is wiping or recovering an interrupted wipe)');
    return (
      <SafeAreaProvider>
        <GestureHandlerRootView style={styles.container}>
          <ThemedStatusBar />
          <MigrationLockdownScreen
            onWiped={() => {
              // Wipe complete → device is fresh. Reset state so the next
              // bootstrap pass routes to onboarding.
              //
              // CRITICAL: just resetting state is NOT enough — the bootstrap
              // useEffect at the top of this component has empty deps and
              // does not re-run on state changes. We MUST manually re-trigger
              // initializeApp() to avoid leaving the user on a permanent
              // splash. (Pre-existing bug in the original frozen→wipe flow.)
              setMigrationFrozen(false);
              setMigrationCheckDone(true);
              initStartedRef.current = false;
              setIsInitializing(true);
              setLockDetected(true); // we know there's no lock (just wiped)
              setNeedsOnboarding(false);
              setNeedsProfileSetup(false);
              setIsLocked(false);
              setLockEnabled(false);
              setInitError(null);
              // Manually re-run the post-clear bootstrap. initializeApp()
              // checks the marker first (now empty), then walks the standard
              // "fresh device" path: no profile → setNeedsOnboarding(true).
              // Defer to the next frame so React commits the state resets
              // before initializeApp() reads them via closure.
              requestAnimationFrame(() => {
                initializeApp().catch(e => {
                  console.error('[App] post-wipe re-bootstrap error:', e);
                });
              });
            }}
          />
        </GestureHandlerRootView>
      </SafeAreaProvider>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER PATH: RESTORING MIGRATION
  // The user picked "Restore from backup" on the WelcomeScreen.
  // ═══════════════════════════════════════════════════════════════════════
  if (restoringMigration) {
    bootlog('render path: MigrationImportScreen (restore in progress)');
    return (
      <SafeAreaProvider>
        <GestureHandlerRootView style={styles.container}>
          <ThemedStatusBar />
          <MigrationImportScreen
            onImported={() => {
              // After import, the device has a real identity, sessions, etc.
              // Force a full re-init so sessionService.initialize() picks up
              // the imported data on the next bootstrap pass.
              //
              // SAME FIX as the wipe path: the bootstrap useEffect has empty
              // deps and does not re-run on state changes. We must manually
              // call initializeApp() to avoid a permanent splash.
              setRestoringMigration(false);
              setNeedsOnboarding(false);
              setNeedsProfileSetup(false);
              initStartedRef.current = false;
              setIsInitializing(true);
              setLockDetected(true);
              setIsLocked(false);
              setLockEnabled(false);
              setInitError(null);
              requestAnimationFrame(() => {
                initializeApp().catch(e => {
                  console.error('[App] post-import re-bootstrap error:', e);
                });
              });
            }}
            onCancel={() => setRestoringMigration(false)}
          />
        </GestureHandlerRootView>
      </SafeAreaProvider>
    );
  }

  if (!lockDetected) {
    bootlog('render path: initialCover (SplashScreen instant) — hint still pending');
    return (
      <SafeAreaProvider>
        <ThemedStatusBar />
        <SplashScreen instant />
      </SafeAreaProvider>
    );
  }

  if (isInitializing) {
    bootlog('render path: SplashScreen (isInitializing=true)');
    return (
      <SafeAreaProvider>
        <SplashScreen statusMessage={splashStatus} instant={splashInstant} />
      </SafeAreaProvider>
    );
  }

  if (initError) {
    return (
      <SafeAreaProvider>
        <View style={styles.errorContainer}>
          <ThemedStatusBar />
          <Text style={styles.errorEmoji}>⚠️</Text>
          <Text style={styles.errorText}>{initError}</Text>
        </View>
      </SafeAreaProvider>
    );
  }

  if (needsOnboarding) {
    return (
      <SafeAreaProvider>
        <GestureHandlerRootView style={styles.container}>
          <ThemedStatusBar transparent />
          {/*
            `onRestore` branche le lien « Restaurer une sauvegarde » du
            carrousel sur le MÊME état que celui utilisé par les Réglages
            (`restoringMigration`), qui monte MigrationImportScreen à la
            place de l'onboarding. Le chemin de retour (`onCancel`) ramène
            ici : aucune donnée n'est persistée tant que l'import n'a pas
            réussi, donc l'aller-retour est sans effet de bord.
          */}
          <WelcomeScreen
            onComplete={handleOnboardingComplete}
            onRestore={() => setRestoringMigration(true)}
          />
          {/* Kill-switch overlay : aussi monté sur onboarding pour qu'un avis
              critique apparaisse même avant que le user ait fini son setup. */}
          <AppNoticeOverlay navigationRef={navigationRef} />
        </GestureHandlerRootView>
      </SafeAreaProvider>
    );
  }

  // Guideline 1.2 : CGU bloquantes — après le carrousel pour les nouveaux
  // utilisateurs, avant l'app principale pour les utilisateurs existants.
  // Rendu HORS NavigationContainer, comme Welcome/SetupProfile.
  if (needsTerms) {
    return (
      <SafeAreaProvider>
        <GestureHandlerRootView style={styles.container}>
          <ThemedStatusBar />
          <TermsScreen onAccept={handleTermsAccepted} />
          {/* Kill-switch overlay : même couverture que l'onboarding. */}
          <AppNoticeOverlay navigationRef={navigationRef} />
        </GestureHandlerRootView>
      </SafeAreaProvider>
    );
  }

  if (needsProfileSetup) {
    return (
      <SafeAreaProvider>
        <GestureHandlerRootView style={styles.container}>
          <ThemedStatusBar />
          <SetupProfileScreen
            onComplete={handleProfileSetupComplete}
            onBack={() => {
              // Retour vers le carrousel WelcomeScreen — aucune donnée
              // n'est encore persistée à ce stade (handleProfileSetupComplete
              // n'a pas tourné), donc safe. Permet à l'utilisateur de relire
              // les slides s'il a cliqué "Commencer" trop vite.
              setNeedsProfileSetup(false);
              setNeedsOnboarding(true);
            }}
          />
          {/* SetupProfileScreen ouvre une feuille d'actions pour le choix de
              la photo : il lui faut un host, ce chemin de rendu étant
              antérieur au NavigationContainer. */}
          <AlertHost />
          {/* Kill-switch overlay : pareil sur l'écran de profil. */}
          <AppNoticeOverlay navigationRef={navigationRef} />
        </GestureHandlerRootView>
      </SafeAreaProvider>
    );
  }

  if (isLocked && lockEnabled) {
    bootlog('render path: LockScreen');
    return (
      <SafeAreaProvider>
        <GestureHandlerRootView style={styles.container}>
          {/*
            Le LockScreen est rendu IMMÉDIATEMENT à opacity=1 (plus de fade-in
            d'entrée, cf. note dans LockScreen.tsx). Son TextInput, son logo
            et son bouton sont visibles au 1er paint, sans masquage.

            L'overlay ci-dessous N'EST RENDU QUE pendant les états AppState
            'inactive' / 'background' (showPrivacyOverlay=true), pour protéger
            le snapshot dans l'App Switcher iOS / Recents Android. Au retour
            'active' :
              - fast return    → setShowPrivacyOverlay(false) immédiat
              - shouldLock     → setShowPrivacyOverlay(false) DANS LE MÊME
                                 batch que setIsLocked(true) → React commit
                                 un seul snapshot "LockScreen sans overlay"
                                 → utilisateur voit le TextInput dès le 1er
                                 paint, pas d'écran noir intermédiaire.

            Précédemment l'overlay était piloté par `!lockScreenReady`,
            persistant jusqu'à ce que LockScreen.useEffect → rAF → onReady()
            → setLockScreenReady(true) déclenche un re-render. Cet aller-retour
            (mount → useEffect → rAF → setState → re-render → commit → paint)
            prend 2-4 frames sur device rapide (33-66ms) mais peut atteindre
            300-500ms quand le JS thread est chargé (transition d'AppState,
            unmount NavigationContainer, services qui se rétablissent).
            Pendant ce temps, l'overlay #0A0F14 = écran noir perçu. Bug supprimé.
          */}
          <LockScreen
            key={lockSessionId}
            onUnlock={handleUnlock}
          />
          {showPrivacyOverlay && (
            <View pointerEvents="none" style={styles.privacyOverlay} />
          )}
        </GestureHandlerRootView>
      </SafeAreaProvider>
    );
  }

  // ============================================
  // APP PRINCIPALE
  // ============================================

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.container}>
        <ThemedStatusBar />
        <ThemedNavigationContainer navigationRef={navigationRef}>
          <AppContent
            onSecurityChange={refreshLockState}
            onRequestRestore={() => setRestoringMigration(true)}
          />
        </ThemedNavigationContainer>
        {showPrivacyOverlay && (
          <View pointerEvents="none" style={styles.privacyOverlay} />
        )}
        <InAppNotificationHost />
        {/* Toast — monté HORS du NavigationContainer pour survivre aux
            changements d'écran (ex. : copier un lien puis fermer la modale
            d'invitation) et se superposer à n'importe quelle route. Rend
            `null` tant qu'aucun toast n'est demandé. */}
        <ToastHost />
        {/* Host des dialogues du design system. Il s'appuie sur le Modal de
            React Native, présenté dans sa propre fenêtre native : un seul
            host suffit pour couvrir tous les écrans, y compris ceux
            présentés en `modal`. */}
        <AlertHost />
        {/* App notice (kill-switch) — monté en dernier pour couvrir tous
            les écrans du Stack. L'overlay s'auto-cache si pas d'avis (null
            return), aucun coût en steady-state. */}
        <AppNoticeOverlay navigationRef={navigationRef} />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

// ============================================
// STYLES
// ============================================

// ════════════════════════════════════════════════════════════════════════════
// Ce `StyleSheet.create` était au niveau MODULE et lisait `theme.colors.X`.
// Or `theme.colors` est une copie de la palette résolue à l'import du module
// theme.ts : les valeurs étaient donc GELÉES au démarrage. Changer
// d'apparence dans les Réglages laissait la racine de l'app — dont l'overlay
// de confidentialité qui recouvre tout l'écran en arrière-plan — peinte dans
// l'ancien thème jusqu'au prochain démarrage à froid.
//
// C'est maintenant une FABRIQUE consommée via `useThemedStyles(makeStyles)`
// dans `AppInner`. `useThemedStyles` mémoïse sur la référence de la palette,
// donc le coût en régime permanent est nul : un seul `StyleSheet.create`
// par changement de thème.
// ════════════════════════════════════════════════════════════════════════════
const makeStyles = (colors: ColorPalette) => ({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Fond uni sans animation, affiché UNIQUEMENT pendant la micro-phase
  // `isLockEnabledFast` (avant que la décision lock/unlock soit connue).
  // Même couleur que `privacyOverlay` pour que la transition soit
  // imperceptible lorsqu'il est remplacé par le LockScreen ou le SplashScreen.
  initialCover: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Overlay plein écran affiché quand l'app est 'inactive' ou 'background'.
  // Empêche la fuite d'informations sensibles dans :
  //   - l'App Switcher iOS (snapshot pris à 'inactive')
  //   - le Recents Android (snapshot pris au moment du pause)
  //   - les previews de FaceID / contrôle center
  // Complément — et non substitut — de la protection anti-capture armée au
  // boot par `screenCaptureGuard` : sur iOS, aucune API ne bloque un
  // screenshot, cet overlay reste donc la seule barrière pour les états
  // 'inactive'/'background'.
  privacyOverlay: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.background,
    zIndex: 9999,
    elevation: 9999,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    backgroundColor: colors.background,
    padding: 20,
  },
  errorEmoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  errorText: {
    fontSize: 16,
    color: colors.text,
    textAlign: 'center' as const,
  },
});