// src/services/decoyService.ts
// Service de génération de faux trafic (Decoy Messages)
// Version 3.0 - SECURITY HARDENING:
//   - v3.0: CSPRNG partout (plus de Math.random)
//   - v3.0: Healthcheck auto (redémarrage si bloqué > 5min)
//   - v3.0: AppState listener (reprise au retour au foreground)
//   - v3.0: Logs minimisés (pas d'info exploitable)
//
// OBJECTIF: Générer des messages leurres impossibles à distinguer des vrais

import { encodeBase64, secureRandomIntRange } from './crypto';
import { secureRpc } from './relayTransport';
import { createSealedSenderEnvelope, isSealedSenderReady } from './sealedSender';
import { generateRandomPushBlob } from './pushNotificationService';
import * as Crypto from 'expo-crypto';
import { AppState, AppStateStatus } from 'react-native';

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // Timing des decoys périodiques
  minIntervalMs: 1 * 60 * 1000,    // 1 minute
  maxIntervalMs: 3 * 60 * 1000,    // 3 minutes
  
  // Burst après envoi d'un vrai message
  burstCount: 3,
  burstMinDelayMs: 2000,
  burstMaxDelayMs: 10000,
  
  // ============================================
  // v25.0: RECALIBRATION — Tailles basées sur le pipeline RÉEL end-to-end
  //
  // Pipeline réel pour un message:
  //   1. api1to1: addUniformPadding(JSON) → tier 2048 ou 8192 bytes
  //   2. Triple Ratchet: padMessage(paddedString, 'medium')
  //      - Ajoute [0x01][2-byte length] → +3 bytes overhead
  //      - Pad au BUCKET suivant: 256/1024/4096/16384/65536
  //      - +0-10% variation aléatoire
  //      Tier 2KB → bucket 4096 → 4096..4505 bytes
  //      Tier 8KB → bucket 16384 → 16384..18022 bytes
  //   3. encryptAEAD: +48 bytes (HMAC-SHA256 32B + Poly1305 16B)
  //      Tier 2KB → 4144..4553 raw ciphertext
  //      Tier 8KB → 16432..18070 raw ciphertext
  //   4. Base64 → TripleRatchetMessage JSON → EncryptedMessage JSON → SealedPayload
  //
  // Tailles RÉELLES au serveur (p_sealed_content):
  //   Tier 2KB: ~5981-6525 chars (5.8-6.4KB)
  //   Tier 8KB: ~22365-24549 chars (21.8-24.0KB)
  // ============================================
  
  // Nonces: toujours 24 bytes = 32 base64 chars
  nonceBytes: 24,
  
  // Encrypted Header: le vrai header fait ~120B JSON → ~136B chiffré
  // (sans rotation PQ, qui est rare ~5%)
  minHeaderBytes: 130,
  maxHeaderBytes: 145,
  
  // Ciphertext RAW bytes par tier (= ce qui est encodé en base64)
  tiers: {
    // Tier 2KB: texte court, ACK, signaux, réactions, receipts
    // addUniformPadding→2048 → TR bucket 4096 +0-10% → AEAD +48
    small: {
      minCiphertextBytes: 4144,  // 4096 + 48
      maxCiphertextBytes: 4553,  // 4505 + 48
    },
    // Tier 8KB: chunks média, texte long
    // addUniformPadding→8192 → TR bucket 16384 +0-10% → AEAD +48
    medium: {
      minCiphertextBytes: 16432,  // 16384 + 48
      maxCiphertextBytes: 18070,  // 18022 + 48
    },
  },
  
  // Distribution: 70% textes courts, 30% chunks/textes longs
  tierDistribution: {
    small: 0.70,
    medium: 0.30,
  },
};

// ============================================
// HELPERS CRYPTO
// ============================================

/**
 * Génère des bytes aléatoires cryptographiquement sûrs
 * Gère la limite de 1024 bytes d'expo-crypto
 */
function getRandomBytes(size: number): Uint8Array {
  if (size <= 1024) {
    return Crypto.getRandomBytes(size);
  }
  
  const result = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const chunkSize = Math.min(1024, size - offset);
    const chunk = Crypto.getRandomBytes(chunkSize);
    result.set(chunk, offset);
    offset += chunkSize;
  }
  return result;
}

/**
 * Génère un entier aléatoire dans [min, max] (inclusif)
 * ACTION 10 (Audit Fix): Délègue à secureRandomIntRange (rejection sampling, no modulo bias)
 */
function getRandomInt(min: number, max: number): number {
  return secureRandomIntRange(min, max);
}

/**
 * Génère un fingerprint réaliste (16 caractères hex)
 * Identique au format utilisé par sessionService
 */
function generateRealisticFingerprint(): string {
  const bytes = getRandomBytes(8);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Génère un tag réaliste (32 caractères hex)
 * Identique au format utilisé pour les vrais tags de session
 */
function generateRealisticTag(): string {
  const bytes = getRandomBytes(16);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Génère un device ID anonyme réaliste
 */
function generateRealisticDeviceId(): string {
  return encodeBase64(getRandomBytes(16));
}

// ============================================
// GÉNÉRATION DE DECOYS INDISTINGUABLES
// ============================================

/**
 * Génère un TripleRatchetMessage factice structurellement identique.
 *
 * @param minCtBytes - Taille min du ciphertext raw
 * @param maxCtBytes - Taille max du ciphertext raw
 */
function generateFakeTripleRatchetMessage(minCtBytes: number, maxCtBytes: number): {
  encryptedHeader: string;
  headerNonce: string;
  ciphertext: string;
  nonce: string;
} {
  const headerSize = getRandomInt(CONFIG.minHeaderBytes, CONFIG.maxHeaderBytes);
  const ciphertextSize = getRandomInt(minCtBytes, maxCtBytes);
  
  return {
    encryptedHeader: encodeBase64(getRandomBytes(headerSize)),
    headerNonce: encodeBase64(getRandomBytes(CONFIG.nonceBytes)),
    ciphertext: encodeBase64(getRandomBytes(ciphertextSize)),
    nonce: encodeBase64(getRandomBytes(CONFIG.nonceBytes)),
  };
}

/**
 * Génère un EncryptedMessage factice.
 */
function generateFakeEncryptedMessage(minCtBytes: number, maxCtBytes: number): string {
  const encryptedMessage = {
    version: 2,
    message: generateFakeTripleRatchetMessage(minCtBytes, maxCtBytes),
    timestamp: Date.now() - getRandomInt(0, 5000),
  };
  
  return JSON.stringify(encryptedMessage);
}

/**
 * Génère un SealedPayload factice.
 */
function generateIndistinguishablePayload(minCtBytes: number, maxCtBytes: number): string {
  const sealedPayload = {
    type: 'triple_ratchet_v3',
    version: 3,
    data: generateFakeEncryptedMessage(minCtBytes, maxCtBytes),
  };
  
  return JSON.stringify(sealedPayload);
}

/**
 * v25.0: Génère un decoy dont la taille correspond exactement
 * à ce que le serveur voit pour un vrai message du même tier.
 *
 * @param forceTier - Si fourni, force le tier au lieu d'utiliser la distribution aléatoire.
 *                    'medium' est utilisé par constantTraffic pendant le drain de chunks
 *                    pour que les decoys interleaved matchent la taille des chunks.
 *
 * Distribution sans forceTier: 70% small (5.8-6.4KB), 30% medium (21.8-24.0KB)
 */
/**
 * v25.1: Exported pour permettre aux decoys ciblés (session-targeted)
 * d'utiliser la même logique de génération de payload.
 * Utilisé par api1to1.ts → sendSessionDecoy().
 */
export function generateSizedPayload(forceTier?: 'small' | 'medium'): string {
  let tier: 'small' | 'medium';
  
  if (forceTier) {
    tier = forceTier;
  } else {
    const randByte = Crypto.getRandomBytes(1)[0] / 256;
    tier = randByte < CONFIG.tierDistribution.small ? 'small' : 'medium';
  }
  
  return generateIndistinguishablePayload(
    CONFIG.tiers[tier].minCiphertextBytes,
    CONFIG.tiers[tier].maxCiphertextBytes
  );
}

// ============================================
// ÉTAT DU SERVICE
// ============================================

interface DecoyState {
  isRunning: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
  healthcheckId: ReturnType<typeof setInterval> | null;
  appStateSubscription: any;
  lastDecoyTime: Date | null;
  decoysSentCount: number;
  lastPayloadSize: number;
}

const state: DecoyState = {
  isRunning: false,
  timeoutId: null,
  healthcheckId: null,
  appStateSubscription: null,
  lastDecoyTime: null,
  decoysSentCount: 0,
  lastPayloadSize: 0,
};

// ============================================
// ENVOI DE DECOYS
// ============================================

/**
 * Envoie un message decoy indistinguable d'un vrai message.
 * @param forceTier - Si fourni, force la taille à matcher un tier spécifique
 */
async function sendDecoyMessage(forceTier?: 'small' | 'medium'): Promise<boolean> {
  __DEV__ && console.log('[Decoy] 📤 Generating indistinguishable decoy...');
  
  try {
    if (!isSealedSenderReady()) {
      __DEV__ && console.log('[Decoy] ⏳ Sealed sender not ready, skipping decoy');
      return false;
    }
    
    const tag = generateRealisticTag();
    const payload = generateSizedPayload(forceTier);
    
    state.lastPayloadSize = payload.length;
    
    __DEV__ && console.log(`[Decoy] 📊 Payload: ${Math.round(payload.length / 1024 * 10) / 10}KB (${forceTier || 'random'} tier)`);
    
    // Wrapper dans une enveloppe sealed sender (identique aux vrais messages)
    const envelope = createSealedSenderEnvelope(tag, payload);
    
    // SÉCURITÉ: Inclure un p_push_blob ALÉATOIRE de même taille que les vrais.
    // Le Gateway forward chaque blob au Push Proxy sans distinction.
    // Le Push Proxy ne peut pas déchiffrer → ignoré silencieusement.
    const { error } = await secureRpc('send_sealed_message', {
      p_tag: envelope.tag,
      p_sealed_content: envelope.sealedContent,
      p_version: envelope.version,
      p_push_blob: generateRandomPushBlob(),
    });

    if (error) {
      __DEV__ && console.warn('[Decoy] ❌ RPC error:', error.message);
      return false;
    }

    state.lastDecoyTime = new Date();
    state.decoysSentCount++;
    __DEV__ && console.log(`[Decoy] ✅ Decoy #${state.decoysSentCount} sent (${Math.round(payload.length / 1024)}KB, indistinguishable)`);
    return true;

  } catch (e) {
    __DEV__ && console.error('[Decoy] ❌ Exception:', e);
    return false;
  }
}

/**
 * Planifie le prochain decoy avec un délai aléatoire
 */
function scheduleNextDecoy(): void {
  if (!state.isRunning) {
    __DEV__ && console.log('[Decoy] Service not running, skip scheduling');
    return;
  }

  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
  }

  const interval = getRandomInt(CONFIG.minIntervalMs, CONFIG.maxIntervalMs);
  __DEV__ && console.log(`[Decoy] ⏰ Next decoy in ${Math.round(interval / 1000)}s`);

  state.timeoutId = setTimeout(async () => {
    if (state.isRunning) {
      await sendDecoyMessage();
      scheduleNextDecoy();
    }
  }, interval);
}

// ============================================
// API PUBLIQUE
// ============================================

/**
 * Active le service de decoy.
 * Note: le scheduling est géré par constantTraffic.ts (PHASE 2).
 * Cette fonction active uniquement le flag isRunning pour que sendDecoyBurst() fonctionne.
 */
export function startDecoyService(): void {
  if (state.isRunning) {
    return;
  }

  state.isRunning = true;
  __DEV__ && console.log('[Decoy] ✅ Service activated (scheduling handled by ConstantTraffic)');

  // AppState listener: uniquement pour le flag, pas de timer indépendant
  if (state.appStateSubscription) {
    state.appStateSubscription.remove();
  }
  state.appStateSubscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
    if (nextState === 'active' && state.isRunning) {
      __DEV__ && console.log('[Decoy] App resumed (ConstantTraffic handles scheduling)');
    }
  });
}

/**
 * Arrête le service de decoy
 */
export function stopDecoyService(): void {
  state.isRunning = false;
  
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
  
  if (state.healthcheckId) {
    clearInterval(state.healthcheckId);
    state.healthcheckId = null;
  }
  
  if (state.appStateSubscription) {
    state.appStateSubscription.remove();
    state.appStateSubscription = null;
  }
}

/**
 * Récupère le statut du service
 */
export function getDecoyServiceStatus(): {
  isRunning: boolean;
  lastDecoyTime: Date | null;
  decoysSentCount: number;
  lastPayloadSize: number;
} {
  return {
    isRunning: state.isRunning,
    lastDecoyTime: state.lastDecoyTime,
    decoysSentCount: state.decoysSentCount,
    lastPayloadSize: state.lastPayloadSize,
  };
}

/**
 * Envoie un burst de decoys après l'envoi d'un vrai message
 * Pour masquer le timing du vrai message
 */
/**
 * Envoie UN SEUL decoy avec distribution aléatoire (70% small, 30% medium).
 * Utilisé par le constant-rate traffic en mode normal.
 */
export async function sendSingleDecoy(): Promise<void> {
  if (!state.isRunning) return;
  await sendDecoyMessage();
}

/**
 * v25.0: Envoie UN decoy forcé au tier MEDIUM (~22-24KB sealed).
 * Utilisé par constantTraffic pendant le drain de chunks média
 * pour que les decoys interleaved soient de la même taille que les chunks réels.
 *
 * Sans ça: chunks à 22-24KB + decoys interleaved à 6KB → l'observateur
 * identifie les decoys par leur taille.
 */
export async function sendSingleDecoyMediumTier(): Promise<void> {
  if (!state.isRunning) return;
  await sendDecoyMessage('medium');
}

export async function sendDecoyBurst(): Promise<void> {
  __DEV__ && console.log('[Decoy] 💥 Burst requested, isRunning:', state.isRunning);
  
  if (!state.isRunning) {
    __DEV__ && console.log('[Decoy] Service not running, skip burst');
    return;
  }
  
  __DEV__ && console.log(`[Decoy] Sending ${CONFIG.burstCount} indistinguishable burst decoys...`);
  
  for (let i = 0; i < CONFIG.burstCount; i++) {
    const delay = getRandomInt(CONFIG.burstMinDelayMs, CONFIG.burstMaxDelayMs);
    __DEV__ && console.log(`[Decoy] Burst ${i + 1}/${CONFIG.burstCount}, waiting ${Math.round(delay / 1000)}s...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    await sendDecoyMessage();
  }
  
  __DEV__ && console.log('[Decoy] ✅ Burst complete');
}

/**
 * Génère des tags decoy pour le k-anonymity lors du polling
 * Ces tags sont mélangés avec les vrais tags pour masquer lesquels sont réels
 */
export function generateDecoyTagsForPolling(
  realTagsCount: number,
  kFactor: number = 4
): string[] {
  const decoyCount = Math.max(kFactor, Math.ceil(realTagsCount * 0.5));
  const decoyTags: string[] = [];
  
  for (let i = 0; i < decoyCount; i++) {
    decoyTags.push(generateRealisticTag());
  }
  
  return decoyTags;
}

// ============================================
// STATISTIQUES (pour debug)
// ============================================

/**
 * Affiche les statistiques du service
 */
export function logDecoyStats(): void {
  const status = getDecoyServiceStatus();
  __DEV__ && console.log('[Decoy] 📊 Statistics:');
  __DEV__ && console.log(`  - Running: ${status.isRunning}`);
  __DEV__ && console.log(`  - Decoys sent: ${status.decoysSentCount}`);
  __DEV__ && console.log(`  - Last decoy: ${status.lastDecoyTime?.toISOString() || 'never'}`);
  __DEV__ && console.log(`  - Last size: ${Math.round(status.lastPayloadSize / 1024 * 10) / 10}KB (pre-outer-padding)`);
  __DEV__ && console.log(`  - Outer padding normalizes to 4KB (${CONFIG.tierDistribution.small * 100}%) / 12KB (${CONFIG.tierDistribution.medium * 100}%)`);
}