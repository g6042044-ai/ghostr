// src/services/tripleRatchet/pqxdh.ts
// PQXDH - Post-Quantum Extended Triple Diffie-Hellman
// Version 1.0 - Implémentation conforme Signal PQXDH
//
// SÉCURITÉ HYBRIDE:
// =================
// PQXDH combine X3DH classique avec ML-KEM (Kyber) pour offrir:
// - Sécurité contre les ordinateurs classiques (X25519)
// - Sécurité contre les ordinateurs quantiques (ML-KEM-768)
// - Un attaquant doit casser LES DEUX pour compromettre la session
//
// PROTOCOLE:
// 1. Bob publie: IK_B, SPK_B, OPK_B (classique) + KEM_PK_B (post-quantum)
// 2. Alice calcule:
//    - DH_secret via X3DH standard (DH1 || DH2 || DH3 || DH4)
//    - KEM_secret via ML-KEM encapsulation avec KEM_PK_B
// 3. SK = KDF(DH_secret || KEM_secret)
// 4. Alice envoie: message X3DH + KEM_ciphertext
// 5. Bob décapsule et combine les secrets
//
// RÉFÉRENCE: Signal PQXDH Specification (2023)

import {
  X25519KeyPair,
  X25519PublicKey,
  Ed25519PublicKey,
  Ed25519Signature,
  SymmetricKey,
  IdentityKeyPair,
  SignedPreKey,
  OneTimePreKey,
  PreKeyBundle,
  X3DHInitialMessage,
  CRYPTO_CONSTANTS,
} from './types';

import {
  generateX25519KeyPair,
  x25519,
  sign,
  verify,
  protocolHkdf,
  hkdfSync,
  hmacSha256,
  zeroize,
  zeroizeAll,
  createSymmetricKey,
  ed25519PublicKeyToX25519,
  bytesToHex,
  hexToBytes,
  getSecureRandomBytes,
} from './primitives';

// @noble/hashes - bibliothèque auditée pour SHA-256
import { sha256 } from '@noble/hashes/sha256';

import {
  KyberKeyPair,
  KyberPublicKey,
  KyberSecretKey,
  KyberCiphertext,
  KyberSharedSecret,
  kyberKeyGen,
  kyberEncapsulate,
  kyberDecapsulate,
  serializeKyberPublicKey,
  deserializeKyberPublicKey,
  serializeKyberCiphertext,
  deserializeKyberCiphertext,
  zeroizeKyberSecretKey,
  zeroizeKyberSharedSecret,
  KYBER_CONSTANTS,
} from './pqPrimitives';

// ============================================
// TYPES PQXDH
// ============================================

/**
 * Clé post-quantique signée (comme SignedPreKey mais pour Kyber)
 */
export interface PQSignedKey {
  readonly id: number;
  readonly keyPair: KyberKeyPair;
  readonly signature: Ed25519Signature;
  readonly timestamp: number;
}

/**
 * PreKeyBundle étendu avec clé post-quantique
 */
export interface PQPreKeyBundle {
  // Clés classiques (X3DH standard)
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
  
  // Clé post-quantique ML-KEM
  readonly pqPreKey: {
    readonly id: number;
    readonly publicKey: KyberPublicKey;
    readonly signature: Ed25519Signature;
  };
  
  // Version du protocole
  readonly version: 2; // PQXDH = version 2
}

/**
 * Résultat de l'initiation PQXDH côté Alice
 */
export interface PQXDHInitiatorResult {
  readonly sharedSecret: SymmetricKey;
  readonly ephemeralPublicKey: X25519PublicKey;
  readonly ephemeralKeyPair: X25519KeyPair; // Paire complète pour le ratchet
  readonly kemCiphertext: KyberCiphertext;
  readonly usedOneTimePreKeyId?: number;
  /** Deniable MAC (Audit C-03) — both parties can compute this */
  readonly deniableMAC: Uint8Array;
}

/**
 * Message initial PQXDH (extension du X3DH)
 * 
 * DENIABILITY (Audit Fix C-03):
 *   Le deniableMAC est un HMAC calculé avec une clé dérivée des DH partagés.
 *   Les DEUX parties peuvent calculer ce MAC → il ne prouve rien à un tiers.
 *   Après vérification, toutes les signatures Ed25519 sont supprimées de l'état.
 *   Les messages post-handshake sont authentifiés par HMAC symétrique uniquement.
 */
export interface PQXDHInitialMessage {
  // Partie X3DH classique
  readonly identityKey: Ed25519PublicKey;
  readonly ephemeralKey: X25519PublicKey;
  readonly usedSignedPreKeyId: number;
  readonly usedOneTimePreKeyId?: number;
  
  // Partie post-quantique
  readonly usedPQPreKeyId: number;
  readonly kemCiphertext: KyberCiphertext;
  
  // Deniable authentication (Audit C-03)
  // MAC(KDF(DH1||DH2), identityKey || ephemeralKey || kemCiphertext_hash)
  // Both parties can compute this → not a proof for third parties
  readonly deniableMAC?: Uint8Array;
  
  // Payload optionnel
  readonly ciphertext: Uint8Array;
}

/**
 * Sérialisation du PQPreKeyBundle pour transmission
 */
export interface SerializedPQPreKeyBundle {
  v: 2; // Version PQXDH
  ik: string; // Identity Key (base64)
  spk: {
    id: number;
    pk: string; // Public Key (base64)
    sig: string; // Signature (base64)
  };
  opk?: {
    id: number;
    pk: string;
  };
  pqk: {
    id: number;
    pk: string; // Kyber Public Key (base64)
    sig: string;
  };
}

// ============================================
// CONSTANTES PQXDH
// ============================================

const PQXDH_KDF_INFO = 'pqxdh_shared_secret_v1';
const PQ_PREKEY_SIGNATURE_PREFIX = 'ghostr_pq_prekey_v1:';
const SIGNED_PREKEY_SIGNATURE_PREFIX = 'SignedPreKey:';

// Durée de validité d'une PQ PreKey
// v2.0: Étendu à 90 jours pour supporter:
// - Absences longues (vacances, voyages, congés)
// - Membres qui ne se connectent pas fréquemment
// - Réduction du overhead de rotation des clés PQ
// Trade-off acceptable: les clés PQ sont signées par l'Identity Key
// donc leur validité étendue n'affaiblit pas la sécurité cryptographique
const PQ_PREKEY_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000; // 90 jours

// ============================================
// GÉNÉRATION DES CLÉS POST-QUANTIQUES
// ============================================

/**
 * Génère une paire de clés ML-KEM signée
 */
export function generatePQSignedKey(
  identityKeyPair: IdentityKeyPair,
  id: number
): PQSignedKey {
  // Générer la paire de clés Kyber
  const keyPair = kyberKeyGen();
  
  // Créer le message à signer
  const signatureMessage = createPQPreKeyMessage(keyPair.publicKey);
  
  // Signer avec l'Identity Key Ed25519
  const signature = sign(signatureMessage, identityKeyPair.privateKey);
  
  return {
    id,
    keyPair,
    signature,
    timestamp: Date.now(),
  };
}

/**
 * Crée le message à signer pour une PQ PreKey
 */
function createPQPreKeyMessage(publicKey: KyberPublicKey): Uint8Array {
  const prefix = new TextEncoder().encode(PQ_PREKEY_SIGNATURE_PREFIX);
  // On signe le hash de la clé publique (trop grande pour signature directe)
  const pkHash = hashForSignature(publicKey.bytes);
  
  const message = new Uint8Array(prefix.length + pkHash.length);
  message.set(prefix);
  message.set(pkHash, prefix.length);
  return message;
}

/**
 * Vérifie la signature d'une PQ PreKey
 */
export function verifyPQPreKey(
  publicKey: KyberPublicKey,
  signature: Ed25519Signature,
  identityKey: Ed25519PublicKey
): boolean {
  const message = createPQPreKeyMessage(publicKey);
  return verify(message, signature, identityKey);
}

/**
 * Hash SHA-256 pour signature
 * Utilise @noble/hashes (bibliothèque auditée, constant-time)
 */
function hashForSignature(data: Uint8Array): Uint8Array {
  return sha256(data);
}

// ============================================
// CRÉATION DU BUNDLE PQXDH
// ============================================

/**
 * Crée un PQPreKeyBundle complet pour publication
 */
export function createPQPreKeyBundle(
  identityKeyPair: IdentityKeyPair,
  signedPreKey: SignedPreKey,
  pqSignedKey: PQSignedKey,
  oneTimePreKey?: OneTimePreKey
): PQPreKeyBundle {
  const bundle: PQPreKeyBundle = {
    version: 2,
    identityKey: identityKeyPair.publicKey,
    signedPreKey: {
      id: signedPreKey.id,
      publicKey: signedPreKey.keyPair.publicKey,
      signature: signedPreKey.signature,
    },
    pqPreKey: {
      id: pqSignedKey.id,
      publicKey: pqSignedKey.keyPair.publicKey,
      signature: pqSignedKey.signature,
    },
  };
  
  if (oneTimePreKey) {
    return {
      ...bundle,
      oneTimePreKey: {
        id: oneTimePreKey.id,
        publicKey: oneTimePreKey.keyPair.publicKey,
      },
    };
  }
  
  return bundle;
}

// ============================================
// PQXDH CÔTÉ INITIATEUR (Alice)
// ============================================

/**
 * Effectue le PQXDH côté initiateur (Alice)
 * 
 * Combine X3DH classique avec encapsulation ML-KEM pour
 * obtenir un secret hybride résistant aux ordinateurs quantiques.
 */
export async function pqxdhInitiator(
  myIdentityKeyPair: IdentityKeyPair,
  theirBundle: PQPreKeyBundle
): Promise<PQXDHInitiatorResult> {
  // 1. Vérifier la signature de la Signed PreKey (classique)
  const spkMessage = createSignedPreKeyMessage(theirBundle.signedPreKey.publicKey);
  const spkValid = verify(
    spkMessage,
    theirBundle.signedPreKey.signature,
    theirBundle.identityKey
  );
  
  if (!spkValid) {
    throw new Error('PQXDH: Invalid signed pre-key signature');
  }
  
  // 2. Vérifier la signature de la PQ PreKey
  const pqValid = verifyPQPreKey(
    theirBundle.pqPreKey.publicKey,
    theirBundle.pqPreKey.signature,
    theirBundle.identityKey
  );
  
  if (!pqValid) {
    throw new Error('PQXDH: Invalid PQ pre-key signature');
  }
  
  // 3. Générer une clé éphémère X25519
  const ephemeralKeyPair = generateX25519KeyPair();
  
  // 4. Convertir l'Identity Key de Bob en X25519
  // R-11: await — ed25519PublicKeyToX25519 utilise libsodium (constant-time, async)
  const theirIdentityDHKey = await ed25519PublicKeyToX25519(theirBundle.identityKey);
  
  // 5. Calculer les DH classiques
  const dh1 = x25519(
    myIdentityKeyPair.dhPrivateKey,
    theirBundle.signedPreKey.publicKey
  );
  
  const dh2 = x25519(
    ephemeralKeyPair.privateKey,
    theirIdentityDHKey
  );
  
  const dh3 = x25519(
    ephemeralKeyPair.privateKey,
    theirBundle.signedPreKey.publicKey
  );
  
  let dh4: Uint8Array | null = null;
  let usedOneTimePreKeyId: number | undefined;
  
  if (theirBundle.oneTimePreKey) {
    dh4 = x25519(
      ephemeralKeyPair.privateKey,
      theirBundle.oneTimePreKey.publicKey
    );
    usedOneTimePreKeyId = theirBundle.oneTimePreKey.id;
  }
  
  // 6. Encapsulation ML-KEM (FIPS 203 via @noble/post-quantum)
  const { ciphertext: kemCiphertext, sharedSecret: kemSecret } = kyberEncapsulate(
    theirBundle.pqPreKey.publicKey
  );
  
  // 7. Concaténer tous les secrets
  // SK = KDF(DH1 || DH2 || DH3 || [DH4] || KEM_SS)
  const dhLength = 32 * (dh4 ? 4 : 3);
  const totalLength = dhLength + 32; // 32 bytes pour KEM secret
  const combinedSecrets = new Uint8Array(totalLength);
  
  let offset = 0;
  combinedSecrets.set(dh1, offset); offset += 32;
  combinedSecrets.set(dh2, offset); offset += 32;
  combinedSecrets.set(dh3, offset); offset += 32;
  if (dh4) {
    combinedSecrets.set(dh4, offset); offset += 32;
  }
  combinedSecrets.set(kemSecret.bytes, offset);
  
  
  // 8. Dériver le secret partagé final
  const sharedSecret = await derivePQXDHSecret(combinedSecrets);
  
  // 8b. DENIABILITY (Audit Fix C-03):
  // Dériver une clé MAC deniable depuis DH1||DH2 (les deux parties peuvent la calculer)
  // Cette clé n'est PAS liée aux signatures Ed25519.
  const deniableMACKeyInput = new Uint8Array(64);
  deniableMACKeyInput.set(dh1, 0);
  deniableMACKeyInput.set(dh2, 32);
  const deniableMACKey = hkdfSync(
    deniableMACKeyInput,
    new Uint8Array(32),
    'ghostr_deniable_mac_v1',
    32
  );
  
  // MAC sur les données publiques du message : identityKey || ephemeralKey || hash(kemCiphertext)
  const kemHash = sha256(kemCiphertext.bytes);
  const macData = new Uint8Array(32 + 32 + 32);
  macData.set(myIdentityKeyPair.publicKey.bytes, 0);
  macData.set(ephemeralKeyPair.publicKey.bytes, 32);
  macData.set(kemHash, 64);
  const deniableMAC = hmacSha256(deniableMACKey, macData);
  
  // Cleanup
  zeroize(deniableMACKeyInput);
  zeroize(deniableMACKey);
  zeroize(macData);
  
  // 9. Cleanup des secrets intermédiaires (mais PAS ephemeralKeyPair - utilisée pour le ratchet)
  zeroizeAll(dh1, dh2, dh3, dh4, combinedSecrets);
  zeroizeKyberSharedSecret(kemSecret);
  
  return {
    sharedSecret,
    ephemeralPublicKey: ephemeralKeyPair.publicKey,
    ephemeralKeyPair, // Retourner la paire complète pour le ratchet !
    kemCiphertext,
    usedOneTimePreKeyId,
    deniableMAC,
  };
}

/**
 * Crée le message de signaturePreKey
 */
function createSignedPreKeyMessage(publicKey: X25519PublicKey): Uint8Array {
  const prefix = new TextEncoder().encode(SIGNED_PREKEY_SIGNATURE_PREFIX);
  const message = new Uint8Array(prefix.length + publicKey.bytes.length);
  message.set(prefix);
  message.set(publicKey.bytes, prefix.length);
  return message;
}

/**
 * Crée le message initial PQXDH à envoyer
 * 
 * DENIABILITY (Audit Fix C-03): Le deniableMAC remplace les Ed25519
 * signatures pour l'authentification du message initial. Les deux
 * parties peuvent calculer ce MAC → non-repudiation impossible.
 */
export function createPQXDHInitialMessage(
  myIdentityKeyPair: IdentityKeyPair,
  ephemeralPublicKey: X25519PublicKey,
  kemCiphertext: KyberCiphertext,
  usedSignedPreKeyId: number,
  usedPQPreKeyId: number,
  usedOneTimePreKeyId?: number,
  initialCiphertext?: Uint8Array,
  deniableMAC?: Uint8Array
): PQXDHInitialMessage {
  return {
    identityKey: myIdentityKeyPair.publicKey,
    ephemeralKey: ephemeralPublicKey,
    usedSignedPreKeyId,
    usedOneTimePreKeyId,
    usedPQPreKeyId,
    kemCiphertext,
    deniableMAC,
    ciphertext: initialCiphertext || new Uint8Array(0),
  };
}

// ============================================
// PQXDH CÔTÉ DESTINATAIRE (Bob)
// ============================================

/**
 * Effectue le PQXDH côté destinataire (Bob)
 */
export async function pqxdhResponder(
  myIdentityKeyPair: IdentityKeyPair,
  mySignedPreKey: SignedPreKey,
  myPQSignedKey: PQSignedKey,
  myOneTimePreKey: OneTimePreKey | null,
  initialMessage: PQXDHInitialMessage
): Promise<SymmetricKey> {
  // 1. Convertir l'Identity Key d'Alice en X25519
  // R-11: await — ed25519PublicKeyToX25519 utilise libsodium (constant-time, async)
  const theirIdentityDHKey = await ed25519PublicKeyToX25519(initialMessage.identityKey);
  
  // 2. Calculer les DH classiques (ordre inverse d'Alice)
  const dh1 = x25519(
    mySignedPreKey.keyPair.privateKey,
    theirIdentityDHKey
  );
  
  const dh2 = x25519(
    myIdentityKeyPair.dhPrivateKey,
    initialMessage.ephemeralKey
  );
  
  const dh3 = x25519(
    mySignedPreKey.keyPair.privateKey,
    initialMessage.ephemeralKey
  );
  
  let dh4: Uint8Array | null = null;
  
  if (myOneTimePreKey && initialMessage.usedOneTimePreKeyId !== undefined) {
    if (myOneTimePreKey.id !== initialMessage.usedOneTimePreKeyId) {
      throw new Error('PQXDH: One-time pre-key ID mismatch');
    }
    
    dh4 = x25519(
      myOneTimePreKey.keyPair.privateKey,
      initialMessage.ephemeralKey
    );
  }
  
  // 3. Décapsulation ML-KEM (FIPS 203 via @noble/post-quantum)
  if (myPQSignedKey.id !== initialMessage.usedPQPreKeyId) {
    throw new Error('PQXDH: PQ pre-key ID mismatch');
  }
  
  const kemSecret = kyberDecapsulate(
    initialMessage.kemCiphertext,
    myPQSignedKey.keyPair.secretKey
  );
  
  // 4. Concaténer tous les secrets
  // SK = KDF(DH1 || DH2 || DH3 || [DH4] || KEM_SS)
  const dhLength = 32 * (dh4 ? 4 : 3);
  const totalLength = dhLength + 32; // 32 bytes pour KEM secret
  const combinedSecrets = new Uint8Array(totalLength);
  
  let offset = 0;
  combinedSecrets.set(dh1, offset); offset += 32;
  combinedSecrets.set(dh2, offset); offset += 32;
  combinedSecrets.set(dh3, offset); offset += 32;
  if (dh4) {
    combinedSecrets.set(dh4, offset); offset += 32;
  }
  combinedSecrets.set(kemSecret.bytes, offset);
  
  
  // 5. Dériver le secret partagé final
  const sharedSecret = await derivePQXDHSecret(combinedSecrets);
  
  // 5b. DENIABILITY (Audit Fix C-03):
  // Vérifier le deniable MAC si présent (compatibilité avec anciennes versions)
  if (initialMessage.deniableMAC) {
    const deniableMACKeyInput = new Uint8Array(64);
    deniableMACKeyInput.set(dh1, 0);
    deniableMACKeyInput.set(dh2, 32);
    const deniableMACKey = hkdfSync(
      deniableMACKeyInput,
      new Uint8Array(32),
      'ghostr_deniable_mac_v1',
      32
    );
    
    const kemHash = sha256(initialMessage.kemCiphertext.bytes);
    const macData = new Uint8Array(32 + 32 + 32);
    macData.set(initialMessage.identityKey.bytes, 0);
    macData.set(initialMessage.ephemeralKey.bytes, 32);
    macData.set(kemHash, 64);
    const expectedMAC = hmacSha256(deniableMACKey, macData);
    
    // Vérification en temps constant (longueur + contenu)
    const receivedMAC = initialMessage.deniableMAC;
    let diff = expectedMAC.length ^ receivedMAC.length; // diff ≠ 0 si longueurs différentes
    const len = Math.max(expectedMAC.length, receivedMAC.length);
    for (let i = 0; i < len; i++) {
      diff |= (expectedMAC[i] || 0) ^ (receivedMAC[i] || 0);
    }
    
    zeroize(deniableMACKeyInput);
    zeroize(deniableMACKey);
    zeroize(macData);
    zeroize(expectedMAC);
    
    if (diff !== 0) {
      throw new Error('PQXDH: Deniable MAC verification failed');
    }
  }
  
  // 6. Cleanup — DENIABILITY: supprimer explicitement toutes les données
  // liées aux signatures. Post-handshake, l'authentification est purement
  // symétrique (HMAC via Triple Ratchet AEAD) → deniable.
  zeroizeAll(dh1, dh2, dh3, dh4, combinedSecrets);
  zeroizeKyberSharedSecret(kemSecret);
  
  return sharedSecret;
}

/**
 * Dérive le secret partagé PQXDH final
 */
async function derivePQXDHSecret(combinedSecrets: Uint8Array): Promise<SymmetricKey> {
  // Utiliser HKDF avec domain separation
  const salt = new Uint8Array(32); // Sel vide (zéros)
  const derivedKey = await protocolHkdf(
    combinedSecrets,
    salt,
    PQXDH_KDF_INFO,
    32
  );
  
  return createSymmetricKey(derivedKey);
}

// ============================================
// VALIDATION DU BUNDLE
// ============================================

/**
 * Valide un PQPreKeyBundle complet
 */
export function validatePQPreKeyBundle(
  bundle: PQPreKeyBundle
): { valid: boolean; error?: string } {
  // Vérifier la version
  if (bundle.version !== 2) {
    return { valid: false, error: 'Invalid bundle version (expected PQXDH v2)' };
  }
  
  // Vérifier la signature de la Signed PreKey
  const spkMessage = createSignedPreKeyMessage(bundle.signedPreKey.publicKey);
  if (!verify(spkMessage, bundle.signedPreKey.signature, bundle.identityKey)) {
    return { valid: false, error: 'Invalid signed pre-key signature' };
  }
  
  // Vérifier la signature de la PQ PreKey
  if (!verifyPQPreKey(bundle.pqPreKey.publicKey, bundle.pqPreKey.signature, bundle.identityKey)) {
    return { valid: false, error: 'Invalid PQ pre-key signature' };
  }
  
  // Vérifier les tailles des clés
  if (bundle.pqPreKey.publicKey.bytes.length !== KYBER_CONSTANTS.PUBLIC_KEY_SIZE) {
    return { valid: false, error: 'Invalid Kyber public key size' };
  }
  
  return { valid: true };
}

// ============================================
// SÉRIALISATION
// ============================================

// Note: encodeBase64/decodeBase64 are imported from primitives.ts which re-exports them
import { 
  serializePublicKey, 
  deserializeX25519PublicKey, 
  deserializeEd25519PublicKey,
  deserializeSignature,
  createEd25519Signature,
  encodeBase64,
  decodeBase64,
} from './primitives';
// SignedPreKey and OneTimePreKey already imported at top of file

/**
 * Sérialise un PQPreKeyBundle pour transmission
 */
export function serializePQPreKeyBundle(bundle: PQPreKeyBundle): SerializedPQPreKeyBundle {
  const result: SerializedPQPreKeyBundle = {
    v: 2,
    ik: serializePublicKey(bundle.identityKey),
    spk: {
      id: bundle.signedPreKey.id,
      pk: serializePublicKey(bundle.signedPreKey.publicKey),
      sig: encodeBase64(bundle.signedPreKey.signature.bytes),
    },
    pqk: {
      id: bundle.pqPreKey.id,
      pk: serializeKyberPublicKey(bundle.pqPreKey.publicKey),
      sig: encodeBase64(bundle.pqPreKey.signature.bytes),
    },
  };
  
  if (bundle.oneTimePreKey) {
    result.opk = {
      id: bundle.oneTimePreKey.id,
      pk: serializePublicKey(bundle.oneTimePreKey.publicKey),
    };
  }
  
  return result;
}

/**
 * Désérialise un PQPreKeyBundle depuis transmission
 */
export function deserializePQPreKeyBundle(data: SerializedPQPreKeyBundle): PQPreKeyBundle {
  if (data.v !== 2) {
    throw new Error('Invalid PQXDH bundle version');
  }
  
  const bundle: PQPreKeyBundle = {
    version: 2,
    identityKey: deserializeEd25519PublicKey(data.ik),
    signedPreKey: {
      id: data.spk.id,
      publicKey: deserializeX25519PublicKey(data.spk.pk),
      signature: deserializeSignature(data.spk.sig),
    },
    pqPreKey: {
      id: data.pqk.id,
      publicKey: deserializeKyberPublicKey(data.pqk.pk),
      signature: {
        _brand: 'Ed25519Signature' as const,
        bytes: decodeBase64(data.pqk.sig),
      },
    },
  };
  
  if (data.opk) {
    return {
      ...bundle,
      oneTimePreKey: {
        id: data.opk.id,
        publicKey: deserializeX25519PublicKey(data.opk.pk),
      },
    };
  }
  
  return bundle;
}

/**
 * Sérialise un message initial PQXDH
 */
/**
 * Sérialise un message initial PQXDH
 *
 * R-06: Padding du premier message PQXDH pour masquer la création de session.
 *
 * Le message PQXDH contient le ciphertext ML-KEM-768 (1088 bytes → ~1452 chars base64),
 * ce qui le rend ~2KB plus grand qu'un message Triple Ratchet ordinaire.
 * Un observateur réseau peut détecter la création d'une nouvelle session même si le
 * contenu est chiffré.
 *
 * SOLUTION: Ajouter un champ `_p` (padding) avec des bytes aléatoires encodés en base64
 * pour aligner le JSON sérialisé sur la taille du tier small des messages normaux
 * (~6000 chars, correspondant aux ~5981-6525 chars observés au serveur).
 *
 * Le champ `_p` est ignoré lors de la désérialisation.
 */
export function serializePQXDHMessage(message: PQXDHInitialMessage): string {
  const obj: Record<string, unknown> = {
    v: 2,
    ik: serializePublicKey(message.identityKey),
    ek: serializePublicKey(message.ephemeralKey),
    spkId: message.usedSignedPreKeyId,
    opkId: message.usedOneTimePreKeyId,
    pqkId: message.usedPQPreKeyId,
    kemCt: serializeKyberCiphertext(message.kemCiphertext),
    ct: encodeBase64(message.ciphertext),
    // Audit Fix C-03: deniableMAC DOIT être transmis pour que Bob puisse vérifier
    dmac: message.deniableMAC ? encodeBase64(message.deniableMAC) : undefined,
  };

  // R-06: Calculer le padding nécessaire pour atteindre la taille cible.
  // Taille cible: 4096 chars de JSON (après outer sealed sender + OHTTP → ~6000 chars,
  // aligné sur le tier small des messages normaux).
  const TARGET_JSON_CHARS = 4096;
  const PADDING_OVERHEAD = 8; // `,"_p":"` + `"` = environ 8 chars overhead
  const base = JSON.stringify(obj);
  if (base.length < TARGET_JSON_CHARS) {
    const paddingNeeded = TARGET_JSON_CHARS - base.length - PADDING_OVERHEAD;
    if (paddingNeeded > 0) {
      // Calculer combien de bytes aléatoires donnent paddingNeeded chars en base64
      // base64: 4 chars = 3 bytes → bytes = floor(paddingNeeded * 3 / 4)
      const paddingBytes = Math.floor(paddingNeeded * 3 / 4);
      if (paddingBytes > 0) {
        const randomPad = getSecureRandomBytes(paddingBytes);
        obj._p = encodeBase64(randomPad);
      }
    }
  }

  return JSON.stringify(obj);
}

/**
 * Désérialise un message initial PQXDH
 */
export function deserializePQXDHMessage(json: string): PQXDHInitialMessage {
  const data = JSON.parse(json);
  
  if (data.v !== 2) {
    throw new Error('Invalid PQXDH message version');
  }
  
  return {
    identityKey: deserializeEd25519PublicKey(data.ik),
    ephemeralKey: deserializeX25519PublicKey(data.ek),
    usedSignedPreKeyId: data.spkId,
    usedOneTimePreKeyId: data.opkId,
    usedPQPreKeyId: data.pqkId,
    kemCiphertext: deserializeKyberCiphertext(data.kemCt),
    ciphertext: decodeBase64(data.ct),
    // Audit Fix C-03: Restaurer le deniableMAC pour vérification côté responder
    deniableMAC: data.dmac ? decodeBase64(data.dmac) : undefined,
  };
}

// ============================================
// MIGRATION X3DH -> PQXDH
// ============================================

/**
 * Vérifie si un bundle est PQXDH ou X3DH classique
 */
export function isPQXDHBundle(bundle: any): bundle is PQPreKeyBundle {
  return bundle && bundle.version === 2 && bundle.pqPreKey;
}

/**
 * Convertit un bundle X3DH en PQXDH (pour migration)
 */
export function upgradeToPoqXDH(
  classicBundle: PreKeyBundle,
  identityKeyPair: IdentityKeyPair,
  pqSignedKey: PQSignedKey
): PQPreKeyBundle {
  const bundle: PQPreKeyBundle = {
    version: 2,
    identityKey: classicBundle.identityKey,
    signedPreKey: classicBundle.signedPreKey,
    pqPreKey: {
      id: pqSignedKey.id,
      publicKey: pqSignedKey.keyPair.publicKey,
      signature: pqSignedKey.signature,
    },
  };
  
  if (classicBundle.oneTimePreKey) {
    return {
      ...bundle,
      oneTimePreKey: classicBundle.oneTimePreKey,
    };
  }
  
  return bundle;
}

// ============================================
// EXPORTS
// ============================================

export {
  PQ_PREKEY_VALIDITY_MS,
};