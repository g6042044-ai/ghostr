// App.tsx
// Point d'entrée principal - Ghostr
// Conversations 1-à-1 uniquement
// Triple Ratchet + Appels vocaux + Vérification sécurité
import 'react-native-get-random-values';
import React, { useEffect, useState, useRef } from 'react';
import { StatusBar, View, StyleSheet, Text, AppState, AppStateStatus, Platform, Alert } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import 'react-native-gesture-handler';

// Push Notifications
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
// Screen capture protection: bloque screenshots Android (FLAG_SECURE),
// scrcpy, enregistrement d'écran, casting. Sur iOS, la capture ne peut être
// que détectée (pas bloquée) — l'overlay privacy reste la protection primaire.
import * as ScreenCapture from 'expo-screen-capture';
import {
  initPushNotifications,
  showLocalNotification,
  showIncomingCallNotification,
  BACKGROUND_NOTIFICATION_TASK,
  hasCompletedNotificationOnboarding,
} from './src/services/pushNotificationService';

// Import des composants d'appels vocaux
import { Call1to1Provider } from './src/hooks/useCall1to1';

// Notification onboarding (écran de configuration affiché une seule fois)
import { NotificationOnboarding } from './src/components/NotificationOnboarding';

// Import des services de sécurité
import {
  performSecurityCheck,
  getSecurityWarningMessage,
  getSecurityAlertTitle,
  applySecurityPolicy,
  SecurityCheckResult,
} from './src/services/deviceSecurity';
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
import { SettingsScreen } from './src/screens/SettingsScreen';
import { LockScreen } from './src/screens/LockScreen';
import { SecurityScreen } from './src/screens/SecurityScreen';
import { SetupProfileScreen } from './src/screens/SetupProfileScreen';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { EditProfileScreen } from './src/screens/EditProfileScreen';
import { SplashScreen } from './src/screens/SplashScreen';

// Services
import { getOrCreateDeviceState, clearEncryptionKey, hasGlobalDisplayName, initHardwareEncryptionAll, nuclearReset } from './src/services/storage';
// api.ts ne contient plus que la config réseau (supabase, supabaseStorage, isRelayEnabled, getApiUrl)
import { startGlobalPolling1to1, stopGlobalPolling1to1, pollAllSessions, waitForSealedSender, precomputePoW, recoverOrphanedSendingMessages } from './src/services/api1to1';
import { inviteWatcher } from './src/services/inviteWatcher';
import { loadSilentMode, ensureInCallStarted, stopInCallManager } from './src/services/callTones';
import { isInCall1to1 } from './src/services/call1to1Service';
import { preWarmNativeAudio } from './src/services/audioService';
import { isLockEnabled, getLockSettings } from './src/services/appLock';
import { isLockSuppressed } from './src/services/lockGuard';
import { 
  initializePrivacyServices,
  pausePrivacyServices,
  resumePrivacyServices,
} from './src/services/privacySettings';
import { initializePinning, listenForPinningErrors } from './src/services/networkSecurity';
import { sessionService } from './src/services/tripleRatchet';
import { initSodiumZeroize } from './src/services/sodiumZeroize';
// R-13: Zeroize sealed sender state on lock
import { clearSealedSenderState } from './src/services/sealedSender';

// Theme
import { theme } from './src/components/ui/theme';

// ============================================
// CONSTANTES
// ============================================

// ⚠️ METTRE À TRUE POUR EFFACER TOUTES LES DONNÉES AU DÉMARRAGE
// ⚠️ REMETTRE À FALSE APRÈS LE TEST !
const RESET_ALL_DATA = false;

const LAST_BACKGROUND_TIME_KEY = '@whisper_last_background_time';
const SECURITY_CHECK_SHOWN_KEY = '@whisper_security_check_shown';
const ONBOARDING_COMPLETED_KEY = '@ghostr_onboarding_completed';

// ═══════════════════════════════════════════════════════════════════════════
// DÉTECTION VRAI vs FAUX BACKGROUND
// ═══════════════════════════════════════════════════════════════════════════
// Android ouvre les écrans `presentation: 'modal'` / `'fullScreenModal'` dans
// une nouvelle Activity : l'Activity principale passe en `onPause` → AppState
// devient temporairement 'background', puis 'active' quand la nouvelle Activity
// est au premier plan. Les transitions de navigation peuvent aussi générer de
// brefs `background`.
//
// Règle fiable : si l'app est TOUJOURS en 'background' après ce délai, alors
// l'utilisateur a bel et bien quitté l'app (Home, App Switcher, autre app).
// Si elle revient en 'active' avant, c'était une transition interne.
//
// 1200ms est assez long pour couvrir les transitions les plus lentes
// (Android bas de gamme, grosses animations), et assez court pour que
// l'utilisateur ne remarque aucun délai de verrouillage perceptible.
// ═══════════════════════════════════════════════════════════════════════════
const BACKGROUND_CONFIRMATION_MS = 1200;

export type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { conversationId: string; conversationName: string };
  ContactInfo: { sessionId: string };
  Create1to1: undefined;
  Join1to1: undefined;
  Invitations: undefined;
  InviteDetail: { tag: string };
  ConnectionSuccess: { sessionId: string; contactName: string; inviteLabel: string; inviteTag?: string; contactAvatarBase64?: string };
  Settings: undefined;
  Security: undefined;
  EditProfile: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const NavigationTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: theme.colors.primary,
    background: theme.colors.background,
    card: theme.colors.surface,
    text: theme.colors.text,
    border: theme.colors.border,
    notification: theme.colors.primary,
  },
};

// ============================================
// CONTENU PRINCIPAL
// ============================================

function AppContent({ onSecurityChange }: { onSecurityChange: () => void }) {
  return (
    <Call1to1Provider>
      <Stack.Navigator
        initialRouteName="ConversationList"
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
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
        <Stack.Screen name="Settings">
          {(props) => <SettingsScreen {...props} onSecurityChange={onSecurityChange} />}
        </Stack.Screen>
        <Stack.Screen 
          name="EditProfile" 
          component={EditProfileScreen}
          options={{ presentation: 'card' }}
        />
        <Stack.Screen name="Security" options={{ presentation: 'modal' }}>
          {(props) => (
            <SecurityScreen
              onBack={() => {
                onSecurityChange();
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

// ============================================
// APP PRINCIPALE
// ============================================

export default function App() {
  // Prevent screen from auto-locking while the app is in the foreground.
  // iOS: isIdleTimerDisabled = true / Android: FLAG_KEEP_SCREEN_ON.
  // User can still lock manually via power button.
  useKeepAwake();
  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [lockEnabled, setLockEnabled] = useState(false);
  const [lockTimeout, setLockTimeout] = useState(1);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [needsProfileSetup, setNeedsProfileSetup] = useState(false);
  const [securityCheckResult, setSecurityCheckResult] = useState<SecurityCheckResult | null>(null);
  const [splashStatus, setSplashStatus] = useState<string | undefined>(undefined);

  // Privacy overlay: masque le contenu pendant 'inactive'/'background' afin
  // qu'aucune donnée ne fuite dans l'App Switcher / Recents.
  const [showPrivacyOverlay, setShowPrivacyOverlay] = useState(false);

  const previousAppState = useRef<AppStateStatus>(AppState.currentState);
  const inactiveStartTime = useRef<number | null>(null);
  const wentToBackground = useRef(false);
  const initStartedRef = useRef(false);

  // Refs miroirs pour accéder aux valeurs à jour dans le timer de confirmation
  // sans recréer l'useEffect à chaque changement (ce qui ferait rater des
  // transitions d'AppState).
  const lockEnabledRef = useRef(lockEnabled);
  const lockTimeoutRef = useRef(lockTimeout);
  const isLockedRef = useRef(isLocked);
  useEffect(() => { lockEnabledRef.current = lockEnabled; }, [lockEnabled]);
  useEffect(() => { lockTimeoutRef.current = lockTimeout; }, [lockTimeout]);
  useEffect(() => { isLockedRef.current = isLocked; }, [isLocked]);

  // Timer de confirmation de vrai background (voir BACKGROUND_CONFIRMATION_MS)
  const bgConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;
    initializeApp();
  }, []);

  useEffect(() => {
    // Fonction appelée quand le timer confirme que le background est RÉEL
    // (l'utilisateur a vraiment quitté l'app : Home, App Switcher, autre app).
    const onConfirmedBackground = async () => {
      bgConfirmTimer.current = null;

      // Double-check : l'état doit toujours être 'background' au moment du fire
      // (si l'app est revenue en 'active' entre-temps, on n'aurait pas dû arriver ici
      //  car clearTimeout a été appelé — mais safety first).
      if (AppState.currentState !== 'background') {
        return;
      }

      wentToBackground.current = true;

      const departureTime = inactiveStartTime.current || Date.now();
      try {
        await AsyncStorage.setItem(LAST_BACKGROUND_TIME_KEY, departureTime.toString());
      } catch {}

      // ═══════════════════════════════════════════════════════════════════════
      // VERROUILLAGE IMMÉDIAT (timeout === 0)
      // ═══════════════════════════════════════════════════════════════════════
      // On efface les clés MAINTENANT (pendant le background), pas au retour.
      // Raison : tant que les clés sont en RAM pendant le background, elles
      // restent accessibles via un memory dump (root / debugger / cold boot).
      // Effacer au moment du départ ferme cette fenêtre d'attaque et respecte
      // littéralement le paramètre « Immédiatement ».
      //
      // Note : ce setState ne re-rend pas l'UI tant que l'app est en background
      // (le thread JS tourne ~5-10s puis est suspendu par l'OS), mais quand
      // l'utilisateur reviendra, il verra directement le LockScreen.
      if (lockEnabledRef.current && lockTimeoutRef.current === 0 && !isLockedRef.current) {
        try { clearEncryptionKey(); } catch {}
        try { clearSealedSenderState(); } catch {}
        setIsLocked(true);
        try { await AsyncStorage.removeItem(LAST_BACKGROUND_TIME_KEY); } catch {}
      }
    };

    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
      const prevState = previousAppState.current;

      // ═══════════════════════════════════════════════════════════════════════
      // INACTIVE (iOS uniquement)
      // ═══════════════════════════════════════════════════════════════════════
      // État transitoire : Control Center, Notification Center, FaceID prompt,
      // preview de l'App Switcher. Afficher immédiatement le privacy overlay
      // pour que rien de sensible ne fuite.
      if (nextAppState === 'inactive' && prevState === 'active') {
        inactiveStartTime.current = Date.now();
        setShowPrivacyOverlay(true);
      }

      // ═══════════════════════════════════════════════════════════════════════
      // BACKGROUND
      // ═══════════════════════════════════════════════════════════════════════
      if (nextAppState === 'background') {
        setShowPrivacyOverlay(true);

        // Cas #1 — FAUX background EXPLICITE déclaré par l'app.
        // Ce sont les seuls cas où on sait avec CERTITUDE que le passage en
        // background est dû à une action interne de l'app qui ouvre une
        // Activity système :
        //   - `isLockSuppressed()` : image picker / caméra / document picker
        //     (src/services/lockGuard.ts, appelé par ConversationScreen,
        //      EditProfileScreen, SetupProfileScreen autour des ImagePicker.launch*)
        //   - `isInCall1to1()` : appel vocal en cours (capteur de proximité
        //      + InCallManager basculent brièvement l'état).
        //
        // Dans ces cas, on ne fait rien : pas de verrouillage, pas de timer.
        if (isLockSuppressed() || isInCall1to1()) {
          pausePrivacyServices();
          // (On ne stoppe pas le polling pendant un appel — il est géré par
          //  le service d'appel lui-même.)
          if (!isInCall1to1()) {
            stopGlobalPolling1to1();
            inviteWatcher.stop();
          }
          previousAppState.current = nextAppState;
          return;
        }

        // Cas #2 — background AMBIGU.
        // On ne sait PAS encore si c'est :
        //   (a) un vrai départ (Home, App Switcher, autre app) → il faut verrouiller
        //   (b) l'ouverture d'un écran modal Android → il ne faut PAS verrouiller
        //   (c) un artefact de transition de navigation Android → idem
        //
        // Pour trancher, on arme un timer. Si l'app revient en 'active' avant
        // l'expiration, c'était un cas (b) ou (c) — on annule. Si le timer
        // expire en étant toujours en 'background', c'est un (a) confirmé.
        //
        // Cette approche est robuste car elle ne fait AUCUNE hypothèse sur la
        // route courante ou les timings de navigation : on observe uniquement
        // le comportement réel d'AppState.
        if (bgConfirmTimer.current) {
          clearTimeout(bgConfirmTimer.current);
        }
        bgConfirmTimer.current = setTimeout(onConfirmedBackground, BACKGROUND_CONFIRMATION_MS);

        pausePrivacyServices();
        if (!isInCall1to1()) {
          stopGlobalPolling1to1();
          inviteWatcher.stop();
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // ACTIVE — retour au premier plan
      // ═══════════════════════════════════════════════════════════════════════
      if (nextAppState === 'active') {
        // Si le timer de confirmation tourne encore, on l'annule : le background
        // n'était pas "réel" (ouverture d'un modal Android, transition, etc.).
        if (bgConfirmTimer.current) {
          clearTimeout(bgConfirmTimer.current);
          bgConfirmTimer.current = null;
        }

        inactiveStartTime.current = null;

        // Vérifier si un vrai background a été enregistré (wentToBackground
        // est passé à true par onConfirmedBackground, OU l'app a été tuée
        // et relancée pendant qu'on était en background — mais dans ce cas
        // on ne passe pas par ici, on passe par initializeApp).
        if (wentToBackground.current && lockEnabled) {
          wentToBackground.current = false;

          // timeout === 0 a déjà été traité dans onConfirmedBackground ; isLocked
          // est déjà true. On laisse l'overlay privacy actif : le LockScreen
          // prendra la main au prochain rendu (il est opaque, masque tout).
          if (isLockedRef.current) {
            setShowPrivacyOverlay(false);
            previousAppState.current = nextAppState;
            return;
          }

          const shouldLock = await checkIfShouldLock(lockTimeout);
          if (shouldLock) {
            try { clearEncryptionKey(); } catch {}
            try { clearSealedSenderState(); } catch {}
            setIsLocked(true);
            // L'overlay reste affiché jusqu'au rendu du LockScreen (opaque) :
            // ça évite tout flash de la conversation déchiffrée entre les
            // deux frames.
            setShowPrivacyOverlay(false);
            try { await AsyncStorage.removeItem(LAST_BACKGROUND_TIME_KEY); } catch {}
            previousAppState.current = nextAppState;
            return;
          }
        }

        wentToBackground.current = false;
        try { await AsyncStorage.removeItem(LAST_BACKGROUND_TIME_KEY); } catch {}
        setShowPrivacyOverlay(false);

        if (!isLocked) {
          resumePrivacyServices();
          startGlobalPolling1to1();
          inviteWatcher.start().catch(console.error);

          // PERF A3: Poll immédiat au retour de background.
          // Avec A1, le sealed sender est probablement encore valide → ce poll
          // part instantanément au lieu d'attendre le premier cycle de constantTraffic.
          // Si le sealed sender a expiré, le poll échouera silencieusement et
          // le prochain cycle régulier réessaiera après le re-bootstrap.
          // Fire-and-forget : ne pas bloquer le handler AppState.
          pollAllSessions().catch(() => {});
        }
      }

      previousAppState.current = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription.remove();
      if (bgConfirmTimer.current) {
        clearTimeout(bgConfirmTimer.current);
        bgConfirmTimer.current = null;
      }
    };
  }, [lockEnabled, lockTimeout, isLocked]);

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
      setSecurityCheckResult(result);
      
      const policy = applySecurityPolicy(result);
      
      // ACTION 08: Bloquer l'app si l'appareil est compromis (pas juste un warning)
      if (policy.shouldBlock) {
        const message = getSecurityWarningMessage(result);
        const title = getSecurityAlertTitle(result);
        
        Alert.alert(
          '🚨 Appareil compromis — Accès bloqué',
          (message || '') + '\n\nGhostr ne peut pas garantir la sécurité de vos conversations sur cet appareil. ' +
          'Root/jailbreak ou framework de hooking détecté.\n\n' +
          'L\'application est bloquée pour protéger vos données.',
          [{ text: 'Fermer', style: 'destructive' }],
          { cancelable: false }
        );
        // L'app restera bloquée sur cet écran — l'utilisateur ne peut pas continuer
        return;
      }
      
      if (policy.shouldWarn && lastShown !== today) {
        const message = getSecurityWarningMessage(result);
        const title = getSecurityAlertTitle(result);
        
        if (message) {
          await AsyncStorage.setItem(SECURITY_CHECK_SHOWN_KEY, today);
          
          Alert.alert(
            title,
            message,
            [{ text: 'Je comprends les risques', style: 'default' }],
            { cancelable: false }
          );
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

      // Activer la protection contre les captures d'écran dès le démarrage.
      // Android : ajoute FLAG_SECURE → écran noir dans les screenshots et les
      //   logiciels de mirroring (scrcpy, Vysor, enregistrement d'écran).
      // iOS : installe un listener pour détecter les screenshots ; la capture
      //   elle-même ne peut pas être empêchée (limitation de l'OS).
      // Le tag 'ghostr-global' permet de le désactiver temporairement autour
      //   d'un ImagePicker (où Android bloquerait aussi la preview de caméra).
      ScreenCapture.preventScreenCaptureAsync('ghostr-global').catch(() => {});
      
      // ═══════════════════════════════════════════════
      // PHASE 1 — RAPIDE (~100ms) : Checks AsyncStorage
      // Objectif : afficher onboarding/profile IMMÉDIATEMENT
      // sans attendre la génération crypto (5-12s sur émulateur)
      // ═══════════════════════════════════════════════
      
      // Certificate pinning (non-bloquant en dev)
      const pinStatus = await initializePinning();
      console.log(`🔒 Pinning: ${pinStatus.active ? 'ACTIF' : 'INACTIF'} — ${pinStatus.reason}`);
      if (pinStatus.active) {
        console.log(`🔒 Domaines pinnés: ${pinStatus.domains.join(', ')}`);
        listenForPinningErrors((error) => {
          console.error('🚨 SSL Pinning error:', error.serverHostname);
        });
      }
      if (!pinStatus.active && !__DEV__) {
        Alert.alert(
          '⚠️ Sécurité',
          `Le certificate pinning n'est pas actif.\nRaison: ${pinStatus.reason}`
        );
      }
      
      // Security check (fire-and-forget, non-bloquant)
      performDeviceSecurityCheck();
      
      // Load silent mode preference (non-bloquant)
      loadSilentMode().catch(() => {});
      
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
      
      // Vérifier l'état d'onboarding AVANT la crypto (juste un read AsyncStorage)
      const onboardingCompleted = await AsyncStorage.getItem(ONBOARDING_COMPLETED_KEY);
      console.log('[App] initializeApp: onboardingCompleted =', onboardingCompleted);
      
      const hasDisplayName = await hasGlobalDisplayName();
      console.log('[App] initializeApp: hasDisplayName =', hasDisplayName);
      
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
        console.log('[App] initializeApp: → profile setup (no crypto needed yet)');
        setNeedsProfileSetup(true);
        setIsInitializing(false);
        return;
      }
      
      // ═══════════════════════════════════════════════
      // PHASE 2 — LENTE : Utilisateur de retour
      // La crypto est nécessaire. Le SplashScreen est visible.
      // ═══════════════════════════════════════════════
      
      console.log('[App] initializeApp: returning user, initializing crypto...');
      const _t0 = Date.now();
      const _ts = (label: string) => console.log(`[App] ⏱️ ${label}: ${Date.now() - _t0}ms`);
      
      // Laisser le splash s'animer avant de bloquer le thread
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      
      // FIX 2.2: Lancer PoW immédiatement, puis sodium + session en parallèle
      // precomputePoW est fire-and-forget (le résultat est attendu par waitForSealedSender)
      // initSodiumZeroize et sessionService.initialize sont indépendants
      precomputePoW();
      
      // Warm the Android AudioManager by cycling through MODE_IN_COMMUNICATION.
      // The FIRST InCallManager session in a process is "fragile" — proximity
      // sensor events cause audio route resets (speaker). After one full
      // start → stop cycle, subsequent sessions handle proximity correctly.
      if (Platform.OS !== 'web') {
        ensureInCallStarted();
        setTimeout(() => stopInCallManager(), 500);
      }
      
      // FIX AUDIO v3: Pré-charger les modules natifs audio (speechmatics +
      // expo-audio-stream) au démarrage de l'app. Au premier appel, smInit()
      // cold-start crée un AudioRecord natif qui corrompt le routage audio
      // quand InCallManager est actif → le capteur de proximité bascule sur
      // haut-parleur. En pré-chauffant ici, smInit() pendant l'appel est un
      // warm-start instantané, sans conflit.
      // Fire-and-forget — n'attend pas la fin, continue l'init en parallèle.
      preWarmNativeAudio();
      
      // ACTION-04 FIX: Check lock status FIRST, then init hardware encryption
      // BEFORE sessionService.initialize() reads ratchet states from AsyncStorage.
      // Without this, encryptionKey is null when sessionService loads encrypted data
      // → ratchet states unreadable → AEAD failures → messages invisible.
      const locked = await isLockEnabled();
      setLockEnabled(locked);
      _ts('isLockEnabled');
      
      if (!locked) {
        await initHardwareEncryptionAll();
        _ts('initHardwareEncryptionAll');
      }
      
      // Initialize sodium always, but sessionService ONLY when not locked.
      // When locked, sessionService.initialize() would run without an encryption key,
      // fail to read encrypted data, and overwrite it with empty state → data loss.
      // handleUnlock() calls sessionService.initialize() after PIN entry instead.
      if (locked) {
        await initSodiumZeroize();
        _ts('initSodiumZeroize (locked, sessionService deferred)');
      } else {
        const [sodiumOk] = await Promise.all([
          initSodiumZeroize(),
          sessionService.initialize(),
        ]);
        _ts(`parallel init (sodium=${sodiumOk ? 'libsodium' : 'JS fallback'} + sessionService)`);
      }
      
      if (locked) {
        const settings = await getLockSettings();
        setLockTimeout(settings.timeoutMinutes);
        
        const shouldLock = await checkIfShouldLock(settings.timeoutMinutes);
        
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
        await getOrCreateDeviceState();
        _ts('getOrCreateDeviceState');
        
        // P3 FIX: Récupérer les messages orphelins en status 'sending' avant de démarrer
        // PERF A10: Déféré à 5s après le démarrage — cas d'erreur rare (~1/10000),
        // pas besoin de bloquer le splash screen pour ça.
        setTimeout(() => recoverOrphanedSendingMessages().catch(() => {}), 5000);
        _ts('recoverOrphanedSendingMessages (deferred 5s)');
        
        // ÉTAPE 1: Sealed sender DOIT être prêt AVANT tout le reste.
        // Rien ne démarre tant que le PoW + certificat ne sont pas terminés.
        // Le splash affiche le statut en temps réel.
        const sealedReady = await waitForSealedSender(setSplashStatus);
        _ts(`waitForSealedSender (ready=${sealedReady})`);
        
        if (!sealedReady) {
          setInitError('Impossible d\'établir la connexion sécurisée. Vérifiez votre connexion internet et relancez l\'application.');
          return;
        }
        
        // ÉTAPE 2: Sealed sender confirmé → lancer les services
        setSplashStatus('Démarrage des services…');
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
        
        // ÉTAPE 3: KT registration (sealed sender prêt → passera immédiatement)
        sessionService.registerKeyInTransparencyLog().catch(e => {
          console.warn('[App] 🌳 KT registration deferred:', e.message);
        });
        
        // ÉTAPE 4: Premier poll
        try {
          await pollAllSessions();
        } catch (e) {
          console.warn('[App] First poll failed (non-fatal):', e);
        }
        _ts('pollAllSessions');
        console.log(`[App] ⏱️ TOTAL init: ${Date.now() - _t0}ms`);
      }
    } catch (error) {
      console.error('App initialization error:', error);
      setInitError('Erreur d\'initialisation');
    } finally {
      setIsInitializing(false);
    }
  };

  const handleUnlock = async () => {
    try {
      // Show SplashScreen during post-unlock initialization
      setIsLocked(false);
      setSplashStatus('Déverrouillage en cours…');
      setIsInitializing(true);

      // Let React paint the SplashScreen before blocking the thread
      await new Promise<void>(resolve => setTimeout(resolve, 50));

      await AsyncStorage.removeItem(LAST_BACKGROUND_TIME_KEY);
      
      setSplashStatus('Initialisation du chiffrement…');
      // FIX 2.2: Paralléliser comme dans le boot principal
      precomputePoW();

      setSplashStatus('Chargement de vos conversations…');
      await Promise.all([
        initSodiumZeroize(),
        getOrCreateDeviceState(),
        sessionService.initialize(),
      ]);

      // P3 FIX: Récupérer les messages orphelins après déverrouillage
      // PERF A10: Déféré — ne pas bloquer le splash post-PIN pour un cas d'erreur rare.
      setTimeout(() => recoverOrphanedSendingMessages().catch(() => {}), 5000);

      // ÉTAPE 1: Sealed sender DOIT être prêt AVANT tout le reste
      const sealedReady = await waitForSealedSender(setSplashStatus);
      if (!sealedReady) {
        setInitError('Impossible d\'établir la connexion sécurisée. Vérifiez votre connexion internet et relancez l\'application.');
        return;
      }
      
      // ÉTAPE 2: Sealed sender confirmé → lancer les services
      setSplashStatus('Démarrage des services…');
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
      
      // ÉTAPE 3: KT registration
      sessionService.registerKeyInTransparencyLog().catch(e => {
        console.warn('[App] 🌳 KT registration deferred:', e.message);
      });
    } catch (error) {
      console.error('Post-unlock error:', error);
    } finally {
      setSplashStatus(undefined);
      setIsInitializing(false);
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
      setNeedsProfileSetup(false);
      
      // Show SplashScreen with status messages during crypto init
      setSplashStatus('Génération des clés de chiffrement…');
      setIsInitializing(true);
      
      // Let React paint the splash BEFORE blocking the thread
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      
      setSplashStatus('Initialisation du chiffrement…');
      // FIX 2.2: Paralléliser sodium + session
      precomputePoW();

      setSplashStatus('Création de vos clés post-quantiques…');
      await Promise.all([
        initSodiumZeroize(),
        sessionService.initialize(),
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
        
        // ÉTAPE 1: Sealed sender DOIT être prêt AVANT tout le reste
        const sealedReady = await waitForSealedSender(setSplashStatus);
        if (!sealedReady) {
          setInitError('Impossible d\'établir la connexion sécurisée. Vérifiez votre connexion internet et relancez l\'application.');
          return;
        }
        
        // ÉTAPE 2: Sealed sender confirmé → lancer les services
        setSplashStatus('Démarrage des services…');
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
        
        // ÉTAPE 3: KT registration
        sessionService.registerKeyInTransparencyLog().catch(e => {
          console.warn('[App] 🌳 KT registration deferred:', e.message);
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
    try {
      console.log('[App] Onboarding completed, saving state...');
      await AsyncStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
      setNeedsOnboarding(false);
      setNeedsProfileSetup(true);
    } catch (error) {
      console.error('Error saving onboarding state:', error);
      setNeedsOnboarding(false);
      setNeedsProfileSetup(true);
    }
  };

  // ============================================
  // ÉCRANS DE CHARGEMENT / ERREUR / SETUP
  // ============================================

  if (isInitializing) {
    return (
      <SafeAreaProvider>
        <SplashScreen statusMessage={splashStatus} />
      </SafeAreaProvider>
    );
  }

  if (initError) {
    return (
      <SafeAreaProvider>
        <View style={styles.errorContainer}>
          <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
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
          <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
          <WelcomeScreen onComplete={handleOnboardingComplete} />
        </GestureHandlerRootView>
      </SafeAreaProvider>
    );
  }

  if (needsProfileSetup) {
    return (
      <SafeAreaProvider>
        <GestureHandlerRootView style={styles.container}>
          <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
          <SetupProfileScreen onComplete={handleProfileSetupComplete} />
        </GestureHandlerRootView>
      </SafeAreaProvider>
    );
  }

  if (isLocked && lockEnabled) {
    return (
      <SafeAreaProvider>
        <GestureHandlerRootView style={styles.container}>
          <LockScreen onUnlock={handleUnlock} />
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
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
        <NavigationContainer theme={NavigationTheme}>
          <AppContent onSecurityChange={refreshLockState} />
        </NavigationContainer>
        {showPrivacyOverlay && (
          <View pointerEvents="none" style={styles.privacyOverlay} />
        )}
        <InAppNotificationHost />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

// ============================================
// STYLES
// ============================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  // Overlay plein écran affiché quand l'app est 'inactive' ou 'background'.
  // Empêche la fuite d'informations sensibles dans :
  //   - l'App Switcher iOS (snapshot pris à 'inactive')
  //   - le Recents Android (snapshot pris au moment du pause)
  //   - les previews de FaceID / contrôle center
  // Note : pour une protection complète contre les screenshots utilisateur,
  // ajouter aussi `expo-screen-capture` → preventScreenCaptureAsync().
  privacyOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: theme.colors.background,
    zIndex: 9999,
    elevation: 9999,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.colors.background,
    padding: 20,
  },
  errorEmoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  errorText: {
    fontSize: 16,
    color: theme.colors.text,
    textAlign: 'center',
  },
});