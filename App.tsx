// App.tsx
// Point d'entrée principal - Ghostr
// Conversations 1-à-1 uniquement
// Triple Ratchet + Appels vocaux + Vérification sécurité
import 'react-native-get-random-values';
import React, { useEffect, useState, useRef } from 'react';
import { StatusBar, View, StyleSheet, Text, AppState, AppStateStatus, Platform, Alert } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import 'react-native-gesture-handler';

// Import des composants d'appels vocaux
import { Call1to1Provider } from './src/hooks/useCall1to1';

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
import { SplashScreen } from './src/screens/SplashScreen';

// Services
import { getOrCreateDeviceState, clearEncryptionKey, hasGlobalDisplayName } from './src/services/storage';
// api.ts ne contient plus que la config réseau (supabase, supabaseStorage, isRelayEnabled, getApiUrl)
import { startGlobalPolling1to1, stopGlobalPolling1to1, pollAllSessions, waitForSealedSender, precomputePoW } from './src/services/api1to1';
import { inviteWatcher } from './src/services/inviteWatcher';
import { isLockEnabled, getLockSettings } from './src/services/appLock';
import { 
  initializePrivacyServices,
  pausePrivacyServices,
  resumePrivacyServices,
} from './src/services/privacySettings';
import { initializePinning, listenForPinningErrors } from './src/services/networkSecurity';
import { sessionService } from './src/services/tripleRatchet';
import { initSodiumZeroize } from './src/services/sodiumZeroize';

// Theme
import { theme } from './src/components/ui/theme';

// ============================================
// CONSTANTES
// ============================================

// ⚠️ METTRE À TRUE POUR EFFACER TOUTES LES DONNÉES AU DÉMARRAGE
// ⚠️ REMETTRE À FALSE APRÈS LE TEST !
const RESET_ALL_DATA = true;

const LAST_BACKGROUND_TIME_KEY = '@whisper_last_background_time';
const LAST_INACTIVE_TIME_KEY = '@whisper_last_inactive_time';
const SECURITY_CHECK_SHOWN_KEY = '@whisper_security_check_shown';
const ONBOARDING_COMPLETED_KEY = '@ghostr_onboarding_completed';

export type RootStackParamList = {
  ConversationList: undefined;
  Conversation: { conversationId: string; conversationName: string };
  ContactInfo: { sessionId: string };
  Create1to1: undefined;
  Join1to1: undefined;
  Invitations: undefined;
  InviteDetail: { tag: string };
  ConnectionSuccess: { sessionId: string; contactName: string; inviteLabel: string; inviteTag?: string };
  Settings: undefined;
  Security: undefined;
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
          options={{ presentation: 'modal' }} 
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
          options={{ presentation: 'modal' }} 
        />
        <Stack.Screen name="Settings">
          {(props) => <SettingsScreen {...props} onSecurityChange={onSecurityChange} />}
        </Stack.Screen>
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
    </Call1to1Provider>
  );
}

// ============================================
// APP PRINCIPALE
// ============================================

export default function App() {
  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [lockEnabled, setLockEnabled] = useState(false);
  const [lockTimeout, setLockTimeout] = useState(1);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [needsProfileSetup, setNeedsProfileSetup] = useState(false);
  const [securityCheckResult, setSecurityCheckResult] = useState<SecurityCheckResult | null>(null);
  const [splashStatus, setSplashStatus] = useState<string | undefined>(undefined);
  
  const previousAppState = useRef<AppStateStatus>(AppState.currentState);
  const inactiveStartTime = useRef<number | null>(null);
  const initStartedRef = useRef(false);

  useEffect(() => {
    // Guard: React StrictMode double-mount → empêcher la double init
    if (initStartedRef.current) return;
    initStartedRef.current = true;
    initializeApp();
  }, []);

  useEffect(() => {
    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
      const prevState = previousAppState.current;
      
      if (nextAppState === 'inactive' && prevState === 'active') {
        inactiveStartTime.current = Date.now();
        await AsyncStorage.setItem(LAST_INACTIVE_TIME_KEY, Date.now().toString());
      }
      
      if (nextAppState === 'background') {
        const now = Date.now();
        await AsyncStorage.setItem(LAST_BACKGROUND_TIME_KEY, now.toString());
        
        if (inactiveStartTime.current) {
          await AsyncStorage.setItem(LAST_INACTIVE_TIME_KEY, inactiveStartTime.current.toString());
        } else {
          await AsyncStorage.setItem(LAST_INACTIVE_TIME_KEY, now.toString());
        }
        
        pausePrivacyServices();
        stopGlobalPolling1to1();
        inviteWatcher.stop();
      }
      
      if (nextAppState === 'active') {
        if (lockEnabled) {
          const shouldLock = await checkIfShouldLock(lockTimeout);
          
          if (shouldLock) {
            clearEncryptionKey();
            setIsLocked(true);
            await AsyncStorage.multiRemove([LAST_BACKGROUND_TIME_KEY, LAST_INACTIVE_TIME_KEY]);
            previousAppState.current = nextAppState;
            inactiveStartTime.current = null;
            return;
          }
        }
        
        await AsyncStorage.multiRemove([LAST_BACKGROUND_TIME_KEY, LAST_INACTIVE_TIME_KEY]);
        inactiveStartTime.current = null;
        
        if (!isLocked) {
          resumePrivacyServices();
          startGlobalPolling1to1();
          inviteWatcher.start().catch(console.error);
        }
      }
      
      previousAppState.current = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [lockEnabled, lockTimeout, isLocked]);

  const checkIfShouldLock = async (timeoutMinutes: number): Promise<boolean> => {
    try {
      const [backgroundTimeStr, inactiveTimeStr] = await AsyncStorage.multiGet([
        LAST_BACKGROUND_TIME_KEY,
        LAST_INACTIVE_TIME_KEY,
      ]);
      
      const inactiveTime = inactiveTimeStr[1] ? parseInt(inactiveTimeStr[1], 10) : null;
      const backgroundTime = backgroundTimeStr[1] ? parseInt(backgroundTimeStr[1], 10) : null;
      
      const referenceTime = inactiveTime || backgroundTime;
      
      if (!referenceTime) {
        return false;
      }
      
      const elapsedMinutes = (Date.now() - referenceTime) / 1000 / 60;
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
      
      // Reset data si flag actif
      if (RESET_ALL_DATA) {
        console.log('[App] ⚠️ RESET_ALL_DATA is TRUE - Clearing ALL data...');
        try {
          await AsyncStorage.clear();
          console.log('[App] ✅ AsyncStorage cleared');
          await sessionService.clearAllData();
          console.log('[App] ✅ SessionService cleared');
        } catch (e) {
          console.error('[App] Error clearing data:', e);
        }
        console.log('[App] ⚠️ Data reset complete. App will start fresh.');
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
      
      // Initialiser sodium.memzero() pour zeroization garantie (v3.1)
      // Non-bloquant: si libsodium n'est pas installé, le fallback JS fonctionne.
      const sodiumOk = await initSodiumZeroize();
      _ts(`initSodiumZeroize (${sodiumOk ? 'libsodium' : 'JS fallback'})`);
      
      precomputePoW();
      
      await sessionService.initialize();
      _ts('sessionService.initialize');
      
      const locked = await isLockEnabled();
      setLockEnabled(locked);
      _ts('isLockEnabled');
      
      if (locked) {
        const settings = await getLockSettings();
        setLockTimeout(settings.timeoutMinutes);
        
        const shouldLock = await checkIfShouldLock(settings.timeoutMinutes);
        
        if (shouldLock) {
          clearEncryptionKey();
          setIsLocked(true);
          await AsyncStorage.multiRemove([LAST_BACKGROUND_TIME_KEY, LAST_INACTIVE_TIME_KEY]);
        } else {
          const [backgroundTimeStr] = await AsyncStorage.multiGet([LAST_BACKGROUND_TIME_KEY]);
          
          if (backgroundTimeStr[1]) {
            clearEncryptionKey();
            setIsLocked(true);
            await AsyncStorage.multiRemove([LAST_BACKGROUND_TIME_KEY, LAST_INACTIVE_TIME_KEY]);
          } else {
            setIsLocked(true);
          }
        }
      } else {
        await getOrCreateDeviceState();
        _ts('getOrCreateDeviceState');
        
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

      await AsyncStorage.multiRemove([LAST_BACKGROUND_TIME_KEY, LAST_INACTIVE_TIME_KEY]);
      
      setSplashStatus('Initialisation du chiffrement…');
      await initSodiumZeroize();
      precomputePoW();

      setSplashStatus('Chargement de vos conversations…');
      await getOrCreateDeviceState();
      await sessionService.initialize();

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
      await initSodiumZeroize();
      precomputePoW();

      setSplashStatus('Création de vos clés post-quantiques…');
      await sessionService.initialize();
      
      const locked = await isLockEnabled();
      setLockEnabled(locked);
      
      if (locked) {
        const settings = await getLockSettings();
        setLockTimeout(settings.timeoutMinutes);
        setIsLocked(true);
      } else {
        await getOrCreateDeviceState();
        
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