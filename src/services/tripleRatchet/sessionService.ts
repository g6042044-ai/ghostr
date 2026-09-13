// src/services/tripleRatchet/sessionService.ts
// Service de Session avec Triple Ratchet + Protection Post-Quantique
// Version 2.0 - Post-Quantum
//
// DIFFÉRENCES vs V1:
// - Utilise PQXDH au lieu de X3DH (résistance post-quantique)
// - Utilise Triple Ratchet au lieu de Double Ratchet (SPQR inclus)
// - Padding automatique des messages
// - Rétrocompatible avec les sessions V1 (lecture seule)
//
// Ce service gère le cycle de vie complet d'une session sécurisée PQ:
// - Génération et stockage des clés d'identité + PQ
// - Création d'invitations (QR code / clé manuelle)
// - Acceptation d'invitations et établissement de session PQXDH
// - Chiffrement/déchiffrement via Triple Ratchet
// - Persistance de l'état

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18n from '../../i18n';

import { IdentityKeyPair, SignedPreKey, OneTimePreKey, Ed25519PublicKey } from './types';

import { generateIdentityKeyPair, generateSignedPreKey, generateOneTimePreKeys, serializePublicKey, deserializeEd25519PublicKey, deserializeX25519PublicKey, bytesToHex, hexToBytes, encodeBase64, decodeBase64, zeroize, getSecureRandomBytes } from './primitives';

// PQXDH imports
import { PQSignedKey, PQXDHInitialMessage, generatePQSignedKey, createPQPreKeyBundle, serializePQPreKeyBundle, deserializePQPreKeyBundle, pqxdhInitiator, pqxdhResponder, validatePQPreKeyBundle, serializePQXDHMessage, deserializePQXDHMessage } from './pqxdh';

// Triple Ratchet imports
import { TripleRatchetState, TripleRatchetMessage, TripleRatchetConfig, initializeTripleRatchetInitiator, initializeTripleRatchetResponder, tripleRatchetEncrypt, tripleRatchetDecrypt, serializeTripleRatchetState, deserializeTripleRatchetState, cleanupTripleRatchetState, SerializedTripleRatchetState } from './tripleRatchet';

import { DEFAULT_SPQR_CONFIG } from './spqr';

// ACTION 01 (CRITIQUE-04): Key Transparency — safety numbers + key pinning
import { verifyAndPinKey, computeSafetyNumber, markKeyAsVerified as markKeyAsVerifiedKT, getKeyVerificationStatus as getKeyVerificationStatusKT, KeyVerificationResult, KeyChangeAction } from '../keyTransparency';

// P0: Key Transparency — Merkle tree verification
import { registerMyKey, verifyKeyInTransparencyLog, isMyKeyRegistered, KTVerificationResult } from '../keyTransparencyMerkle';

// FIX: Import statique au lieu de dynamic import() dans createInvite/acceptInvite.
// Les dynamic imports causent le re-bundling Metro en dev mode (500ms+ par module).
import { secureRpc } from '../relayTransport';
import { createSealedSenderEnvelope, isSealedSenderReady } from '../sealedSender';
// R-02: Compteur monotone pour prévenir la réutilisation de nonce après rollback d'état
import { verifySendCounter, updateSendCounter, deleteSendCounter } from './monotonicCounter';

// Static imports for modules previously loaded via dynamic import() on the init path.
// Each dynamic import() triggered Metro lazy-bundling (~300-600ms each, 5-6 on init path = 2-3s wasted).
// With static imports, these modules are bundled upfront and resolve instantly.
import { isEncryptionEnabled as localCryptoIsEnabled, encrypt as localCryptoEncrypt, decryptIfNeeded as localCryptoDecrypt, setEncryptionKey as localCryptoSetKey, generateEncryptionKey as localCryptoGenKey, isEncrypted as localCryptoIsEncrypted, tryRecoverFromPreFixBug, hasAnyEncryptionKey as localCryptoHasAnyKey } from '../localCrypto';
import { getGlobalDisplayName, getGlobalAvatar, setGlobalDisplayName, setGlobalAvatar, registerLockHook } from '../storage';
import { pendingInviteStore } from '../pendingInvites';

// ============================================
// CONSTANTES DE STOCKAGE V2
// ============================================

const STORAGE_KEYS = {
  // Clés d'identité
  IDENTITY_KEY_PAIR: 'ghostr_pq_identity_key_pair',
  
  // PreKeys classiques
  SIGNED_PRE_KEY: 'ghostr_pq_signed_pre_key',
  ONE_TIME_PRE_KEYS: 'ghostr_pq_one_time_pre_keys',
  NEXT_PRE_KEY_ID: 'ghostr_pq_next_pre_key_id',
  
  // PreKeys Post-Quantiques
  PQ_SIGNED_KEY: 'ghostr_pq_pq_signed_key',
  NEXT_PQ_KEY_ID: 'ghostr_pq_next_pq_key_id',
  
  // v25.0: Anciennes clés (pour les messages asynchrones)
  OLD_SIGNED_PRE_KEYS: 'ghostr_pq_old_signed_pre_keys',
  OLD_PQ_SIGNED_KEYS: 'ghostr_pq_old_pq_signed_keys',
  
  // Sessions
  SESSIONS: 'ghostr_pq_sessions_index',
  SESSION_PREFIX: 'ghostr_pq_session_',
  
  // Profil
  MY_PROFILE: 'ghostr_pq_my_profile',
} as const;

// ============================================
// OPTION 3: Détection "PIN jamais défini" vs "PIN défini mais clé absente"
// ============================================
// Cache pour éviter de lire SecureStore à chaque opération
let _lockConfiguredCache: boolean | null = null;

// P2 FIX: Clé de chiffrement device-level — chiffre les sessions même sans PIN.
// Stockée dans SecureStore (Keychain iOS / Keystore Android) = inaccessible
// sans biométrie ou déverrouillage device. Si l'utilisateur active un PIN,
// la clé PIN prend le relais automatiquement via setEncryptionKeyAndRotate().
const DEVICE_ENCRYPTION_KEY = 'ghostr_device_encryption_key_v1';

/**
 * P2 FIX: Garantit qu'une clé de chiffrement est TOUJOURS active.
 * 
 * Priorité : PIN > device-level key.
 * Si aucun PIN n'est configuré, génère une clé aléatoire 256 bits
 * et la stocke dans SecureStore (hardware-backed sur iOS/Android).
 * 
 * Résultat : les sessions Triple Ratchet ne sont JAMAIS stockées en clair
 * dans AsyncStorage, même au premier lancement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * INVARIANT CRITIQUE — COUPLAGE AVEC localCrypto.transitionPinToHardware
 * ════════════════════════════════════════════════════════════════════════════
 * Cette fonction et `localCrypto.transitionPinToHardware` DOIVENT lire/écrire
 * la MÊME clé sous la MÊME entrée SecureStore (DEVICE_ENCRYPTION_KEY =
 * 'ghostr_device_encryption_key_v1'). Si elles divergent, le scénario
 * "active PIN → désactive PIN → relance app" rend toutes les données
 * AsyncStorage illisibles (clé re-chiffrement ≠ clé chargée au boot).
 *
 * En particulier, NE PAS modifier ici sans vérifier l'autre côté :
 *   - Nom de la clé SecureStore
 *   - Options keychainAccessible (doivent matcher)
 *   - Format de la valeur (Base64 d'un Uint8Array de 32 bytes)
 * ════════════════════════════════════════════════════════════════════════════
 */
async function ensureDeviceLevelEncryption(): Promise<void> {
  // Static imports used (no dynamic import latency)
  
  // Si le PIN est déjà actif, rien à faire
  if (localCryptoIsEnabled()) {
    __DEV__ && console.log('[SessionService] 🔐 PIN encryption active');
    return;
  }
  
  // Si un PIN a été configuré mais la clé n'est pas en mémoire,
  // on ne peut pas générer de clé device — il faut le PIN
  if (await wasLockEverConfigured()) {
    __DEV__ && console.log('[SessionService] 🔒 PIN was configured — waiting for unlock');
    return;
  }
  
  // Pas de PIN configuré : utiliser/générer une clé device-level
  try {
    let deviceKeyB64 = await SecureStore.getItemAsync(DEVICE_ENCRYPTION_KEY);
    
    if (!deviceKeyB64) {
      // ──────────────────────────────────────────────────────────────────────
      // RÉCUPÉRATION POST-BUG (mai 2026)
      // ──────────────────────────────────────────────────────────────────────
      // Avant de générer un nouveau deviceKey, vérifier si l'utilisateur est
      // affecté par l'ancien bug de transitionPinToHardware (re-chiffrement
      // vers hwKey sans création de DEVICE_ENCRYPTION_KEY). Si les données
      // AsyncStorage existantes sont déchiffrables avec la hardwareKey
      // (déjà chargée par initHardwareEncryptionAll), on l'adopte comme
      // deviceKey pour préserver l'accès aux données.
      //
      // Si la récupération réussit, encryptionKey est déjà set et la clé est
      // persistée — on peut return tout de suite.
      // Si elle échoue (fresh install ou autre cas), on tombe sur la
      // génération normale ci-dessous.
      // ──────────────────────────────────────────────────────────────────────
      try {
        const recovered = await tryRecoverFromPreFixBug();
        if (recovered) {
          __DEV__ && console.log('[SessionService] 🔧 Recovered from pre-fix bug — adopted hardwareKey');
          return;
        }
      } catch (e) {
        __DEV__ && console.warn('[SessionService] Recovery attempt failed (non-fatal):', e);
      }

      // Première utilisation : générer et stocker
      const deviceKey = localCryptoGenKey(); // 32 bytes random
      deviceKeyB64 = encodeBase64(deviceKey);
      await SecureStore.setItemAsync(DEVICE_ENCRYPTION_KEY, deviceKeyB64, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      __DEV__ && console.log('[SessionService] 🔐 Generated new device-level encryption key');
    } else {
      __DEV__ && console.log('[SessionService] 🔐 Loaded existing device-level encryption key');
    }
    
    // Activer le chiffrement avec cette clé
    localCryptoSetKey(deviceKeyB64);
    
  } catch (error) {
    // SecureStore indisponible (ex: émulateur sans Keystore)
    // Fallback : générer une clé volatile (perdue au redémarrage,
    // mais au moins les données sur disque sont chiffrées pendant la session)
    __DEV__ && console.warn('[SessionService] ⚠️ SecureStore unavailable, using volatile encryption key:', error);
    const volatileKey = localCryptoGenKey();
    localCryptoSetKey(volatileKey);
  }
}

/**
 * Vérifie si le PIN/verrou a DÉJÀ été configuré.
 * - Si oui ET que localCryptoIsEnabled() est false → la clé a été perdue = DANGER
 * - Si non → l'utilisateur n'a jamais défini de PIN = acceptable de stocker en clair
 */
async function wasLockEverConfigured(): Promise<boolean> {
  if (_lockConfiguredCache !== null) return _lockConfiguredCache;
  try {
    // whisper_lock_data_v6 est créé par setupLock() dans appLock.ts
    const lockData = await SecureStore.getItemAsync('whisper_lock_data_v6');
    _lockConfiguredCache = lockData !== null;
    return _lockConfiguredCache;
  } catch {
    return false;
  }
}

/** Reset le cache (appelé quand le PIN est activé pour la première fois) */
export function resetLockConfiguredCache(): void {
  _lockConfiguredCache = null;
}

// ============================================
// TYPES V2
// ============================================

/**
 * Profil utilisateur local
 */
export interface UserProfile {
  displayName: string;
  avatarEmoji?: string;
  avatarColor?: string;
  avatarBase64?: string;
}

/**
 * Session V2 avec Triple Ratchet
 */
export interface StoredSession {
  // Version de la session
  version: 2;
  
  // ID unique
  id: string;
  
  // Identités
  myIdentityKeyFingerprint: string;
  theirIdentityKey: string; // Base64
  theirIdentityKeyFingerprint: string;
  
  // Profil du contact
  theirProfile: UserProfile;
  
  // État Triple Ratchet (sérialisé JSON)
  tripleRatchetState: SerializedTripleRatchetState;
  
  // Métadonnées
  createdAt: number;
  lastActivityAt: number;
  isInitiator: boolean;
  
  // Statistiques
  messagesSent: number;
  messagesReceived: number;
  
  // Tag pour le transport (anonymat serveur)
  tag?: string;
  
  // Flag PQ
  isPostQuantum: true;
  
  // v19.0: userId original (pour sessions créées via PQXDH bundle)
  // Permet de retrouver la session via findSessionByAnyId
  originalUserId?: string;
  
  // ACTION-06 (Phase 2 Security): Key Transparency verification status.
  // Stored at session creation so the UI can display warnings.
  // 'verified' = key in log + valid proof + consistent STH
  // 'not_in_log' = key not found (new contact, may be normal)
  // 'invalid_proof' = proof failed verification (CRITICAL: possible MITM)
  // 'sth_inconsistent' = tree may have been rewritten (CRITICAL)
  // 'error' = verification failed due to network/gateway issue
  ktStatus?: 'verified' | 'not_in_log' | 'invalid_proof' | 'sth_inconsistent' | 'error';
}

/**
 * ACTION 01 (CRITIQUE-04): Événement de changement de clé d'identité
 * Émis quand la clé d'un contact change (potentiel MITM).
 */
export interface KeyChangeEvent {
  /** ID de session concernée */
  sessionId: string;
  /** Nom du contact */
  contactName: string;
  /** Action détectée: 'new' (première fois), 'unchanged', 'changed' (alerte!) */
  action: KeyChangeAction;
  /** true si la clé précédente était vérifiée manuellement → alerte critique */
  wasVerified: boolean;
  /** Fingerprint de la nouvelle clé */
  fingerprint: string;
}

/**
 * Données d'invitation V2 pour QR code
 */
export interface InviteData {
  version: 2;
  type: 'ghostr_invite_pq';
  
  // PQ PreKey Bundle (JSON sérialisé)
  bundle: string;
  
  // Profil du créateur
  profile: UserProfile;
  
  // Métadonnées
  createdAt: number;
  expiresAt?: number;
  
  // Tag pour le transport
  tag?: string;
}

/**
 * Réponse à une invitation V2
 */
export interface InviteResponse {
  version: 2;
  type: 'ghostr_accept_pq';
  
  // Message PQXDH initial (JSON sérialisé)
  pqxdhMessage: string;
  
  // Profil de l'acceptant
  profile: UserProfile;
  
  // Tag
  tag?: string;
}

/**
 * Résultat de création d'invitation
 */
export interface CreateInviteResult {
  inviteData: InviteData;
  inviteString: string;
  inviteCode: string;
  keyIds: {
    signedPreKeyId: number;
    pqSignedKeyId: number;
    oneTimePreKeyId?: number;
  };
}

/**
 * Résultat d'acceptation d'invitation
 */
export interface AcceptInviteResult {
  session: StoredSession;
  responseData: InviteResponse;
  responseString: string;
}

/**
 * Résultat de finalisation de session
 */
export interface FinalizeSessionResult {
  session: StoredSession;
}

/**
 * Message chiffré V2 (Triple Ratchet)
 */
export interface EncryptedMessage {
  version: 2;
  message: TripleRatchetMessage;
  timestamp: number;
}

// ============================================
// SESSION SERVICE V2
// ============================================

export class SessionService {
  private initialized = false;
  
  // Clés d'identité
  private identityKeyPair: IdentityKeyPair | null = null;
  
  // PreKeys classiques
  private signedPreKey: SignedPreKey | null = null;
  private oneTimePreKeys: Map<number, OneTimePreKey> = new Map();
  private nextPreKeyId = 1;
  
  // PreKeys Post-Quantiques
  private pqSignedKey: PQSignedKey | null = null;
  private nextPQKeyId = 1;
  
  // v25.0: Anciennes clés (conservées pour les messages asynchrones)
  // Les anciennes clés sont gardées pendant OLD_KEY_RETENTION_DAYS jours
  private oldSignedPreKeys: Map<number, { key: SignedPreKey; savedAt: number }> = new Map();
  private oldPQSignedKeys: Map<number, { key: PQSignedKey; savedAt: number }> = new Map();
  private static readonly OLD_KEY_RETENTION_DAYS = 60; // Garder 60 jours
  private static readonly MAX_OLD_KEYS = 10; // Maximum d'anciennes clés
  
  // Sessions actives (en mémoire)
  private sessions: Map<string, StoredSession> = new Map();
  private ratchetStates: Map<string, TripleRatchetState> = new Map();
  
  // Mutex par session: empêche les opérations crypto concurrentes qui
  // corrompent l'état du ratchet (batch poll + session poll en parallèle,
  // ou encrypt + decrypt simultanés). Sans ce verrou, deux opérations
  // lisent le même état S0, avancent chacune indépendamment, et la
  // dernière à sauvegarder écrase les changements de l'autre.
  private cryptoLocks: Map<string, Promise<any>> = new Map();
  
  // [Bug #1] OTPKs réservées par des invitations en attente
  // Les OTPKs restent dans le pool (nécessaire pour pqxdhResponder)
  // mais sont marquées pour que les nouvelles invitations les ignorent.
  // Reconstruit depuis pendingInviteStore au démarrage.
  private reservedOtpkIds: Set<number> = new Set();
  
  // Profil local
  private myProfile: UserProfile = { displayName: 'Anonymous' };
  
  // v6.1: Listeners pour les changements de profil
  private profileChangeListeners: Set<(profile: UserProfile) => void> = new Set();
  
  // ACTION 01 (CRITIQUE-04): Listeners pour les alertes de changement de clé d'identité
  // L'UI doit s'abonner pour afficher une alerte quand la clé d'un contact change
  // (potentiel MITM si la clé était vérifiée manuellement).
  private keyChangeListeners: Set<(event: KeyChangeEvent) => void> = new Set();
  
  // Configuration Triple Ratchet
  private config: Partial<TripleRatchetConfig> = {
    spqr: DEFAULT_SPQR_CONFIG,
    paddingSize: 'medium',
  };
  
  // ==========================================
  // INITIALISATION
  // ==========================================
  
  /**
   * Initialise le service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    const t0 = Date.now();
    const ts = (label: string) => __DEV__ && console.log(`[SessionService] ⏱️ ${label}: ${Date.now() - t0}ms`);
    
    // P2 FIX: Garantir qu'une clé de chiffrement est active AVANT de lire/écrire
    // quoi que ce soit. Sans ça, les sessions étaient stockées en clair.
    await ensureDeviceLevelEncryption();
    ts('ensureDeviceLevelEncryption');
    
    // Charger ou générer les clés d'identité (required before PreKeys/PQKeys)
    await this.loadOrCreateIdentityKeys();
    ts('loadOrCreateIdentityKeys');
    
    // PARALLELIZATION: Steps 3-7 are independent — run concurrently.
    // Before: sequential (~20s). After: parallel (~max of any single step, ~9s)
    await Promise.all([
      this.loadPreKeys().then(() => ts('loadPreKeys')),
      this.loadPQKeys().then(() => ts('loadPQKeys')),
      this.loadOldKeys().then(() => ts('loadOldKeys')),
      this.loadProfile().then(() => ts('loadProfile')),
      this.loadSessionsIndex().then(() => ts('loadSessionsIndex')),
    ]);
    
    __DEV__ && console.log(`[SessionService] ⏱️ TOTAL initialize: ${Date.now() - t0}ms`);
    this.initialized = true;
    
    // Defer OTPK reservation rebuild to background (non-critical, after sealed sender + PoW)
    setTimeout(() => {
      this.rebuildOtpkReservations().then(() => {
        ts('rebuildOtpkReservations (deferred)');
      }).catch(() => {});
    }, 15000);
    // NOTE: KT registration is now called explicitly from App.tsx
    // AFTER sealed sender is confirmed ready. This prevents the race condition
    // where KT tried to register before the relay was available.
  }

  /**
   * P0: Register my identity key in the Key Transparency Merkle tree.
   * Idempotent — if already registered, this is a no-op.
   * 
   * IMPORTANT: Doit être appelé APRÈS que le sealed sender est confirmé actif.
   * App.tsx appelle cette méthode après waitForSealedSender() === true.
   */
  async registerKeyInTransparencyLog(): Promise<void> {
    if (!this.identityKeyPair) return;

    // Check if already registered locally
    const alreadyRegistered = await isMyKeyRegistered();
    if (alreadyRegistered) {
      __DEV__ && console.log('[SessionService] 🌳 KT: Key already registered in transparency log');
      return;
    }

    // Sealed sender doit être prêt (garanti par App.tsx, mais vérification défensive)
    if (!isSealedSenderReady()) {
      throw new Error('Sealed sender not ready — KT registration requires active sealed sender');
    }

    const myKeyB64 = serializePublicKey(this.identityKeyPair.publicKey);
    const result = await registerMyKey(myKeyB64);

    if (result) {
      __DEV__ && console.log(`[SessionService] 🌳 KT: Identity key registered at index #${result.index} (tree size: ${result.treeSize})`);
    } else {
      __DEV__ && console.warn('[SessionService] 🌳 KT: Registration failed — will retry on next session creation');
    }
  }
  
  /**
   * [Bug #1] Reconstruit reservedOtpkIds depuis les invitations pendantes
   * Appelé au démarrage pour restaurer l'état des réservations.
   */
  private async rebuildOtpkReservations(): Promise<void> {
    try {
      // Static import used
      await pendingInviteStore.load();
      const pending = pendingInviteStore.getPending();
      this.reservedOtpkIds.clear();
      for (const inv of pending) {
        if (inv.oneTimePreKeyId !== undefined && this.oneTimePreKeys.has(inv.oneTimePreKeyId)) {
          this.reservedOtpkIds.add(inv.oneTimePreKeyId);
        }
      }
      if (this.reservedOtpkIds.size > 0) {
        __DEV__ && console.log(`[SessionService] 🔑 Rebuilt ${this.reservedOtpkIds.size} OTPK reservation(s) from pending invites`);
      }
    } catch (e) {
      __DEV__ && console.warn('[SessionService] Could not rebuild OTPK reservations:', e);
    }
  }
  
  /**
   * [Bug #1] Libère la réservation d'une OTPK (quand l'invitation expire ou est supprimée)
   */
  unreserveOtpk(otpkId: number | undefined): void {
    if (otpkId !== undefined && this.reservedOtpkIds.delete(otpkId)) {
      __DEV__ && console.log(`[SessionService] 🔑 OTPK #${otpkId} unreserved (${this.reservedOtpkIds.size} remaining)`);
    }
  }
  
  /**
   * Vérifie que le service est initialisé
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SessionService not initialized. Call initialize() first.');
    }
  }
  
  // ==========================================
  // GESTION DES CLÉS D'IDENTITÉ
  // ==========================================
  
  /**
   * Charge ou crée les clés d'identité
   */
  private async loadOrCreateIdentityKeys(): Promise<void> {
    try {
      const stored = await SecureStore.getItemAsync(STORAGE_KEYS.IDENTITY_KEY_PAIR);
      
      if (stored) {
        const data = JSON.parse(stored);
        this.identityKeyPair = {
          publicKey: deserializeEd25519PublicKey(data.publicKey),
          privateKey: {
            _brand: 'Ed25519PrivateKey' as const,
            bytes: decodeBase64(data.privateKey),
          },
          dhPublicKey: deserializeX25519PublicKey(data.dhPublicKey),
          dhPrivateKey: {
            _brand: 'X25519PrivateKey' as const,
            bytes: decodeBase64(data.dhPrivateKey),
          },
        };
      } else {
        this.identityKeyPair = generateIdentityKeyPair();
        await this.saveIdentityKeys();
      }
    } catch (error) {
      __DEV__ && console.error('[SessionService] Error loading identity keys:', error);
      this.identityKeyPair = generateIdentityKeyPair();
      await this.saveIdentityKeys();
    }
  }
  
  /**
   * Sauvegarde les clés d'identité
   */
  private async saveIdentityKeys(): Promise<void> {
    if (!this.identityKeyPair) return;
    
    const data = {
      publicKey: serializePublicKey(this.identityKeyPair.publicKey),
      privateKey: encodeBase64(this.identityKeyPair.privateKey.bytes),
      dhPublicKey: serializePublicKey(this.identityKeyPair.dhPublicKey),
      dhPrivateKey: encodeBase64(this.identityKeyPair.dhPrivateKey.bytes),
    };
    
    await SecureStore.setItemAsync(
      STORAGE_KEYS.IDENTITY_KEY_PAIR,
      JSON.stringify(data)
    );
  }
  
  // ==========================================
  // GESTION DES PRE-KEYS CLASSIQUES
  // ==========================================
  
  /**
   * Charge les PreKeys
   */
  private async loadPreKeys(): Promise<void> {
    try {
      // Signed PreKey
      const signedStored = await SecureStore.getItemAsync(STORAGE_KEYS.SIGNED_PRE_KEY);
      if (signedStored) {
        const data = JSON.parse(signedStored);
        this.signedPreKey = {
          id: data.id,
          keyPair: {
            publicKey: deserializeX25519PublicKey(data.publicKey),
            privateKey: {
              _brand: 'X25519PrivateKey' as const,
              bytes: decodeBase64(data.privateKey),
            },
          },
          signature: {
            _brand: 'Ed25519Signature' as const,
            bytes: decodeBase64(data.signature),
          },
          timestamp: data.timestamp,
        };
      } else {
        await this.rotateSignedPreKey();
      }
      
      // One-Time PreKeys (AsyncStorage — 100 clés × ~130 bytes = ~13 KB)
      const otpkStored = await AsyncStorage.getItem(STORAGE_KEYS.ONE_TIME_PRE_KEYS);
      if (otpkStored) {
        let otpkJson: string;
        if (otpkStored.startsWith('enc1:')) {
          // Static import used (localCryptoDecrypt)
          otpkJson = localCryptoDecrypt(otpkStored);
        } else if (await wasLockEverConfigured()) {
          __DEV__ && console.error('[SessionService] ❌ REJECTED unencrypted OTPK data (PIN was configured) — wiping');
          await AsyncStorage.removeItem(STORAGE_KEYS.ONE_TIME_PRE_KEYS);
          otpkJson = '[]';
        } else {
          // PIN never set → plaintext is expected
          otpkJson = otpkStored;
        }
        const data = JSON.parse(otpkJson);
        for (const item of data) {
          this.oneTimePreKeys.set(item.id, {
            id: item.id,
            keyPair: {
              publicKey: deserializeX25519PublicKey(item.publicKey),
              privateKey: {
                _brand: 'X25519PrivateKey' as const,
                bytes: decodeBase64(item.privateKey),
              },
            },
          });
        }
      }
      
      // Next ID
      const nextIdStored = await AsyncStorage.getItem(STORAGE_KEYS.NEXT_PRE_KEY_ID);
      if (nextIdStored) {
        this.nextPreKeyId = parseInt(nextIdStored, 10);
      }
      
      // ════════════════════════════════════════════════════════════════════
      // PATCH 7 — REPLENISHMENT INTELLIGENT EN ARRIÈRE-PLAN
      // ════════════════════════════════════════════════════════════════════
      // Avant : `if (size < 50) await replenish()` bloquait toujours l'init
      // pour générer 50+ paires X25519 (200-600 ms de JS bloqué) même quand
      // le stock n'était pas critique.
      //
      // Maintenant, on tient compte de l'urgence :
      //   • size === 0 (cold start absolu) : `replenishOneTimePreKeys` gère
      //     déjà ce cas en générant 10 paires synchrone + schedulant 90
      //     en background à T+30s. Garde ce comportement.
      //   • size < 10 : stock critique. On bloque pour remonter à 100, sinon
      //     l'utilisateur risque de ne plus pouvoir recevoir d'invitation
      //     post-quantique le temps que le replenish termine.
      //   • 10 <= size < 50 : stock dégradé mais opérationnel. On défère le
      //     replenish à T+5s (UI déjà interactive) en fire-and-forget.
      //
      // SÉCURITÉ : aucun impact. Les OTPK ne sont consommées qu'à la
      // réception d'une invitation entrante. Tant qu'il en reste >0, la
      // sécurité du PQXDH initial est intacte. Le replenishment background
      // remet le stock avant qu'il atteigne 0 dans tous les cas réalistes.
      // ════════════════════════════════════════════════════════════════════
      const otpkSize = this.oneTimePreKeys.size;
      if (otpkSize < 10) {
        // Stock critique (ou cold start absolu) → blocage nécessaire
        await this.replenishOneTimePreKeys();
      } else if (otpkSize < 50) {
        // Stock dégradé non critique → defer pour ne pas bloquer init
        setTimeout(() => {
          this.replenishOneTimePreKeys().catch(e =>
            __DEV__ && console.warn('[SessionService] Background replenish failed:', e)
          );
        }, 5000);
      }
      // size >= 50 : rien à faire
    } catch (error) {
      __DEV__ && console.error('[SessionService] Error loading PreKeys:', error);
      await this.rotateSignedPreKey();
      await this.replenishOneTimePreKeys();
    }
  }
  
  /**
   * Rotation de la Signed PreKey
   */
  private async rotateSignedPreKey(): Promise<void> {
    // v25.0: Archiver les clés actuelles avant rotation
    await this.archiveCurrentKeys();
    
    this.signedPreKey = generateSignedPreKey(this.identityKeyPair!, this.nextPreKeyId++);
    
    const data = {
      id: this.signedPreKey.id,
      publicKey: serializePublicKey(this.signedPreKey.keyPair.publicKey),
      privateKey: encodeBase64(this.signedPreKey.keyPair.privateKey.bytes),
      signature: encodeBase64(this.signedPreKey.signature.bytes),
      timestamp: this.signedPreKey.timestamp,
    };
    
    await SecureStore.setItemAsync(STORAGE_KEYS.SIGNED_PRE_KEY, JSON.stringify(data));
    await AsyncStorage.setItem(STORAGE_KEYS.NEXT_PRE_KEY_ID, this.nextPreKeyId.toString());
  }
  
  /**
   * Régénère les One-Time PreKeys
   */
  private async replenishOneTimePreKeys(): Promise<void> {
    // On first launch, generate only 10 OTPKs to avoid blocking init for 18+ seconds.
    // The remaining 90 are generated lazily via replenishOneTimePreKeysBackground().
    const isFirstLaunch = this.oneTimePreKeys.size === 0;
    const targetCount = isFirstLaunch ? 10 : 100;
    const currentCount = this.oneTimePreKeys.size;
    const toGenerate = targetCount - currentCount;
    
    if (toGenerate <= 0) return;
    
    const newKeys = await generateOneTimePreKeys(this.nextPreKeyId, toGenerate);
    for (const key of newKeys) {
      this.oneTimePreKeys.set(key.id, key);
    }
    this.nextPreKeyId += toGenerate;
    
    await this.saveOneTimePreKeys();
    await AsyncStorage.setItem(STORAGE_KEYS.NEXT_PRE_KEY_ID, this.nextPreKeyId.toString());
    
    // Schedule background replenishment AFTER sealed sender is ready
    // to avoid CPU contention with PoW computation.
    if (isFirstLaunch) {
      setTimeout(() => this.replenishOneTimePreKeysBackground(), 30000);
    }
  }
  
  /**
   * Background replenishment: generates remaining OTPKs after the app is responsive.
   * Called 5s after first launch to avoid blocking the UI.
   */
  private async replenishOneTimePreKeysBackground(): Promise<void> {
    const targetCount = 100;
    const currentCount = this.oneTimePreKeys.size;
    const toGenerate = targetCount - currentCount;
    
    if (toGenerate <= 0) return;
    
    __DEV__ && console.log(`[SessionService] 🔑 Background OTPK replenishment: generating ${toGenerate} keys...`);
    
    const newKeys = await generateOneTimePreKeys(this.nextPreKeyId, toGenerate);
    for (const key of newKeys) {
      this.oneTimePreKeys.set(key.id, key);
    }
    this.nextPreKeyId += toGenerate;
    
    await this.saveOneTimePreKeys();
    await AsyncStorage.setItem(STORAGE_KEYS.NEXT_PRE_KEY_ID, this.nextPreKeyId.toString());
    
    __DEV__ && console.log(`[SessionService] 🔑 Background OTPK replenishment complete: ${this.oneTimePreKeys.size} total`);
  }
  
  /**
   * Sauvegarde les One-Time PreKeys
   */
  private async saveOneTimePreKeys(): Promise<void> {
    const data = Array.from(this.oneTimePreKeys.values()).map(key => ({
      id: key.id,
      publicKey: serializePublicKey(key.keyPair.publicKey),
      privateKey: encodeBase64(key.keyPair.privateKey.bytes),
    }));
    
    // ACTION 07: Chiffrer les clés privées dans AsyncStorage
    const serialized = JSON.stringify(data);
    // Static import used
    const toStore = localCryptoIsEnabled() ? localCryptoEncrypt(serialized) : serialized;
    await AsyncStorage.setItem(STORAGE_KEYS.ONE_TIME_PRE_KEYS, toStore);
  }
  
  // ==========================================
  // GESTION DES CLÉS POST-QUANTIQUES
  // ==========================================
  
  /**
   * Charge les clés PQ
   */
  private async loadPQKeys(): Promise<void> {
    try {
      const pqStored = await AsyncStorage.getItem(STORAGE_KEYS.PQ_SIGNED_KEY);
      
      if (pqStored) {
        let pqJson: string;
        if (pqStored.startsWith('enc1:')) {
          // Static import used (localCryptoDecrypt)
          pqJson = localCryptoDecrypt(pqStored);
        } else if (await wasLockEverConfigured()) {
          __DEV__ && console.error('[SessionService] ❌ REJECTED unencrypted PQ key data (PIN was configured) — wiping');
          await AsyncStorage.removeItem(STORAGE_KEYS.PQ_SIGNED_KEY);
          await this.rotatePQSignedKey();
          return;
        } else {
          // PIN never set → plaintext is expected
          pqJson = pqStored;
        }
        const data = JSON.parse(pqJson);
        this.pqSignedKey = {
          id: data.id,
          keyPair: {
            publicKey: {
              _brand: 'KyberPublicKey',
              bytes: decodeBase64(data.publicKey),
            },
            secretKey: {
              _brand: 'KyberSecretKey',
              bytes: decodeBase64(data.secretKey),
            },
          },
          signature: {
            _brand: 'Ed25519Signature' as const,
            bytes: decodeBase64(data.signature),
          },
          timestamp: data.timestamp,
        };
      } else {
        await this.rotatePQSignedKey();
      }
      
      const nextPQIdStored = await AsyncStorage.getItem(STORAGE_KEYS.NEXT_PQ_KEY_ID);
      if (nextPQIdStored) {
        this.nextPQKeyId = parseInt(nextPQIdStored, 10);
      }
    } catch (error) {
      __DEV__ && console.error('[SessionService] Error loading PQ keys:', error);
      await this.rotatePQSignedKey();
    }
  }
  
  /**
   * Rotation de la PQ Signed Key
   */
  private async rotatePQSignedKey(): Promise<void> {
    // v25.0: Archiver les clés actuelles avant rotation
    await this.archiveCurrentKeys();
    
    this.pqSignedKey = generatePQSignedKey(this.identityKeyPair!, this.nextPQKeyId++);
    
    const data = {
      id: this.pqSignedKey.id,
      publicKey: encodeBase64(this.pqSignedKey.keyPair.publicKey.bytes),
      secretKey: encodeBase64(this.pqSignedKey.keyPair.secretKey.bytes),
      signature: encodeBase64(this.pqSignedKey.signature.bytes),
      timestamp: this.pqSignedKey.timestamp,
    };
    
    await AsyncStorage.setItem(STORAGE_KEYS.PQ_SIGNED_KEY, JSON.stringify(data));
    await AsyncStorage.setItem(STORAGE_KEYS.NEXT_PQ_KEY_ID, this.nextPQKeyId.toString());
    
    // ACTION 07: Re-chiffrer les clés PQ si le chiffrement local est disponible
    // Static import used
    if (localCryptoIsEnabled()) {
      const encrypted = localCryptoEncrypt(JSON.stringify(data));
      await AsyncStorage.setItem(STORAGE_KEYS.PQ_SIGNED_KEY, encrypted);
    }
  }
  
  // ==========================================
  // GESTION DU PROFIL
  // ==========================================
  
  /**
   * Charge le profil
   * v2.1: Synchronise automatiquement depuis le stockage global si nécessaire
   */
  private async loadProfile(): Promise<void> {
    try {
      // 1. D'abord essayer de charger depuis notre stockage
      const stored = await AsyncStorage.getItem(STORAGE_KEYS.MY_PROFILE);
      if (stored) {
        this.myProfile = JSON.parse(stored);
        __DEV__ && console.log('[SessionService] 📋 Profile loaded from session storage:');
        __DEV__ && console.log(`  - displayName: ${this.myProfile.displayName}`);
        __DEV__ && console.log(`  - avatarBase64: ${this.myProfile.avatarBase64 ? `SET (${this.myProfile.avatarBase64.length} chars)` : 'NOT SET'}`);
      } else {
        __DEV__ && console.log('[SessionService] 📋 No profile in session storage');
      }
      
      // 2. Vérifier si le stockage global a un profil plus récent/différent
      // Cela assure la synchronisation bidirectionnelle
      await this.syncFromGlobalStorageIfNeeded();
      
    } catch (error) {
      __DEV__ && console.error('[SessionService] Error loading profile:', error);
      // En cas d'erreur, essayer de récupérer depuis le stockage global
      await this.syncFromGlobalStorageIfNeeded();
    }
  }
  
  /**
   * Synchronise depuis le stockage global si notre profil est vide ou incomplet
   * Cela corrige les cas de désynchronisation entre les deux systèmes de stockage
   * 
   * v6.1: BUGFIX - Toujours synchroniser l'avatar même si displayName existe
   */
  private async syncFromGlobalStorageIfNeeded(): Promise<void> {
    try {
      // Static import used
      
      const globalDisplayName = await getGlobalDisplayName();
      const globalAvatar = await getGlobalAvatar();
      
      let needsSave = false;
      
      // Si on n'a pas de displayName local mais qu'il existe dans le stockage global
      if (!this.myProfile.displayName || this.myProfile.displayName === 'Anonymous') {
        if (globalDisplayName && globalDisplayName.trim().length > 0) {
          __DEV__ && console.log('[SessionService] Syncing displayName from global storage');
          this.myProfile.displayName = globalDisplayName;
          needsSave = true;
        }
      }
      // Si on a un displayName local mais pas global, synchroniser vers le global
      else if (this.myProfile.displayName && 
               this.myProfile.displayName !== 'Anonymous' && 
               (!globalDisplayName || globalDisplayName.trim().length === 0)) {
        __DEV__ && console.log('[SessionService] Syncing displayName TO global storage');
        // Static import used
        await setGlobalDisplayName(this.myProfile.displayName);
      }
      
      // v6.1: TOUJOURS synchroniser l'avatar depuis global s'il existe et diffère
      // C'est le fix du bug où l'avatar n'était pas envoyé dans les messages
      if (globalAvatar && globalAvatar !== this.myProfile.avatarBase64) {
        __DEV__ && console.log('[SessionService] 🖼️ Syncing avatar from global storage');
        __DEV__ && console.log(`  - globalAvatar: ${globalAvatar.slice(0, 50)}... (${globalAvatar.length} chars)`);
        __DEV__ && console.log(`  - local avatar was: ${this.myProfile.avatarBase64 ? 'SET' : 'NOT SET'}`);
        this.myProfile.avatarBase64 = globalAvatar;
        needsSave = true;
      } else if (!globalAvatar && this.myProfile.avatarBase64) {
        // Si on a un avatar local mais pas global, synchroniser vers le global
        __DEV__ && console.log('[SessionService] 🖼️ Syncing avatar TO global storage');
        // Static import used
        await setGlobalAvatar(this.myProfile.avatarBase64);
      }
      
      // Sauvegarder si des changements ont été faits
      if (needsSave) {
        await AsyncStorage.setItem(
          STORAGE_KEYS.MY_PROFILE,
          JSON.stringify(this.myProfile)
        );
        __DEV__ && console.log('[SessionService] ✅ Profile synced, avatar:', this.myProfile.avatarBase64 ? 'SET' : 'NOT SET');
      }
    } catch (error) {
      __DEV__ && console.error('[SessionService] Error syncing from global storage:', error);
    }
  }
  
  /**
   * Met à jour le profil
   */
  async updateProfile(profile: Partial<UserProfile>): Promise<void> {
    this.myProfile = { ...this.myProfile, ...profile };
    await AsyncStorage.setItem(STORAGE_KEYS.MY_PROFILE, JSON.stringify(this.myProfile));
  }
  
  /**
   * Récupère le profil
   */
  getMyProfile(): UserProfile {
    const profile = { ...this.myProfile };
    // Log périodique pour debug (pas à chaque appel pour éviter spam)
    if (!this._lastProfileLogTime || Date.now() - this._lastProfileLogTime > 10000) {
      __DEV__ && console.log('[SessionService] 📋 getMyProfile:', {
        displayName: profile.displayName,
        hasAvatar: !!profile.avatarBase64,
        avatarLength: profile.avatarBase64?.length || 0,
      });
      this._lastProfileLogTime = Date.now();
    }
    return profile;
  }
  private _lastProfileLogTime: number = 0;
  
  /**
   * v6.1: S'abonner aux changements de profil
   * Permet aux composants UI de se mettre à jour quand l'avatar change
   */
  onProfileChange(listener: (profile: UserProfile) => void): () => void {
    this.profileChangeListeners.add(listener);
    __DEV__ && console.log(`[SessionService] 📢 Profile listener added (total: ${this.profileChangeListeners.size})`);
    
    // Retourne une fonction de désabonnement
    return () => {
      this.profileChangeListeners.delete(listener);
      __DEV__ && console.log(`[SessionService] 📢 Profile listener removed (total: ${this.profileChangeListeners.size})`);
    };
  }
  
  /**
   * v6.1: Notifie tous les listeners d'un changement de profil
   */
  private notifyProfileChange(): void {
    const profile = { ...this.myProfile };
    __DEV__ && console.log(`[SessionService] 📢 Notifying ${this.profileChangeListeners.size} profile listeners`);
    for (const listener of this.profileChangeListeners) {
      try {
        listener(profile);
      } catch (e) {
        __DEV__ && console.error('[SessionService] Profile listener error:', e);
      }
    }
  }
  
  // ==========================================
  // ACTION 01 (CRITIQUE-04): KEY TRANSPARENCY
  // ==========================================
  
  /**
   * S'abonner aux alertes de changement de clé d'identité.
   * L'UI doit afficher une alerte quand action === 'changed',
   * surtout si wasVerified === true (la clé précédente avait été
   * vérifiée manuellement → MITM probable).
   */
  onKeyChange(listener: (event: KeyChangeEvent) => void): () => void {
    this.keyChangeListeners.add(listener);
    __DEV__ && console.log(`[SessionService] 🔑 Key change listener added (total: ${this.keyChangeListeners.size})`);
    return () => {
      this.keyChangeListeners.delete(listener);
      __DEV__ && console.log(`[SessionService] 🔑 Key change listener removed (total: ${this.keyChangeListeners.size})`);
    };
  }
  
  /**
   * Notifie les listeners d'un changement de clé d'identité.
   */
  private notifyKeyChange(event: KeyChangeEvent): void {
    __DEV__ && console.log(`[SessionService] 🔑 Key event: ${event.action} for ${event.contactName} (verified=${event.wasVerified})`);
    for (const listener of this.keyChangeListeners) {
      try {
        listener(event);
      } catch (e) {
        __DEV__ && console.error('[SessionService] Key change listener error:', e);
      }
    }
  }
  
  /**
   * Vérifie et pin la clé d'identité d'un contact.
   * Appelé automatiquement lors de acceptInvite() et finalizeSession().
   * 
   * @returns Le résultat de la vérification (ou null si erreur non-critique)
   */
  private async verifyContactKey(
    sessionId: string,
    theirIdentityKeyB64: string,
    contactName: string
  ): Promise<KeyVerificationResult | null> {
    try {
      const result = await verifyAndPinKey(sessionId, theirIdentityKeyB64);
      
      // Émettre un événement pour l'UI
      if (result.action !== 'unchanged') {
        this.notifyKeyChange({
          sessionId,
          contactName,
          action: result.action,
          wasVerified: result.wasVerified,
          fingerprint: result.fingerprint,
        });
      }
      
      // Log si changement de clé critique (clé précédente vérifiée)
      if (result.action === 'changed' && result.wasVerified) {
        __DEV__ && console.warn(
          `[SessionService] ⚠️🔴 CRITICAL: Verified identity key changed for ${contactName} (session ${sessionId}). ` +
          `This could indicate a man-in-the-middle attack. Previous key was manually verified.`
        );
      } else if (result.action === 'changed') {
        __DEV__ && console.warn(
          `[SessionService] ⚠️ Identity key changed for ${contactName} (session ${sessionId}). ` +
          `This may be normal (device change) or suspicious (MITM).`
        );
      }
      
      return result;
    } catch (e) {
      // Key verification failure is non-fatal — log and continue.
      // Don't block session creation for a key pinning error.
      __DEV__ && console.error('[SessionService] Key verification error (non-fatal):', e);
      return null;
    }
  }
  
  /**
   * Calcule le safety number pour une session donnée.
   * 
   * Le safety number est un nombre de 60 chiffres (12 groupes de 5)
   * que les deux participants peuvent comparer (QR code ou lecture vocale)
   * pour vérifier qu'il n'y a pas de MITM.
   * 
   * @param sessionId - ID de la session
   * @returns Safety number formaté (60 chiffres, 12 groupes de 5) ou null
   */
  async getSafetyNumber(sessionId: string): Promise<string | null> {
    this.ensureInitialized();
    
    const session = this.sessions.get(sessionId);
    if (!session || !this.identityKeyPair) return null;
    
    // Décoder la clé d'identité du contact
    const theirKeyBytes = decodeBase64(session.theirIdentityKey);
    const myKeyBytes = this.identityKeyPair.publicKey.bytes;
    
    // Identifiants stables = fingerprints hex
    const myIdentifier = session.myIdentityKeyFingerprint;
    const theirIdentifier = session.theirIdentityKeyFingerprint;
    
    return computeSafetyNumber(
      myKeyBytes,
      myIdentifier,
      theirKeyBytes,
      theirIdentifier
    );
  }
  
  /**
   * Marque la clé d'un contact comme vérifiée manuellement.
   * À appeler quand l'utilisateur a vérifié le safety number
   * (scan QR ou comparaison vocale).
   */
  async markContactKeyVerified(sessionId: string): Promise<void> {
    await markKeyAsVerifiedKT(sessionId);
    __DEV__ && console.log(`[SessionService] ✅ Key marked as verified for session ${sessionId}`);
  }
  
  /**
   * Retourne le statut de vérification de la clé d'un contact.
   */
  async getContactKeyStatus(sessionId: string): Promise<{
    pinned: boolean;
    verified: boolean;
    fingerprint: string | null;
  }> {
    return getKeyVerificationStatusKT(sessionId);
  }
  
  /**
   * Force la synchronisation du profil avec storage.ts
   * À appeler après la configuration du profil dans SetupProfileScreen
   * v6.1: Notifie les listeners après la mise à jour
   */
  async syncProfileFromGlobal(): Promise<void> {
    try {
      // Static import used
      
      const globalDisplayName = await getGlobalDisplayName();
      const globalAvatar = await getGlobalAvatar();
      
      __DEV__ && console.log('[SessionService] 🔄 syncProfileFromGlobal:');
      __DEV__ && console.log(`  - globalDisplayName: ${globalDisplayName || '(null)'}`);
      __DEV__ && console.log(`  - globalAvatar: ${globalAvatar ? `${globalAvatar.slice(0, 50)}... (${globalAvatar.length} chars)` : '(null)'}`);
      __DEV__ && console.log(`  - current myProfile.displayName: ${this.myProfile.displayName}`);
      __DEV__ && console.log(`  - current myProfile.avatarBase64: ${this.myProfile.avatarBase64 ? `${this.myProfile.avatarBase64.slice(0, 50)}... (${this.myProfile.avatarBase64.length} chars)` : '(null)'}`);
      
      const oldAvatar = this.myProfile.avatarBase64;
      const oldDisplayName = this.myProfile.displayName;
      
      if (globalDisplayName) {
        this.myProfile = {
          displayName: globalDisplayName,
          avatarBase64: globalAvatar || undefined,
        };
        await AsyncStorage.setItem(
          STORAGE_KEYS.MY_PROFILE,
          JSON.stringify(this.myProfile)
        );
        __DEV__ && console.log('[SessionService] ✅ Profile synced from global:');
        __DEV__ && console.log(`  - new displayName: ${this.myProfile.displayName}`);
        __DEV__ && console.log(`  - new avatarBase64: ${this.myProfile.avatarBase64 ? 'SET' : 'NOT SET'}`);
        
        // v6.1: Notifier les listeners si le profil a changé
        if (oldAvatar !== this.myProfile.avatarBase64 || oldDisplayName !== this.myProfile.displayName) {
          this.notifyProfileChange();
        }
      } else {
        __DEV__ && console.log('[SessionService] ⚠️ No globalDisplayName, sync skipped');
      }
    } catch (error) {
      __DEV__ && console.error('[SessionService] Error syncing profile:', error);
    }
  }
  
  /**
   * v27.1: Met à jour myProfile DIRECTEMENT avec les valeurs fournies.
   * Évite le round-trip AsyncStorage de syncProfileFromGlobal() qui relit
   * des données qui viennent d'être écrites par le caller.
   * 
   * Utilisé par SettingsScreen après avoir déjà écrit dans GLOBAL_AVATAR_KEY
   * et GLOBAL_DISPLAY_NAME_KEY — on a les valeurs en mémoire, pas besoin
   * de les relire.
   */
  async updateMyProfileDirect(profile: UserProfile): Promise<void> {
    try {
      const oldAvatar = this.myProfile.avatarBase64;
      const oldDisplayName = this.myProfile.displayName;
      
      this.myProfile = {
        displayName: profile.displayName,
        avatarBase64: profile.avatarBase64,
      };
      
      // Une seule écriture AsyncStorage (au lieu de 2 reads + 1 write dans syncProfileFromGlobal)
      await AsyncStorage.setItem(
        STORAGE_KEYS.MY_PROFILE,
        JSON.stringify(this.myProfile)
      );
      
      if (oldAvatar !== this.myProfile.avatarBase64 || oldDisplayName !== this.myProfile.displayName) {
        this.notifyProfileChange();
      }
      
      __DEV__ && console.log('[SessionService] ✅ Profile updated directly:', {
        displayName: this.myProfile.displayName,
        hasAvatar: !!this.myProfile.avatarBase64,
      });
    } catch (error) {
      __DEV__ && console.error('[SessionService] Error updating profile directly:', error);
    }
  }
  
  // ==========================================
  // UTILITAIRES D'IDENTITÉ
  // ==========================================
  
  /**
   * Récupère l'empreinte courte de ma clé d'identité
   */
  getMyShortFingerprint(): string {
    if (!this.identityKeyPair) return '';
    return bytesToHex(this.identityKeyPair.publicKey.bytes).substring(0, 16);
  }
  
  /**
   * Récupère l'empreinte complète pour les Safety Numbers
   */
  getMyFullFingerprint(): string {
    if (!this.identityKeyPair) return '';
    return bytesToHex(this.identityKeyPair.publicKey.bytes);
  }

  /**
   * Clé secrète Ed25519 (64o, format tweetnacl) pour SIGNER (ex. messages de
   * groupe). null tant que l'identité n'est pas chargée.
   */
  getMySigningSecretKey(): Uint8Array | null {
    return this.identityKeyPair ? this.identityKeyPair.privateKey.bytes : null;
  }

  /** Clé publique Ed25519 (32o) ; hex(.)[:16] === fingerprint. */
  getMyIdentityPublicKeyBytes(): Uint8Array | null {
    return this.identityKeyPair ? this.identityKeyPair.publicKey.bytes : null;
  }
  
  /**
   * Génère un tag aléatoire pour le transport
   */
  private generateTag(): string {
    const bytes = getSecureRandomBytes(16);
    return bytesToHex(bytes);
  }
  
  // ==========================================
  // BUNDLE PQXDH POUR GROUPES (v4.0)
  // ==========================================
  
  // ==========================================
  // CRÉATION D'INVITATION (PQXDH)
  // ==========================================
  
  /**
   * Crée une invitation avec bundle PQXDH
   * Le bundle est uploadé sur le serveur, seul le tag est dans le QR code
   */
  async createInvite(): Promise<CreateInviteResult> {
    this.ensureInitialized();
    
    
    // [Bug #1] Sélectionner une OTPK NON-réservée par une autre invitation
    // L'OTPK doit rester dans le pool (pqxdhResponder en a besoin lors de la finalisation)
    // mais elle est réservée pour que les autres invitations n'utilisent pas la même.
    let dedicatedOtpk: OneTimePreKey | undefined;
    for (const otpk of this.oneTimePreKeys.values()) {
      if (!this.reservedOtpkIds.has(otpk.id)) {
        dedicatedOtpk = otpk;
        break;
      }
    }
    
    if (dedicatedOtpk) {
      this.reservedOtpkIds.add(dedicatedOtpk.id);
      __DEV__ && console.log(`[SessionService] 🔑 OTPK #${dedicatedOtpk.id} reserved for invite (${this.reservedOtpkIds.size} reserved, ${this.oneTimePreKeys.size} total)`);
    } else {
      __DEV__ && console.warn('[SessionService] ⚠️ No unreserved OTPK available — invite will proceed without (reduced forward secrecy)');
    }
    
    // Créer le bundle PQXDH complet
    const bundle = createPQPreKeyBundle(
      this.identityKeyPair!,
      this.signedPreKey!,
      this.pqSignedKey!,
      dedicatedOtpk
    );
    
    __DEV__ && console.log('  - Identity Key: ' + this.getMyShortFingerprint());
    __DEV__ && console.log('  - PQ Key ID: ' + this.pqSignedKey!.id);
    
    // Générer un tag pour le transport
    const tag = this.generateTag();
    
    __DEV__ && console.log('  - Tag: ' + tag.substring(0, 12) + '...');
    
    // Créer les données d'invitation complètes (pour stockage serveur)
    const inviteData: InviteData = {
      version: 2,
      type: 'ghostr_invite_pq',
      bundle: JSON.stringify(serializePQPreKeyBundle(bundle)),
      profile: this.myProfile,
      createdAt: Date.now(),
      tag,
    };
    
    // Uploader le bundle sur le serveur
    try {
      // ACTION 02: Route via OHTTP relay, pas de device_id
      // (secureRpc, createSealedSenderEnvelope, isSealedSenderReady imported statically)
      
      const serverPayload = {
        type: 'ghostr_invite_pq',
        version: 2,
        data: encodeBase64(new TextEncoder().encode(JSON.stringify(inviteData))),
        timestamp: Date.now(),
      };
      
      const payloadString = JSON.stringify(serverPayload);
      __DEV__ && console.log('[SessionService] 📤 Uploading bundle:');
      __DEV__ && console.log('  - tag length:', tag.length);
      __DEV__ && console.log('  - payload size:', payloadString.length, 'chars');
      __DEV__ && console.log('  - payload type:', serverPayload.type);
      
      // BUG FIX: Le gateway attend une enveloppe sealed sender (NaCl box).
      // Sans ça, le gateway essaie nacl.box.open() sur du JSON brut → échec.
      // FIX: Utilise waitForSealedSenderReady (utilitaire unifié, timeout +
      //      retries internes + AbortSignal-aware + status callback).
      //      L'écran appelant (Create1to1Screen) a déjà fait son propre
      //      pré-bootstrap, mais on conserve ce filet de sécurité au cas où
      //      le certificat aurait été invalidé entre temps (cf. P6 quota).
      if (!isSealedSenderReady()) {
        __DEV__ && console.log('[SessionService] ⏳ Waiting for sealed sender bootstrap (upload)...');
        try {
          const { waitForSealedSenderReady } = await import('../api1to1');
          const ready = await waitForSealedSenderReady({ timeoutMs: 60_000 });
          if (!ready || !isSealedSenderReady()) {
            throw new Error('Sealed sender bootstrap failed — cannot upload invitation anonymously');
          }
          __DEV__ && console.log('[SessionService] ✅ Sealed sender ready (bootstrap completed)');
        } catch (e: any) {
          throw new Error(`Sealed sender bootstrap error: ${e.message}`);
        }
      }
      const envelope = createSealedSenderEnvelope(tag, payloadString);
      
      const { data, error } = await secureRpc('send_sealed_message', {
        p_tag: envelope.tag,
        p_sealed_content: envelope.sealedContent,
        p_version: envelope.version,
      });
      
      __DEV__ && console.log('[SessionService] 📥 Upload response:');
      __DEV__ && console.log('  - data:', JSON.stringify(data));
      __DEV__ && console.log('  - error:', JSON.stringify(error));
      
      if (error) {
        __DEV__ && console.error('[SessionService] Failed to upload bundle:', JSON.stringify(error));
        __DEV__ && console.error('  - error.message:', error.message);
        __DEV__ && console.error('  - error.code:', error.code);
        __DEV__ && console.error('  - error.details:', error.details);
        __DEV__ && console.error('  - error.hint:', error.hint);
        throw new Error('Failed to upload invitation to server: ' + (error.message || error.code || JSON.stringify(error)));
      }
      
    } catch (e: any) {
      __DEV__ && console.error('[SessionService] Error uploading bundle:', e);
      throw new Error('Failed to upload invitation: ' + e.message);
    }
    
    // QR code contient SEULEMENT le tag + version (très court!)
    const qrData = {
      v: 2,
      t: tag,
      n: this.myProfile.displayName,
    };
    const inviteString = encodeBase64(new TextEncoder().encode(JSON.stringify(qrData)));
    
    
    return {
      inviteData,
      inviteString,
      inviteCode: inviteString,
      keyIds: {
        signedPreKeyId: this.signedPreKey!.id,
        pqSignedKeyId: this.pqSignedKey!.id,
        oneTimePreKeyId: dedicatedOtpk?.id,
      },
    };
  }
  
  /**
   * Récupère le bundle d'invitation depuis le serveur
   * Utilisé quand le QR code ne contient que le tag
   */
  private async fetchInviteFromServer(tag: string): Promise<InviteData> {
    try {
      // ACTION 02: Route via OHTTP relay (secureRpc imported statically)
      
      
      // Récupérer les messages sur ce tag (même RPC que api1to1)
      const { data, error } = await secureRpc('get_messages_by_tags', {
        p_tags: [tag],
        p_since: null, // Tous les messages
        p_limit: 50,
      });
      
      if (error) {
        throw new Error('Server error: ' + error.message);
      }
      
      if (!data || data.length === 0) {
        throw new Error('Invitation expired or not found');
      }
      
      
      // Chercher le message d'invitation
      for (const msg of data) {
        try {
          const payload = typeof msg.sealed_payload === 'string' 
            ? JSON.parse(msg.sealed_payload)
            : msg.sealed_payload;
          
          if (payload.type === 'ghostr_invite_pq' && payload.version === 2 && payload.data) {
            // Décoder les données d'invitation
            const inviteData = JSON.parse(
              new TextDecoder().decode(decodeBase64(payload.data))
            );
            
            return inviteData as InviteData;
          }
        } catch (parseErr) {
          // Ignorer les messages non-valides
          continue;
        }
      }
      
      throw new Error('Invitation not found on server');
      
    } catch (e: any) {
      __DEV__ && console.error('[SessionService] Error fetching invite:', e);
      throw new Error('Failed to fetch invitation: ' + e.message);
    }
  }
  
  // ==========================================
  // ACCEPTATION D'INVITATION (PQXDH)
  // ==========================================
  
  /**
   * Accepte une invitation et crée la session via PQXDH
   * Supporte deux formats:
   * - Format court (QR): {v, t, n} - récupère le bundle du serveur
   * - Format long (manuel): {version, type, bundle, ...} - utilise directement
   */
  async acceptInvite(inviteString: string): Promise<AcceptInviteResult> {
    this.ensureInitialized();
    
    
    // Nettoyer l'entrée
    const cleanedInput = inviteString
      .trim()
      .replace(/\s+/g, '')
      .replace(/[\r\n]/g, '');
    
    // Décoder l'invitation
    let inviteData: InviteData;
    try {
      const decoded = new TextDecoder().decode(decodeBase64(cleanedInput));
      const parsed = JSON.parse(decoded);
      
      // Vérifier si c'est le format court (QR code)
      if (parsed.v && parsed.t && !parsed.bundle) {
        __DEV__ && console.log('  - Tag: ' + parsed.t.substring(0, 12) + '...');
        __DEV__ && console.log('  - From: ' + (parsed.n || 'Unknown'));

        // Bug #3 fix (early): if this tag belongs to an invite we
        // generated on this device, the user is trying to chat with
        // themselves. Reject before the network fetch, before any
        // crypto state is touched.
        await pendingInviteStore.load();
        if (pendingInviteStore.getByTag(parsed.t)) {
          const err: any = new Error('SELF_INVITE');
          err.isSelfInvite = true;
          throw err;
        }

        // Récupérer le bundle depuis le serveur
        inviteData = await this.fetchInviteFromServer(parsed.t);
      } else if (parsed.type === 'ghostr_invite_pq') {
        // Format long direct
        inviteData = parsed;
      } else {
        throw new Error('Unknown invite format');
      }
    } catch (error: any) {
      // Don't wrap our typed self-invite error in the generic "invalid
      // format" message — it must reach the screen as-is.
      if (error?.isSelfInvite) throw error;
      __DEV__ && console.error('[SessionService] Failed to decode invite:', error);
      throw new Error('Invalid invite format - ' + (error.message || 'make sure you copied the complete code'));
    }
    
    __DEV__ && console.log('  - Type: ' + inviteData.type + ' v' + inviteData.version);
    __DEV__ && console.log('  - From: ' + inviteData.profile.displayName);
    
    // Vérifier la version
    if (inviteData.type !== 'ghostr_invite_pq' || inviteData.version !== 2) {
      throw new Error('Unsupported invite version. This invite requires Post-Quantum support (V2).');
    }
    
    // [Bug #6] Vérifier l'expiration de l'invitation (30 jours)
    const INVITE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    if (inviteData.createdAt && (Date.now() - inviteData.createdAt > INVITE_MAX_AGE_MS)) {
      throw new Error(i18n.t('errors.invitationExpired'));
    }
    
    // Désérialiser le bundle PQXDH
    const bundleSerialized = JSON.parse(inviteData.bundle);
    const bundle = deserializePQPreKeyBundle(bundleSerialized);
    
    // Valider le bundle
    const validation = validatePQPreKeyBundle(bundle);
    if (!validation.valid) {
      throw new Error(`Invalid bundle: ${validation.error}`);
    }

    // Bug #3 fix (late): backstop the early tag check by comparing the
    // inviter's identity key with our own. This covers:
    //   - Long-format invites (no tag indirection through pendingInviteStore).
    //   - Short-format invites whose tag is no longer in pendingInviteStore
    //     (e.g., after a reinstall that wiped local invite state).
    // Critically, this runs BEFORE pqxdhInitiator() consumes a one-time
    // pre-key, so a self-invite leaves no crypto state behind.
    if (this.identityKeyPair) {
      const myKeyB64 = serializePublicKey(this.identityKeyPair.publicKey);
      const theirKeyB64Compare = serializePublicKey(bundle.identityKey);
      if (myKeyB64 === theirKeyB64Compare) {
        const err: any = new Error('SELF_INVITE');
        err.isSelfInvite = true;
        throw err;
      }
    }

    // P0: Verify the inviter's identity key is in the Key Transparency log.
    // This is the CRITICAL MITM protection: a substituted key won't be in the log.
    const theirKeyB64 = serializePublicKey(bundle.identityKey);
    let ktResult: KTVerificationResult | null = null;
    let ktStatus: StoredSession['ktStatus'] = 'error';
    try {
      ktResult = await verifyKeyInTransparencyLog(theirKeyB64);

      if (ktResult.verified) {
        ktStatus = 'verified';
        __DEV__ && console.log(`[SessionService] 🌳 KT: Correspondent's key VERIFIED in transparency log (tree size: ${ktResult.treeSize})`);
      } else if (!ktResult.inLog) {
        // Key not in log — might be a new contact who hasn't registered yet.
        // Warn but don't block (first-time contacts need graceful handling).
        ktStatus = 'not_in_log';
        __DEV__ && console.warn(
          `[SessionService] 🌳⚠️ KT: Correspondent's key NOT FOUND in transparency log. ` +
          `This may be normal for new contacts, or it may indicate key substitution. ` +
          `Error: ${ktResult.error}`
        );
      } else if (!ktResult.proofValid) {
        // ACTION-06 (Phase 2 Security): BLOCK the handshake.
        // Key is in log but proof is invalid — the server returned a forged proof.
        // This is a STRONG indicator of MITM. Do NOT proceed.
        ktStatus = 'invalid_proof';
        throw new Error(
          `KT_INVALID_PROOF: The server provided an invalid Merkle proof for the correspondent's identity key. ` +
          `This is a strong indicator of a man-in-the-middle attack. Session creation blocked.`
        );
      } else if (!ktResult.sthConsistent) {
        // ACTION-06: BLOCK on STH inconsistency.
        // The transparency tree may have been rewritten — append-only violation.
        ktStatus = 'sth_inconsistent';
        throw new Error(
          `KT_STH_INCONSISTENT: The Key Transparency tree appears to have been rewritten. ` +
          `This is a CRITICAL security event indicating possible server compromise. Session creation blocked.`
        );
      }
    } catch (ktError: any) {
      if (ktError.message?.startsWith('KT_INVALID_PROOF') || ktError.message?.startsWith('KT_STH_INCONSISTENT')) {
        // Re-throw blocking errors — these MUST stop the handshake.
        throw ktError;
      }
      // KT verification failed (network error, gateway down, etc.)
      // Don't block session creation — log the issue.
      ktStatus = 'error';
      __DEV__ && console.warn(`[SessionService] 🌳⚠️ KT verification failed (non-fatal): ${ktError.message}`);
    }

    // Also ensure my own key is registered (retry if it failed at init)
    this.registerKeyInTransparencyLog().catch(() => {});
    
    // [Bug #2] Vérifier si une session existe déjà avec cette identity key
    const candidateSessionId = this.generateSessionId(bundle.identityKey);
    const existingSession = this.sessions.get(candidateSessionId);
    if (existingSession) {
      const contactName = existingSession.theirProfile.displayName || inviteData.profile.displayName;
      __DEV__ && console.warn(`[SessionService] ⚠️ Session already exists with ${contactName} (${candidateSessionId})`);
      const err = new Error(`EXISTING_SESSION:${contactName}:${candidateSessionId}`) as any;
      err.existingSessionId = candidateSessionId;
      err.existingContactName = contactName;
      err.isExistingSession = true;
      throw err;
    }
    
    
    // Effectuer PQXDH (hybride X25519 + ML-KEM)
    const pqxdhResult = await pqxdhInitiator(this.identityKeyPair!, bundle);
    
    __DEV__ && console.log('  - KEM ciphertext size: ' + pqxdhResult.kemCiphertext.bytes.length + ' bytes');
    
    
    // Initialiser le Triple Ratchet avec la paire éphémère PQXDH
    const ratchetState = await initializeTripleRatchetInitiator(
      pqxdhResult.sharedSecret,
      bundle.signedPreKey.publicKey,
      pqxdhResult.ephemeralKeyPair, // Paire éphémère PQXDH comme première clé de ratchet
      pqxdhResult.sharedSecret.bytes, // Secret PQ pour SPQR
      this.config
    );
    
    
    // Générer l'ID de session
    const sessionId = this.generateSessionId(bundle.identityKey);
    
    // Créer le message PQXDH initial
    const pqxdhMessage: PQXDHInitialMessage = {
      identityKey: this.identityKeyPair!.publicKey,
      ephemeralKey: pqxdhResult.ephemeralPublicKey,
      usedSignedPreKeyId: bundle.signedPreKey.id,
      usedOneTimePreKeyId: pqxdhResult.usedOneTimePreKeyId,
      usedPQPreKeyId: bundle.pqPreKey.id,
      kemCiphertext: pqxdhResult.kemCiphertext,
      ciphertext: new Uint8Array(0),
    };
    
    // Créer la session
    const session: StoredSession = {
      version: 2,
      id: sessionId,
      myIdentityKeyFingerprint: this.getMyShortFingerprint(),
      theirIdentityKey: serializePublicKey(bundle.identityKey),
      theirIdentityKeyFingerprint: bytesToHex(bundle.identityKey.bytes).substring(0, 16),
      theirProfile: inviteData.profile,
      tripleRatchetState: serializeTripleRatchetState(ratchetState),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      isInitiator: true,
      messagesSent: 0,
      messagesReceived: 0,
      tag: inviteData.tag,
      isPostQuantum: true,
      ktStatus,
    };
    
    // Stocker la session
    await this.saveSession(session);
    this.ratchetStates.set(sessionId, ratchetState);
    
    // ACTION 01 (CRITIQUE-04): Verify and pin the inviter's identity key.
    // First contact → stores key. Key change → emits alert to UI.
    await this.verifyContactKey(
      sessionId,
      session.theirIdentityKey,
      inviteData.profile.displayName || 'Unknown'
    );
    
    // Créer la réponse
    const responseData: InviteResponse = {
      version: 2,
      type: 'ghostr_accept_pq',
      pqxdhMessage: serializePQXDHMessage(pqxdhMessage),
      profile: this.myProfile,
      tag: inviteData.tag,
    };
    
    const responseString = encodeBase64(
      new TextEncoder().encode(JSON.stringify(responseData))
    );
    
    return {
      session,
      responseData,
      responseString,
    };
  }
  
  // ==========================================
  // FINALISATION DE SESSION
  // ==========================================
  
  /**
   * Envoie la réponse d'acceptation au serveur
   */
  async sendAcceptResponseToServer(
    tag: string,
    responseString: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // ACTION 02: Route via OHTTP relay, pas de device_id
      // (secureRpc, createSealedSenderEnvelope, isSealedSenderReady imported statically)
      
      
      const payload = {
        type: 'ghostr_accept_pq', // V2 post-quantum
        version: 2,
        data: responseString,
        timestamp: Date.now(),
      };
      
      // BUG FIX: Wrapper dans une enveloppe sealed sender
      // FIX: Utilise waitForSealedSenderReady (utilitaire unifié, timeout
      //      30s, retries internes, AbortSignal-aware). L'écran Join1to1Screen
      //      a déjà fait son pré-bootstrap, mais on garde ce filet pour le
      //      cas où le certificat serait invalidé entre temps.
      if (!isSealedSenderReady()) {
        __DEV__ && console.log('[SessionService] ⏳ Waiting for sealed sender bootstrap (acceptInvite)...');
        try {
          // Import dynamique pour éviter la dépendance circulaire sessionService ↔ api1to1
          const { waitForSealedSenderReady } = await import('../api1to1');
          const ready = await waitForSealedSenderReady({ timeoutMs: 60_000 });
          if (!ready || !isSealedSenderReady()) {
            return { success: false, error: 'Sealed sender bootstrap failed — cannot send accept anonymously' };
          }
          __DEV__ && console.log('[SessionService] ✅ Sealed sender ready (bootstrap completed)');
        } catch (e) {
          return { success: false, error: `Sealed sender bootstrap error: ${e}` };
        }
      }
      const payloadString = JSON.stringify(payload);
      const envelope = createSealedSenderEnvelope(tag, payloadString);
      
      const { error } = await secureRpc('send_sealed_message', {
        p_tag: envelope.tag,
        p_sealed_content: envelope.sealedContent,
        p_version: envelope.version,
      });
      
      if (error) {
        __DEV__ && console.error('[SessionService] Failed to send response:', error);
        return { success: false, error: error.message };
      }
      
      return { success: true };
      
    } catch (e: any) {
      __DEV__ && console.error('[SessionService] Error sending response:', e);
      return { success: false, error: e.message };
    }
  }
  
  /**
   * Accepte une invitation ET envoie automatiquement la réponse au serveur
   * Flux simplifié pour le joigneur.
   *
   * FIX: Si l'envoi de la réponse échoue (sealed sender HS, réseau, etc.),
   * on rollback la session locale pour éviter un état orphelin :
   *   - Le pair inviteur n'a JAMAIS reçu la réponse → il pense que personne
   *     n'a accepté son invitation → il peut la régénérer.
   *   - Sans rollback, le joigneur croit avoir une session établie mais
   *     l'inviteur ne le verra jamais → messages partiraient dans le vide.
   * En cas d'échec, on throw avec `wasRollback: true` pour que l'UI puisse
   * afficher un message clair et inviter à réessayer.
   */

  // ==========================================
  // v30.0 — MESH DE GROUPE : sessions à la demande depuis un bundle
  // ==========================================
  //
  // Pour le maillage des groupes : créer une session 1:1 SANS le flux QR/serveur
  // (pas de tag, pas de fetch). Le bundle est transporté dans le canal de groupe
  // (welcome / roster_state). Réplique la logique d'acceptInvite (initiateur) et
  // de finalizeSession (répondeur), mais à partir de données déjà en main.

  /**
   * Crée une session 1:1 en tant qu'INITIATEUR à partir d'un bundle PQXDH
   * sérialisé (clés publiques du pair) et de son profil. Renvoie la session +
   * le PQXDHInitialMessage SÉRIALISÉ à joindre au premier message de groupe
   * (pour que le pair crée sa moitié de session à la réception).
   *
   * Réutilisé par apiGroups pour le lazy-mesh. Consomme une OTPK du pair (ou
   * dégradation gracieuse si absente). Vérifie KT (non bloquant sauf MITM).
   */
  async createMeshInitiatorSession(
    serializedBundle: string,
    theirProfile: UserProfile
  ): Promise<{ sessionId: string; initialMessageSerialized: string } | null> {
    if (!this.identityKeyPair) { await this.initialize(); }
    if (!this.identityKeyPair) throw new Error('Identity not initialized');

    // Désérialiser + valider le bundle.
    let bundle;
    try {
      bundle = deserializePQPreKeyBundle(JSON.parse(serializedBundle));
    } catch (e) {
      __DEV__ && console.warn('[SessionService] mesh: bad bundle:', e);
      return null;
    }
    const validation = validatePQPreKeyBundle(bundle);
    if (!validation.valid) {
      __DEV__ && console.warn('[SessionService] mesh: invalid bundle:', validation.error);
      return null;
    }

    // Anti self-session.
    const myKeyB64 = serializePublicKey(this.identityKeyPair.publicKey);
    if (myKeyB64 === serializePublicKey(bundle.identityKey)) {
      __DEV__ && console.warn('[SessionService] mesh: self-session ignored');
      return null;
    }

    // Si une session existe déjà avec ce pair, ne pas en recréer.
    const existingId = this.generateSessionId(bundle.identityKey);
    if (this.sessions.has(existingId)) {
      return { sessionId: existingId, initialMessageSerialized: '' };
    }

    // KT (protection MITM) — non bloquant sauf invalid_proof.
    const theirKeyB64 = serializePublicKey(bundle.identityKey);
    let ktStatus: StoredSession['ktStatus'] = 'error';
    try {
      const ktResult = await verifyKeyInTransparencyLog(theirKeyB64);
      if (ktResult.verified) ktStatus = 'verified';
      else if (!ktResult.inLog) ktStatus = 'not_in_log';
      else if (!ktResult.proofValid) {
        __DEV__ && console.warn('[SessionService] mesh: KT invalid_proof — blocking');
        return null; // MITM probable
      }
    } catch { ktStatus = 'error'; }

    // PQXDH initiateur (consomme une OTPK si présente).
    const pqxdhResult = await pqxdhInitiator(this.identityKeyPair, bundle);
    const ratchetState = await initializeTripleRatchetInitiator(
      pqxdhResult.sharedSecret,
      bundle.signedPreKey.publicKey,
      pqxdhResult.ephemeralKeyPair,
      pqxdhResult.sharedSecret.bytes,
      this.config
    );
    const sessionId = this.generateSessionId(bundle.identityKey);

    const pqxdhMessage: PQXDHInitialMessage = {
      identityKey: this.identityKeyPair.publicKey,
      ephemeralKey: pqxdhResult.ephemeralPublicKey,
      usedSignedPreKeyId: bundle.signedPreKey.id,
      usedOneTimePreKeyId: pqxdhResult.usedOneTimePreKeyId,
      usedPQPreKeyId: bundle.pqPreKey.id,
      kemCiphertext: pqxdhResult.kemCiphertext,
      ciphertext: new Uint8Array(0),
    };

    const session: StoredSession = {
      version: 2,
      id: sessionId,
      myIdentityKeyFingerprint: this.getMyShortFingerprint(),
      theirIdentityKey: serializePublicKey(bundle.identityKey),
      theirIdentityKeyFingerprint: bytesToHex(bundle.identityKey.bytes).substring(0, 16),
      theirProfile,
      tripleRatchetState: serializeTripleRatchetState(ratchetState),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      isInitiator: true,
      messagesSent: 0,
      messagesReceived: 0,
      tag: '', // mesh : pas de tag d'invitation
      isPostQuantum: true,
      ktStatus,
    };
    await this.saveSession(session);
    this.ratchetStates.set(sessionId, ratchetState);
    await this.verifyContactKey(sessionId, session.theirIdentityKey, theirProfile.displayName || 'Unknown');

    return {
      sessionId,
      initialMessageSerialized: serializePQXDHMessage(pqxdhMessage),
    };
  }

  /**
   * Crée une session 1:1 en tant que RÉPONDEUR à partir d'un PQXDHInitialMessage
   * sérialisé (reçu en accompagnement d'un premier message de groupe). Réplique
   * finalizeSession sans le wrapping InviteResponse. Renvoie le sessionId créé,
   * ou un sessionId existant si la session est déjà là (idempotent).
   */
  async createMeshResponderSession(
    initialMessageSerialized: string,
    theirProfile: UserProfile
  ): Promise<string | null> {
    if (!this.identityKeyPair) { await this.initialize(); }
    if (!this.identityKeyPair) throw new Error('Identity not initialized');

    let pqxdhMessage: PQXDHInitialMessage;
    try {
      pqxdhMessage = deserializePQXDHMessage(initialMessageSerialized);
    } catch (e) {
      __DEV__ && console.warn('[SessionService] mesh responder: bad initial message:', e);
      return null;
    }

    // Anti self.
    const myKeyB64 = serializePublicKey(this.identityKeyPair.publicKey);
    if (myKeyB64 === serializePublicKey(pqxdhMessage.identityKey)) return null;

    // Session déjà existante ? (idempotent)
    const sessionId = this.generateSessionId(pqxdhMessage.identityKey);
    if (this.sessions.has(sessionId)) return sessionId;

    // KT.
    const theirKeyB64 = serializePublicKey(pqxdhMessage.identityKey);
    let ktStatus: StoredSession['ktStatus'] = 'error';
    try {
      const ktResult = await verifyKeyInTransparencyLog(theirKeyB64);
      if (ktResult.verified) ktStatus = 'verified';
      else if (!ktResult.inLog) ktStatus = 'not_in_log';
      else if (!ktResult.proofValid) return null;
    } catch { ktStatus = 'error'; }

    // Retrouver MES prekeys référencées par le message initial.
    const signedPreKey = this.findSignedPreKeyById(pqxdhMessage.usedSignedPreKeyId);
    const pqSignedKey = this.findPQSignedKeyById(pqxdhMessage.usedPQPreKeyId);
    if (!signedPreKey || !pqSignedKey) {
      __DEV__ && console.warn('[SessionService] mesh responder: prekeys not found (expired?)');
      return null;
    }
    const usedOtpk = pqxdhMessage.usedOneTimePreKeyId !== undefined
      ? this.oneTimePreKeys.get(pqxdhMessage.usedOneTimePreKeyId)
      : null;

    // PQXDH répondeur (signature réelle : objets, pas callbacks).
    let sharedSecret;
    try {
      sharedSecret = await pqxdhResponder(
        this.identityKeyPair,
        signedPreKey,
        pqSignedKey,
        usedOtpk ?? null,
        pqxdhMessage
      );
    } catch (e) {
      __DEV__ && console.warn('[SessionService] mesh responder: pqxdhResponder failed:', e);
      return null;
    }

    // Consommer l'OTPK utilisée.
    if (pqxdhMessage.usedOneTimePreKeyId !== undefined) {
      this.oneTimePreKeys.delete(pqxdhMessage.usedOneTimePreKeyId);
      this.reservedOtpkIds.delete(pqxdhMessage.usedOneTimePreKeyId);
      await this.saveOneTimePreKeys();
    }

    const ratchetState = await initializeTripleRatchetResponder(
      sharedSecret,
      signedPreKey.keyPair,
      pqxdhMessage.ephemeralKey,
      sharedSecret.bytes,
      this.config
    );

    const session: StoredSession = {
      version: 2,
      id: sessionId,
      myIdentityKeyFingerprint: this.getMyShortFingerprint(),
      theirIdentityKey: serializePublicKey(pqxdhMessage.identityKey),
      theirIdentityKeyFingerprint: bytesToHex(pqxdhMessage.identityKey.bytes).substring(0, 16),
      theirProfile,
      tripleRatchetState: serializeTripleRatchetState(ratchetState),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      isInitiator: false,
      messagesSent: 0,
      messagesReceived: 0,
      tag: '',
      isPostQuantum: true,
      ktStatus,
    };
    await this.saveSession(session);
    this.ratchetStates.set(sessionId, ratchetState);
    await this.verifyContactKey(sessionId, session.theirIdentityKey, theirProfile.displayName || 'Unknown');

    return sessionId;
  }

  /**
   * Génère MON bundle PQXDH sérialisé, à transporter dans le canal de groupe
   * (welcome / roster_state) pour que les autres membres puissent créer une
   * session vers moi (mesh à la demande). Réserve une OTPK si disponible
   * (dégradation gracieuse sinon). Ne consomme PAS de tag (hors flux QR).
   */
  async generateMyBundleForGroup(): Promise<string | null> {
    if (!this.identityKeyPair) { await this.initialize(); }
    if (!this.identityKeyPair || !this.signedPreKey || !this.pqSignedKey) return null;

    // Tenter de réserver une OTPK dédiée (comme createInvite).
    let dedicatedOtpk: OneTimePreKey | undefined;
    for (const [id, otpk] of this.oneTimePreKeys) {
      if (!this.reservedOtpkIds.has(id)) {
        dedicatedOtpk = otpk;
        this.reservedOtpkIds.add(id);
        break;
      }
    }
    if (!dedicatedOtpk) {
      __DEV__ && console.warn('[SessionService] group bundle: no OTPK available (reduced FS)');
    }

    const bundle = createPQPreKeyBundle(
      this.identityKeyPair,
      this.signedPreKey,
      this.pqSignedKey,
      dedicatedOtpk
    );
    return JSON.stringify(serializePQPreKeyBundle(bundle));
  }

  // ==========================================
  // PUBLICATION DU BUNDLE ADMIN POUR INVITATION DE GROUPE
  // ==========================================
  //
  // Reproduit exactement le mécanisme du 1:1 (`createInvite`) : le bundle
  // PQXDH est téléversé sur le serveur sous un tag aléatoire, et seul ce tag
  // — 32 caractères hexadécimaux — voyage dans le QR code. Cela fait passer
  // l'invitation de groupe d'environ 2 170 octets (QR version 40, à la limite
  // du lisible) à environ 200 octets (QR version 6, scannable instantanément).
  //
  // ⚠️ CONTRAINTE DE RÉTENTION — À CONNAÎTRE AVANT D'UTILISER CE CHEMIN
  // Le serveur purge les messages au bout de 48 h (`cleanup_old_data`), alors
  // que les tickets de groupe valent 7 jours par défaut. Un QR reposant sur un
  // tag cesse donc de fonctionner après 48 h, même si le ticket est encore
  // valide. C'est aussi vrai du flux 1:1 aujourd'hui : `acceptInvite` vérifie
  // une péremption de 30 jours côté client (`INVITE_MAX_AGE_MS`) qui ne peut
  // jamais être atteinte, puisque la ligne a disparu du serveur bien avant.
  //
  // Conséquence pour l'appelant : republier à chaque affichage de l'écran
  // d'invitation (ce que fait `GroupInviteQRScreen`), et conserver un chemin
  // durable — le lien partageable embarque le bundle en clair, sans dépendance
  // au serveur ni limite de taille.

  /**
   * Téléverse le bundle PQXDH de l'admin et renvoie le tag permettant de le
   * récupérer. Le payload serveur est strictement identique à celui d'une
   * invitation 1:1 (`type: 'ghostr_invite_pq'`, version 2), afin de réutiliser
   * `fetchInviteFromServer` sans ajouter la moindre surface côté serveur.
   *
   * @throws si le sealed sender ne peut pas être initialisé, ou si le
   *         téléversement échoue. L'appelant doit prévoir un repli.
   */
  async publishGroupAdminBundle(): Promise<{ tag: string; bundleJson: string }> {
    const bundleJson = await this.generateMyBundleForGroup();
    if (!bundleJson) {
      throw new Error('Bundle admin indisponible (identité non initialisée)');
    }

    const tag = this.generateTag();

    const inviteData: InviteData = {
      version: 2,
      type: 'ghostr_invite_pq',
      bundle: bundleJson,
      profile: this.myProfile,
      createdAt: Date.now(),
      tag,
    };

    const serverPayload = {
      type: 'ghostr_invite_pq',
      version: 2,
      data: encodeBase64(new TextEncoder().encode(JSON.stringify(inviteData))),
      timestamp: Date.now(),
    };

    // Le gateway n'accepte que des enveloppes sealed sender : sans bootstrap,
    // il tenterait nacl.box.open() sur du JSON brut et rejetterait la requête.
    if (!isSealedSenderReady()) {
      const { waitForSealedSenderReady } = await import('../api1to1');
      const ready = await waitForSealedSenderReady({ timeoutMs: 60_000 });
      if (!ready || !isSealedSenderReady()) {
        throw new Error('Sealed sender indisponible — publication du bundle impossible');
      }
    }

    const envelope = createSealedSenderEnvelope(tag, JSON.stringify(serverPayload));
    const { error } = await secureRpc('send_sealed_message', {
      p_tag: envelope.tag,
      p_sealed_content: envelope.sealedContent,
      p_version: envelope.version,
    });

    if (error) {
      throw new Error('Publication du bundle admin échouée : ' + (error.message || error.code));
    }

    __DEV__ && console.log('[SessionService] 📤 Bundle admin de groupe publié, tag:', tag.slice(0, 12) + '…');
    return { tag, bundleJson };
  }

  /**
   * Récupère un bundle PQXDH publié, à partir de son tag.
   * Enveloppe publique de `fetchInviteFromServer` : lecture seule, le tag
   * n'est pas consommé, donc plusieurs personnes peuvent rejoindre avec le
   * même QR.
   *
   * @returns le bundle sérialisé, prêt pour `createMeshInitiatorSession`.
   */
  async fetchGroupAdminBundle(tag: string): Promise<string> {
    const inviteData = await this.fetchInviteFromServer(tag);
    if (!inviteData || !inviteData.bundle) {
      throw new Error('Bundle introuvable pour ce tag');
    }
    return inviteData.bundle;
  }

  async acceptInviteAndRespond(inviteString: string): Promise<AcceptInviteResult> {
    // 1. Accepter l'invitation (crée la session localement, consomme l'OTPK)
    const result = await this.acceptInvite(inviteString);
    
    // 2. Envoyer automatiquement la réponse au serveur
    if (result.session.tag) {
      const sendResult = await this.sendAcceptResponseToServer(
        result.session.tag,
        result.responseString
      );
      
      if (!sendResult.success) {
        __DEV__ && console.warn(
          '[SessionService] ❌ Failed to send auto-response, rolling back local session:',
          sendResult.error
        );
        // Rollback : supprimer la session locale orpheline. On garde l'OTPK
        // consommée comme « brûlée » côté sécurité (le ratchet a avancé),
        // mais on retire la session pour que le joigneur puisse réessayer
        // proprement (en re-scannant le QR par exemple).
        try {
          await this.deleteSession(result.session.id);
        } catch (delErr) {
          __DEV__ && console.error('[SessionService] Rollback deleteSession failed:', delErr);
        }
        const err: any = new Error(
          sendResult.error || 'Failed to confirm join with peer'
        );
        err.wasRollback = true;
        err.code = 'JOIN_SEND_FAILED';
        throw err;
      }
    }
    
    return result;
  }
  
  /**
   * [Bug #2] Remplace une session existante et accepte une nouvelle invitation
   * Appelé quand l'utilisateur confirme "Reconnecter" après détection de doublon.
   * Supprime proprement l'ancienne session avant d'en créer une nouvelle.
   *
   * ⚠️ EDGE CASE — échec d'envoi de la réponse :
   *   Si `acceptInviteAndRespond` throw `JOIN_SEND_FAILED` (la réponse n'a
   *   pas pu être envoyée au pair → rollback de la nouvelle session locale),
   *   l'utilisateur se retrouve avec NI l'ancienne session (déjà supprimée
   *   ici) NI la nouvelle (rollback). C'est intentionnel et préférable à
   *   l'alternative : garder une session locale orpheline alors que le pair
   *   ne sait pas qu'on a accepté son invitation.
   *
   *   Le pré-bootstrap SealedSender effectué par Join1to1Screen avant cet
   *   appel rend cet edge case très rare (le SS est vérifié prêt avant
   *   toute mutation d'état). Si malgré tout l'envoi échoue (ex: certificat
   *   expiré entre temps, réseau coupé pile au mauvais moment), l'utilisateur
   *   verra le message `errors.joinSendFailed` et pourra re-scanner le QR
   *   du contact pour réessayer proprement.
   *
   *   Restauration impossible : `deleteSession` supprime les états Triple
   *   Ratchet de façon irréversible (zeroize des clés). Il n'y a pas de
   *   chemin pour "annuler" la suppression sans re-scanner.
   */
  async acceptInviteAndReplace(
    inviteString: string,
    existingSessionId: string
  ): Promise<AcceptInviteResult> {
    this.ensureInitialized();
    
    __DEV__ && console.log(`[SessionService] 🔄 Replacing session ${existingSessionId}`);
    
    // 1. Supprimer proprement l'ancienne session
    //    (Obligatoire avant l'accept car le nouveau sessionId est déterministe
    //    et peut entrer en collision avec l'ancien — cf. Bug #1.)
    await this.deleteSession(existingSessionId);
    __DEV__ && console.log(`[SessionService] 🗑 Old session deleted`);
    
    // 2. Accepter normalement (plus de conflit possible)
    //    Si l'envoi échoue, JOIN_SEND_FAILED remonte à Join1to1Screen qui
    //    affichera errors.joinSendFailed. Cf. note edge case ci-dessus.
    return this.acceptInviteAndRespond(inviteString);
  }
  
  /**
   * Finalise la session après réception de la réponse PQXDH
   */
  async finalizeSession(responseString: string): Promise<FinalizeSessionResult> {
    this.ensureInitialized();
    
    
    // Nettoyer l'entrée
    const cleanedInput = responseString
      .trim()
      .replace(/\s+/g, '')
      .replace(/[\r\n]/g, '');
    
    // Décoder la réponse
    let responseData: InviteResponse;
    try {
      const decoded = new TextDecoder().decode(decodeBase64(cleanedInput));
      responseData = JSON.parse(decoded);
    } catch (error) {
      __DEV__ && console.error('[SessionService] Failed to decode response:', error);
      throw new Error('Invalid response format');
    }
    
    __DEV__ && console.log('  - Type: ' + responseData.type + ' v' + responseData.version);
    __DEV__ && console.log('  - From: ' + responseData.profile.displayName);
    
    if (responseData.type !== 'ghostr_accept_pq' || responseData.version !== 2) {
      throw new Error('Unsupported response version');
    }
    
    // Désérialiser le message PQXDH
    const pqxdhMessage = deserializePQXDHMessage(responseData.pqxdhMessage);
    
    __DEV__ && console.log('  - KEM ciphertext size: ' + pqxdhMessage.kemCiphertext.bytes.length + ' bytes');

    // P0: Verify the accepter's identity key is in the Key Transparency log.
    // ACTION-06 (Phase 2 Security): Block on invalid proofs.
    let ktStatusResponder: StoredSession['ktStatus'] = 'error';
    try {
      const accepterKeyB64 = serializePublicKey(pqxdhMessage.identityKey);
      const ktResult = await verifyKeyInTransparencyLog(accepterKeyB64);
      if (ktResult.verified) {
        ktStatusResponder = 'verified';
        __DEV__ && console.log(`[SessionService] 🌳 KT: Accepter's key VERIFIED in transparency log`);
      } else if (!ktResult.inLog) {
        ktStatusResponder = 'not_in_log';
        __DEV__ && console.warn(`[SessionService] 🌳⚠️ KT: Accepter's key NOT FOUND in transparency log`);
      } else if (!ktResult.proofValid) {
        ktStatusResponder = 'invalid_proof';
        throw new Error(
          `KT_INVALID_PROOF: The server provided an invalid Merkle proof for the accepter's identity key. ` +
          `Possible MITM attack. Session finalization blocked.`
        );
      } else if (!ktResult.sthConsistent) {
        ktStatusResponder = 'sth_inconsistent';
        throw new Error(
          `KT_STH_INCONSISTENT: Key Transparency tree appears rewritten. Session finalization blocked.`
        );
      }
    } catch (ktError: any) {
      if (ktError.message?.startsWith('KT_INVALID_PROOF') || ktError.message?.startsWith('KT_STH_INCONSISTENT')) {
        throw ktError;
      }
      ktStatusResponder = 'error';
      __DEV__ && console.warn(`[SessionService] 🌳⚠️ KT verification failed (non-fatal): ${ktError.message}`);
    }
    
    // Trouver les clés correspondantes (actuelles OU archivées)
    const signedPreKey = this.findSignedPreKeyById(pqxdhMessage.usedSignedPreKeyId);
    const pqSignedKey = this.findPQSignedKeyById(pqxdhMessage.usedPQPreKeyId);
    
    if (!signedPreKey) {
      throw new Error(`SignedPreKey id=${pqxdhMessage.usedSignedPreKeyId} not found (current or archived). Keys may have expired.`);
    }
    if (!pqSignedKey) {
      throw new Error(`PQSignedKey id=${pqxdhMessage.usedPQPreKeyId} not found (current or archived). Keys may have expired.`);
    }
    
    const usedOtpk = pqxdhMessage.usedOneTimePreKeyId !== undefined
      ? this.oneTimePreKeys.get(pqxdhMessage.usedOneTimePreKeyId)
      : null;
    
    // Effectuer PQXDH côté répondeur (avec les clés retrouvées)
    const sharedSecret = await pqxdhResponder(
      this.identityKeyPair!,
      signedPreKey,
      pqSignedKey,
      usedOtpk ?? null,
      pqxdhMessage
    );
    
    
    // Supprimer la One-Time PreKey utilisée
    if (pqxdhMessage.usedOneTimePreKeyId !== undefined) {
      this.oneTimePreKeys.delete(pqxdhMessage.usedOneTimePreKeyId);
      this.reservedOtpkIds.delete(pqxdhMessage.usedOneTimePreKeyId); // [Bug #1] Libérer la réservation
      await this.saveOneTimePreKeys();
    }
    
    
    // Initialiser le Triple Ratchet avec la clé éphémère de l'initiateur
    const ratchetState = await initializeTripleRatchetResponder(
      sharedSecret,
      signedPreKey.keyPair,
      pqxdhMessage.ephemeralKey, // Clé éphémère de l'initiateur (Bob)
      sharedSecret.bytes, // Secret PQ pour SPQR
      this.config
    );
    
    
    // Générer l'ID de session
    const sessionId = this.generateSessionId(pqxdhMessage.identityKey);
    
    // [Bug #2] Vérifier si une session existe déjà avec cette identity key
    const existingSession = this.sessions.get(sessionId);
    if (existingSession) {
      if (existingSession.tag === responseData.tag) {
        // Même tag = doublon (même accept traité deux fois) → ignorer
        __DEV__ && console.log(`[SessionService] ⚠️ finalizeSession: duplicate accept on same tag, skipping (session ${sessionId})`);
        return { session: existingSession };
      }
      // Tag différent = même personne via nouvelle invitation → remplacement
      // Le nouveau PQXDH produit un secret frais, l'ancien ratchet est de toute façon désync
      __DEV__ && console.log(`[SessionService] 🔄 finalizeSession: replacing session ${sessionId} (old tag → new tag)`);
      const oldState = this.ratchetStates.get(sessionId);
      if (oldState) {
        cleanupTripleRatchetState(oldState);
        this.ratchetStates.delete(sessionId);
      }
    }
    
    // Créer la session
    const session: StoredSession = {
      version: 2,
      id: sessionId,
      myIdentityKeyFingerprint: this.getMyShortFingerprint(),
      theirIdentityKey: serializePublicKey(pqxdhMessage.identityKey),
      theirIdentityKeyFingerprint: bytesToHex(pqxdhMessage.identityKey.bytes).substring(0, 16),
      theirProfile: responseData.profile,
      tripleRatchetState: serializeTripleRatchetState(ratchetState),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      isInitiator: false,
      messagesSent: 0,
      messagesReceived: 0,
      tag: responseData.tag,
      isPostQuantum: true,
      ktStatus: ktStatusResponder,
    };
    
    // Stocker la session (écrase proprement si remplacement)
    await this.saveSession(session);
    this.ratchetStates.set(sessionId, ratchetState);
    
    // ACTION 01 (CRITIQUE-04): Verify and pin the joiner's identity key.
    // First contact → stores key. Key change → emits alert to UI.
    await this.verifyContactKey(
      sessionId,
      session.theirIdentityKey,
      responseData.profile.displayName || 'Unknown'
    );
    
    // Régénérer les PreKeys
    await this.replenishOneTimePreKeys();
    
    
    return { session };
  }
  
  // ==========================================
  // CHIFFREMENT / DÉCHIFFREMENT
  // ==========================================
  
  /**
   * Chiffre un message pour une session (Triple Ratchet)
   */
  async encryptMessageForSession(
    sessionId: string,
    plaintext: string
  ): Promise<string> {
    // Attendre que toute opération crypto en cours termine
    while (this.cryptoLocks.has(sessionId)) {
      await this.cryptoLocks.get(sessionId).catch(() => {});
    }
    const promise = this._doEncrypt(sessionId, plaintext);
    this.cryptoLocks.set(sessionId, promise);
    let counterUpdate: (() => Promise<void>) | null = null;
    try {
      const { result, pendingCounterUpdate } = await promise;
      counterUpdate = pendingCounterUpdate;
      return result;
    } finally {
      // Libérer le lock AVANT updateSendCounter pour éviter que le Keystore
      // Android bloqué (jusqu'à 3s de timeout) retarde tous les encrypts suivants.
      this.cryptoLocks.delete(sessionId);
      // Mettre à jour le compteur monotone hors du lock (best-effort, non-bloquant)
      if (counterUpdate) {
        counterUpdate().catch(() => {});
      }
    }
  }
  
  private async _doEncrypt(
    sessionId: string,
    plaintext: string
  ): Promise<{ result: string; pendingCounterUpdate: (() => Promise<void>) | null }> {
    this.ensureInitialized();
    
    // Charger l'état du ratchet
    let state = await this.loadRatchetState(sessionId);
    if (!state) {
      throw new Error('Session not found');
    }
    
    
    // R-02 + GH-07: Protection contre la réutilisation de nonce après rollback d'état.
    // Les nonces Triple Ratchet sont déterministes: HMAC(messageKey, msgNum || dir).
    // Si l'état est restauré depuis une sauvegarde, messageNumberSend peut revenir
    // en arrière → même (clé, nonce) → XOR plaintexts révélé.
    //
    // GH-07: Si SecureStore est indisponible (timeout), on force AUSSI un DH ratchet
    // plutôt que de continuer en best-effort (risque de nonce reuse).
    //
    // IMPORTANT: Le compteur est LIÉ à la clé d'envoi courante (sendingRatchetKey).
    // Un DH ratchet légitime remet messageNumberSend à 0 avec une NOUVELLE paire de
    // clés → il ne faut PAS considérer cela comme un rollback.
    // On utilise donc la clé comme discriminant: `sessionId_keyHex16`.
    if (state.sendingRatchetKey) {
      const keyHex16 = bytesToHex(state.sendingRatchetKey.publicKey.bytes).slice(0, 16);
      const counterKey = `${sessionId}_${keyHex16}`;
      const check = await verifySendCounter(counterKey, state.messageNumberSend);
      if (check.mustForceDHRatchet) {
        __DEV__ && console.warn(
          `[R-02/GH-07] Session ${sessionId.slice(0, 8)}: ` +
          (check.verified
            ? `messageNumberSend (${state.messageNumberSend}) < storedCounter (${check.storedCounter}) — rollback detected`
            : `SecureStore unavailable — cannot verify counter`) +
          ` → forcing DH ratchet for nonce safety.`
        );
        state = { ...state, sendingChainKey: null };
      }
    }

    // Chiffrer avec Triple Ratchet (padding automatique)
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const { message, newState } = await tripleRatchetEncrypt(state, plaintextBytes);
    
    // Mettre à jour l'état
    this.ratchetStates.set(sessionId, newState);
    
    // R-02: Préparer la mise à jour du compteur monotone.
    // Retourné sous forme de closure pour être exécuté HORS du cryptoLock
    // (le Keystore Android peut bloquer jusqu'à 3s → libérer le lock avant).
    let pendingCounterUpdate: (() => Promise<void>) | null = null;
    if (newState.sendingRatchetKey) {
      const keyHex16 = bytesToHex(newState.sendingRatchetKey.publicKey.bytes).slice(0, 16);
      const counterKey = `${sessionId}_${keyHex16}`;
      const msgNum = newState.messageNumberSend;
      pendingCounterUpdate = () => updateSendCounter(counterKey, msgNum);
    }
    
    // Sauvegarder
    const session = this.sessions.get(sessionId);
    if (session) {
      session.tripleRatchetState = serializeTripleRatchetState(newState);
      session.lastActivityAt = Date.now();
      session.messagesSent++;
      await this.saveSession(session);
      
      // Log périodique
      if (session.messagesSent % 10 === 0) {
      }
    }
    
    // Sérialiser le message chiffré
    const encryptedMessage: EncryptedMessage = {
      version: 2,
      message,
      timestamp: Date.now(),
    };
    
    return { result: JSON.stringify(encryptedMessage), pendingCounterUpdate };
  }
  
  /**
   * Déchiffre un message reçu (Triple Ratchet)
   */
  async decryptMessageForSession(
    sessionId: string,
    encryptedMessageJson: string
  ): Promise<string | null> {
    // Attendre que toute opération crypto en cours termine
    while (this.cryptoLocks.has(sessionId)) {
      await this.cryptoLocks.get(sessionId).catch(() => {});
    }
    const promise = this._doDecrypt(sessionId, encryptedMessageJson);
    this.cryptoLocks.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.cryptoLocks.delete(sessionId);
    }
  }
  
  private async _doDecrypt(
    sessionId: string,
    encryptedMessageJson: string
  ): Promise<string | null> {
    this.ensureInitialized();
    
    // Charger l'état du ratchet
    let state = await this.loadRatchetState(sessionId);
    if (!state) {
      throw new Error('Session not found');
    }
    
    // Désérialiser le message
    const encryptedMessage: EncryptedMessage = JSON.parse(encryptedMessageJson);
    
    if (encryptedMessage.version !== 2) {
      throw new Error('Unsupported message version');
    }
    
    
    // Déchiffrer avec Triple Ratchet
    // SÉCURITÉ CRITIQUE: tripleRatchetDecrypt fait un shallow copy de l'état,
    // mais les objets imbriqués (skippedKeys Map, SPQR) sont des références partagées.
    // Si le header se déchiffre mais le body échoue (ex: notre propre message),
    // les mutations corrompent l'état original via les références.
    // → Sauvegarder un snapshot sérialisé AVANT et restaurer sur échec.
    const stateSnapshot = serializeTripleRatchetState(state);
    
    try {
      const { result, newState } = await tripleRatchetDecrypt(
        state,
        encryptedMessage.message
      );
      
      // Mettre à jour l'état
      this.ratchetStates.set(sessionId, newState);
      
      // Sauvegarder
      const session = this.sessions.get(sessionId);
      if (session) {
        session.tripleRatchetState = serializeTripleRatchetState(newState);
        session.lastActivityAt = Date.now();
        session.messagesReceived++;
        await this.saveSession(session);
        
        // Log périodique
        if (session.messagesReceived % 10 === 0) {
        }
      }
      
      return new TextDecoder().decode(result.plaintext);
    } catch (error) {
      __DEV__ && console.error('[SessionService] ❌ Decryption failed:', error);
      
      // RESTAURER l'état du ratchet à partir du snapshot
      // Empêche la corruption par les mutations du shallow copy
      try {
        const restoredState = deserializeTripleRatchetState(stateSnapshot);
        this.ratchetStates.set(sessionId, restoredState);
        __DEV__ && console.log('[SessionService] 🔄 Ratchet state restored after failed decryption');
      } catch (restoreError) {
        __DEV__ && console.error('[SessionService] ❌ Failed to restore ratchet state:', restoreError);
      }
      
      return null;
    }
  }
  
  // ==========================================
  // GESTION DES SESSIONS
  // ==========================================
  
  /**
   * Génère un ID de session unique
   */
  private generateSessionId(theirIdentityKey: Ed25519PublicKey): string {
    const myFingerprint = this.getMyShortFingerprint();
    const theirFingerprint = bytesToHex(theirIdentityKey.bytes).substring(0, 16);
    const parts = [myFingerprint, theirFingerprint].sort();
    return `session_v2_${parts[0]}_${parts[1]}`;
  }
  
  /**
   * Charge l'état du ratchet pour une session
   */
  private async loadRatchetState(sessionId: string): Promise<TripleRatchetState | null> {
    // D'abord chercher en mémoire
    if (this.ratchetStates.has(sessionId)) {
      return this.ratchetStates.get(sessionId)!;
    }
    
    // Sinon charger depuis le stockage
    const session = this.sessions.get(sessionId);
    if (!session) {
      await this.loadSession(sessionId);
      const loadedSession = this.sessions.get(sessionId);
      if (!loadedSession) {
        return null;
      }
    }
    
    const currentSession = this.sessions.get(sessionId);
    if (!currentSession) return null;
    
    const state = deserializeTripleRatchetState(currentSession.tripleRatchetState);
    this.ratchetStates.set(sessionId, state);
    
    return state;
  }
  
  /**
   * Charge l'index des sessions
   */
  private async loadSessionsIndex(): Promise<void> {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEYS.SESSIONS);
      if (stored) {
        let idsJson: string;
        if (stored.startsWith('enc1:')) {
          // FIX migration: si la clé n'est pas (encore) en RAM, NE PAS tenter
          // le déchiffrement (qui throw) et NE PAS toucher au stockage. La
          // recovery via tryRecoverFromPreFixBug ou la promotion explicite
          // (promoteHardwareKeyToDeviceKey) interviendra ensuite. Avant ce
          // fix, le catch global laissait passer sans removeItem, donc OK,
          // mais le warning ci-dessous rend le diagnostic explicite.
          if (!localCryptoHasAnyKey()) {
            __DEV__ && console.warn(
              '[SessionService] ⏳ Sessions index encrypted but no key in RAM — ' +
              'deferring load (will be retried after key bootstrap)'
            );
            return;
          }
          // Static import used (localCryptoDecrypt)
          idsJson = localCryptoDecrypt(stored);
        } else if (await wasLockEverConfigured()) {
          // PIN was set → plaintext data should not exist → corrupt/tampered.
          // FIX migration: on n'agit que si on a la clé en RAM (preuve qu'on
          // est dans un état "unlocked stable", pas un boot incomplet). Sans
          // ce garde-fou, un faux positif du cache `_lockConfiguredCache` post-
          // nuclearReset pouvait conduire à la suppression de données valides.
          if (!localCryptoHasAnyKey()) {
            __DEV__ && console.warn(
              '[SessionService] Plaintext sessions index found but no key in RAM ' +
              'and PIN cache says configured — refusing to delete (likely stale cache)'
            );
            return;
          }
          __DEV__ && console.error('[SessionService] ❌ REJECTED unencrypted session index (PIN was configured)');
          await AsyncStorage.removeItem(STORAGE_KEYS.SESSIONS);
          return;
        } else {
          // PIN never set → plaintext is expected
          idsJson = stored;
        }
        
        const ids: string[] = JSON.parse(idsJson);
        // PERF A7: Charger les sessions en parallèle au lieu de séquentiellement.
        // Chaque loadSession est indépendant (clé AsyncStorage différente, entrée Map
        // différente). Les JSON.parse et déchiffrements XSalsa20 s'exécutent en
        // parallèle sur le thread JS entre les yields AsyncStorage.
        // Avec 10 sessions : ~500ms séquentiel → ~100ms parallèle.
        await Promise.all(ids.map(id => this.loadSession(id)));
      }
    } catch (error) {
      __DEV__ && console.error('[SessionService] Error loading sessions index:', error);
    }
  }
  
  /**
   * Charge une session depuis le stockage
   */
  private async loadSession(sessionId: string): Promise<void> {
    try {
      const stored = await AsyncStorage.getItem(
        STORAGE_KEYS.SESSION_PREFIX + sessionId
      );
      if (stored) {
        let sessionJson: string;
        
        if (stored.startsWith('enc1:')) {
          // FIX migration: garde explicite — si aucune clé en RAM, on diffère.
          // Sans ce check, `localCryptoDecrypt` throw → tombe dans le catch
          // global → log seulement (pas de removeItem, OK), mais le diagnostic
          // est meilleur ici.
          if (!localCryptoHasAnyKey()) {
            __DEV__ && console.warn(
              `[SessionService] ⏳ Session ${sessionId.slice(0, 12)}... encrypted ` +
              'but no key in RAM — deferring load'
            );
            return;
          }
          // Static import used (localCryptoDecrypt)
          sessionJson = localCryptoDecrypt(stored);
        } else if (await wasLockEverConfigured()) {
          // FIX migration: protection contre faux positif du cache _lockConfiguredCache
          // (cf. loadSessionsIndex pour le rationale complet).
          if (!localCryptoHasAnyKey()) {
            __DEV__ && console.warn(
              `[SessionService] Plaintext session ${sessionId.slice(0, 12)}... ` +
              'with PIN-configured cache but no key in RAM — refusing to delete'
            );
            return;
          }
          // PIN was set → plaintext session = corrupt/tampered
          __DEV__ && console.error(`[SessionService] ❌ REJECTED unencrypted session ${sessionId} (PIN was configured)`);
          await AsyncStorage.removeItem(STORAGE_KEYS.SESSION_PREFIX + sessionId);
          return;
        } else {
          // PIN never set → plaintext is expected
          sessionJson = stored;
        }
        
        const session: StoredSession = JSON.parse(sessionJson);
        this.sessions.set(sessionId, session);
      }
    } catch (error) {
      __DEV__ && console.error(`[SessionService] Error loading session ${sessionId}:`, error);
    }
  }
  
  /**
   * Sauvegarde une session
   * ACTION 07: Le chiffrement local est OBLIGATOIRE pour les sessions.
   * Les clés Triple Ratchet + SPQR ne sont JAMAIS stockées en clair.
   */
  private async saveSession(session: StoredSession): Promise<void> {
    this.sessions.set(session.id, session);
    
    const serialized = JSON.stringify(session);
    
    // ACTION 07: Importer et vérifier le chiffrement local
    // Static import used
    
    let dataToStore: string;
    if (localCryptoIsEnabled()) {
      // Chiffrer avec XSalsa20-Poly1305 via localCrypto
      dataToStore = localCryptoEncrypt(serialized);
    } else if (await wasLockEverConfigured()) {
      // PIN était configuré mais la clé n'est plus en mémoire → danger
      throw new Error('ENCRYPTION_KEY_LOST: PIN was configured but encryption key is unavailable. Unlock the app first.');
    } else {
      // P2 FIX: Ce cas ne devrait PLUS arriver grâce à ensureDeviceLevelEncryption()
      // appelé dans initialize(). Si on arrive ici, c'est un bug — on refuse de
      // stocker en clair plutôt que d'exposer les clés Triple Ratchet.
      __DEV__ && console.error('[SessionService] 🚨 CRITICAL: No encryption key available — this should not happen');
      __DEV__ && console.error('[SessionService] Calling ensureDeviceLevelEncryption as emergency fallback');
      await ensureDeviceLevelEncryption();
      
      // Re-vérifier après le bootstrap d'urgence
      // Static import used
      if (localCryptoIsEnabled()) {
        dataToStore = localCryptoEncrypt(serialized);
      } else {
        throw new Error('ENCRYPTION_UNAVAILABLE: Cannot save session without encryption. Device keystore may be unavailable.');
      }
    }
    
    // AsyncStorage au lieu de SecureStore : l'état Triple Ratchet + SPQR
    // fait 4-8 KB, bien au-delà de la limite SecureStore (2048 bytes).
    await AsyncStorage.setItem(
      STORAGE_KEYS.SESSION_PREFIX + session.id,
      dataToStore
    );
    
    const ids = Array.from(this.sessions.keys());
    // BUG FIX: Chiffrer l'index des sessions (sinon le nombre de conversations est visible sur disque)
    const idsJson = JSON.stringify(ids);
    const idsToStore = localCryptoIsEnabled() ? localCryptoEncrypt(idsJson) : idsJson;
    await AsyncStorage.setItem(STORAGE_KEYS.SESSIONS, idsToStore);
  }
  
  /**
   * Récupère toutes les sessions
   */
  getAllSessions(): StoredSession[] {
    return Array.from(this.sessions.values());
  }
  
  /**
   * Récupère une session par ID
   */
  getSession(sessionId: string): StoredSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Vérifie si une session existe
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
  
  /**
   * Supprime une session
   * [Bug #5] NE supprime PAS l'invite de pendingInviteStore — nécessaire pour
   * permettre la re-finalisation (Bug #3) si le contact re-scanne après suppression.
   * L'invite reste avec status 'accepted' mais hasSession() retournera false,
   * ce qui est détecté par getOrphanAcceptedTags() dans inviteWatcher.
   * Les invites expirées sont nettoyées automatiquement par cleanupExpired().
   */
  async deleteSession(sessionId: string): Promise<void> {
    // Cleanup du ratchet state
    const state = this.ratchetStates.get(sessionId);
    if (state) {
      cleanupTripleRatchetState(state);
      this.ratchetStates.delete(sessionId);
    }
    
    this.sessions.delete(sessionId);
    
    await AsyncStorage.removeItem(STORAGE_KEYS.SESSION_PREFIX + sessionId);
    
    // R-02: Supprimer le compteur monotone de cette session
    await deleteSendCounter(sessionId);
    
    const ids = Array.from(this.sessions.keys());
    // BUG FIX: Chiffrer l'index des sessions
    // Static import used
    const idsJson = JSON.stringify(ids);
    const idsToStore = localCryptoIsEnabled() ? localCryptoEncrypt(idsJson) : idsJson;
    await AsyncStorage.setItem(STORAGE_KEYS.SESSIONS, idsToStore);
    
    __DEV__ && console.log(`[SessionService] 🗑 Session ${sessionId} deleted (invite preserved for potential re-connection)`);
  }
  
  /**
   * Met à jour le profil d'un contact
   */
  async updateContactProfile(sessionId: string, profile: Partial<UserProfile>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      __DEV__ && console.warn('[SessionService] Session not found for profile update:', sessionId);
      return;
    }
    
    // Mettre à jour le profil du contact
    session.theirProfile = { ...session.theirProfile, ...profile };
    session.lastActivityAt = Date.now();
    
    // Sauvegarder la session
    await this.saveSession(session);
  }
  
  // ==========================================
  // KEY LOOKUP (current + archived)
  // ==========================================
  
  /**
   * Retrouve une SignedPreKey par ID.
   * Cherche d'abord la clé courante, puis dans les archives.
   * Essentiel pour les invitations asynchrones (QR pré-générés).
   */
  findSignedPreKeyById(id: number): SignedPreKey | null {
    if (this.signedPreKey && this.signedPreKey.id === id) {
      return this.signedPreKey;
    }
    const archived = this.oldSignedPreKeys.get(id);
    if (archived) {
      __DEV__ && console.log(`[SessionService] Found archived SignedPreKey id=${id} (saved ${Math.round((Date.now() - archived.savedAt) / 86400000)}d ago)`);
      return archived.key;
    }
    return null;
  }
  
  /**
   * Retrouve une PQSignedKey par ID.
   * Cherche d'abord la clé courante, puis dans les archives.
   */
  findPQSignedKeyById(id: number): PQSignedKey | null {
    if (this.pqSignedKey && this.pqSignedKey.id === id) {
      return this.pqSignedKey;
    }
    const archived = this.oldPQSignedKeys.get(id);
    if (archived) {
      __DEV__ && console.log(`[SessionService] Found archived PQSignedKey id=${id} (saved ${Math.round((Date.now() - archived.savedAt) / 86400000)}d ago)`);
      return archived.key;
    }
    return null;
  }
  
  // ==========================================
  // RESET & CLEANUP
  // ==========================================

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * VERROUILLAGE EN MÉMOIRE — Zéroisation complète sans toucher au stockage
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Appelée par le handler de verrouillage (App.tsx → onConfirmedBackground
   * ou retour shouldLock). Elle :
   *   - Zéroise toutes les clés privées (identité long terme, pre-keys classiques
   *     et post-quantiques, anciennes clés archivées).
   *   - Zéroise tous les états de ratchet actifs (rootKey, chainKeys, headerKeys,
   *     clés sautées et état SPQR — via cleanupTripleRatchetState).
   *   - Vide toutes les Maps (sessions, ratchetStates, cryptoLocks, reservedOtpkIds).
   *   - Marque `initialized = false` pour forcer un rechargement complet depuis
   *     le stockage chiffré au prochain déverrouillage.
   *
   * Le stockage persistant (SecureStore/AsyncStorage) n'est PAS touché — les
   * données y restent chiffrées avec la clé dérivée du mot de passe utilisateur
   * (qui vient d'être effacée de la RAM). Sans le mot de passe, elles sont
   * inaccessibles.
   *
   * Différence avec clearAllData() : clearAllData supprime aussi le stockage
   * (reset complet, perte définitive des données). lockMemory() n'affecte
   * que la RAM.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  lockMemory(): void {
    try {
      // ── Zéroiser tous les états de ratchet actifs ───────────────────────
      for (const state of this.ratchetStates.values()) {
        try { cleanupTripleRatchetState(state); } catch {}
      }
      this.ratchetStates.clear();

      // ── Zéroiser l'identity key pair (Ed25519 + X25519 dérivée) ─────────
      if (this.identityKeyPair) {
        try { zeroize(this.identityKeyPair.privateKey.bytes); } catch {}
        try { zeroize(this.identityKeyPair.dhPrivateKey.bytes); } catch {}
      }
      this.identityKeyPair = null;

      // ── Zéroiser la signed pre-key courante ─────────────────────────────
      if (this.signedPreKey) {
        try { zeroize(this.signedPreKey.keyPair.privateKey.bytes); } catch {}
      }
      this.signedPreKey = null;

      // ── Zéroiser toutes les one-time pre-keys ───────────────────────────
      for (const otpk of this.oneTimePreKeys.values()) {
        try { zeroize(otpk.keyPair.privateKey.bytes); } catch {}
      }
      this.oneTimePreKeys.clear();

      // ── Zéroiser la clé PQ signed courante (ML-KEM) ─────────────────────
      if (this.pqSignedKey) {
        try { zeroize(this.pqSignedKey.keyPair.secretKey.bytes); } catch {}
      }
      this.pqSignedKey = null;

      // ── Zéroiser les anciennes signed pre-keys archivées ────────────────
      for (const entry of this.oldSignedPreKeys.values()) {
        try { zeroize(entry.key.keyPair.privateKey.bytes); } catch {}
      }
      this.oldSignedPreKeys.clear();

      // ── Zéroiser les anciennes PQ signed keys archivées ─────────────────
      for (const entry of this.oldPQSignedKeys.values()) {
        try { zeroize(entry.key.keyPair.secretKey.bytes); } catch {}
      }
      this.oldPQSignedKeys.clear();

      // ── Vider les sessions (pas de clés secrètes dedans, mais des méta-
      //    données : fingerprints, noms, avatars qu'on ne veut pas en RAM) ─
      this.sessions.clear();

      // ── Vider les verrous et réservations ───────────────────────────────
      this.cryptoLocks.clear();
      this.reservedOtpkIds.clear();

      // ── Forcer un rechargement depuis le stockage chiffré au déverrouillage
      this.initialized = false;

      // NOTE: on ne touche PAS `myProfile` (nom + avatar sont du non-secret
      // déjà affichable sur le LockScreen et dans l'App Switcher masqué).
      // NOTE: on ne vide PAS `profileChangeListeners` ni les autres listeners :
      // ils sont attachés par des composants React toujours montés, et vider
      // les sets les casserait pour la durée de la session.

      __DEV__ && console.log('[SessionService] 🔒 Memory locked (keys zeroized)');
    } catch (error) {
      __DEV__ && console.error('[SessionService] lockMemory error:', error);
    }
  }

  /**
   * Supprime toutes les données (pour reset complet)
   */
  async clearAllData(): Promise<void> {
    
    try {
      // Cleanup de tous les états de ratchet
      for (const state of this.ratchetStates.values()) {
        cleanupTripleRatchetState(state);
      }
      
      // Supprimer toutes les sessions
      for (const sessionId of this.sessions.keys()) {
        try { await AsyncStorage.removeItem(STORAGE_KEYS.SESSION_PREFIX + sessionId); } catch {}
      }
      
      // Supprimer les clés d'identité (SecureStore — petites, hardware-backed)
      try { await SecureStore.deleteItemAsync(STORAGE_KEYS.IDENTITY_KEY_PAIR); } catch {}
      try { await SecureStore.deleteItemAsync(STORAGE_KEYS.SIGNED_PRE_KEY); } catch {}
      
      // Supprimer les grosses clés (AsyncStorage)
      try { await AsyncStorage.removeItem(STORAGE_KEYS.ONE_TIME_PRE_KEYS); } catch {}
      try { await AsyncStorage.removeItem(STORAGE_KEYS.PQ_SIGNED_KEY); } catch {}
      
      // Supprimer les données AsyncStorage (sauf le profil)
      try { await AsyncStorage.removeItem(STORAGE_KEYS.SESSIONS); } catch {}
      // NOTE: On conserve MY_PROFILE pour garder le nom/avatar après reset
      // try { await AsyncStorage.removeItem(STORAGE_KEYS.MY_PROFILE); } catch {}
      try { await AsyncStorage.removeItem(STORAGE_KEYS.NEXT_PRE_KEY_ID); } catch {}
      try { await AsyncStorage.removeItem(STORAGE_KEYS.NEXT_PQ_KEY_ID); } catch {}
      try { await AsyncStorage.removeItem(STORAGE_KEYS.OLD_SIGNED_PRE_KEYS); } catch {}
      try { await AsyncStorage.removeItem(STORAGE_KEYS.OLD_PQ_SIGNED_KEYS); } catch {}
      
      // BUG FIX #10: Nettoyer le cache Key Transparency (STH + registration).
      // Quand les identity keys sont régénérées, le STH cache est périmé.
      // Sans ce nettoyage, la re-registration produit un nouveau rootHash
      // avec le même treeSize → checkSTHConsistency détecte un faux positif
      // de "LEAF MODIFICATION" et bloque toutes les finalisations de session.
      try { await AsyncStorage.removeItem('ghostr_kt_sth_latest'); } catch {}
      try { await AsyncStorage.removeItem('ghostr_kt_my_registration'); } catch {}
      
      // Vider les caches en mémoire (sauf le profil)
      this.sessions.clear();
      this.ratchetStates.clear();
      this.cryptoLocks.clear();
      this.oneTimePreKeys.clear();
      this.oldSignedPreKeys.clear();
      this.oldPQSignedKeys.clear();
      this.identityKeyPair = null;
      this.signedPreKey = null;
      this.pqSignedKey = null;
      this.initialized = false;
      // NOTE: On ne réinitialise PAS this.myProfile pour conserver le profil
      
    } catch (error) {
      __DEV__ && console.error('[SessionService] Error clearing data:', error);
    }
  }
  
  // ==========================================
  // RECHERCHE DE SESSIONS
  // ==========================================
  
  /**
   * v18.0: Trouve une session par le fingerprint de l'identité distante
   */
  findSessionByFingerprint(fingerprint: string): StoredSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.theirIdentityKeyFingerprint === fingerprint ||
          session.theirIdentityKeyFingerprint.startsWith(fingerprint) ||
          fingerprint.startsWith(session.theirIdentityKeyFingerprint)) {
        return session;
      }
    }
    return undefined;
  }
  
  /**
   * v18.0: Trouve une session par le nom d'affichage
   */
  findSessionByDisplayName(displayName: string): StoredSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.theirProfile?.displayName === displayName) {
        return session;
      }
    }
    return undefined;
  }
  
  /**
   * v18.0: Trouve une session qui pourrait correspondre à un userId
   * Cherche dans l'ID de session, le fingerprint, le nom, ou l'originalUserId
   */
  findSessionByAnyId(userId: string): StoredSession | undefined {
    // 1. Recherche directe par sessionId
    const direct = this.sessions.get(userId);
    if (direct) return direct;
    
    // 2. Recherche par ID partiel (le userId pourrait être un préfixe)
    for (const [sessionId, session] of this.sessions) {
      if (sessionId.includes(userId) || userId.includes(sessionId)) {
        return session;
      }
    }
    
    // 3. v19.0: Recherche par originalUserId (pour sessions créées via PQXDH bundle)
    for (const session of this.sessions.values()) {
      if (session.originalUserId && session.originalUserId === userId) {
        return session;
      }
    }
    
    // 4. Recherche par fingerprint
    const byFingerprint = this.findSessionByFingerprint(userId);
    if (byFingerprint) return byFingerprint;
    
    return undefined;
  }
  
  /**
   * v25.0: Archive la clé actuelle avant rotation
   * Appelé automatiquement lors de la rotation des clés
   */
  private async archiveCurrentKeys(): Promise<void> {
    const now = Date.now();
    let changed = false;
    
    // Archiver SignedPreKey si elle existe et n'est pas déjà archivée
    if (this.signedPreKey && !this.oldSignedPreKeys.has(this.signedPreKey.id)) {
      this.oldSignedPreKeys.set(this.signedPreKey.id, {
        key: this.signedPreKey,
        savedAt: now,
      });
      changed = true;
    }
    
    // Archiver PQSignedKey si elle existe et n'est pas déjà archivée
    if (this.pqSignedKey && !this.oldPQSignedKeys.has(this.pqSignedKey.id)) {
      this.oldPQSignedKeys.set(this.pqSignedKey.id, {
        key: this.pqSignedKey,
        savedAt: now,
      });
      changed = true;
    }
    
    if (changed) {
      // Nettoyer les anciennes clés expirées
      await this.cleanupOldKeys();
      
      // Persister
      await this.persistOldKeys();
    }
  }

  /**
   * v25.0: Nettoie les anciennes clés expirées
   */
  private async cleanupOldKeys(): Promise<void> {
    const now = Date.now();
    const maxAge = SessionService.OLD_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    
    // Nettoyer SignedPreKeys
    for (const [id, entry] of this.oldSignedPreKeys) {
      if (now - entry.savedAt > maxAge) {
        this.oldSignedPreKeys.delete(id);
        __DEV__ && console.log(`[SessionService] Cleaned up old SignedPreKey id=${id}`);
      }
    }
    
    // Limiter le nombre
    if (this.oldSignedPreKeys.size > SessionService.MAX_OLD_KEYS) {
      const sorted = Array.from(this.oldSignedPreKeys.entries())
        .sort((a, b) => a[1].savedAt - b[1].savedAt);
      const toDelete = sorted.slice(0, sorted.length - SessionService.MAX_OLD_KEYS);
      for (const [id] of toDelete) {
        this.oldSignedPreKeys.delete(id);
      }
    }
    
    // Nettoyer PQSignedKeys
    for (const [id, entry] of this.oldPQSignedKeys) {
      if (now - entry.savedAt > maxAge) {
        this.oldPQSignedKeys.delete(id);
        __DEV__ && console.log(`[SessionService] Cleaned up old PQSignedKey id=${id}`);
      }
    }
    
    // Limiter le nombre
    if (this.oldPQSignedKeys.size > SessionService.MAX_OLD_KEYS) {
      const sorted = Array.from(this.oldPQSignedKeys.entries())
        .sort((a, b) => a[1].savedAt - b[1].savedAt);
      const toDelete = sorted.slice(0, sorted.length - SessionService.MAX_OLD_KEYS);
      for (const [id] of toDelete) {
        this.oldPQSignedKeys.delete(id);
      }
    }
  }

  /**
   * v25.0: Persiste les anciennes clés
   */
  private async persistOldKeys(): Promise<void> {
    try {
      // SignedPreKeys
      const signedData: Record<number, { keyData: any; savedAt: number }> = {};
      for (const [id, entry] of this.oldSignedPreKeys) {
        signedData[id] = {
          keyData: {
            id: entry.key.id,
            keyPair: {
              publicKey: serializePublicKey(entry.key.keyPair.publicKey),
              privateKey: bytesToHex(entry.key.keyPair.privateKey.bytes),
            },
            signature: encodeBase64(entry.key.signature.bytes),
            timestamp: entry.key.timestamp,
          },
          savedAt: entry.savedAt,
        };
      }
      await AsyncStorage.setItem(STORAGE_KEYS.OLD_SIGNED_PRE_KEYS, JSON.stringify(signedData));
      
      // PQSignedKeys
      const pqData: Record<number, { keyData: any; savedAt: number }> = {};
      for (const [id, entry] of this.oldPQSignedKeys) {
        pqData[id] = {
          keyData: {
            id: entry.key.id,
            keyPair: {
              publicKey: encodeBase64(entry.key.keyPair.publicKey.bytes),
              secretKey: encodeBase64(entry.key.keyPair.secretKey.bytes),
            },
            signature: encodeBase64(entry.key.signature.bytes),
            timestamp: entry.key.timestamp,
          },
          savedAt: entry.savedAt,
        };
      }
      await AsyncStorage.setItem(STORAGE_KEYS.OLD_PQ_SIGNED_KEYS, JSON.stringify(pqData));
      
      __DEV__ && console.log(`[SessionService] Persisted ${this.oldSignedPreKeys.size} old SignedPreKeys, ${this.oldPQSignedKeys.size} old PQSignedKeys`);
    } catch (error) {
      __DEV__ && console.error('[SessionService] Failed to persist old keys:', error);
    }
  }

  /**
   * v25.0: Charge les anciennes clés depuis le stockage
   */
  private async loadOldKeys(): Promise<void> {
    try {
      // SignedPreKeys
      const signedJson = await AsyncStorage.getItem(STORAGE_KEYS.OLD_SIGNED_PRE_KEYS);
      if (signedJson) {
        const signedData = JSON.parse(signedJson);
        for (const [idStr, entry] of Object.entries(signedData) as any[]) {
          const id = parseInt(idStr);
          const key: SignedPreKey = {
            id: entry.keyData.id,
            keyPair: {
              publicKey: deserializeX25519PublicKey(entry.keyData.keyPair.publicKey),
              privateKey: { _brand: 'X25519PrivateKey', bytes: hexToBytes(entry.keyData.keyPair.privateKey) },
            },
            signature: { _brand: 'Ed25519Signature', bytes: decodeBase64(entry.keyData.signature) },
            timestamp: entry.keyData.timestamp,
          };
          this.oldSignedPreKeys.set(id, { key, savedAt: entry.savedAt });
        }
      }
      
      // PQSignedKeys
      const pqJson = await AsyncStorage.getItem(STORAGE_KEYS.OLD_PQ_SIGNED_KEYS);
      if (pqJson) {
        const pqData = JSON.parse(pqJson);
        for (const [idStr, entry] of Object.entries(pqData) as any[]) {
          const id = parseInt(idStr);
          const key: PQSignedKey = {
            id: entry.keyData.id,
            keyPair: {
              publicKey: { _brand: 'KyberPublicKey', bytes: decodeBase64(entry.keyData.keyPair.publicKey) },
              secretKey: { _brand: 'KyberSecretKey', bytes: decodeBase64(entry.keyData.keyPair.secretKey) },
            },
            signature: { _brand: 'Ed25519Signature', bytes: decodeBase64(entry.keyData.signature) },
            timestamp: entry.keyData.timestamp,
          };
          this.oldPQSignedKeys.set(id, { key, savedAt: entry.savedAt });
        }
      }
      
      __DEV__ && console.log(`[SessionService] Loaded ${this.oldSignedPreKeys.size} old SignedPreKeys, ${this.oldPQSignedKeys.size} old PQSignedKeys`);
    } catch (error) {
      __DEV__ && console.error('[SessionService] Failed to load old keys:', error);
    }
  }


  // ==========================================
  // DEBUG
  // ==========================================
  
  /**
   * Informations de debug
   */
  getDebugInfo(): object {
    return {
      initialized: this.initialized,
      identityFingerprint: this.getMyShortFingerprint(),
      signedPreKeyId: this.signedPreKey?.id,
      pqSignedKeyId: this.pqSignedKey?.id,
      oneTimePreKeysCount: this.oneTimePreKeys.size,
      sessionsCount: this.sessions.size,
      isPostQuantum: true,
      version: 2,
    };
  }

  // ============================================
  // OPTION 3: Re-chiffrement des données quand le PIN est activé
  // ============================================
  
  /**
   * Re-chiffre toutes les données en clair avec la clé maintenant disponible.
   * À appeler après setupLock() quand le PIN est configuré pour la première fois.
   */
  async reEncryptAllPlaintextData(): Promise<void> {
    // Static import used
    if (!localCryptoIsEnabled()) {
      __DEV__ && console.warn('[SessionService] reEncrypt called but encryption not enabled');
      return;
    }
    
    __DEV__ && console.log('[SessionService] 🔐 Re-encrypting all plaintext data...');
    let count = 0;
    
    // 1. Session index
    const indexStored = await AsyncStorage.getItem(STORAGE_KEYS.SESSIONS);
    if (indexStored && !localCryptoIsEncrypted(indexStored)) {
      await AsyncStorage.setItem(STORAGE_KEYS.SESSIONS, localCryptoEncrypt(indexStored));
      count++;
    }
    
    // 2. Each session
    for (const sessionId of this.sessions.keys()) {
      const key = STORAGE_KEYS.SESSION_PREFIX + sessionId;
      const stored = await AsyncStorage.getItem(key);
      if (stored && !localCryptoIsEncrypted(stored)) {
        await AsyncStorage.setItem(key, localCryptoEncrypt(stored));
        count++;
      }
    }
    
    // 3. OTPK
    const otpk = await AsyncStorage.getItem(STORAGE_KEYS.ONE_TIME_PRE_KEYS);
    if (otpk && !localCryptoIsEncrypted(otpk)) {
      await AsyncStorage.setItem(STORAGE_KEYS.ONE_TIME_PRE_KEYS, localCryptoEncrypt(otpk));
      count++;
    }
    
    // 4. PQ keys
    const pq = await AsyncStorage.getItem(STORAGE_KEYS.PQ_SIGNED_KEY);
    if (pq && !localCryptoIsEncrypted(pq)) {
      await AsyncStorage.setItem(STORAGE_KEYS.PQ_SIGNED_KEY, localCryptoEncrypt(pq));
      count++;
    }
    
    // Reset le cache pour que wasLockEverConfigured() retourne true
    resetLockConfiguredCache();
    
    __DEV__ && console.log(`[SessionService] 🔐 Re-encrypted ${count} items`);
  }

}


// ============================================
// INSTANCE SINGLETON
// ============================================

export const sessionService = new SessionService();

// Enregistrer lockMemory() pour qu'il soit appelé automatiquement par
// storage.clearEncryptionKey() au verrouillage de l'app. Fait ici (et non dans
// le constructor) pour garantir que le singleton est complet et que la méthode
// est bien liée avant l'enregistrement.
registerLockHook(() => {
  sessionService.lockMemory();
});