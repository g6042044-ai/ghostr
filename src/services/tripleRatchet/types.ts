// src/services/tripleRatchet/types.ts
// Types TypeScript stricts pour le Triple Ratchet
// Version 1.0 - État de l'art cryptographique
//
// ARCHITECTURE:
// - Types nominaux pour éviter les confusions entre clés
// - Interfaces immuables quand possible
// - Support complet du protocole Signal amélioré

// ============================================
// TYPES DE BASE - CLÉS CRYPTOGRAPHIQUES
// ============================================

/**
 * Clé publique X25519 (32 bytes)
 * Utilisée pour l'échange Diffie-Hellman
 */
export interface X25519PublicKey {
  readonly _brand: 'X25519PublicKey';
  readonly bytes: Uint8Array; // 32 bytes
}

/**
 * Clé privée X25519 (32 bytes)
 * SENSIBLE - doit être zeroizée après usage
 */
export interface X25519PrivateKey {
  readonly _brand: 'X25519PrivateKey';
  readonly bytes: Uint8Array; // 32 bytes
}

/**
 * Paire de clés X25519 pour DH
 */
export interface X25519KeyPair {
  readonly publicKey: X25519PublicKey;
  readonly privateKey: X25519PrivateKey;
}

/**
 * Clé publique Ed25519 (32 bytes)
 * Utilisée pour les signatures (Identity Key)
 */
export interface Ed25519PublicKey {
  readonly _brand: 'Ed25519PublicKey';
  readonly bytes: Uint8Array; // 32 bytes
}

/**
 * Clé privée Ed25519 (64 bytes)
 * SENSIBLE - doit être zeroizée après usage
 */
export interface Ed25519PrivateKey {
  readonly _brand: 'Ed25519PrivateKey';
  readonly bytes: Uint8Array; // 64 bytes
}

/**
 * Paire de clés Ed25519 pour signatures
 */
export interface Ed25519KeyPair {
  readonly publicKey: Ed25519PublicKey;
  readonly privateKey: Ed25519PrivateKey;
}

/**
 * Signature Ed25519 (64 bytes)
 */
export interface Ed25519Signature {
  readonly _brand: 'Ed25519Signature';
  readonly bytes: Uint8Array; // 64 bytes
}

/**
 * Clé symétrique générique (32 bytes)
 * Utilisée pour le chiffrement AES/ChaCha ou comme clé de chaîne
 */
export interface SymmetricKey {
  readonly _brand: 'SymmetricKey';
  readonly bytes: Uint8Array; // 32 bytes
}

/**
 * Clé de chaîne (Chain Key) pour le ratchet symétrique
 */
export interface ChainKey {
  readonly _brand: 'ChainKey';
  readonly bytes: Uint8Array; // 32 bytes
}

/**
 * Clé de message dérivée d'une Chain Key
 */
export interface MessageKey {
  readonly _brand: 'MessageKey';
  readonly bytes: Uint8Array; // 32 bytes
}

/**
 * Root Key pour le Double Ratchet
 */
export interface RootKey {
  readonly _brand: 'RootKey';
  readonly bytes: Uint8Array; // 32 bytes
}

/**
 * Header Key pour le chiffrement des en-têtes (Header Encryption)
 * Utilisée pour masquer les métadonnées DH (clé publique, numéros de message)
 */
export interface HeaderKey {
  readonly _brand: 'HeaderKey';
  readonly bytes: Uint8Array; // 32 bytes
}

// ============================================
// TYPES X3DH (Extended Triple Diffie-Hellman)
// ============================================

/**
 * Identity Key - Clé d'identité long terme
 * Paire Ed25519 pour signer, convertible en X25519 pour DH
 */
export interface IdentityKeyPair {
  readonly publicKey: Ed25519PublicKey;
  readonly privateKey: Ed25519PrivateKey;
  // Version X25519 dérivée pour DH
  readonly dhPublicKey: X25519PublicKey;
  readonly dhPrivateKey: X25519PrivateKey;
}

/**
 * Signed Pre-Key - Clé pré-signée (rotation ~semaine)
 */
export interface SignedPreKey {
  readonly id: number; // ID unique pour cette pre-key
  readonly keyPair: X25519KeyPair;
  readonly signature: Ed25519Signature; // Signature par Identity Key
  readonly timestamp: number; // Date de création
}

/**
 * One-Time Pre-Key - Clé à usage unique
 */
export interface OneTimePreKey {
  readonly id: number;
  readonly keyPair: X25519KeyPair;
}

/**
 * Bundle de clés publiques pour initier X3DH
 * Publié par chaque utilisateur
 */
export interface PreKeyBundle {
  readonly identityKey: Ed25519PublicKey;
  readonly signedPreKey: {
    readonly id: number;
    readonly publicKey: X25519PublicKey;
    readonly signature: Ed25519Signature;
  };
  readonly oneTimePreKey?: {
    readonly id: number;
    readonly publicKey: X25519PublicKey;
  };
}

/**
 * Résultat de l'échange X3DH côté initiateur
 */
export interface X3DHInitiatorResult {
  readonly sharedSecret: SymmetricKey;
  readonly ephemeralPublicKey: X25519PublicKey;
  readonly usedOneTimePreKeyId?: number;
}

/**
 * Message initial X3DH envoyé au destinataire
 */
export interface X3DHInitialMessage {
  readonly identityKey: Ed25519PublicKey;
  readonly ephemeralKey: X25519PublicKey;
  readonly usedSignedPreKeyId: number;
  readonly usedOneTimePreKeyId?: number;
  // Le premier message chiffré avec la clé dérivée
  readonly ciphertext: Uint8Array;
}

// ============================================
// TYPES DOUBLE RATCHET
// ============================================

/**
 * État d'une chaîne de ratchet (envoi ou réception)
 */
export interface RatchetChain {
  readonly chainKey: ChainKey;
  readonly messageIndex: number;
}

/**
 * Clés de messages sautés (pour messages out-of-order)
 * Map: (dhPublicKey, messageIndex) -> MessageKey
 */
export interface SkippedMessageKeys {
  readonly keys: Map<string, MessageKey>; // key = `${dhPubKeyHex}:${index}`
}

/**
 * État complet du Double Ratchet pour une session
 */
export interface DoubleRatchetState {
  // Root Key actuelle
  readonly rootKey: RootKey;
  
  // Ma paire DH actuelle (pour envoyer)
  readonly myDHKeyPair: X25519KeyPair;
  
  // Clé DH publique du pair (pour recevoir)
  readonly theirDHPublicKey: X25519PublicKey | null;
  
  // Chaîne d'envoi
  readonly sendChain: RatchetChain | null;
  
  // Chaîne de réception
  readonly receiveChain: RatchetChain | null;
  
  // Compteur de messages envoyés dans le ratchet actuel
  readonly sendMessageCount: number;
  
  // Compteur de messages reçus
  readonly receiveMessageCount: number;
  
  // Nombre de ratchets DH effectués
  readonly previousChainLength: number;
  
  // Clés de messages sautés
  readonly skippedKeys: SkippedMessageKeys;
}

// ============================================
// TYPES TRIPLE RATCHET (Identity Rotation)
// ============================================

/**
 * Époque d'identité pour le Triple Ratchet
 */
export interface IdentityEpoch {
  readonly epochNumber: number;
  readonly identityKeyPair: IdentityKeyPair;
  readonly createdAt: number;
  readonly expiresAt: number; // Rotation suggérée
}

/**
 * État du Triple Ratchet
 */
export interface TripleRatchetState {
  // Mon identité actuelle
  readonly myIdentity: IdentityEpoch;
  
  // Identité du pair (leur clé publique actuelle)
  readonly theirIdentity: Ed25519PublicKey;
  readonly theirIdentityEpoch: number;
  
  // État du Double Ratchet
  readonly doubleRatchet: DoubleRatchetState;
  
  // Historique des identités (pour vérification)
  readonly identityHistory: ReadonlyArray<{
    readonly publicKey: Ed25519PublicKey;
    readonly epoch: number;
    readonly firstSeenAt: number;
  }>;
}

// ============================================
// TYPES MESSAGES CHIFFRÉS
// ============================================

/**
 * En-tête d'un message Double Ratchet
 */
export interface MessageHeader {
  readonly dhPublicKey: X25519PublicKey; // Clé DH de l'expéditeur
  readonly previousChainLength: number; // Nb messages dans chaîne précédente
  readonly messageNumber: number; // Index dans la chaîne actuelle
}

/**
 * Message chiffré complet
 */
export interface EncryptedMessage {
  readonly header: MessageHeader;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  // Pour le Triple Ratchet
  readonly identityEpoch?: number;
}

/**
 * Message sérialisé pour transmission
 */
export interface SerializedMessage {
  readonly type: 'triple_ratchet_v1';
  readonly version: number;
  readonly headerBase64: string;
  readonly ciphertextBase64: string;
  readonly nonceBase64: string;
  readonly identityEpoch?: number;
}

// ============================================
// TYPES SESSION
// ============================================

/**
 * État d'une session 1-à-1 complète
 */
export interface Session {
  readonly id: string; // Identifiant unique de session
  readonly createdAt: number;
  readonly lastActivityAt: number;
  
  // Identités
  readonly myIdentityPublicKey: Ed25519PublicKey;
  readonly theirIdentityPublicKey: Ed25519PublicKey;
  
  // État du Triple Ratchet
  readonly tripleRatchetState: TripleRatchetState;
  
  // Metadata
  readonly isInitiator: boolean; // Qui a initié la session
  readonly verified: boolean; // Safety Numbers vérifiés
}

/**
 * Session sérialisée pour stockage
 */
export interface SerializedSession {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly isInitiator: boolean;
  readonly verified: boolean;
  
  // Clés sérialisées en base64
  readonly myIdentityPublicKeyBase64: string;
  readonly theirIdentityPublicKeyBase64: string;
  readonly stateJson: string; // État Triple Ratchet JSON
}

// ============================================
// TYPES POUR LA CRÉATION DE CONVERSATION 1-à-1
// ============================================

/**
 * Données d'invitation pour créer/rejoindre
 */
export interface ConversationInvite {
  readonly version: number;
  readonly creatorIdentityKey: Ed25519PublicKey;
  readonly creatorSignedPreKey: {
    readonly id: number;
    readonly publicKey: X25519PublicKey;
    readonly signature: Ed25519Signature;
  };
  readonly creatorOneTimePreKey?: {
    readonly id: number;
    readonly publicKey: X25519PublicKey;
  };
  // Métadonnées (chiffrées avec une clé dérivée)
  readonly encryptedMetadata?: Uint8Array;
}

/**
 * Réponse à une invitation
 */
export interface ConversationAccept {
  readonly version: number;
  readonly responderIdentityKey: Ed25519PublicKey;
  readonly ephemeralKey: X25519PublicKey;
  readonly usedSignedPreKeyId: number;
  readonly usedOneTimePreKeyId?: number;
  // Premier message (optionnel)
  readonly initialMessage?: EncryptedMessage;
}

// ============================================
// TYPES UTILITAIRES
// ============================================

/**
 * Résultat d'une opération crypto qui peut échouer
 */
export type CryptoResult<T> = 
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly error: string };

/**
 * Informations pour générer les Safety Numbers
 */
export interface SafetyNumberInfo {
  readonly myIdentityKey: Ed25519PublicKey;
  readonly theirIdentityKey: Ed25519PublicKey;
  readonly myIdentifier: string; // Ex: numéro de téléphone ou username
  readonly theirIdentifier: string;
}

/**
 * Représentation des Safety Numbers
 */
export interface SafetyNumber {
  readonly numericCode: string; // 60 chiffres (12 groupes de 5)
  readonly qrData: Uint8Array; // Données pour QR code
}

// ============================================
// CONSTANTES
// ============================================

export const CRYPTO_CONSTANTS = {
  // Tailles des clés
  X25519_PUBLIC_KEY_SIZE: 32,
  X25519_PRIVATE_KEY_SIZE: 32,
  ED25519_PUBLIC_KEY_SIZE: 32,
  ED25519_PRIVATE_KEY_SIZE: 64,
  ED25519_SIGNATURE_SIZE: 64,
  SYMMETRIC_KEY_SIZE: 32,
  NONCE_SIZE: 24,
  HEADER_KEY_SIZE: 32,
  HEADER_NONCE_SIZE: 24, // XSalsa20 nonce
  
  // Limites
  MAX_SKIP: 1000, // Max messages out-of-order
  MAX_SKIPPED_KEYS: 100, // Max clés gardées en cache
  
  // Rotation
  SIGNED_PRE_KEY_ROTATION_DAYS: 7,
  IDENTITY_ROTATION_DAYS: 90, // Triple Ratchet
  
  // Versions
  PROTOCOL_VERSION: 2, // Incrémenté pour Header Encryption
  MESSAGE_VERSION: 2,
} as const;

// ============================================
// TYPE GUARDS
// ============================================

export function isX25519PublicKey(key: unknown): key is X25519PublicKey {
  return (
    typeof key === 'object' &&
    key !== null &&
    '_brand' in key &&
    (key as X25519PublicKey)._brand === 'X25519PublicKey' &&
    'bytes' in key &&
    (key as X25519PublicKey).bytes instanceof Uint8Array &&
    (key as X25519PublicKey).bytes.length === 32
  );
}

export function isEd25519PublicKey(key: unknown): key is Ed25519PublicKey {
  return (
    typeof key === 'object' &&
    key !== null &&
    '_brand' in key &&
    (key as Ed25519PublicKey)._brand === 'Ed25519PublicKey' &&
    'bytes' in key &&
    (key as Ed25519PublicKey).bytes instanceof Uint8Array &&
    (key as Ed25519PublicKey).bytes.length === 32
  );
}

export function isSymmetricKey(key: unknown): key is SymmetricKey {
  return (
    typeof key === 'object' &&
    key !== null &&
    '_brand' in key &&
    (key as SymmetricKey)._brand === 'SymmetricKey' &&
    'bytes' in key &&
    (key as SymmetricKey).bytes instanceof Uint8Array &&
    (key as SymmetricKey).bytes.length === 32
  );
}

export function isHeaderKey(key: unknown): key is HeaderKey {
  return (
    typeof key === 'object' &&
    key !== null &&
    '_brand' in key &&
    (key as HeaderKey)._brand === 'HeaderKey' &&
    'bytes' in key &&
    (key as HeaderKey).bytes instanceof Uint8Array &&
    (key as HeaderKey).bytes.length === 32
  );
}