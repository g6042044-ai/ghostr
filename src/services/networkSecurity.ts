// src/services/networkSecurity.ts
// Certificate Pinning pour Supabase et Workers
// Version 4.0 - react-native-ssl-public-key-pinning (transparent)
//
// POURQUOI CE CHANGEMENT (v3 → v4):
//   L'ancienne librairie (react-native-ssl-pinning) remplaçait fetch par son
//   propre fetch avec une API incompatible (pas de .json(), crash natif
//   sur les options inconnues comme signal/credentials). Impossible de l'utiliser
//   comme drop-in pour Supabase.
//
//   La nouvelle librairie (react-native-ssl-public-key-pinning) intercepte 
//   TOUTES les requêtes au niveau natif (OkHttp/TrustKit). Aucun remplacement
//   de fetch nécessaire. Supabase, WebRTC, tout est pinné automatiquement.
//
// INSTALLATION:
//   npm uninstall react-native-ssl-pinning
//   npm install react-native-ssl-public-key-pinning
//   npx expo prebuild
//   eas build --platform all
//
// IMPORTANT iOS: Il faut minimum 2 pins par domaine sur iOS (TrustKit l'exige).

// ============================================
// CONFIGURATION DES PINS
// ============================================

/**
 * INSTRUCTIONS POUR OBTENIR LES PINS:
 * 
 *   echo | openssl s_client -servername DOMAIN -connect DOMAIN:443 2>/dev/null | \
 *     openssl x509 -pubkey -noout | \
 *     openssl pkey -pubin -outform DER | \
 *     openssl dgst -sha256 -binary | openssl enc -base64
 * 
 * IMPORTANT: Sur iOS, TrustKit exige AU MINIMUM 2 pins par domaine
 * (un principal + un backup). Un seul pin = crash sur iOS.
 */

interface DomainPinConfig {
  includeSubdomains: boolean;
  publicKeyHashes: string[];
}

// Configuration de pinning par domaine
// Chaque domaine doit avoir au moins 2 pins (exigence iOS/TrustKit)
const PIN_CONFIG: Record<string, DomainPinConfig> = {
  // ============================================
  // SUPABASE - Base de données et API
  // ============================================
  'supabase.co': {
    includeSubdomains: true,
    publicKeyHashes: [
      // Pin principal (certificat leaf) - enshmhxaqwxfehtccjlu.supabase.co
      // Généré le: 2026-01-07
      'p/0tEtQuS5nc34qL4c1JS+XqKizBjtowkWbF6Mw0t9A=',
      // Pin intermédiaire (CA) - plus stable lors des rotations
      'kIdp6NNEd8wsugYyyIYFsi1ylMCED3hZbSR8ZFsa/A4=',
    ],
  },

  // ============================================
  // CLOUDFLARE WORKERS - Relay et SFU
  // ============================================
  'ghostcrypt.workers.dev': {
    includeSubdomains: true,
    publicKeyHashes: [
      // Pin principal (certificat leaf) - whisper-relay & whisper-sfu
      // Généré le: 2026-01-07
      'kRN6ODByI5Gr0Bcb6acvRyt7lp7bnBfm1wSuYbWpHQg=',
      // Pin intermédiaire (CA)
      'kIdp6NNEd8wsugYyyIYFsi1ylMCED3hZbSR8ZFsa/A4=',
    ],
  },

  // ============================================
  // GOOGLE CLOUD RUN - OHTTP Gateway (safety net)
  // Le client ne devrait JAMAIS contacter ce domaine directement.
  // Ce pin existe uniquement pour bloquer un MITM si un bug réintroduit
  // un fetch direct vers le gateway.
  // ============================================
  'run.app': {
    includeSubdomains: true,
    publicKeyHashes: [
      // Pin principal (certificat leaf) — ghostr-gateway-831985391959.europe-north1.run.app
      // Généré le: 2026-02-15
      'gbRz7/jJWiZ2vOp3ZeHMdw5NiFgcFUnGqLeRY4m6Nmg=',
      // Pin intermédiaire (GTS CA) — vérifié le 2026-02-15
      'YPtHaftLw6/0vnc2BnNKGF54xiCA28WFcccjkA4ypCM=',
    ],
  },
};

// ============================================
// ÉTAT DU MODULE
// ============================================

let pinningInitialized = false;
let pinningAvailable = false;
let pinningError: string | null = null;

// ============================================
// INITIALISATION (appeler au démarrage dans App.tsx)
// ============================================

export interface PinningStatus {
  active: boolean;
  reason: string;
  domains: string[];
}

/**
 * Initialise le certificate pinning au niveau natif.
 * Doit être appelé le plus tôt possible dans App.tsx.
 * 
 * Après cet appel, TOUTES les requêtes fetch/XMLHttpRequest
 * sont automatiquement pinnées — pas besoin de custom fetch.
 */
export async function initializePinning(): Promise<PinningStatus> {
  if (pinningInitialized) {
    return {
      active: pinningAvailable,
      reason: pinningAvailable ? 'already_initialized' : (pinningError || 'unavailable'),
      domains: pinningAvailable ? Object.keys(PIN_CONFIG) : [],
    };
  }

  try {
    const {
      initializeSslPinning,
      isSslPinningAvailable,
    } = require('react-native-ssl-public-key-pinning');

    // Vérifier que le module natif est disponible
    if (!isSslPinningAvailable()) {
      __DEV__ && console.warn('⚠️ SSL pinning native module not available');
      pinningAvailable = false;
      pinningInitialized = true;
      pinningError = 'native_module_unavailable';
      return { active: false, reason: 'native_module_unavailable', domains: [] };
    }

    // Initialiser le pinning — à partir de cet appel, TOUTES les
    // requêtes réseau sont vérifiées contre les pins configurés
    await initializeSslPinning(PIN_CONFIG);

    pinningAvailable = true;
    pinningInitialized = true;
    const domains = Object.keys(PIN_CONFIG);
    __DEV__ && console.log('✅ Certificate pinning initialized for:', domains.join(', '));
    return { active: true, reason: 'initialized', domains };

  } catch (error: any) {
    pinningAvailable = false;
    pinningInitialized = true;
    pinningError = error.message;

    if (__DEV__) {
      __DEV__ && console.warn(
        '⚠️ Certificate pinning not available (normal in Expo Go).\n' +
        'For production: npm install react-native-ssl-public-key-pinning && npx expo prebuild'
      );
    } else {
      __DEV__ && console.error('🚨 Certificate pinning failed to initialize:', error.message);
    }

    return { active: false, reason: error.message, domains: [] };
  }
}

/**
 * Désactive le pinning (utile pour le debug).
 */
export async function disablePinning(): Promise<void> {
  try {
    const { disableSslPinning } = require('react-native-ssl-public-key-pinning');
    await disableSslPinning();
    pinningAvailable = false;
    __DEV__ && console.log('⚠️ Certificate pinning disabled');
  } catch {
    // Module pas disponible, rien à faire
  }
}

// ============================================
// ÉTAT ET VÉRIFICATION
// ============================================

/**
 * Vérifie si le pinning est initialisé et actif.
 */
export function isPinningAvailable(): boolean {
  return pinningAvailable;
}

/**
 * Vérifie l'état du pinning au démarrage.
 * Retourne un message d'avertissement si problème, ou null si OK.
 */
export function verifyPinningOrWarn(): string | null {
  if (__DEV__) {
    if (!pinningAvailable) {
      __DEV__ && console.warn('⚠️ Certificate pinning not available (dev mode - OK)');
    }
    return null;
  }

  if (!pinningAvailable) {
    return (
      'Le certificate pinning n\'est pas actif. ' +
      (pinningError ? `Raison: ${pinningError}. ` : '') +
      'Veuillez mettre à jour l\'application.'
    );
  }

  return null;
}

/**
 * Écoute les erreurs de pinning (pin mismatch).
 * Utile pour logger les tentatives MITM.
 */
export function listenForPinningErrors(
  callback: (error: { serverHostname: string }) => void
): (() => void) | null {
  try {
    const { addSslPinningErrorListener } = require('react-native-ssl-public-key-pinning');
    const subscription = addSslPinningErrorListener(callback);
    return () => subscription.remove();
  } catch {
    return null;
  }
}

// ============================================
// FIX 0.5: PINNING OBLIGATOIRE EN PRODUCTION
// ============================================

/**
 * Vérifie que le cert pinning est actif. Lève une erreur fatale en production si non.
 * En développement (Expo Go), retourne false sans bloquer.
 * 
 * À appeler au démarrage de chaque opération réseau critique (sendInnerPayload, etc.)
 */
export function requirePinningOrThrow(): boolean {
  if (pinningAvailable) {
    return true;
  }
  
  if (__DEV__) {
    // En dev (Expo Go), le pinning n'est pas disponible — non bloquant
    return false;
  }
  
  // PRODUCTION: Le pinning DOIT être actif
  throw new Error(
    '[SECURITY] Certificate pinning is not active. ' +
    'The app cannot securely communicate with servers. ' +
    (pinningError ? `Reason: ${pinningError}` : 'Please update the app.')
  );
}