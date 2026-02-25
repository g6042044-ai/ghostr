// src/services/tripleRatchet/index.ts
// Triple Ratchet avec Protection Post-Quantique ML-KEM-768
// Version 2.0 - Signal Protocol + PQXDH + SPQR
//
// GARANTIES DE SÉCURITÉ:
// ✅ Forward Secrecy (DH Ratchet X25519)
// ✅ Post-Compromise Security (Symmetric Ratchet)
// ✅ Post-Quantum Security (SPQR + ML-KEM-768)
// ✅ Harvest Now, Decrypt Later Resistance
// ✅ Traffic Analysis Protection (Message Padding)

// ============================================
// TYPES DE BASE
// ============================================

export {
  type X25519PublicKey,
  type X25519PrivateKey,
  type X25519KeyPair,
  type Ed25519PublicKey,
  type Ed25519PrivateKey,
  type Ed25519KeyPair,
  type Ed25519Signature,
  type SymmetricKey,
  type ChainKey,
  type MessageKey,
  type RootKey,
  type HeaderKey,
  type IdentityKeyPair,
  type SignedPreKey,
  type OneTimePreKey,
  type PreKeyBundle,
  type EncryptedMessage,
  CRYPTO_CONSTANTS,
} from './types';

// ============================================
// PRIMITIVES CRYPTOGRAPHIQUES
// ============================================

export {
  generateX25519KeyPair,
  generateEd25519KeyPair,
  generateIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKey,
  generateOneTimePreKeys,
  getSecureRandomBytes,
  x25519,
  sign,
  verify,
  protocolHkdf,
  ed25519PublicKeyToX25519,
  encryptAEAD,
  decryptAEAD,
  bytesToHex,
  hexToBytes,
  encodeBase64,
  decodeBase64,
  constantTimeEqual,
  serializePublicKey,
  deserializeX25519PublicKey,
  deserializeEd25519PublicKey,
  deserializeSignature,
  createEd25519Signature,
  createSymmetricKey,
  createChainKey,
  createRootKey,
  createMessageKey,
  createHeaderKey,
  zeroize,
  zeroizeAll,
  secureClone,
} from './primitives';

// ============================================
// ML-KEM-768 (POST-QUANTUM)
// ============================================

export {
  type KyberPublicKey,
  type KyberSecretKey,
  type KyberKeyPair,
  type KyberCiphertext,
  type KyberSharedSecret,
  type KyberChunk,
  KYBER_CONSTANTS,
  kyberKeyGen,
  kyberEncapsulate,
  kyberDecapsulate,
  chunkPublicKey,
  chunkCiphertext,
  reconstructPublicKey,
  reconstructCiphertext,
  serializeKyberPublicKey,
  deserializeKyberPublicKey,
  serializeKyberCiphertext,
  deserializeKyberCiphertext,
  serializeKyberChunk,
  deserializeKyberChunk,
  zeroizeKyberSecretKey,
  zeroizeKyberSharedSecret,
} from './pqPrimitives';

// ============================================
// PQXDH (POST-QUANTUM KEY EXCHANGE)
// ============================================

export {
  type PQSignedKey,
  type PQPreKeyBundle,
  type PQXDHInitialMessage,
  type PQXDHInitiatorResult,
  type SerializedPQPreKeyBundle,
  generatePQSignedKey,
  createPQPreKeyBundle,
  validatePQPreKeyBundle,
  pqxdhInitiator,
  pqxdhResponder,
  serializePQPreKeyBundle,
  deserializePQPreKeyBundle,
  serializePQXDHMessage,
  deserializePQXDHMessage,
  isPQXDHBundle,
} from './pqxdh';

// ============================================
// SPQR (SPARSE POST-QUANTUM RATCHET)
// ============================================

export {
  type SPQRState,
  type SPQRConfig,
  type SPQRMessageMeta,
  type HybridRatchetState,
  type SerializedSPQRState,
  type SerializedBraidPayload,
  DEFAULT_SPQR_CONFIG,
  createNSESPQRConfig,
  createInitialSPQRState,
  initializeSPQR,
  shouldRotateSPQR,
  rotateSPQR,
  encapsulatePQ,
  decapsulatePQ,
  mixPQSecrets,
  prepareBraidChunks,
  processReceivedChunks,
  deriveHybridRootKey,
  deriveHybridRootKeyWithHE,
  createSPQRMessageMeta,
  processSPQRMessageMeta,
  applyPendingBraidSecret,
  serializeSPQRState,
  deserializeSPQRState,
  cleanupSPQRState,
} from './spqr';

// ============================================
// ML-KEM BRAID (PARALLEL PQ KEY EXCHANGE)
// ============================================

export {
  type BraidState,
  type BraidPayload,
  type BraidConfig,
  type BraidPhase,
  type BraidRole,
  type BraidChunk,
  type SerializedBraidState,
  BRAID_CONSTANTS,
  DEFAULT_BRAID_CONFIG,
  createInitialBraidState,
  initiateBraid,
  processReceivedBraidPayload,
  generateBraidPayload,
  shouldInitiateBraid,
  canFinalizeBraid,
  finalizeBraid,
  cleanupBraidState,
  serializeBraidState,
  deserializeBraidState,
  mixBraidSecrets,
  isBraidExchangeExpired,
  resetExpiredBraidExchange,
} from './mlkemBraid';

// ============================================
// TRIPLE RATCHET
// ============================================

export {
  type TripleRatchetState,
  type TripleRatchetConfig,
  type TripleRatchetHeader,
  type TripleRatchetMessage,
  type SerializedTripleRatchetState,
  initializeTripleRatchetInitiator,
  initializeTripleRatchetResponder,
  tripleRatchetEncrypt,
  tripleRatchetDecrypt,
  serializeTripleRatchetState,
  deserializeTripleRatchetState,
  cleanupTripleRatchetState,
} from './tripleRatchet';

// ============================================
// MESSAGE PADDING
// ============================================

export {
  type PaddingSize,
  type PaddingConfig,
  type PaddingStats,
  DEFAULT_PADDING_CONFIG,
  BUCKET_SIZES,
  padMessage,
  unpadMessage,
  padMessageConstantTime,
  unpadMessageConstantTime,
  padTextMessage,
  unpadTextMessage,
  padMediaMessage,
  padControlMessage,
  estimatePaddedSize,
  isValidPaddedMessage,
  getPaddingStats,
} from './messagePadding';

// ============================================
// SESSION SERVICE (Triple Ratchet + Post-Quantum)
// ============================================

export {
  sessionService,
  SessionService,
  type UserProfile,
  type StoredSession,
  type InviteData,
  type InviteResponse,
  type CreateInviteResult,
  type AcceptInviteResult,
  type FinalizeSessionResult,
  type EncryptedMessage as EncryptedMessagePQ,
  type KeyChangeEvent,
} from './sessionService';

// ============================================
// CALL TRIPLE RATCHET (Audio Encryption)
// ============================================

export {
  type CallRatchetState,
  type EncryptedAudioPacket,
  type DHRotationMessage,
  type SerializedCallRatchetInit,
  initializeCallRatchet,
  initializeCallRatchetFromSecret,
  encryptAudioPacket as encryptCallAudioPacket,
  decryptAudioPacket as decryptCallAudioPacket,
  shouldRotateDH,
  prepareDHRotation,
  processDHRotation,
  cleanupCallRatchetState,
  getCallRatchetStats,
  createCallRatchetInit,
  processCallRatchetInit,
  initializeCallRatchetFromInit,
  serializeCallRatchetState,
  deserializeCallRatchetState,
} from './callTripleRatchet';

// ============================================
// MODULE INFO
// ============================================

export const MODULE_INFO = {
  name: 'Triple Ratchet with Post-Quantum Security, Header Encryption, and Audio Encryption',
  version: '2.2.0',
  
  algorithms: {
    keyExchange: 'X25519 + ML-KEM-768 (PQXDH)',
    signatures: 'Ed25519',
    encryption: 'XSalsa20-Poly1305',
    headerEncryption: 'XSalsa20-Poly1305',
    audioEncryption: 'XSalsa20-Poly1305 with Symmetric Ratchet',
    kdf: 'HKDF-SHA256',
    postQuantum: 'ML-KEM-768 (NIST FIPS 203)',
  },
  
  security: {
    forwardSecrecy: true,
    postCompromiseSecurity: true,
    postQuantumSecurity: true,
    harvestNowDecryptLaterResistance: true,
    messagePadding: true,
    headerEncryption: true,
    metadataProtection: true,
    audioForwardSecrecy: true,
    replayProtection: true,
  },
};

// ============================================
// SODIUM ZEROIZE (v3.1)
// ============================================
// Doit être appelé au démarrage: await initSodiumZeroize()
// Si libsodium est dispo, zeroize() utilise sodium.memzero() garanti.
// Sinon, le fallback JS 4-pass continue de fonctionner.

export {
  initSodiumZeroize,
  isSodiumReady,
  getSodiumZeroizeStats,
} from '../sodiumZeroize';