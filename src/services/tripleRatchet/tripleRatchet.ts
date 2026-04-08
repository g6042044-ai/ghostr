// src/services/tripleRatchet/tripleRatchet.ts
// Triple Ratchet - Orchestrateur Principal
// Version 1.0 - Implémentation conforme Signal Triple Ratchet
//
// ARCHITECTURE:
// =============
// Le Triple Ratchet combine trois mécanismes de ratcheting:
//
// 1. DH RATCHET (X25519)
//    - Rotation à chaque changement de direction de conversation
//    - Forward Secrecy: compromission de clé n'expose pas les messages passés
//    - Break-in Recovery: récupération de sécurité après compromission
//
// 2. SYMMETRIC RATCHET (KDF Chain)
//    - Avance à chaque message envoyé/reçu
//    - Clés de message uniques et éphémères
//    - Suppression après utilisation
//
// 3. SPQR (Sparse Post-Quantum Ratchet)
//    - Rotation ML-KEM périodique
//    - Résistance aux attaques "Harvest Now, Decrypt Later"
//    - Sécurité hybride: attaquant doit casser X25519 ET ML-KEM
//
// GARANTIES DE SÉCURITÉ:
// - Forward Secrecy (FS): Compromission future ne révèle pas le passé
// - Post-Compromise Security (PCS): Récupération après compromission
// - Post-Quantum Security (PQS): Résistance aux ordinateurs quantiques
// - Message Unlinkability: Messages indépendants cryptographiquement
//
// RÉFÉRENCE: Signal Protocol + PQXDH + Triple Ratchet (2024-2025)

import {
  SymmetricKey,
  ChainKey,
  RootKey,
  MessageKey,
  HeaderKey,
  X25519KeyPair,
  X25519PublicKey,
  IdentityKeyPair,
  DoubleRatchetState,
  EncryptedMessage,
  CRYPTO_CONSTANTS,
} from './types';

import {
  generateX25519KeyPair,
  x25519,
  protocolHkdf,
  zeroize,
  zeroizeAll,
  createSymmetricKey,
  createChainKey,
  createRootKey,
  createHeaderKey,
  createMessageKey,
  secureClone,
  getSecureRandomBytes,
  bytesToHex,
  serializePublicKey,
  deserializeX25519PublicKey,
  encryptAEAD,
  decryptAEAD,
  encrypt as symmetricEncrypt,
  decrypt as symmetricDecrypt,
} from './primitives';

import {
  SPQRState,
  SPQRConfig,
  SPQRMessageMeta,
  HybridRatchetState,
  createInitialSPQRState,
  initializeSPQR,
  shouldRotateSPQR,
  rotateSPQR,
  createSPQRMessageMeta,
  processSPQRMessageMeta,
  applyPendingPQOperation,
  applyPendingBraidSecret,
  deriveHybridRootKey,
  deriveHybridRootKeyWithHE,
  serializeSPQRState,
  deserializeSPQRState,
  cleanupSPQRState,
  DEFAULT_SPQR_CONFIG,
  SerializedSPQRState,
  prepareBraidChunks,
} from './spqr';

import {
  padMessage,
  unpadMessage,
  PADDING_CONFIG,
  PaddingSize,
} from './messagePadding';

// encodeBase64/decodeBase64 re-exported from primitives.ts
import { encodeBase64, decodeBase64 } from './primitives';

// ============================================
// CONSTANTES TRIPLE RATCHET
// ============================================

const TRIPLE_RATCHET_CONSTANTS = {
  // Version du protocole (v2 avec Header Encryption)
  PROTOCOL_VERSION: 2,
  
  // P2-A4: Réduit de 200 à 50. En mode 1-to-1 avec peu de latence,
  // 50 messages sautés couvrent largement les réordonnements réseau.
  // Réduit l'impact DoS par messages craftés avec messageNumber élevé.
  MAX_SKIP: 50,
  
  SKIPPED_KEY_TTL_MS: 24 * 60 * 60 * 1000, // P2-A4: Réduit de 48h à 24h
  
  HEADER_SIZE: 80,
  
  HEADER_NONCE_SIZE: 24,
  
  // Audit Fix M-01: Rotation DH forcée tous les N messages dans la même direction
  // Sans cela, une conversation unidirectionnelle (centaines de messages d'un côté)
  // utilise la même clé DH indéfiniment → PCS étendue indéfiniment.
  MAX_SAME_DIRECTION_MESSAGES: 100,
} as const;

const KDF_DOMAINS = {
  ROOT_KEY: 'triple_ratchet_root_v2',
  CHAIN_KEY: 'triple_ratchet_chain_v2',
  MESSAGE_KEY: 'triple_ratchet_message_v2',
  HEADER_KEY: 'triple_ratchet_header_v2',
  HEADER_NONCE: 'triple_ratchet_header_nonce_v2',
  INITIAL_HEADER_KEY: 'triple_ratchet_init_hk_v2',
} as const;

// ============================================
// TYPES TRIPLE RATCHET
// ============================================

/**
 * État complet du Triple Ratchet avec Header Encryption
 */
export interface TripleRatchetState {
  // Version du protocole
  version: number;
  
  // État Double Ratchet (DH + Symmetric)
  rootKey: RootKey;
  sendingChainKey: ChainKey | null;
  receivingChainKey: ChainKey | null;
  sendingRatchetKey: X25519KeyPair;
  receivingRatchetKey: X25519PublicKey | null;
  previousSendingChainLength: number;
  messageNumberSend: number;
  messageNumberReceive: number;
  
  // Header Encryption Keys
  // HKs: Clé pour chiffrer les en-têtes des messages envoyés
  sendingHeaderKey: HeaderKey | null;
  // HKr: Clé pour déchiffrer les en-têtes des messages reçus
  receivingHeaderKey: HeaderKey | null;
  // NHKs: Prochaine clé d'en-tête d'envoi (sera utilisée après DH ratchet)
  nextSendingHeaderKey: HeaderKey;
  // NHKr: Prochaine clé d'en-tête de réception (sera utilisée après DH ratchet)
  nextReceivingHeaderKey: HeaderKey;
  
  // État SPQR (Post-Quantum)
  spqr: SPQRState;
  
  // Clés sautées (messages hors-ordre) - Inclut maintenant la header key
  skippedKeys: Map<string, { 
    key: MessageKey; 
    headerKey: HeaderKey;
    timestamp: number;
  }>;
  
  // Configuration
  config: TripleRatchetConfig;
}

/**
 * Configuration du Triple Ratchet
 */
export interface TripleRatchetConfig {
  // Configuration SPQR
  spqr: SPQRConfig;
  
  // Configuration du padding
  paddingSize: PaddingSize;
  
  // Maximum de clés sautées
  maxSkip: number;
  
  // TTL des clés sautées
  skippedKeyTTL: number;
}

/**
 * En-tête de message Triple Ratchet
 */
export interface TripleRatchetHeader {
  // Version du protocole
  version: number;
  
  // Clé publique DH actuelle
  dhPublicKey: X25519PublicKey;
  
  // Previous chain length (pour gestion des messages sautés)
  previousChainLength: number;
  
  // Numéro de message dans la chaîne actuelle
  messageNumber: number;
  
  // Métadonnées SPQR (optionnel)
  spqrMeta?: SPQRMessageMeta;
}

/**
 * Message chiffré Triple Ratchet avec Header Encryption
 */
export interface TripleRatchetMessage {
  // En-tête chiffré (encrypted with header key)
  encryptedHeader: string; // Base64
  
  // Nonce utilisé pour chiffrer l'en-tête
  headerNonce: string; // Base64
  
  // Corps du message (chiffré avec message key)
  ciphertext: string; // Base64
  
  // Nonce pour le déchiffrement du corps
  nonce: string; // Base64
}

/**
 * Résultat de déchiffrement
 */
export interface TripleRatchetDecryptResult {
  plaintext: Uint8Array;
  header: TripleRatchetHeader;
}

// ============================================
// INITIALISATION
// ============================================

/**
 * Initialise le Triple Ratchet côté initiateur (Alice)
 * 
 * @param sharedSecret - Secret partagé issu de PQXDH
 * @param theirRatchetKey - Clé publique DH initiale de Bob
 * @param pqSecret - Secret post-quantum initial (optionnel, de PQXDH)
 */
export async function initializeTripleRatchetInitiator(
  sharedSecret: SymmetricKey,
  theirRatchetKey: X25519PublicKey,
  myRatchetKeyPair: X25519KeyPair, // Paire éphémère de PQXDH (au lieu d'en générer une nouvelle)
  pqSecret?: Uint8Array,
  config?: Partial<TripleRatchetConfig>
): Promise<TripleRatchetState> {
  // Configuration par défaut
  const fullConfig: TripleRatchetConfig = {
    spqr: config?.spqr || DEFAULT_SPQR_CONFIG,
    paddingSize: config?.paddingSize || 'medium',
    maxSkip: config?.maxSkip || TRIPLE_RATCHET_CONSTANTS.MAX_SKIP,
    skippedKeyTTL: config?.skippedKeyTTL || TRIPLE_RATCHET_CONSTANTS.SKIPPED_KEY_TTL_MS,
  };
  
  // Utiliser la paire de clés fournie (clé éphémère PQXDH)
  const sendingRatchetKey = myRatchetKeyPair;
  
  // Dériver les header keys initiales depuis le shared secret
  // Ces clés sont utilisées avant le premier DH ratchet
  const initialHKMaterial = await protocolHkdf(
    sharedSecret.bytes,
    new Uint8Array(32), // Salt vide
    KDF_DOMAINS.INITIAL_HEADER_KEY,
    64 // 32 bytes pour HKs + 32 bytes pour NHKs
  );
  
  const sendingHeaderKey = createHeaderKey(initialHKMaterial.slice(0, 32));
  const nextSendingHeaderKey = createHeaderKey(initialHKMaterial.slice(32, 64));
  
  // Pour la réception, on dérive aussi depuis le shared secret
  // mais avec un domaine différent pour que les deux parties aient les bonnes clés
  const initialHKrMaterial = await protocolHkdf(
    sharedSecret.bytes,
    new Uint8Array(32),
    KDF_DOMAINS.INITIAL_HEADER_KEY + '_recv',
    64
  );
  
  const receivingHeaderKey = createHeaderKey(initialHKrMaterial.slice(0, 32));
  const nextReceivingHeaderKey = createHeaderKey(initialHKrMaterial.slice(32, 64));
  
  // Premier DH pour initialiser
  const dhSecret = x25519(sendingRatchetKey.privateKey, theirRatchetKey);
  
  // Dériver les clés initiales avec le secret PQ si disponible ET la nouvelle header key
  const { newRootKey, newChainKey, newHeaderKey } = await deriveHybridRootKeyWithHE(
    dhSecret,
    pqSecret || null,
    createRootKey(sharedSecret.bytes) // Utiliser le shared secret comme root key initiale
  );
  
  // Cleanup
  zeroize(dhSecret);
  
  // Initialiser SPQR
  const spqrState = initializeSPQR(pqSecret);
  
  return {
    version: TRIPLE_RATCHET_CONSTANTS.PROTOCOL_VERSION,
    rootKey: newRootKey,
    sendingChainKey: newChainKey,
    receivingChainKey: null,
    sendingRatchetKey,
    receivingRatchetKey: theirRatchetKey,
    previousSendingChainLength: 0,
    messageNumberSend: 0,
    messageNumberReceive: 0,
    // Header Encryption
    sendingHeaderKey,
    receivingHeaderKey,
    nextSendingHeaderKey: newHeaderKey, // La header key dérivée devient la prochaine
    nextReceivingHeaderKey,
    spqr: spqrState,
    skippedKeys: new Map(),
    config: fullConfig,
  };
}

/**
 * Initialise le Triple Ratchet côté destinataire (Bob)
 * 
 * @param sharedSecret - Secret partagé issu de PQXDH
 * @param myRatchetKey - Ma paire de clés DH (SignedPreKey)
 * @param pqSecret - Secret post-quantum initial (optionnel, de PQXDH)
 */
export async function initializeTripleRatchetResponder(
  sharedSecret: SymmetricKey,
  myRatchetKey: X25519KeyPair,
  theirRatchetKey: X25519PublicKey, // Clé éphémère de l'initiateur (Bob)
  pqSecret?: Uint8Array,
  config?: Partial<TripleRatchetConfig>
): Promise<TripleRatchetState> {
  // Configuration par défaut
  const fullConfig: TripleRatchetConfig = {
    spqr: config?.spqr || DEFAULT_SPQR_CONFIG,
    paddingSize: config?.paddingSize || 'medium',
    maxSkip: config?.maxSkip || TRIPLE_RATCHET_CONSTANTS.MAX_SKIP,
    skippedKeyTTL: config?.skippedKeyTTL || TRIPLE_RATCHET_CONSTANTS.SKIPPED_KEY_TTL_MS,
  };
  
  // Dériver les header keys initiales depuis le shared secret
  // IMPORTANT: Le Responder inverse les clés d'envoi/réception par rapport à l'Initiateur
  const initialHKMaterial = await protocolHkdf(
    sharedSecret.bytes,
    new Uint8Array(32),
    KDF_DOMAINS.INITIAL_HEADER_KEY + '_recv', // Inversé par rapport à l'Initiateur
    64
  );
  
  const sendingHeaderKey = createHeaderKey(initialHKMaterial.slice(0, 32));
  const nextSendingHeaderKey = createHeaderKey(initialHKMaterial.slice(32, 64));
  
  const initialHKrMaterial = await protocolHkdf(
    sharedSecret.bytes,
    new Uint8Array(32),
    KDF_DOMAINS.INITIAL_HEADER_KEY, // L'autre sens
    64
  );
  
  const receivingHeaderKey = createHeaderKey(initialHKrMaterial.slice(0, 32));
  const nextReceivingHeaderKey = createHeaderKey(initialHKrMaterial.slice(32, 64));
  
  // Faire le DH initial (symétrique à ce que l'initiateur a fait)
  // Bob a fait: DH(bob_ephemeral_priv, alice_signed_pub)
  // Alice fait: DH(alice_signed_priv, bob_ephemeral_pub)
  const dhSecret = x25519(myRatchetKey.privateKey, theirRatchetKey);
  
  // Dériver les clés initiales avec header key
  const { newRootKey, newChainKey, newHeaderKey } = await deriveHybridRootKeyWithHE(
    dhSecret,
    pqSecret || null,
    createRootKey(sharedSecret.bytes)
  );
  
  // Cleanup
  zeroize(dhSecret);
  
  // Initialiser SPQR
  const spqrState = initializeSPQR(pqSecret);
  
  // Alice a la chaîne de RÉCEPTION (inverse de Bob qui a la chaîne d'envoi)
  return {
    version: TRIPLE_RATCHET_CONSTANTS.PROTOCOL_VERSION,
    rootKey: newRootKey,
    sendingChainKey: null, // Alice n'a pas encore de chaîne d'envoi
    receivingChainKey: newChainKey, // Alice peut recevoir avec cette chaîne
    sendingRatchetKey: myRatchetKey,
    receivingRatchetKey: theirRatchetKey, // Clé éphémère de Bob
    previousSendingChainLength: 0,
    messageNumberSend: 0,
    messageNumberReceive: 0,
    // Header Encryption
    sendingHeaderKey,
    receivingHeaderKey,
    nextSendingHeaderKey,
    nextReceivingHeaderKey: newHeaderKey, // La header key dérivée devient la prochaine
    spqr: spqrState,
    skippedKeys: new Map(),
    config: fullConfig,
  };
}

// ============================================
// CHIFFREMENT
// ============================================

/**
 * Chiffre un message avec le Triple Ratchet et Header Encryption
 * 
 * L'en-tête est chiffré avec la header key pour masquer:
 * - La clé publique DH (empêche la corrélation de sessions)
 * - Le numéro de message (empêche l'analyse de trafic)
 * - Les métadonnées SPQR
 * 
 * @param state - État actuel du ratchet
 * @param plaintext - Message en clair
 * @param associatedData - Données associées (AAD) pour l'authentification
 */
export async function tripleRatchetEncrypt(
  state: TripleRatchetState,
  plaintext: Uint8Array,
  associatedData?: Uint8Array
): Promise<{
  message: TripleRatchetMessage;
  newState: TripleRatchetState;
}> {
  // R-04: Deep copy pour éviter la mutation de l'état original.
  // { ...state } (shallow spread) mute la Map skippedKeys et pqSecretHistory.
  let currentState = deepCopyTripleRatchetState(state);
  // (not just decrypt) so keys don't linger if user only sends
  currentState = cleanupExpiredSkippedKeys(currentState);
  
  // 1. Vérifier si on doit faire une rotation SPQR
  let spqrMeta: SPQRMessageMeta | undefined;
  
  // CORRECTION CRITIQUE (Audit Février 2026 — Phase 0 §1):
  //
  // CHEMIN BRAID (défaut, braid.enabled = true) :
  //   La rotation ML-KEM est gérée EXCLUSIVEMENT par le système Braid
  //   (shouldInitiateBraid → initiateBraid → generateBraidPayload) dans
  //   createSPQRMessageMeta(). rotateSPQR() n'est JAMAIS appelé.
  //   Le compteur de rotation est braid.messagesSinceLastExchange (indépendant
  //   de spqr.messageCount) et est incrémenté dans generateBraidPayload().
  //
  // CHEMIN LEGACY (braid.enabled = false) :
  //   rotateSPQR() génère une nouvelle paire ML-KEM et retourne publicKeyToSend.
  //   La clé publique est propagée au pair via createSPQRMessageMeta() qui lit
  //   state.pendingPQRotation + state.myKyberKeyPair.publicKey et les inclut
  //   dans SPQRMessageMeta.kyberPublicKey. Le pair répond avec un ciphertext
  //   KEM, les deux côtés dérivent le même sharedSecret.
  //
  const braidEnabled = currentState.config.spqr.braid?.enabled ?? true;
  
  if (!braidEnabled && shouldRotateSPQR(currentState.spqr, currentState.config.spqr)) {
    const { newState: rotatedSPQR, publicKeyToSend } = rotateSPQR(currentState.spqr);
    currentState.spqr = rotatedSPQR;
    
    // SÉCURITÉ: Vérification défensive — la clé publique DOIT être propagée.
    // En chemin legacy, la propagation passe par pendingPQRotation=true
    // + myKyberKeyPair mis à jour par rotateSPQR(). createSPQRMessageMeta()
    // les lira et les inclura dans les métadonnées du message.
    if (!publicKeyToSend) {
      throw new Error('SPQR rotation: publicKeyToSend is null — rotation ML-KEM a échoué');
    }
    if (!currentState.spqr.pendingPQRotation) {
      throw new Error('SPQR rotation: pendingPQRotation devrait être true après rotateSPQR()');
    }
  }
  
  // 2. Créer les métadonnées SPQR pour ce message
  const { meta, newState: afterMetaSPQR } = createSPQRMessageMeta(
    currentState.spqr,
    currentState.config.spqr
  );
  currentState.spqr = afterMetaSPQR;
  spqrMeta = meta;
  
  // 3. S'assurer qu'on a une chaîne d'envoi
  // Si le Responder n'a pas encore de sendingChainKey, faire un DH Ratchet
  // Audit Fix M-01: AUSSI forcer la rotation DH si on a envoyé trop de messages
  //   dans la même direction (PCS dégradée en conversation unidirectionnelle)
  const needsForcedDHRotation = currentState.sendingChainKey &&
    currentState.receivingRatchetKey &&
    currentState.messageNumberSend >= TRIPLE_RATCHET_CONSTANTS.MAX_SAME_DIRECTION_MESSAGES;
  
  if (!currentState.sendingChainKey || needsForcedDHRotation) {
    if (!currentState.receivingRatchetKey) {
      throw new Error('Triple Ratchet: No receiving ratchet key for DH ratchet');
    }
    
    // Générer une nouvelle paire de clés DH pour l'envoi
    const newSendingRatchetKey = generateX25519KeyPair();
    
    // Calculer le secret DH avec la clé publique du pair
    const dhSecret = x25519(
      newSendingRatchetKey.privateKey,
      currentState.receivingRatchetKey
    );
    
    // SÉCURITÉ CRITIQUE: Mixer le pqSecret ET dériver la nouvelle header key
    const { newRootKey, newChainKey, newHeaderKey } = await deriveHybridRootKeyWithHE(
      dhSecret,
      currentState.spqr.pqSecret,
      currentState.rootKey
    );
    
    // Cleanup
    zeroize(dhSecret);
    
    // Mettre à jour l'état avec les nouvelles clés
    // La sendingHeaderKey devient la nextSendingHeaderKey précédente
    currentState.sendingHeaderKey = currentState.nextSendingHeaderKey;
    currentState.nextSendingHeaderKey = newHeaderKey;
    currentState.rootKey = newRootKey;
    currentState.sendingChainKey = newChainKey;
    currentState.sendingRatchetKey = newSendingRatchetKey;
    currentState.previousSendingChainLength = currentState.messageNumberSend;
    currentState.messageNumberSend = 0;
  }
  
  // 4. Vérifier qu'on a une header key pour l'envoi
  if (!currentState.sendingHeaderKey) {
    throw new Error('Triple Ratchet: No sending header key');
  }
  
  // 5. Dériver la clé de message avec protection PQ hybride
  const { messageKey, nextChainKey } = await deriveMessageKey(
    currentState.sendingChainKey,
    currentState.spqr.pqSecret
  );
  
  currentState.sendingChainKey = nextChainKey;
  
  // 6. Appliquer le padding au message
  const paddedPlaintext = padMessage(plaintext, currentState.config.paddingSize);
  
  // 7. Construire l'en-tête
  const header: TripleRatchetHeader = {
    version: TRIPLE_RATCHET_CONSTANTS.PROTOCOL_VERSION,
    dhPublicKey: currentState.sendingRatchetKey.publicKey,
    previousChainLength: currentState.previousSendingChainLength,
    messageNumber: currentState.messageNumberSend,
    spqrMeta,
  };
  
  // 8. Sérialiser et CHIFFRER l'en-tête avec la header key
  const headerSerialized = serializeHeader(header);
  const headerBytes = new TextEncoder().encode(headerSerialized);
  
  // Chiffrer l'en-tête avec XSalsa20-Poly1305
  const { ciphertext: encryptedHeaderBytes, nonce: headerNonce } = symmetricEncrypt(
    headerBytes,
    currentState.sendingHeaderKey
  );
  
  // 9. Construire les AAD complètes (en-tête CHIFFRÉ + AAD fourni)
  // L'en-tête chiffré fait partie des AAD pour lier cryptographiquement
  const fullAAD = buildAAD(encodeBase64(encryptedHeaderBytes), associatedData);
  
  // 10. Chiffrer le corps avec la clé de message et NONCE DÉTERMINISTE
  const { ciphertext, nonce } = await encryptAEAD(
    messageKey.bytes,
    paddedPlaintext,
    fullAAD,
    currentState.messageNumberSend,
    'send'
  );
  
  // 11. Incrémenter le compteur
  currentState.messageNumberSend++;
  
  // 12. Cleanup
  zeroize(messageKey.bytes);
  zeroize(paddedPlaintext);
  
  return {
    message: {
      encryptedHeader: encodeBase64(encryptedHeaderBytes),
      headerNonce: encodeBase64(headerNonce),
      ciphertext: encodeBase64(ciphertext),
      nonce: encodeBase64(nonce),
    },
    newState: currentState,
  };
}

// ============================================
// DÉCHIFFREMENT
// ============================================

/**
 * Résultat du déchiffrement d'en-tête avec Header Encryption
 */
interface HeaderDecryptResult {
  header: TripleRatchetHeader;
  usedHeaderKey: HeaderKey;
  triggeredDHRatchet: boolean;
}

/**
 * Tente de déchiffrer l'en-tête avec une header key
 * 
 * @returns L'en-tête déchiffré ou null si échec
 */
function tryDecryptHeader(
  encryptedHeader: Uint8Array,
  headerNonce: Uint8Array,
  headerKey: HeaderKey
): TripleRatchetHeader | null {
  try {
    const headerBytes = symmetricDecrypt(encryptedHeader, headerNonce, headerKey);
    if (!headerBytes) {
      return null;
    }
    const headerSerialized = new TextDecoder().decode(headerBytes);
    return deserializeHeader(headerSerialized);
  } catch {
    return null;
  }
}

/**
 * Déchiffre l'en-tête en essayant différentes clés
 *
 * R-10: Toutes les clés sont essayées sans early-exit pour éviter un canal
 * auxiliaire de timing (la position de la clé correcte était observable).
 * On collecte tous les résultats et on sélectionne le premier non-null.
 *
 * Ordre d'essai:
 * 1. receivingHeaderKey (cas normal)
 * 2. nextReceivingHeaderKey (nouveau DH ratchet)
 * 3. Clés des messages sautés
 *
 * @returns L'en-tête et la clé utilisée, ou lance une erreur
 */
function decryptHeaderWithFallback(
  message: TripleRatchetMessage,
  state: TripleRatchetState
): HeaderDecryptResult {
  const encryptedHeader = decodeBase64(message.encryptedHeader);
  const headerNonce = decodeBase64(message.headerNonce);

  // R-10: Construire la liste COMPLÈTE des clés à essayer, dans l'ordre de priorité.
  // Toutes sont testées pour éviter la fuite de timing par early-exit.
  const candidates: Array<{ headerKey: HeaderKey; triggeredDHRatchet: boolean }> = [];

  if (state.receivingHeaderKey) {
    candidates.push({ headerKey: state.receivingHeaderKey, triggeredDHRatchet: false });
  }
  candidates.push({ headerKey: state.nextReceivingHeaderKey, triggeredDHRatchet: true });

  for (const [, entry] of state.skippedKeys) {
    candidates.push({ headerKey: entry.headerKey, triggeredDHRatchet: false });
  }

  // Essayer TOUTES les clés (pas de early-exit)
  const results: Array<TripleRatchetHeader | null> = candidates.map(({ headerKey }) =>
    tryDecryptHeader(encryptedHeader, headerNonce, headerKey)
  );

  // Sélectionner le premier résultat valide
  for (let i = 0; i < results.length; i++) {
    if (results[i] !== null) {
      return {
        header: results[i]!,
        usedHeaderKey: candidates[i].headerKey,
        triggeredDHRatchet: candidates[i].triggeredDHRatchet,
      };
    }
  }

  throw new Error('Triple Ratchet: Header decryption failed with all available keys');
}

/**
 * Déchiffre un message avec le Triple Ratchet et Header Encryption
 * 
 * Le déchiffrement suit ces étapes:
 * 1. Déchiffrer l'en-tête (essayer HKr, puis NHKr, puis clés sautées)
 * 2. Vérifier si c'est un message sauté
 * 3. Effectuer le DH ratchet si nécessaire
 * 4. Dériver la clé de message et déchiffrer le corps
 * 
 * @param state - État actuel du ratchet
 * @param message - Message chiffré avec en-tête chiffré
 * @param associatedData - Données associées (AAD)
 */
export async function tripleRatchetDecrypt(
  state: TripleRatchetState,
  message: TripleRatchetMessage,
  associatedData?: Uint8Array
): Promise<{
  result: TripleRatchetDecryptResult;
  newState: TripleRatchetState;
}> {
  // R-04: Deep copy — même raison que dans tripleRatchetEncrypt.
  let currentState = deepCopyTripleRatchetState(state);
  const { header, usedHeaderKey, triggeredDHRatchet } = decryptHeaderWithFallback(
    message,
    currentState
  );
  
  // 2. Vérifier la version
  if (header.version !== TRIPLE_RATCHET_CONSTANTS.PROTOCOL_VERSION) {
    throw new Error(`Triple Ratchet: Unsupported protocol version ${header.version}`);
  }
  
  // 3. Traiter les métadonnées SPQR si présentes
  let pendingPQOperation: {
    type: 'encapsulate' | 'decapsulate';
    publicKey?: any;
    ciphertext?: any;
  } | undefined;
  
  if (header.spqrMeta) {
    const { newState: afterSPQR, pendingPQOperation: pqOp } = await processSPQRMessageMeta(
      currentState.spqr,
      header.spqrMeta,
      currentState.config.spqr
    );
    currentState.spqr = afterSPQR;
    pendingPQOperation = pqOp;
  }
  
  // 4. Vérifier si c'est un message sauté
  const skipKey = makeSkipKey(header.dhPublicKey, header.messageNumber);
  const skippedEntry = currentState.skippedKeys.get(skipKey);
  
  if (skippedEntry) {
    // Utiliser la clé sautée
    const plaintext = await decryptWithKey(
      skippedEntry.key,
      message,
      header,
      associatedData
    );
    
    // Supprimer la clé utilisée
    currentState.skippedKeys.delete(skipKey);
    
    // Appliquer l'opération PQ différée si présente
    if (pendingPQOperation) {
      const { newState: afterPQ, responseMeta } = await applyPendingPQOperation(
        currentState.spqr,
        pendingPQOperation
      );
      currentState.spqr = afterPQ;
      if (responseMeta) {
        currentState.spqr.pendingPQRotation = true;
      }
    }
    
    // Appliquer le secret Braid en attente (APRÈS déchiffrement réussi)
    currentState.spqr = applyPendingBraidSecret(currentState.spqr);
    
    return {
      result: { plaintext, header },
      newState: currentState,
    };
  }
  
  // 5. Si le déchiffrement d'en-tête a déclenché un DH ratchet
  if (triggeredDHRatchet) {
    // Sauvegarder les clés sautées de la chaîne précédente
    if (currentState.receivingChainKey && currentState.receivingHeaderKey) {
      currentState = await skipMessageKeysWithHE(
        currentState,
        header.previousChainLength,
        currentState.receivingHeaderKey
      );
    }
    
    // Effectuer la rotation DH avec mise à jour des header keys
    currentState = await performDHRatchetWithHE(currentState, header.dhPublicKey);
  }
  
  // 6. Vérifier si la clé DH a changé (mais pas détecté par header decryption)
  const theirKeyChanged = !currentState.receivingRatchetKey ||
    !publicKeysEqual(currentState.receivingRatchetKey, header.dhPublicKey);
  
  if (theirKeyChanged && !triggeredDHRatchet) {
    // Sauvegarder les clés sautées de la chaîne précédente
    if (currentState.receivingChainKey && currentState.receivingHeaderKey) {
      currentState = await skipMessageKeysWithHE(
        currentState,
        header.previousChainLength,
        currentState.receivingHeaderKey
      );
    }
    
    // Effectuer la rotation DH
    currentState = await performDHRatchetWithHE(currentState, header.dhPublicKey);
  }
  
  // 7. Sauvegarder les clés sautées de la chaîne actuelle si nécessaire
  if (currentState.receivingHeaderKey) {
    currentState = await skipMessageKeysWithHE(
      currentState,
      header.messageNumber,
      currentState.receivingHeaderKey
    );
  }
  
  // 8. Dériver la clé de message
  if (!currentState.receivingChainKey) {
    throw new Error('Triple Ratchet: No receiving chain key');
  }
  
  const { messageKey, nextChainKey } = await deriveMessageKey(
    currentState.receivingChainKey,
    currentState.spqr.pqSecret
  );
  
  currentState.receivingChainKey = nextChainKey;
  currentState.messageNumberReceive++;
  
  // 9. Déchiffrer le corps du message
  const plaintext = await decryptWithKey(messageKey, message, header, associatedData);
  
  // 10. Cleanup de la clé de message
  zeroize(messageKey.bytes);
  
  // 11. Appliquer l'opération PQ différée (APRÈS déchiffrement réussi)
  if (pendingPQOperation) {
    const { newState: afterPQ, responseMeta } = await applyPendingPQOperation(
      currentState.spqr,
      pendingPQOperation
    );
    currentState.spqr = afterPQ;
    if (responseMeta) {
      currentState.spqr.pendingPQRotation = true;
    }
  }
  
  // 11b. Appliquer le secret Braid en attente (APRÈS déchiffrement réussi)
  // IMPORTANT: Le message a été chiffré avec l'ancien pqSecret, donc on ne peut
  // mettre à jour le secret qu'APRÈS avoir déchiffré avec succès.
  currentState.spqr = applyPendingBraidSecret(currentState.spqr);
  
  // 12. Nettoyer les clés sautées expirées
  currentState = cleanupExpiredSkippedKeys(currentState);
  
  return {
    result: { plaintext, header },
    newState: currentState,
  };
}

// ============================================
// R-04: DEEP COPY DE L'ÉTAT
// ============================================
// { ...state } (shallow spread) ne clone PAS:
//   - skippedKeys: Map<string, ...> → mutée par skipMessageKeysWithHE
//   - spqr.pqSecretHistory: Map<number, Uint8Array> → mutée par SPQR rotation
//
// Sans deep copy, currentState.skippedKeys.set() mutait la Map de l'état
// original, corrompant l'état si l'appelant conservait une référence à state.
//
// INVARIANT: Toute fonction qui retourne newState doit partir d'une copie profonde.

/**
 * Clone profond de l'état Triple Ratchet.
 * Clone explicitement les Maps et objets imbriqués.
 */
function deepCopyTripleRatchetState(state: TripleRatchetState): TripleRatchetState {
  // GH-12: Clone Uint8Array-backed keys to prevent zeroize() cross-contamination
  const cloneKey = <T extends { bytes: Uint8Array }>(k: T): T =>
    ({ ...k, bytes: new Uint8Array(k.bytes) } as T);

  // Clone Maps (reference types)
  const skippedKeysCopy = new Map<string, { key: MessageKey; headerKey: HeaderKey; timestamp: number }>();
  for (const [k, v] of state.skippedKeys) {
    skippedKeysCopy.set(k, { key: cloneKey(v.key), headerKey: cloneKey(v.headerKey), timestamp: v.timestamp });
  }

  const pqSecretHistoryCopy = new Map<number, Uint8Array>();
  for (const [k, v] of state.spqr.pqSecretHistory) {
    pqSecretHistoryCopy.set(k, new Uint8Array(v));
  }

  const braidCopy = state.spqr.braid ? {
    ...state.spqr.braid,
    remoteEKBodyChunks: new Map<number, Uint8Array>(state.spqr.braid.remoteEKBodyChunks),
    remoteCTChunks: new Map<number, Uint8Array>(state.spqr.braid.remoteCTChunks),
    localEKBodyChunks: [...(state.spqr.braid.localEKBodyChunks ?? [])],
    localCTChunks: [...(state.spqr.braid.localCTChunks ?? [])],
  } : state.spqr.braid;

  return {
    ...state,
    // GH-12: Clone critical Uint8Array-backed keys
    rootKey: cloneKey(state.rootKey),
    sendingChainKey: state.sendingChainKey ? cloneKey(state.sendingChainKey) : null,
    receivingChainKey: state.receivingChainKey ? cloneKey(state.receivingChainKey) : null,
    sendingHeaderKey: state.sendingHeaderKey ? cloneKey(state.sendingHeaderKey) : null,
    receivingHeaderKey: state.receivingHeaderKey ? cloneKey(state.receivingHeaderKey) : null,
    nextSendingHeaderKey: cloneKey(state.nextSendingHeaderKey),
    nextReceivingHeaderKey: cloneKey(state.nextReceivingHeaderKey),
    skippedKeys: skippedKeysCopy,
    spqr: {
      ...state.spqr,
      pqSecret: state.spqr.pqSecret ? new Uint8Array(state.spqr.pqSecret) : state.spqr.pqSecret,
      pqSecretHistory: pqSecretHistoryCopy,
      pendingChunks: [...(state.spqr.pendingChunks ?? [])],
      outgoingChunks: [...(state.spqr.outgoingChunks ?? [])],
      braid: braidCopy,
    },
  };
}


async function deriveMessageKey(
  chainKey: ChainKey,
  pqSecret?: Uint8Array | null
): Promise<{
  messageKey: MessageKey;
  nextChainKey: ChainKey;
}> {
  // CORRECTION CRITIQUE #1: Mixage PQ Systématique
  // Le pqSecret DOIT être incorporé dans CHAQUE dérivation de clé de message
  // pour garantir la protection post-quantique entre les rotations SPQR.
  // 
  // Signal Triple Ratchet (SPQR) - Eurocrypt 2025:
  // "The accumulated post-quantum secret must be mixed into every
  //  message key derivation to ensure continuous PQ protection."
  
  let messageKeyInput: Uint8Array;
  let chainKeyInput: Uint8Array;
  
  if (pqSecret && pqSecret.length > 0) {
    // Mixer le pqSecret avec la chaîne pour protection hybride
    // Cela garantit que CHAQUE message est protégé par X25519 ET ML-KEM
    messageKeyInput = new Uint8Array(chainKey.bytes.length + pqSecret.length);
    messageKeyInput.set(chainKey.bytes);
    messageKeyInput.set(pqSecret, chainKey.bytes.length);
    
    // La chaîne progresse avec le mix aussi pour la forward secrecy
    chainKeyInput = new Uint8Array(chainKey.bytes.length + pqSecret.length);
    chainKeyInput.set(chainKey.bytes);
    chainKeyInput.set(pqSecret, chainKey.bytes.length);
    
  } else {
    // Fallback sans protection PQ (ne devrait pas arriver en production)
    messageKeyInput = chainKey.bytes;
    chainKeyInput = chainKey.bytes;
  }
  
  // Dériver la clé de message avec domain separation
  const messageKeyBytes = await protocolHkdf(
    messageKeyInput,
    new Uint8Array(32),
    KDF_DOMAINS.MESSAGE_KEY,
    32
  );
  
  // Dériver la prochaine clé de chaîne avec domain separation différent
  const nextChainKeyBytes = await protocolHkdf(
    chainKeyInput,
    new Uint8Array(32),
    KDF_DOMAINS.CHAIN_KEY,
    32
  );
  
  // Cleanup si on a alloué des buffers
  if (pqSecret && pqSecret.length > 0) {
    zeroize(messageKeyInput);
    zeroize(chainKeyInput);
  }
  
  return {
    messageKey: createMessageKey(messageKeyBytes),
    nextChainKey: createChainKey(nextChainKeyBytes),
  };
}

/**
 * Effectue une rotation DH et met à jour l'état
 * 
 * SÉCURITÉ POST-QUANTIQUE:
 * ========================
 * Contrairement au commentaire précédent, le pqSecret DOIT être mixé
 * dans chaque rotation DH pour garantir la sécurité hybride continue.
 * 
 * Justification (conforme Signal SPQR - Eurocrypt 2025):
 * - Sans mixage PQ: fenêtres temporelles vulnérables aux attaques quantiques
 * - Avec mixage PQ: attaquant doit casser X25519 ET ML-KEM pour chaque message
 * - Le pqSecret est déjà synchronisé entre les parties via SPQR
 * - La symétrie est maintenue car les deux parties ont le même pqSecret
 */
async function performDHRatchet(
  state: TripleRatchetState,
  theirNewPublicKey: X25519PublicKey
): Promise<TripleRatchetState> {
  
  // Calculer le nouveau secret DH pour réception
  const dhSecretReceive = x25519(
    state.sendingRatchetKey.privateKey,
    theirNewPublicKey
  );
  
  
  // SÉCURITÉ CRITIQUE: Mixer le pqSecret pour protection post-quantique
  // Ceci garantit que chaque rotation DH bénéficie de la sécurité hybride
  const { newRootKey: rootKey1, newChainKey: receivingChainKey } = await deriveHybridRootKey(
    dhSecretReceive,
    state.spqr.pqSecret, // ✅ CORRECTION: Mixer le pqSecret
    state.rootKey
  );
  
  
  // Générer nouvelle paire DH pour envoi
  const newSendingRatchetKey = generateX25519KeyPair();
  
  // Calculer le secret DH pour envoi
  const dhSecretSend = x25519(
    newSendingRatchetKey.privateKey,
    theirNewPublicKey
  );
  
  // SÉCURITÉ CRITIQUE: Mixer également pour l'envoi
  const { newRootKey: rootKey2, newChainKey: sendingChainKey } = await deriveHybridRootKey(
    dhSecretSend,
    state.spqr.pqSecret, // ✅ CORRECTION: Mixer le pqSecret
    rootKey1
  );
  
  
  // Cleanup
  zeroize(dhSecretReceive);
  zeroize(dhSecretSend);
  
  return {
    ...state,
    rootKey: rootKey2,
    sendingChainKey,
    receivingChainKey,
    sendingRatchetKey: newSendingRatchetKey,
    receivingRatchetKey: theirNewPublicKey,
    previousSendingChainLength: state.messageNumberSend,
    messageNumberSend: 0,
    messageNumberReceive: 0,
  };
}

/**
 * Effectue une rotation DH avec mise à jour des header keys
 * 
 * Cette version met à jour également les header keys conformément
 * à la spécification Signal avec header encryption.
 */
async function performDHRatchetWithHE(
  state: TripleRatchetState,
  theirNewPublicKey: X25519PublicKey
): Promise<TripleRatchetState> {
  
  // Calculer le nouveau secret DH pour réception
  const dhSecretReceive = x25519(
    state.sendingRatchetKey.privateKey,
    theirNewPublicKey
  );
  
  // Dériver avec header key pour réception
  const { 
    newRootKey: rootKey1, 
    newChainKey: receivingChainKey,
    newHeaderKey: receivingHeaderKey
  } = await deriveHybridRootKeyWithHE(
    dhSecretReceive,
    state.spqr.pqSecret,
    state.rootKey
  );
  
  // Générer nouvelle paire DH pour envoi
  const newSendingRatchetKey = generateX25519KeyPair();
  
  // Calculer le secret DH pour envoi
  const dhSecretSend = x25519(
    newSendingRatchetKey.privateKey,
    theirNewPublicKey
  );
  
  // Dériver avec header key pour envoi
  const { 
    newRootKey: rootKey2, 
    newChainKey: sendingChainKey,
    newHeaderKey: sendingHeaderKey
  } = await deriveHybridRootKeyWithHE(
    dhSecretSend,
    state.spqr.pqSecret,
    rootKey1
  );
  
  // Cleanup
  zeroize(dhSecretReceive);
  zeroize(dhSecretSend);
  
  return {
    ...state,
    rootKey: rootKey2,
    sendingChainKey,
    receivingChainKey,
    sendingRatchetKey: newSendingRatchetKey,
    receivingRatchetKey: theirNewPublicKey,
    previousSendingChainLength: state.messageNumberSend,
    messageNumberSend: 0,
    messageNumberReceive: 0,
    // Mise à jour des header keys
    // Les "next" deviennent les "current"
    sendingHeaderKey: state.nextSendingHeaderKey,
    receivingHeaderKey: state.nextReceivingHeaderKey,
    // Les nouvelles dérivées deviennent les "next"
    nextSendingHeaderKey: sendingHeaderKey,
    nextReceivingHeaderKey: receivingHeaderKey,
  };
}

/**
 * Saute et sauvegarde les clés de messages manquants
 */
async function skipMessageKeys(
  state: TripleRatchetState,
  until: number
): Promise<TripleRatchetState> {
  if (!state.receivingChainKey) {
    return state;
  }
  
  if (state.messageNumberReceive + state.config.maxSkip < until) {
    throw new Error('Triple Ratchet: Too many skipped messages');
  }
  
  // R-04: Deep copy — skipMessageKeys ajoute à skippedKeys
  let currentState = deepCopyTripleRatchetState(state);
  let chainKey = state.receivingChainKey;
  
  while (currentState.messageNumberReceive < until) {
    // CRITIQUE: Le pqSecret est TOUJOURS mixé même pour les clés sautées
    const { messageKey, nextChainKey } = await deriveMessageKey(
      chainKey,
      currentState.spqr.pqSecret  // Protection PQ systématique
    );
    
    // Sauvegarder la clé
    const skipKey = makeSkipKey(
      currentState.receivingRatchetKey!,
      currentState.messageNumberReceive
    );
    
    currentState.skippedKeys.set(skipKey, {
      key: messageKey,
      headerKey: currentState.receivingHeaderKey || currentState.nextReceivingHeaderKey,
      timestamp: Date.now(),
    });
    
    chainKey = nextChainKey;
    currentState.messageNumberReceive++;
  }
  
  currentState.receivingChainKey = chainKey;
  
  return currentState;
}

/**
 * Saute et sauvegarde les clés de messages manquants avec Header Encryption
 * 
 * Cette version stocke aussi la header key utilisée pour chaque message sauté,
 * permettant de déchiffrer les en-têtes des messages hors-ordre.
 */
async function skipMessageKeysWithHE(
  state: TripleRatchetState,
  until: number,
  currentHeaderKey: HeaderKey
): Promise<TripleRatchetState> {
  if (!state.receivingChainKey) {
    return state;
  }
  
  if (state.messageNumberReceive + state.config.maxSkip < until) {
    throw new Error('Triple Ratchet: Too many skipped messages');
  }
  
  // R-04: Deep copy — skipMessageKeysWithHE mutait la Map skippedKeys originale
  let currentState = deepCopyTripleRatchetState(state);
  let chainKey = state.receivingChainKey;

  while (currentState.messageNumberReceive < until) {
    // CRITIQUE: Le pqSecret est TOUJOURS mixé même pour les clés sautées
    const { messageKey, nextChainKey } = await deriveMessageKey(
      chainKey,
      currentState.spqr.pqSecret
    );
    
    // Sauvegarder la clé ET la header key associée
    const skipKey = makeSkipKey(
      currentState.receivingRatchetKey!,
      currentState.messageNumberReceive
    );
    
    currentState.skippedKeys.set(skipKey, {
      key: messageKey,
      headerKey: currentHeaderKey, // Stocker la header key pour ce message
      timestamp: Date.now(),
    });
    
    chainKey = nextChainKey;
    currentState.messageNumberReceive++;
  }
  
  currentState.receivingChainKey = chainKey;
  
  return currentState;
}

/**
 * Déchiffre avec une clé spécifique
 * 
 * Utilise l'en-tête CHIFFRÉ comme AAD pour garantir la liaison cryptographique
 */
async function decryptWithKey(
  messageKey: MessageKey,
  message: TripleRatchetMessage,
  header: TripleRatchetHeader,
  associatedData?: Uint8Array
): Promise<Uint8Array> {
  const ciphertext = decodeBase64(message.ciphertext);
  const nonce = decodeBase64(message.nonce);
  // Utiliser l'en-tête CHIFFRÉ comme AAD (cohérent avec l'encryption)
  const fullAAD = buildAAD(message.encryptedHeader, associatedData);
  
  const paddedPlaintext = await decryptAEAD(
    messageKey.bytes,
    nonce,
    ciphertext,
    fullAAD
  );
  
  // Retirer le padding
  return unpadMessage(paddedPlaintext);
}

/**
 * Construit les AAD complètes
 */
function buildAAD(header: string, additionalData?: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(header);
  
  if (!additionalData || additionalData.length === 0) {
    return headerBytes;
  }
  
  const combined = new Uint8Array(headerBytes.length + additionalData.length);
  combined.set(headerBytes);
  combined.set(additionalData, headerBytes.length);
  return combined;
}

/**
 * Crée une clé unique pour identifier un message sauté
 */
function makeSkipKey(publicKey: X25519PublicKey, messageNumber: number): string {
  return `${bytesToHex(publicKey.bytes)}:${messageNumber}`;
}

/**
 * Compare deux clés publiques
 */
function publicKeysEqual(a: X25519PublicKey, b: X25519PublicKey): boolean {
  if (a.bytes.length !== b.bytes.length) return false;
  let result = 0;
  for (let i = 0; i < a.bytes.length; i++) {
    result |= a.bytes[i] ^ b.bytes[i];
  }
  return result === 0;
}

/**
 * Nettoie les clés sautées expirées
 */
function cleanupExpiredSkippedKeys(state: TripleRatchetState): TripleRatchetState {
  const now = Date.now();
  const newSkippedKeys = new Map<string, { key: MessageKey; headerKey: HeaderKey; timestamp: number }>();
  
  for (const [key, entry] of state.skippedKeys) {
    if (now - entry.timestamp < state.config.skippedKeyTTL) {
      newSkippedKeys.set(key, entry);
    } else {
      // Effacer les clés expirées
      zeroize(entry.key.bytes);
      zeroize(entry.headerKey.bytes);
    }
  }
  
  return {
    ...state,
    skippedKeys: newSkippedKeys,
  };
}

// ============================================
// SÉRIALISATION
// ============================================

/**
 * Sérialise l'en-tête d'un message
 */
function serializeHeader(header: TripleRatchetHeader): string {
  // ACTION 17: Sérialisation canonique — clés triées alphabétiquement.
  // JSON.stringify préserve l'ordre d'insertion dans V8/Hermes, mais pour
  // garantir un encodage déterministe indépendamment du moteur JS,
  // on utilise des clés explicitement ordonnées et un replacer de tri.
  const obj: Record<string, unknown> = {
    dh: serializePublicKey(header.dhPublicKey),
    n: header.messageNumber,
    pn: header.previousChainLength,
    pq: header.spqrMeta,
    v: header.version,
  };
  // Tri récursif des clés pour le spqrMeta (objet imbriqué)
  return JSON.stringify(obj, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      );
    }
    return value;
  });
}

/**
 * Désérialise l'en-tête d'un message
 */
function deserializeHeader(serialized: string): TripleRatchetHeader {
  const data = JSON.parse(serialized);
  return {
    version: data.v,
    dhPublicKey: deserializeX25519PublicKey(data.dh),
    previousChainLength: data.pn,
    messageNumber: data.n,
    spqrMeta: data.pq,
  };
}

/**
 * État sérialisé pour stockage
 */
export interface SerializedTripleRatchetState {
  version: number;
  rootKey: string;
  sendingChainKey: string | null;
  receivingChainKey: string | null;
  sendingRatchetKey: {
    publicKey: string;
    privateKey: string;
  };
  receivingRatchetKey: string | null;
  previousSendingChainLength: number;
  messageNumberSend: number;
  messageNumberReceive: number;
  // Header Encryption Keys
  sendingHeaderKey: string | null;
  receivingHeaderKey: string | null;
  nextSendingHeaderKey: string;
  nextReceivingHeaderKey: string;
  spqr: SerializedSPQRState;
  skippedKeys: Array<[string, { key: string; headerKey: string; timestamp: number }]>;
  config: TripleRatchetConfig;
}

/**
 * Sérialise l'état complet pour stockage sécurisé
 */
export function serializeTripleRatchetState(state: TripleRatchetState): SerializedTripleRatchetState {
  // Convertir les clés sautées (incluant la header key)
  const skippedKeysArray: Array<[string, { key: string; headerKey: string; timestamp: number }]> = [];
  for (const [key, entry] of state.skippedKeys) {
    skippedKeysArray.push([
      key,
      {
        key: encodeBase64(entry.key.bytes),
        headerKey: encodeBase64(entry.headerKey.bytes),
        timestamp: entry.timestamp,
      },
    ]);
  }
  
  return {
    version: state.version,
    rootKey: encodeBase64(state.rootKey.bytes),
    sendingChainKey: state.sendingChainKey ? encodeBase64(state.sendingChainKey.bytes) : null,
    receivingChainKey: state.receivingChainKey ? encodeBase64(state.receivingChainKey.bytes) : null,
    sendingRatchetKey: {
      publicKey: serializePublicKey(state.sendingRatchetKey.publicKey),
      privateKey: encodeBase64(state.sendingRatchetKey.privateKey.bytes),
    },
    receivingRatchetKey: state.receivingRatchetKey
      ? serializePublicKey(state.receivingRatchetKey)
      : null,
    previousSendingChainLength: state.previousSendingChainLength,
    messageNumberSend: state.messageNumberSend,
    messageNumberReceive: state.messageNumberReceive,
    // Header Encryption Keys
    sendingHeaderKey: state.sendingHeaderKey ? encodeBase64(state.sendingHeaderKey.bytes) : null,
    receivingHeaderKey: state.receivingHeaderKey ? encodeBase64(state.receivingHeaderKey.bytes) : null,
    nextSendingHeaderKey: encodeBase64(state.nextSendingHeaderKey.bytes),
    nextReceivingHeaderKey: encodeBase64(state.nextReceivingHeaderKey.bytes),
    spqr: serializeSPQRState(state.spqr),
    skippedKeys: skippedKeysArray,
    config: state.config,
  };
}

/**
 * Désérialise l'état depuis le stockage
 */
export function deserializeTripleRatchetState(
  data: SerializedTripleRatchetState
): TripleRatchetState {
  // Reconstituer les clés sautées (incluant la header key)
  const skippedKeys = new Map<string, { key: MessageKey; headerKey: HeaderKey; timestamp: number }>();
  for (const [key, entry] of data.skippedKeys) {
    skippedKeys.set(key, {
      key: createMessageKey(decodeBase64(entry.key)),
      headerKey: createHeaderKey(decodeBase64(entry.headerKey)),
      timestamp: entry.timestamp,
    });
  }
  
  const state: TripleRatchetState = {
    version: data.version,
    rootKey: createRootKey(decodeBase64(data.rootKey)),
    sendingChainKey: data.sendingChainKey
      ? createChainKey(decodeBase64(data.sendingChainKey))
      : null,
    receivingChainKey: data.receivingChainKey
      ? createChainKey(decodeBase64(data.receivingChainKey))
      : null,
    sendingRatchetKey: {
      publicKey: deserializeX25519PublicKey(data.sendingRatchetKey.publicKey),
      privateKey: {
        _brand: 'X25519PrivateKey' as const,
        bytes: decodeBase64(data.sendingRatchetKey.privateKey),
      },
    },
    receivingRatchetKey: data.receivingRatchetKey
      ? deserializeX25519PublicKey(data.receivingRatchetKey)
      : null,
    previousSendingChainLength: data.previousSendingChainLength,
    messageNumberSend: data.messageNumberSend,
    messageNumberReceive: data.messageNumberReceive,
    // Header Encryption Keys
    sendingHeaderKey: data.sendingHeaderKey
      ? createHeaderKey(decodeBase64(data.sendingHeaderKey))
      : null,
    receivingHeaderKey: data.receivingHeaderKey
      ? createHeaderKey(decodeBase64(data.receivingHeaderKey))
      : null,
    nextSendingHeaderKey: createHeaderKey(decodeBase64(data.nextSendingHeaderKey)),
    nextReceivingHeaderKey: createHeaderKey(decodeBase64(data.nextReceivingHeaderKey)),
    spqr: deserializeSPQRState(data.spqr),
    skippedKeys,
    // IMPORTANT: Fusionner avec les valeurs par défaut pour rétrocompatibilité
    // Les sessions créées avant l'ajout de braid n'auront pas config.spqr.braid
    config: {
      ...data.config,
      spqr: {
        ...DEFAULT_SPQR_CONFIG,
        ...data.config.spqr,
        braid: {
          ...DEFAULT_SPQR_CONFIG.braid,
          ...(data.config.spqr?.braid || {}),
        },
      },
    },
  };
  
  // ACTION 16 SUPPRIMÉE — CAUSE DE BUG CATASTROPHIQUE
  //
  // L'ancien code faisait: state.sendingChainKey = null;
  // Cela forçait un DH ratchet au prochain envoi après chaque désérialisation.
  //
  // PROBLÈME: performDHRatchetWithHE() côté réception utilise
  // state.sendingRatchetKey.privateKey pour calculer le DH secret.
  // Si les deux téléphones redémarrent et envoient avant de recevoir:
  //   - A envoie → DH ratchet → sendingRatchetKey = A_new
  //   - B envoie → DH ratchet → DH(B_new, A_old) (connaît encore A_old)
  //   - A reçoit → DH(A_new, B_new) ≠ DH(B_new, A_old) → MISMATCH PERMANENT
  //
  // La justification originale (nonce reuse) n'est pas valide pour un restart normal:
  // messageNumberSend est correctement persisté et restauré, donc les nonces
  // (HMAC(chainKey, messageNumber)) ne sont jamais réutilisés.
  
  return state;
}

// ============================================
// CLEANUP
// ============================================

/**
 * Efface tous les secrets de l'état
 */
export function cleanupTripleRatchetState(state: TripleRatchetState): void {
  zeroize(state.rootKey.bytes);
  
  if (state.sendingChainKey) {
    zeroize(state.sendingChainKey.bytes);
  }
  
  if (state.receivingChainKey) {
    zeroize(state.receivingChainKey.bytes);
  }
  
  zeroize(state.sendingRatchetKey.privateKey.bytes);
  
  // Effacer les header keys
  if (state.sendingHeaderKey) {
    zeroize(state.sendingHeaderKey.bytes);
  }
  if (state.receivingHeaderKey) {
    zeroize(state.receivingHeaderKey.bytes);
  }
  zeroize(state.nextSendingHeaderKey.bytes);
  zeroize(state.nextReceivingHeaderKey.bytes);
  
  // Effacer les clés sautées (incluant les header keys)
  for (const entry of state.skippedKeys.values()) {
    zeroize(entry.key.bytes);
    zeroize(entry.headerKey.bytes);
  }
  state.skippedKeys.clear();
  
  // Effacer l'état SPQR
  cleanupSPQRState(state.spqr);
}

// ============================================
// EXPORTS
// ============================================

export {
  TRIPLE_RATCHET_CONSTANTS,
  KDF_DOMAINS,
};