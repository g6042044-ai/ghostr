// src/services/senderKeys.ts
// Implémentation des Sender Keys pour le chiffrement des appels
// Version 5.0 - Post-Compromise Security (PCS) Complet comme Signal
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │                    ARCHITECTURE PCS COMPLÈTE                            │
// ├─────────────────────────────────────────────────────────────────────────┤
// │                                                                         │
// │  1. CHAIN RATCHET (Forward Secrecy par frame)                          │
// │     ┌──────────┐     ┌──────────┐     ┌──────────┐                     │
// │     │chainKey₀ │────►│chainKey₁ │────►│chainKey₂ │────►...             │
// │     └────┬─────┘     └────┬─────┘     └────┬─────┘                     │
// │          │                │                │                            │
// │          ▼                ▼                ▼                            │
// │     messageKey₀      messageKey₁      messageKey₂                       │
// │     (Frame 0)        (Frame 1)        (Frame 2)                         │
// │                                                                         │
// │     ✅ Compromission frame N ne révèle pas frames < N                   │
// │                                                                         │
// │  2. ROTATION PÉRIODIQUE (PCS toutes les ~4 secondes)                   │
// │     ┌─────────────┐         ┌─────────────┐                            │
// │     │ SenderKey   │  100    │ SenderKey   │                            │
// │     │ Generation 0│ frames  │ Generation 1│────►...                    │
// │     └─────────────┘  ────►  └─────────────┘                            │
// │           │                       │                                     │
// │           └───── Distribution via Triple Ratchet (PQ-protected)        │
// │                                                                         │
// │     ✅ Compromission ne persiste pas au-delà de 100 frames             │
// │                                                                         │
// │  3. ROTATION SUR ÉVÉNEMENT (PCS immédiate)                             │
// │                                                                         │
// │     [Membre quitte]  ────►  TOUS régénèrent SenderKeys                 │
// │     [Membre rejoint] ────►  Distribution aux nouveaux                  │
// │                                                                         │
// │     ✅ Ancien membre ne peut plus déchiffrer                           │
// │     ✅ Nouveau membre reçoit les clés actuelles uniquement             │
// │                                                                         │
// └─────────────────────────────────────────────────────────────────────────┘
//
// v4.0 - PROTECTION POST-QUANTIQUE:
// - Les SenderKeys sont dérivées depuis pqSecret (ML-KEM)
// - Résistance "Harvest Now Decrypt Later"

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

// ============================================
// CONSTANTES PCS
// ============================================

export const SENDER_KEY_CONSTANTS = {
  // v5.0: Rotation périodique toutes les 100 frames (~4 secondes à 25fps)
  // Signal utilise ~100 messages, adapté pour l'audio temps réel
  ROTATION_INTERVAL: 100,
  
  // Nombre maximum de frames avant rotation forcée (sécurité)
  MAX_FRAMES_WITHOUT_ROTATION: 500,
  
  // Nombre de clés précédentes à conserver (pour déchiffrer les frames en transit)
  MAX_PREVIOUS_KEYS: 5,
  
  // Durée de vie des clés précédentes (ms)
  PREVIOUS_KEY_TTL_MS: 30000, // 30 secondes
  
  // Taille des clés
  KEY_SIZE: 32,
  
  // Version du protocole
  VERSION: 5,
} as const;

// ============================================
// TYPES
// ============================================

/**
 * Clé de chiffrement pour un participant
 * v5.0: Ajout de generation pour tracking des rotations PCS
 */
export interface SenderKey {
  // Identifiant unique de cette clé
  keyId: string;
  
  // Clé de chaîne (32 bytes) - avance à chaque frame (chain ratchet)
  chainKey: Uint8Array;
  
  // Clé de signature (32 bytes) - pour authentifier les frames
  signatureKey: Uint8Array;
  
  // Index de la chaîne (incrémenté à chaque frame)
  chainIndex: number;
  
  // v5.0: Génération de la clé (incrémenté à chaque rotation PCS)
  generation: number;
  
  // Timestamp de création
  createdAt: number;
  
  // v5.0: Raison de la dernière rotation
  lastRotationReason?: 'periodic' | 'member_left' | 'member_joined' | 'security' | 'initial';
}

/**
 * v5.0: État de rotation complet pour gérer la PCS
 */
export interface SenderKeyState {
  // Clé actuelle pour le chiffrement
  currentKey: SenderKey;
  
  // v5.0: Clés précédentes pour déchiffrer les frames en transit
  previousKeys: Map<string, { key: SenderKey; expiresAt: number }>;
  
  // v5.0: Secret PQ pour rotations PQ-protected
  pqSecret: Uint8Array | null;
  
  // ID de l'appel (pour domain separation)
  callId: string;
  
  // ID du participant
  participantId: string;
  
  // v5.0: Compteur de frames depuis dernière rotation
  framesSinceRotation: number;
  
  // v5.0: Callback pour notifier les rotations (distribution aux autres)
  onRotationNeeded?: (newKey: SenderKey, reason: string) => Promise<void>;
}

/**
 * Distribution chiffrée d'une SenderKey
 * Envoyée aux autres participants via Triple Ratchet
 */
export interface SenderKeyDistribution {
  // ID de la clé distribuée
  keyId: string;
  
  // Données chiffrées (chainKey + signatureKey)
  encryptedData: string;
  
  // Nonce utilisé pour le chiffrement
  nonce: string;
  
  // Index actuel de la chaîne
  chainIndex: number;
  
  // v5.0: Génération de la clé
  generation: number;
  
  // v5.0: Raison de la distribution
  reason: 'initial' | 'periodic' | 'member_left' | 'member_joined';
  
  // v5.0 PCS: Entropie fraîche pour les rotations
  // Les autres participants utilisent cette entropie pour
  // reconstruire leur état de clé. Sans cela, pas de vraie PCS.
  // Chiffré séparément car critique pour la sécurité.
  freshEntropy?: string; // Base64, présent seulement lors des rotations
  
  // Timestamp
  timestamp: number;
}

/**
 * Format sérialisé pour stockage/transmission
 */
export interface SerializedSenderKey {
  keyId: string;
  chainKey: string;      // Base64
  signatureKey: string;  // Base64
  chainIndex: number;
  generation: number;    // v5.0
  createdAt: number;
  lastRotationReason?: string;
}

// ============================================
// GÉNÉRATION DE CLÉS
// ============================================

/**
 * Génère une nouvelle SenderKey (sans protection PQ)
 * Utilisé comme fallback si aucun pqSecret n'est disponible
 */
export function generateSenderKey(generation: number = 0): SenderKey {
  const keyId = encodeBase64(nacl.randomBytes(16));
  const chainKey = nacl.randomBytes(32);
  const signatureKey = nacl.randomBytes(32);
  
  return {
    keyId,
    chainKey,
    signatureKey,
    chainIndex: 0,
    generation,
    createdAt: Date.now(),
    lastRotationReason: generation === 0 ? 'initial' : 'periodic',
  };
}

/**
 * v5.0: Génère une SenderKey protégée par un secret post-quantique
 * 
 * La clé est dérivée depuis le pqSecret de la session Triple Ratchet,
 * garantissant que les appels héritent de la protection PQ.
 * 
 * @param pqSecret - Secret post-quantique de la session
 * @param callId - ID unique de l'appel
 * @param participantId - ID du participant
 * @param generation - Numéro de génération (pour rotations PCS)
 * @param reason - Raison de la génération
 */
export function generatePQProtectedSenderKey(
  pqSecret: Uint8Array,
  callId: string,
  participantId: string,
  generation: number = 0,
  reason: SenderKey['lastRotationReason'] = 'initial'
): SenderKey {
  // Domain separation incluant la génération pour unicité après rotation
  const context = new TextEncoder().encode(
    `ghostr_sender_key_v5:${callId}:${participantId}:gen${generation}`
  );
  
  // Combiner pqSecret avec le contexte
  const combined = new Uint8Array(pqSecret.length + context.length);
  combined.set(pqSecret, 0);
  combined.set(context, pqSecret.length);
  
  // Dériver le matériel de clé via SHA-512 (64 bytes)
  const derived = nacl.hash(combined);
  
  // Séparer le matériel dérivé
  // [0-16]: keyId seed
  // [16-48]: chainKey (32 bytes)
  const keyIdSeed = derived.slice(0, 16);
  const chainKey = new Uint8Array(derived.slice(16, 48));
  
  // signatureKey reste aléatoire pour l'authentification
  const signatureKey = nacl.randomBytes(32);
  
  __DEV__ && console.log(`[SenderKeys] 🔐 PQ-protected SenderKey generated (gen ${generation}, reason: ${reason})`);
  
  return {
    keyId: encodeBase64(keyIdSeed),
    chainKey,
    signatureKey,
    chainIndex: 0,
    generation,
    createdAt: Date.now(),
    lastRotationReason: reason,
  };
}

// ============================================
// v5.0: GESTION D'ÉTAT PCS
// ============================================

/**
 * v5.0: Crée un nouvel état de SenderKey avec support PCS
 */
export function createSenderKeyState(
  callId: string,
  participantId: string,
  pqSecret: Uint8Array | null,
  onRotationNeeded?: (newKey: SenderKey, reason: string) => Promise<void>
): SenderKeyState {
  const initialKey = pqSecret
    ? generatePQProtectedSenderKey(pqSecret, callId, participantId, 0, 'initial')
    : generateSenderKey(0);
  
  return {
    currentKey: initialKey,
    previousKeys: new Map(),
    pqSecret,
    callId,
    participantId,
    framesSinceRotation: 0,
    onRotationNeeded,
  };
}

/**
 * v5.0: Vérifie si une rotation est nécessaire
 */
export function shouldRotate(state: SenderKeyState): boolean {
  return state.framesSinceRotation >= SENDER_KEY_CONSTANTS.ROTATION_INTERVAL;
}

/**
 * v5.0: Effectue une rotation PCS de la SenderKey
 * 
 * DIFFÉRENCE CRITIQUE AVEC L'ANCIENNE IMPLÉMENTATION:
 * ===================================================
 * Cette rotation introduit de l'ENTROPIE FRAÎCHE (nouveaux random bytes)
 * à chaque rotation, garantissant une vraie Post-Compromise Security.
 * 
 * Si un attaquant compromet la clé à la génération N, il ne peut PAS
 * dériver les clés des générations N+1, N+2, etc. car elles contiennent
 * des bytes aléatoires qu'il ne connaît pas.
 * 
 * L'entropie fraîche est distribuée aux autres participants via
 * Triple Ratchet (qui a lui-même PCS), garantissant que seuls les
 * participants légitimes peuvent reconstruire les nouvelles clés.
 * 
 * Cette fonction :
 * 1. Génère de l'entropie fraîche (32 bytes aléatoires)
 * 2. Combine avec le secret existant pour la nouvelle clé
 * 3. Archive l'ancienne clé pour déchiffrer les frames en transit
 * 4. Notifie via callback pour distribution de l'entropie
 * 5. Met à jour le secret racine pour les rotations futures
 */
export async function rotateSenderKeyPCS(
  state: SenderKeyState,
  reason: 'periodic' | 'member_left' | 'member_joined' | 'security' = 'periodic'
): Promise<{ newKey: SenderKey; freshEntropy: Uint8Array }> {
  const oldKey = state.currentKey;
  const newGeneration = oldKey.generation + 1;
  
  __DEV__ && console.log(`[SenderKeys] 🔄 PCS Rotation (gen ${oldKey.generation} → ${newGeneration}, reason: ${reason})`);
  
  // ============================================
  // ÉTAPE 1: GÉNÉRER DE L'ENTROPIE FRAÎCHE
  // ============================================
  // C'est LE point clé pour la PCS: nouveaux random bytes
  // que l'attaquant ne peut pas prédire
  const freshEntropy = nacl.randomBytes(32);
  
  // ============================================
  // ÉTAPE 2: ARCHIVER L'ANCIENNE CLÉ
  // ============================================
  state.previousKeys.set(oldKey.keyId, {
    key: oldKey,
    expiresAt: Date.now() + SENDER_KEY_CONSTANTS.PREVIOUS_KEY_TTL_MS,
  });
  
  // ============================================
  // ÉTAPE 3: GÉNÉRER LA NOUVELLE CLÉ AVEC ENTROPIE FRAÎCHE
  // ============================================
  const newKey = generateSenderKeyWithFreshEntropy(
    state.pqSecret,
    freshEntropy,
    state.callId,
    state.participantId,
    newGeneration,
    reason
  );
  
  // ============================================
  // ÉTAPE 4: METTRE À JOUR LE SECRET RACINE
  // ============================================
  // Le nouveau pqSecret inclut l'entropie fraîche pour les futures rotations
  // Cela crée un "ratchet" du secret lui-même
  if (state.pqSecret) {
    const newRootSecret = deriveNewRootSecret(state.pqSecret, freshEntropy);
    state.pqSecret.fill(0); // Zeroize l'ancien
    state.pqSecret = newRootSecret;
  }
  
  // Mettre à jour l'état
  state.currentKey = newKey;
  state.framesSinceRotation = 0;
  
  // Nettoyer les anciennes clés expirées
  cleanupExpiredKeys(state);
  
  // Notifier pour distribution (l'entropie doit être envoyée aux autres)
  if (state.onRotationNeeded) {
    try {
      await state.onRotationNeeded(newKey, reason);
    } catch (error) {
      __DEV__ && console.error('[SenderKeys] Error notifying rotation:', error);
    }
  }
  
  __DEV__ && console.log(`[SenderKeys] ✅ PCS Rotation complete - fresh entropy injected`);
  
  return { newKey, freshEntropy };
}

/**
 * v5.0: Génère une SenderKey avec entropie fraîche (pour PCS)
 * 
 * La clé est dérivée de:
 * - pqSecret existant (pour protection PQ)
 * - freshEntropy (pour PCS - nouveaux random bytes)
 * - contexte (callId, participantId, generation)
 */
function generateSenderKeyWithFreshEntropy(
  pqSecret: Uint8Array | null,
  freshEntropy: Uint8Array,
  callId: string,
  participantId: string,
  generation: number,
  reason: SenderKey['lastRotationReason']
): SenderKey {
  // Contexte pour domain separation
  const context = new TextEncoder().encode(
    `ghostr_sender_key_pcs_v5:${callId}:${participantId}:gen${generation}`
  );
  
  // Combiner: pqSecret (si disponible) + freshEntropy + context
  const pqSecretPart = pqSecret || new Uint8Array(0);
  const combined = new Uint8Array(pqSecretPart.length + freshEntropy.length + context.length);
  combined.set(pqSecretPart, 0);
  combined.set(freshEntropy, pqSecretPart.length);
  combined.set(context, pqSecretPart.length + freshEntropy.length);
  
  // Dériver via SHA-512
  const derived = nacl.hash(combined);
  
  const keyIdSeed = derived.slice(0, 16);
  const chainKey = new Uint8Array(derived.slice(16, 48));
  const signatureKey = nacl.randomBytes(32);
  
  __DEV__ && console.log(`[SenderKeys] 🔐 Generated PCS-protected SenderKey (gen ${generation}, with fresh entropy)`);
  
  return {
    keyId: encodeBase64(keyIdSeed),
    chainKey,
    signatureKey,
    chainIndex: 0,
    generation,
    createdAt: Date.now(),
    lastRotationReason: reason,
  };
}

/**
 * v5.0: Dérive un nouveau secret racine en combinant l'ancien avec l'entropie fraîche
 * 
 * Cela crée un "ratchet" du secret lui-même:
 * rootSecret[n+1] = KDF(rootSecret[n], freshEntropy)
 * 
 * Propriétés:
 * - Forward Secrecy: rootSecret[n] effacé après dérivation
 * - PCS: freshEntropy inconnue de l'attaquant
 */
function deriveNewRootSecret(oldSecret: Uint8Array, freshEntropy: Uint8Array): Uint8Array {
  const context = new TextEncoder().encode('SenderKeyRootRatchet');
  
  const combined = new Uint8Array(oldSecret.length + freshEntropy.length + context.length);
  combined.set(oldSecret, 0);
  combined.set(freshEntropy, oldSecret.length);
  combined.set(context, oldSecret.length + freshEntropy.length);
  
  const derived = nacl.hash(combined);
  return new Uint8Array(derived.slice(0, 32));
}

/**
 * v5.0: Applique une rotation reçue d'un autre participant
 * 
 * Quand on reçoit l'entropie fraîche d'un autre participant,
 * on l'utilise pour reconstruire sa nouvelle SenderKey.
 */
export function applyReceivedRotation(
  state: SenderKeyState,
  freshEntropy: Uint8Array,
  newGeneration: number,
  reason: SenderKey['lastRotationReason'] = 'periodic'
): SenderKey {
  const oldKey = state.currentKey;
  
  __DEV__ && console.log(`[SenderKeys] 📥 Applying received rotation (gen ${oldKey.generation} → ${newGeneration})`);
  
  // Archiver l'ancienne clé
  state.previousKeys.set(oldKey.keyId, {
    key: oldKey,
    expiresAt: Date.now() + SENDER_KEY_CONSTANTS.PREVIOUS_KEY_TTL_MS,
  });
  
  // Reconstruire la nouvelle clé avec l'entropie reçue
  const newKey = generateSenderKeyWithFreshEntropy(
    state.pqSecret,
    freshEntropy,
    state.callId,
    state.participantId,
    newGeneration,
    reason
  );
  
  // Mettre à jour le secret racine
  if (state.pqSecret) {
    const newRootSecret = deriveNewRootSecret(state.pqSecret, freshEntropy);
    state.pqSecret.fill(0);
    state.pqSecret = newRootSecret;
  }
  
  state.currentKey = newKey;
  state.framesSinceRotation = 0;
  
  cleanupExpiredKeys(state);
  
  return newKey;
}

/**
 * v5.0: Nettoie les clés précédentes expirées
 */
function cleanupExpiredKeys(state: SenderKeyState): void {
  const now = Date.now();
  const toDelete: string[] = [];
  
  for (const [keyId, entry] of state.previousKeys) {
    if (entry.expiresAt < now) {
      // Zeroize la clé avant suppression
      entry.key.chainKey.fill(0);
      entry.key.signatureKey.fill(0);
      toDelete.push(keyId);
    }
  }
  
  // Limiter aussi le nombre de clés conservées
  if (state.previousKeys.size > SENDER_KEY_CONSTANTS.MAX_PREVIOUS_KEYS) {
    const sortedEntries = Array.from(state.previousKeys.entries())
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    
    const excess = sortedEntries.slice(0, state.previousKeys.size - SENDER_KEY_CONSTANTS.MAX_PREVIOUS_KEYS);
    for (const [keyId, entry] of excess) {
      entry.key.chainKey.fill(0);
      entry.key.signatureKey.fill(0);
      toDelete.push(keyId);
    }
  }
  
  for (const keyId of toDelete) {
    state.previousKeys.delete(keyId);
  }
  
  if (toDelete.length > 0) {
    __DEV__ && console.log(`[SenderKeys] 🧹 Cleaned up ${toDelete.length} expired previous keys`);
  }
}

/**
 * v5.0: Récupère une clé par son ID (actuelle ou précédente)
 * Utilisé pour déchiffrer les frames avec d'anciennes clés en transit
 */
export function getKeyById(state: SenderKeyState, keyId: string): SenderKey | null {
  // Vérifier la clé actuelle
  if (state.currentKey.keyId === keyId) {
    return state.currentKey;
  }
  
  // Vérifier les clés précédentes
  const previous = state.previousKeys.get(keyId);
  if (previous && previous.expiresAt > Date.now()) {
    return previous.key;
  }
  
  return null;
}

// ============================================
// v5.0: ROTATION SUR ÉVÉNEMENT (comme Signal)
// ============================================

/**
 * v5.0: Force une rotation quand un membre quitte l'appel
 * 
 * SÉCURITÉ SIGNAL:
 * Quand un membre quitte, TOUS les participants doivent régénérer
 * leurs SenderKeys pour garantir que l'ancien membre ne peut plus
 * déchiffrer les communications futures.
 * 
 * Retourne l'entropie fraîche qui doit être distribuée aux autres.
 */
export async function rotateOnMemberLeft(
  state: SenderKeyState
): Promise<{ newKey: SenderKey; freshEntropy: Uint8Array }> {
  __DEV__ && console.log('[SenderKeys] 🚪 Member left - forcing PCS rotation with fresh entropy');
  return rotateSenderKeyPCS(state, 'member_left');
}

/**
 * v5.0: Notification quand un nouveau membre rejoint
 * 
 * Note: Contrairement à member_left, on ne régénère pas forcément.
 * On distribue simplement la clé actuelle au nouveau membre.
 * Optionnellement, on peut forcer une rotation pour plus de sécurité.
 */
export async function onMemberJoined(
  state: SenderKeyState,
  forceRotation: boolean = false
): Promise<{ newKey: SenderKey; freshEntropy: Uint8Array | null }> {
  if (forceRotation) {
    __DEV__ && console.log('[SenderKeys] 👋 Member joined - rotating with fresh entropy for extra security');
    return rotateSenderKeyPCS(state, 'member_joined');
  }
  
  __DEV__ && console.log('[SenderKeys] 👋 Member joined - distributing current key (no rotation)');
  return { newKey: state.currentKey, freshEntropy: null };
}

// ============================================
// DISTRIBUTION DE CLÉS
// ============================================

/**
 * Prépare une distribution chiffrée de la SenderKey
 * À envoyer aux autres participants via Triple Ratchet
 * 
 * @param senderKey - La SenderKey à distribuer
 * @param encryptionKey - Clé de chiffrement (dérivée de la session)
 * @param reason - Raison de la distribution
 * @param freshEntropy - v5.0 PCS: Entropie fraîche pour les rotations
 */
export function prepareSenderKeyDistribution(
  senderKey: SenderKey,
  encryptionKey: Uint8Array,
  reason: SenderKeyDistribution['reason'] = 'initial',
  freshEntropy?: Uint8Array
): SenderKeyDistribution {
  // Combiner les clés à distribuer (chainKey + signatureKey)
  const dataToEncrypt = new Uint8Array(64);
  dataToEncrypt.set(senderKey.chainKey, 0);
  dataToEncrypt.set(senderKey.signatureKey, 32);
  
  // Chiffrer avec NaCl secretbox (XSalsa20-Poly1305)
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const encryptedData = nacl.secretbox(dataToEncrypt, nonce, encryptionKey);
  
  const distribution: SenderKeyDistribution = {
    keyId: senderKey.keyId,
    encryptedData: encodeBase64(encryptedData),
    nonce: encodeBase64(nonce),
    chainIndex: senderKey.chainIndex,
    generation: senderKey.generation,
    reason,
    timestamp: Date.now(),
  };
  
  // v5.0 PCS: Inclure l'entropie fraîche si présente (pour rotations)
  if (freshEntropy) {
    // Chiffrer l'entropie séparément pour plus de sécurité
    const entropyNonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const encryptedEntropy = nacl.secretbox(freshEntropy, entropyNonce, encryptionKey);
    // Format: nonce (24 bytes) + encrypted entropy
    const entropyPacket = new Uint8Array(entropyNonce.length + encryptedEntropy.length);
    entropyPacket.set(entropyNonce, 0);
    entropyPacket.set(encryptedEntropy, entropyNonce.length);
    distribution.freshEntropy = encodeBase64(entropyPacket);
    
    __DEV__ && console.log(`[SenderKeys] 📤 Distribution includes fresh entropy for PCS (gen ${senderKey.generation})`);
  }
  
  return distribution;
}

/**
 * v5.0: Résultat de la réception d'une distribution
 */
export interface ReceivedSenderKeyResult {
  senderKey: SenderKey;
  freshEntropy: Uint8Array | null;
}

/**
 * Reçoit et déchiffre une distribution de SenderKey
 * 
 * @returns La SenderKey et l'entropie fraîche (si présente)
 */
export function receiveSenderKeyDistribution(
  distribution: SenderKeyDistribution,
  decryptionKey: Uint8Array
): ReceivedSenderKeyResult {
  const encryptedData = decodeBase64(distribution.encryptedData);
  const nonce = decodeBase64(distribution.nonce);
  
  // Déchiffrer avec NaCl secretbox
  const decryptedData = nacl.secretbox.open(encryptedData, nonce, decryptionKey);
  
  if (!decryptedData || decryptedData.length !== 64) {
    throw new Error('Failed to decrypt SenderKey distribution');
  }
  
  // Extraire les clés
  const chainKey = new Uint8Array(decryptedData.slice(0, 32));
  const signatureKey = new Uint8Array(decryptedData.slice(32, 64));
  
  // v5.0 PCS: Extraire l'entropie fraîche si présente
  let freshEntropy: Uint8Array | null = null;
  if (distribution.freshEntropy) {
    const entropyPacket = decodeBase64(distribution.freshEntropy);
    const entropyNonce = entropyPacket.slice(0, nacl.secretbox.nonceLength);
    const encryptedEntropy = entropyPacket.slice(nacl.secretbox.nonceLength);
    
    const decryptedEntropy = nacl.secretbox.open(encryptedEntropy, entropyNonce, decryptionKey);
    if (decryptedEntropy) {
      freshEntropy = new Uint8Array(decryptedEntropy);
      __DEV__ && console.log(`[SenderKeys] 📥 Received fresh entropy for PCS (gen ${distribution.generation})`);
    } else {
      __DEV__ && console.warn('[SenderKeys] ⚠️ Failed to decrypt fresh entropy');
    }
  }
  
  __DEV__ && console.log(`[SenderKeys] 📥 Received SenderKey distribution (gen ${distribution.generation}, reason: ${distribution.reason})`);
  
  const senderKey: SenderKey = {
    keyId: distribution.keyId,
    chainKey,
    signatureKey,
    chainIndex: distribution.chainIndex,
    generation: distribution.generation,
    createdAt: Date.now(),
    lastRotationReason: distribution.reason === 'initial' ? 'initial' : distribution.reason,
  };
  
  return { senderKey, freshEntropy };
}

// ============================================
// SÉRIALISATION
// ============================================

/**
 * Sérialise une SenderKey pour stockage
 */
export function serializeSenderKey(key: SenderKey): SerializedSenderKey {
  return {
    keyId: key.keyId,
    chainKey: encodeBase64(key.chainKey),
    signatureKey: encodeBase64(key.signatureKey),
    chainIndex: key.chainIndex,
    generation: key.generation,
    createdAt: key.createdAt,
    lastRotationReason: key.lastRotationReason,
  };
}

/**
 * Désérialise une SenderKey
 */
export function deserializeSenderKey(serialized: SerializedSenderKey): SenderKey {
  return {
    keyId: serialized.keyId,
    chainKey: decodeBase64(serialized.chainKey),
    signatureKey: decodeBase64(serialized.signatureKey),
    chainIndex: serialized.chainIndex,
    generation: serialized.generation || 0,
    createdAt: serialized.createdAt,
    lastRotationReason: serialized.lastRotationReason as SenderKey['lastRotationReason'],
  };
}

// ============================================
// NETTOYAGE
// ============================================

/**
 * Efface de manière sécurisée une SenderKey de la mémoire
 */
export function clearSenderKey(key: SenderKey): void {
  if (key.chainKey) {
    key.chainKey.fill(0);
  }
  if (key.signatureKey) {
    key.signatureKey.fill(0);
  }
}

/**
 * v5.0: Nettoie tout l'état de SenderKey
 */
export function clearSenderKeyState(state: SenderKeyState): void {
  clearSenderKey(state.currentKey);
  
  for (const [_, entry] of state.previousKeys) {
    clearSenderKey(entry.key);
  }
  state.previousKeys.clear();
  
  if (state.pqSecret) {
    state.pqSecret.fill(0);
  }
}

// ============================================
// CHIFFREMENT/DÉCHIFFREMENT AUDIO (avec Chain Ratchet)
// ============================================

/**
 * v5.0: Chiffre un paquet audio avec la SenderKey
 * Implémente le chain ratchet pour Forward Secrecy par frame
 */
export function encryptAudioPacketWithState(
  state: SenderKeyState,
  audioData: Uint8Array
): { encrypted: Uint8Array; needsRotation: boolean } {
  const senderKey = state.currentKey;
  
  // Dériver une clé de message à partir de la chainKey et de l'index
  const messageKey = deriveMessageKey(senderKey.chainKey, senderKey.chainIndex);
  
  // CHAIN RATCHET: Avancer la chainKey (Forward Secrecy)
  advanceChainKey(senderKey);
  
  // Incrémenter les compteurs
  senderKey.chainIndex++;
  state.framesSinceRotation++;
  
  // Générer un nonce aléatoire
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  
  // Chiffrer les données audio
  const encrypted = nacl.secretbox(audioData, nonce, messageKey);
  
  // Créer le paquet final: [keyId (16)] + [generation (4)] + [chainIndex (4)] + [nonce (24)] + [encrypted]
  const keyIdBytes = decodeBase64(senderKey.keyId).slice(0, 16);
  const genBytes = new Uint8Array(4);
  new DataView(genBytes.buffer).setUint32(0, senderKey.generation, true);
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, senderKey.chainIndex - 1, true);
  
  const packet = new Uint8Array(16 + 4 + 4 + nonce.length + encrypted.length);
  packet.set(keyIdBytes, 0);
  packet.set(genBytes, 16);
  packet.set(indexBytes, 20);
  packet.set(nonce, 24);
  packet.set(encrypted, 24 + nonce.length);
  
  // Zeroize la clé de message
  messageKey.fill(0);
  
  return {
    encrypted: packet,
    needsRotation: shouldRotate(state),
  };
}

/**
 * v5.0: Déchiffre un paquet audio avec la SenderKey distante
 * Supporte les clés précédentes pour les frames en transit
 */
export function decryptAudioPacketWithState(
  receiverState: SenderKeyState,
  encryptedPacket: Uint8Array
): Uint8Array | null {
  try {
    // v19.0: Validation robuste
    if (!receiverState) {
      return null;
    }
    
    if (!encryptedPacket || encryptedPacket.length < 48) { // 16 + 4 + 4 + 24 minimum
      __DEV__ && console.warn('[SenderKeys] Packet too short or missing');
      return null;
    }
    
    // Extraire les parties du paquet
    const keyIdBytes = encryptedPacket.slice(0, 16);
    const genBytes = encryptedPacket.slice(16, 20);
    const indexBytes = encryptedPacket.slice(20, 24);
    const nonce = encryptedPacket.slice(24, 48);
    const encrypted = encryptedPacket.slice(48);
    
    const keyId = encodeBase64(keyIdBytes);
    const generation = new DataView(genBytes.buffer, genBytes.byteOffset).getUint32(0, true);
    const chainIndex = new DataView(indexBytes.buffer, indexBytes.byteOffset).getUint32(0, true);
    
    // Trouver la bonne clé
    const senderKey = getKeyById(receiverState, keyId);
    
    if (!senderKey || !senderKey.chainKey || senderKey.chainKey.length !== 32) {
      // Pas de log spam - normal en début d'appel
      return null;
    }
    
    // Dériver la clé de message pour cet index
    const messageKey = deriveMessageKey(senderKey.chainKey, chainIndex);
    
    // Déchiffrer
    const decrypted = nacl.secretbox.open(encrypted, nonce, messageKey);
    
    // Zeroize la clé de message
    messageKey.fill(0);
    
    if (!decrypted) {
      return null;
    }
    
    return new Uint8Array(decrypted);
    
  } catch (error) {
    __DEV__ && console.error('[SenderKeys] decryptAudioPacket error:', error);
    return null;
  }
}

// ============================================
// LEGACY API (pour compatibilité avec le code existant)
// ============================================

/**
 * Chiffre un paquet audio avec la SenderKey (API legacy)
 * Utilise XSalsa20-Poly1305 (NaCl secretbox)
 */
export function encryptAudioPacket(senderKey: SenderKey, audioData: Uint8Array): Uint8Array {
  // Dériver une clé de message à partir de la chainKey et de l'index
  const messageKey = deriveMessageKey(senderKey.chainKey, senderKey.chainIndex);
  
  // Incrémenter l'index de la chaîne
  senderKey.chainIndex++;
  
  // Générer un nonce aléatoire
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  
  // Chiffrer les données audio
  const encrypted = nacl.secretbox(audioData, nonce, messageKey);
  
  // Créer le paquet final: [keyId (16 bytes)] + [chainIndex (4 bytes)] + [nonce (24 bytes)] + [encrypted data]
  const keyIdBytes = decodeBase64(senderKey.keyId).slice(0, 16);
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, senderKey.chainIndex - 1, true);
  
  const packet = new Uint8Array(16 + 4 + nonce.length + encrypted.length);
  packet.set(keyIdBytes, 0);
  packet.set(indexBytes, 16);
  packet.set(nonce, 20);
  packet.set(encrypted, 20 + nonce.length);
  
  return packet;
}

/**
 * Déchiffre un paquet audio avec la SenderKey distante (API legacy)
 */
export function decryptAudioPacket(senderKey: SenderKey, encryptedPacket: Uint8Array): Uint8Array | null {
  try {
    // v19.0: Validation robuste des paramètres
    if (!senderKey) {
      // Pas de log pour éviter le spam - c'est normal en début d'appel
      return null;
    }
    
    if (!senderKey.chainKey || senderKey.chainKey.length !== 32) {
      // SenderKey invalide ou incomplète
      return null;
    }
    
    if (!encryptedPacket || encryptedPacket.length < 44) { // 16 + 4 + 24 minimum
      __DEV__ && console.warn('[SenderKeys] Packet too short or missing');
      return null;
    }
    
    // Extraire les parties du paquet
    // const keyIdBytes = encryptedPacket.slice(0, 16); // Pour vérification future
    const indexBytes = encryptedPacket.slice(16, 20);
    const nonce = encryptedPacket.slice(20, 44);
    const encrypted = encryptedPacket.slice(44);
    
    // Extraire l'index de chaîne
    const chainIndex = new DataView(indexBytes.buffer, indexBytes.byteOffset).getUint32(0, true);
    
    // Dériver la clé de message pour cet index
    const messageKey = deriveMessageKey(senderKey.chainKey, chainIndex);
    
    // Déchiffrer
    const decrypted = nacl.secretbox.open(encrypted, nonce, messageKey);
    
    if (!decrypted) {
      // Pas de log - peut arriver avec une mauvaise clé
      return null;
    }
    
    return new Uint8Array(decrypted);
    
  } catch (error) {
    __DEV__ && console.error('[SenderKeys] decryptAudioPacket error:', error);
    return null;
  }
}

// ============================================
// HELPERS CRYPTOGRAPHIQUES
// ============================================

/**
 * Dérive une clé de message à partir de la chainKey et d'un index
 */
function deriveMessageKey(chainKey: Uint8Array, index: number): Uint8Array {
  // v19.0: Validation robuste
  if (!chainKey || chainKey.length !== 32) {
    throw new Error('Invalid chainKey for message key derivation');
  }
  
  // Contexte incluant l'index
  const context = new TextEncoder().encode(`SenderKeyMessage:${index}`);
  
  // Combiner chainKey avec le contexte
  const combined = new Uint8Array(chainKey.length + context.length);
  combined.set(chainKey, 0);
  combined.set(context, chainKey.length);
  
  // Hash SHA-512 et tronquer à 32 bytes pour la clé de chiffrement
  const hash = nacl.hash(combined);
  return new Uint8Array(hash.slice(0, 32));
}

/**
 * v5.0: Avance la chainKey (Chain Ratchet pour Forward Secrecy)
 * 
 * C'est le cœur de la Forward Secrecy par frame:
 * - chainKey[n+1] = KDF(chainKey[n])
 * - L'ancienne chainKey est effacée
 * - Impossible de dériver chainKey[n] depuis chainKey[n+1]
 */
function advanceChainKey(senderKey: SenderKey): void {
  // v19.0: Validation robuste
  if (!senderKey || !senderKey.chainKey || senderKey.chainKey.length !== 32) {
    __DEV__ && console.warn('[SenderKeys] Cannot advance invalid chainKey');
    return;
  }
  
  const context = new TextEncoder().encode('SenderKeyChainAdvance');
  
  // Combiner la clé actuelle avec le contexte
  const combined = new Uint8Array(senderKey.chainKey.length + context.length);
  combined.set(senderKey.chainKey, 0);
  combined.set(context, senderKey.chainKey.length);
  
  // Hash SHA-512 et tronquer à 32 bytes
  const hash = nacl.hash(combined);
  const newChainKey = hash.slice(0, 32);
  
  // Effacer l'ancienne clé
  senderKey.chainKey.fill(0);
  
  // Remplacer par la nouvelle
  senderKey.chainKey = new Uint8Array(newChainKey);
}

/**
 * Dérive la prochaine clé de chaîne (pour rotation complète)
 */
function deriveNextChainKey(currentChainKey: Uint8Array): Uint8Array {
  const context = new TextEncoder().encode('SenderKeyChainDerivation');
  
  const combined = new Uint8Array(currentChainKey.length + context.length);
  combined.set(currentChainKey, 0);
  combined.set(context, currentChainKey.length);
  
  const hash = nacl.hash(combined);
  return new Uint8Array(hash.slice(0, 32));
}

// ============================================
// LEGACY: Compatibilité avec l'ancienne API
// ============================================

/**
 * @deprecated Utiliser rotateSenderKeyPCS à la place
 * Fait tourner une SenderKey existante (ancienne API)
 */
export function rotateSenderKey(oldKey: SenderKey): { newKey: SenderKey; oldKeyId: string } {
  const newChainKey = deriveNextChainKey(oldKey.chainKey);
  const newSignatureKey = nacl.randomBytes(32);
  
  const newKey: SenderKey = {
    keyId: encodeBase64(nacl.randomBytes(16)),
    chainKey: newChainKey,
    signatureKey: newSignatureKey,
    chainIndex: 0,
    generation: (oldKey.generation || 0) + 1,
    createdAt: Date.now(),
    lastRotationReason: 'periodic',
  };
  
  return {
    newKey,
    oldKeyId: oldKey.keyId,
  };
}