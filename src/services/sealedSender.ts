// src/services/sealedSender.ts
// SEALED SENDER — Real Implementation
// Version 5.0 — Audit Fix C-01
//
// AVANT (vulnérable):
//   Le serveur voyait p_device_id (expéditeur) + p_tag (destinataire)
//   → Graphe social complet reconstructible.
//
// APRÈS (sealed sender):
//   Double chiffrement:
//     inner = message Triple Ratchet (E2E, inchangé)
//     outer = NaCl box(inner || senderCertificate, serverPubKey)
//   Le serveur déchiffre l'outer, vérifie le certificat anonyme,
//   route vers le tag, puis SUPPRIME l'outer. Il ne voit jamais l'expéditeur.
//
// CERTIFICAT ANONYME:
//   Le serveur délivre un certificat signé (HMAC) à chaque client.
//   Le certificat prouve "cet utilisateur est légitime" sans contenir d'identité.
//   Format: { nonce (random 32B), expiry, hmac(serverKey, nonce || expiry) }

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { secureRandomInt } from './crypto';
// P1-A1: SHA-256 pour le tag commitment
import { sha256 } from '@noble/hashes/sha256';

// ============================================
// TYPES
// ============================================

/**
 * Certificat anonyme prouvant que l'expéditeur est légitime
 * sans révéler son identité.
 */
export interface SenderCertificate {
  /** Nonce aléatoire 32 bytes (non-corrélé à l'identité) */
  nonce: string; // Base64
  /** Timestamp d'expiration (ms) */
  expiry: number;
  /** HMAC-SHA256(serverHmacKey, nonce || expiry) */
  hmac: string; // Base64
}

/**
 * Envelope sealed sender envoyée au serveur.
 * Le serveur voit UNIQUEMENT le tag destinataire + le blob opaque.
 */
export interface SealedSenderEnvelope {
  /** Version du protocole sealed sender */
  version: 1;
  /** Tag destinataire (epoch tag, visible au serveur pour routage) */
  tag: string;
  /**
   * Contenu chiffré avec NaCl box (clé publique du serveur).
   * Le serveur déchiffre, vérifie le certificat, route, puis SUPPRIME.
   * Wire format: [ephemeralPubKey(32)][nonce(24)][ciphertext]
   */
  sealedContent: string; // Base64
}

/**
 * Contenu interne du sealed_box (visible par le serveur pour routage uniquement).
 */
interface SealedSenderInner {
  /** Le payload Triple Ratchet chiffré E2E (opaque au serveur) */
  innerPayload: string;
  /** Certificat anonyme prouvant la légitimité de l'expéditeur */
  certificate: SenderCertificate;
  /** P1-A1: SHA-256(tag) — le gateway vérifie que ce commitment matche le tag de l'enveloppe */
  tagCommitment: string; // Hex
}

// ============================================
// STATE
// ============================================

let _currentCertificate: SenderCertificate | null = null;
let _serverSealedSenderPubKey: Uint8Array | null = null;

/**
 * Stocke le certificat anonyme reçu du serveur après authentification.
 */
export function setSenderCertificate(cert: SenderCertificate): void {
  _currentCertificate = cert;
}

/**
 * Retourne le certificat actuel ou null s'il est expiré/absent.
 */
export function getSenderCertificate(): SenderCertificate | null {
  if (!_currentCertificate) return null;
  if (Date.now() > _currentCertificate.expiry) {
    _currentCertificate = null;
    return null;
  }
  return _currentCertificate;
}

/**
 * Invalide le certificat actuel (P6 fix).
 * Appelé lorsque le gateway rejette pour quota dépassé ou expiry.
 * Le prochain envoi déclenchera l'obtention d'un nouveau certificat via PoW.
 */
export function invalidateSenderCertificate(): void {
  _currentCertificate = null;
}

/**
 * R-13: Efface TOUT l'état sealed sender lors du verrouillage de l'application.
 *
 * SÉCURITÉ: _serverSealedSenderPubKey est une clé publique NaCl X25519 (32 bytes).
 * Bien qu'une clé PUBLIQUE ne soit pas secrète, la laisser en mémoire après le
 * verrouillage permet à un attaquant ayant accès au process (ex: memory dump via ADB
 * sur un appareil rooté, ou exploitation d'une CVE JavaScript) de:
 *   - Identifier quelle instance gateway est utilisée (fingerprinting)
 *   - Préparer une attaque par substitution de clé si le verrou est levé
 *
 * Le certificat anonyme (_currentCertificate) contient:
 *   - Un nonce aléatoire de 32 bytes (identifiant de session gateway)
 *   - Un HMAC permettant au gateway de vérifier l'authenticité
 *   → Sa conservation en mémoire après lock expose l'identité de session.
 *
 * Après clearSealedSenderState(), les deux doivent être refetchés au déverrouillage.
 */
export function clearSealedSenderState(): void {
  // Zeroizer les bytes si possible (clé publique dans un Uint8Array)
  if (_serverSealedSenderPubKey) {
    try {
      _serverSealedSenderPubKey.fill(0);
    } catch {
      // Uint8Array potentiellement détaché (ArrayBuffer partagé) — ignorer
    }
    _serverSealedSenderPubKey = null;
  }
  // Le certificat ne contient pas de Uint8Array — null suffit
  _currentCertificate = null;
}

/**
 * Définit la clé publique du serveur pour le sealed sender.
 * Distincte de la clé OHTTP gateway.
 */
export function setSealedSenderServerKey(pubKeyB64: string): void {
  _serverSealedSenderPubKey = decodeBase64(pubKeyB64);
}

/**
 * Vérifie si le sealed sender est opérationnel.
 */
export function isSealedSenderReady(): boolean {
  return _serverSealedSenderPubKey !== null && getSenderCertificate() !== null;
}

// ============================================
// BOOTSTRAP (Audit Fix C-01 — MISSING PIECE)
// ============================================
// Le sealed sender nécessite deux éléments qui doivent être fetch au démarrage:
//   1. La clé publique NaCl du serveur sealed sender (GET /sealed-sender-key)
//   2. Un certificat anonyme prouvant la légitimité (POST /certificate via relay)
// ACTION 01: Sans ces deux éléments, isSealedSenderReady() retourne false et l'envoi
// est BLOQUÉ (plus de fallback legacy). L'utilisateur voit un message d'erreur.

// PAS de GATEWAY_BASE_URL — la clé sealed sender est obtenue via le relay
// (incluse dans /gateway-manifests). Aucun contact direct avec le gateway.
/** Durée avant renouvellement du certificat (marge de 10min avant expiry) */
const CERTIFICATE_REFRESH_MARGIN_MS = 10 * 60 * 1000; // P5 fix: 10min (was 1h for 24h certs)

let _certificateRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Bootstrap du sealed sender. À appeler une fois au démarrage de l'app.
 * 
 * 1. Fetch la clé publique sealed sender depuis le gateway
 * 2. Obtient un certificat anonyme (via relay OHTTP pour protéger l'IP)
 * 3. Programme le renouvellement automatique du certificat
 * 
 * @param fetchCertificateViaRelay - Fonction qui obtient le certificat via le relay OHTTP.
 *   Passe par le relay pour que le gateway ne voie pas l'IP du client.
 * @returns true si le bootstrap a réussi
 */
export async function bootstrapSealedSender(
  fetchCertificateViaRelay: () => Promise<SenderCertificate | null>
): Promise<boolean> {
  try {
    // 1. Récupérer la clé sealed sender depuis le relay (PAS de contact direct gateway)
    const { getSealedSenderKeyFromRelay, initRelay } = await import('./relayTransport');
    
    // S'assurer que le relay est initialisé (il fetch les manifests incluant la SS key)
    await initRelay();
    
    const ssKeyB64 = getSealedSenderKeyFromRelay();
    if (!ssKeyB64) {
      __DEV__ && console.warn('[SealedSender] ❌ Sealed sender key not available from relay');
      return false;
    }
    
    setSealedSenderServerKey(ssKeyB64);
    __DEV__ && console.log('[SealedSender] ✅ Server public key loaded via relay:', ssKeyB64.slice(0, 16) + '...');
    
    // 2. Obtenir un certificat anonyme via le relay
    const cert = await fetchCertificateViaRelay();
    if (!cert) {
      __DEV__ && console.warn('[SealedSender] ❌ Failed to obtain anonymous certificate');
      return false;
    }
    
    setSenderCertificate(cert);
    __DEV__ && console.log('[SealedSender] ✅ Anonymous certificate obtained, expires:', new Date(cert.expiry).toISOString());
    
    // 3. Programmer le renouvellement avant expiration
    scheduleCertificateRefresh(cert.expiry, fetchCertificateViaRelay);
    
    __DEV__ && console.log('[SealedSender] ✅ Bootstrap complete — sealed sender ACTIVE');
    return true;
  } catch (error) {
    __DEV__ && console.warn('[SealedSender] ❌ Bootstrap failed:', error);
    return false;
  }
}

/**
 * Programme le renouvellement automatique du certificat.
 */
function scheduleCertificateRefresh(
  expiry: number,
  fetchFn: () => Promise<SenderCertificate | null>
): void {
  if (_certificateRefreshTimer) clearTimeout(_certificateRefreshTimer);
  
  const refreshAt = expiry - CERTIFICATE_REFRESH_MARGIN_MS;
  const delayMs = Math.max(refreshAt - Date.now(), 60_000); // min 1 minute
  
  _certificateRefreshTimer = setTimeout(async () => {
    __DEV__ && console.log('[SealedSender] 🔄 Refreshing anonymous certificate...');
    try {
      const cert = await fetchFn();
      if (cert) {
        setSenderCertificate(cert);
        scheduleCertificateRefresh(cert.expiry, fetchFn);
        __DEV__ && console.log('[SealedSender] ✅ Certificate refreshed');
      }
    } catch {
      // Retry in 5 minutes
      _certificateRefreshTimer = setTimeout(
        () => scheduleCertificateRefresh(Date.now() + 10 * 60_000, fetchFn),
        5 * 60_000
      );
    }
  }, delayMs);
}

/**
 * Crée une enveloppe sealed sender.
 *
 * Le serveur ne verra que le tag destinataire + un blob opaque chiffré.
 * L'identité de l'expéditeur est masquée : seul le certificat anonyme
 * prouve la légitimité, sans lien avec l'identité.
 *
 * @param tag - Tag epoch destinataire (visible au serveur pour routage)
 * @param innerPayload - Payload Triple Ratchet chiffré E2E (opaque)
 * @returns Enveloppe sealed sender prête à envoyer
 */
/**
 * v25.0: OUTER PADDING TIERS — Normalisation des tailles au dernier point commun.
 *
 * PROBLÈME RÉSOLU:
 *   Les vrais messages et les decoys suivent deux pipelines différents:
 *     - Vrai: InnerPayload → addUniformPadding(2KB/8KB) → TR padMessage(4096/16384)
 *             → encryptAEAD → SealedPayload JSON ~5.8-6.4KB ou ~22-24.5KB
 *     - Decoy: génération directe de fake ciphertext calibré → SealedPayload ~5.9-6.5KB ou ~22-24.5KB
 *   → Malgré la calibration, de petites variations subsistent entre les deux pipelines.
 *
 * SOLUTION:
 *   Padder le SealedPayload JSON (innerPayload) DANS createSealedSenderEnvelope
 *   à des tiers FIXES avant le chiffrement nacl.box. Les deux pipelines
 *   convergent au même point → taille finale strictement identique.
 *
 * Tiers (calculés d'après les tailles réelles):
 *   - 12KB (12288): SealedPayloads de 5-12KB (texte court, receipts, signaux, decoys small)
 *   - 24KB (24576): SealedPayloads de 12-24.5KB (chunks média, texte long, decoys medium)
 *   - Fallback: prochain multiple de 12KB pour les cas rares (PQ rotation sur chunks ~26KB)
 *
 * Le serveur voit p_sealed_content de taille:
 *   - base64(12288 + ~440) ≈ 17KB pour les messages texte
 *   - base64(24576 + ~440) ≈ 33KB pour les chunks média
 *   → Impossible de distinguer vrai/decoy au sein d'un même tier.
 */
const SEALED_PAYLOAD_TIERS = [
  12 * 1024,     // 12 KB — texte court ~6KB, receipts, signaux, decoys small
  36 * 1024,     // 36 KB — chunks média ~23KB, texte long, decoys medium (v25.1: élargi de 24→36KB)
];

/**
 * Padde un SealedPayload JSON string à un tier fixe en ajoutant un champ `_p`.
 * Le récepteur ignore ce champ (il ne lit que type, version, data).
 *
 * Approche: manipulation directe du string JSON (pas de re-parse)
 * pour un contrôle exact de la taille en octets.
 */
function padSealedPayloadToTier(sealedPayloadStr: string): string {
  const currentSize = new TextEncoder().encode(sealedPayloadStr).length;
  
  // Trouver le tier cible
  const targetTier = SEALED_PAYLOAD_TIERS.find(tier => currentSize <= tier);
  
  if (!targetTier || currentSize >= targetTier) {
    // Déjà au-dessus du plus grand tier (ne devrait pas arriver avec le chunking)
    // Fallback: prochain multiple de 12KB
    const fallbackTier = Math.ceil(currentSize / (12 * 1024)) * (12 * 1024);
    return _applyPadding(sealedPayloadStr, currentSize, fallbackTier);
  }
  
  return _applyPadding(sealedPayloadStr, currentSize, targetTier);
}

function _applyPadding(json: string, currentBytes: number, targetBytes: number): string {
  // GH-13 fix: Parse JSON → add _p field → re-serialize for robustness
  // Overhead estimate: ,"_p":"" = 8 bytes min
  const overhead = 8;
  const padNeeded = targetBytes - currentBytes - overhead;
  
  if (padNeeded <= 0) return json;
  
  const padChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let padding = '';
  for (let i = 0; i < padNeeded; i++) {
    padding += padChars[secureRandomInt(padChars.length)];
  }
  
  // GH-13: Safe JSON manipulation — parse, add field, re-serialize
  try {
    const obj = JSON.parse(json);
    obj._p = padding;
    const result = JSON.stringify(obj);
    // Adjust if serialized size differs from estimate (due to escaping etc.)
    const resultBytes = new TextEncoder().encode(result).length;
    if (resultBytes > targetBytes) {
      // Trim padding to fit
      const excess = resultBytes - targetBytes;
      obj._p = padding.slice(0, Math.max(0, padding.length - excess));
      return JSON.stringify(obj);
    }
    return result;
  } catch (e) {
    // Si le JSON est invalide à ce stade, c'est un BUG en amont —
    // ne pas masquer avec du string manipulation qui pourrait produire
    // du JSON invalide et créer un side-channel de taille.
    __DEV__ && console.error('[SealedSender] CRITICAL: Invalid JSON in _applyPadding — this should never happen:', e);
    // Retourner sans padding : le message sera légèrement plus petit que le tier
    // mais au moins le JSON sera valide et déchiffrable.
    return json;
  }
}

export function createSealedSenderEnvelope(
  tag: string,
  innerPayload: string
): SealedSenderEnvelope {
  const cert = getSenderCertificate();
  if (!cert) {
    throw new Error('SealedSender: No valid sender certificate');
  }
  if (!_serverSealedSenderPubKey) {
    throw new Error('SealedSender: Server public key not set');
  }

  // v25.0: OUTER PADDING — normaliser la taille AVANT chiffrement
  // Tous les messages (vrais + decoys) passent par ici → même taille finale
  const paddedPayload = padSealedPayloadToTier(innerPayload);

  // Construire le contenu interne
  // P1-A1: Inclure SHA-256(tag) pour que le gateway vérifie la cohérence
  const tagBytes = new TextEncoder().encode(tag);
  const tagHash = sha256(tagBytes);
  const tagCommitment = Array.from(tagHash).map(b => b.toString(16).padStart(2, '0')).join('');

  const inner: SealedSenderInner = {
    innerPayload: paddedPayload,
    certificate: cert,
    tagCommitment,
  };

  const innerBytes = new TextEncoder().encode(JSON.stringify(inner));

  // Chiffrer avec NaCl box éphémère → le serveur ne peut pas
  // corréler la clé éphémère à un expéditeur.
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);

  const ciphertext = nacl.box(
    innerBytes,
    nonce,
    _serverSealedSenderPubKey,
    ephemeral.secretKey
  );

  if (!ciphertext) {
    throw new Error('SealedSender: Encryption failed');
  }

  // Wire format: [ephemeralPubKey(32)][nonce(24)][ciphertext]
  const sealedContent = new Uint8Array(32 + 24 + ciphertext.length);
  sealedContent.set(ephemeral.publicKey, 0);
  sealedContent.set(nonce, 32);
  sealedContent.set(ciphertext, 56);

  // Zeroize ephemeral secret key
  ephemeral.secretKey.fill(0);

  return {
    version: 1,
    tag,
    sealedContent: encodeBase64(sealedContent),
  };
}

// ============================================
// SEALED SENDER DECRYPTION (SERVER SIDE REFERENCE)
// ============================================
// Ce code est pour référence / tests. En production, le déchiffrement
// se fait côté serveur (Gateway ou Supabase Edge Function).

/**
 * Déchiffre une enveloppe sealed sender (côté serveur).
 *
 * @param envelope - Enveloppe sealed sender
 * @param serverSecretKey - Clé privée NaCl du serveur (32 bytes)
 * @param serverHmacKey - Clé HMAC pour vérifier les certificats (32 bytes)
 * @returns Le payload intérieur ou null si invalide
 */
export function openSealedSenderEnvelope(
  envelope: SealedSenderEnvelope,
  serverSecretKey: Uint8Array,
  serverHmacKey: Uint8Array
): { innerPayload: string; valid: boolean } | null {
  try {
    const sealedContent = decodeBase64(envelope.sealedContent);

    if (sealedContent.length < 32 + 24 + 16) {
      return null;
    }

    const ephemeralPubKey = sealedContent.slice(0, 32);
    const nonce = sealedContent.slice(32, 56);
    const ciphertext = sealedContent.slice(56);

    const plaintext = nacl.box.open(
      ciphertext,
      nonce,
      ephemeralPubKey,
      serverSecretKey
    );

    if (!plaintext) {
      return null;
    }

    const inner: SealedSenderInner = JSON.parse(
      new TextDecoder().decode(plaintext)
    );

    // Vérifier expiration du certificat
    if (Date.now() > inner.certificate.expiry) {
      return { innerPayload: inner.innerPayload, valid: false };
    }

    // Vérifier HMAC(serverHmacKey, nonce || expiry)
    // Ceci utilise @noble/hashes côté serveur
    const { hmac } = require('@noble/hashes/hmac');
    const { sha256 } = require('@noble/hashes/sha256');

    const certNonce = decodeBase64(inner.certificate.nonce);
    const expiryBytes = new Uint8Array(8);
    new DataView(expiryBytes.buffer).setBigUint64(
      0,
      BigInt(inner.certificate.expiry),
      false
    );

    const dataToHmac = new Uint8Array(certNonce.length + expiryBytes.length);
    dataToHmac.set(certNonce, 0);
    dataToHmac.set(expiryBytes, certNonce.length);

    const expectedHmac = hmac(sha256, serverHmacKey, dataToHmac);
    const receivedHmac = decodeBase64(inner.certificate.hmac);

    // Comparaison en temps constant
    let diff = 0;
    const len = Math.max(expectedHmac.length, receivedHmac.length);
    for (let i = 0; i < len; i++) {
      diff |= (expectedHmac[i] || 0) ^ (receivedHmac[i] || 0);
    }

    return {
      innerPayload: inner.innerPayload,
      valid: diff === 0 && expectedHmac.length === receivedHmac.length,
    };
  } catch {
    return null;
  }
}

// ============================================
// DÉLAI ALÉATOIRE (anti-timing, conservé)
// ============================================

/**
 * Calcule un délai aléatoire CSPRNG pour masquer les patterns temporels
 */
export function getRandomDelay(minMs: number = 0, maxMs: number = 3000): number {
  const range = maxMs - minMs;
  if (range <= 0) return minMs;
  return minMs + secureRandomInt(range);
}

/**
 * Attend un délai aléatoire
 */
export async function randomDelay(
  minMs: number = 0,
  maxMs: number = 3000
): Promise<void> {
  const delay = getRandomDelay(minMs, maxMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

// ============================================
// MODE FANTÔME (conservé)
// ============================================

export interface GhostModeConfig {
  enabled: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  coalescingWindowMs: number;
}

export const DEFAULT_GHOST_MODE: GhostModeConfig = {
  enabled: false,
  minDelayMs: 0,
  maxDelayMs: 3000,
  coalescingWindowMs: 0,
};

export const PARANOID_GHOST_MODE: GhostModeConfig = {
  enabled: true,
  minDelayMs: 5000,
  maxDelayMs: 30000,
  coalescingWindowMs: 10000,
};

export async function applyGhostModeDelay(
  config: GhostModeConfig
): Promise<void> {
  if (!config.enabled) {
    return;
  }
  await randomDelay(config.minDelayMs, config.maxDelayMs);
}