// src/services/relayTransport.ts
// PHASE 3: OHTTP Relay Transport (Split-Trust Client)
//
// REPLACES direct Supabase calls with encrypted relay routing:
//   1. Client encrypts RPC request with Gateway's public key (NaCl box)
//   2. Sends encrypted blob to CF Relay (CF sees IP, not content)
//   3. CF Relay forwards blob to Gateway (Gateway sees content, not IP)
//   4. Gateway decrypts, forwards to Supabase, re-encrypts response
//   5. Response flows back: Gateway → CF Relay → Client
//
// RESULT: No single server sees both IP and content.
//
// USAGE:
//   import { initRelay, relayRpc } from './relayTransport';
//   await initRelay();
//   const result = await relayRpc('send_sealed_message', { p_tag, p_sealed_content, p_version });

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { secureRandomInt } from './crypto';
// R-03: sha256 via @noble/hashes (crypto.subtle non disponible sur Hermes/React Native)
import { sha256 } from '@noble/hashes/sha256';

// ============================================
// CONFIGURATION
// ============================================

// URLs configurées depuis les variables d'environnement (.env)
const CF_RELAY_URL = process.env.EXPO_PUBLIC_RELAY_URL;

// ACTION 09: Multi-gateway support
const GATEWAY_MANIFESTS_URL = CF_RELAY_URL + '/gateway-manifests';

// ============================================
// R-03: GATEWAY PUBLIC KEY PINNING (CRITIQUE)
// ============================================
//
// PROBLÈME: La clé publique X25519 du gateway est récupérée dynamiquement depuis
// /gateway-manifests. Si le compte Cloudflare ou le code Worker est compromis,
// un attaquant peut servir sa propre clé → MITM complet de tout le trafic OHTTP.
// Le client acceptait n'importe quel tableau de 32 bytes valide sans vérification.
//
// SOLUTION: Chaque gateway a une empreinte SHA-256 de sa clé publique codée en dur
// dans le binaire de l'app. La clé reçue depuis le réseau est rejetée si elle
// ne correspond pas à une empreinte connue.
//
// DÉPLOIEMENT:
//   1. Générer les clés gateway: node ohttp-gateway/keygen-sealed-sender.js
//   2. Calculer l'empreinte: sha256(pubKeyBytes) → hex
//   3. Ajouter à PINNED_GATEWAY_KEY_FINGERPRINTS ci-dessous
//   4. Recompiler l'app et la distribuer
//   5. En cas de rotation de clé planifiée: ajouter la NOUVELLE empreinte AVANT
//      de déployer le gateway, attendre que tous les clients aient mis à jour,
//      puis retirer l'ancienne.
//
// GESTION DES ALERTES:
//   Si la clé reçue ne correspond à aucune empreinte connue, initRelay() retourne
//   false et tous les envois de messages sont bloqués. L'utilisateur voit une
//   alerte "Impossible de sécuriser la connexion".
//
// ROTATION DE CLÉS:
//   Le gateway effectue une rotation automatique des clés toutes les 24h (ACTION 10).
//   Ces clés éphémères NE sont PAS des clés d'identité — elles protègent seulement
//   contre un compromis total du compte CF. Les empreintes ici doivent donc pointer
//   vers la clé INITIALE (celle dans GATEWAY_PUBLIC_KEY env var), pas les éphémères.
//
// FORMAT: Map<gatewayId, Set<empreinteSHA256Hex>>
// Chaque gateway peut avoir plusieurs empreintes valides (rotation planifiée).
//
// ⚠️  AVANT PRODUCTION: Remplacer les valeurs de développement ci-dessous par les
//     empreintes réelles de vos gateways. Les valeurs 'dev-placeholder-*' font
//     confiance à TOUTE clé de 32 bytes — équivalent à ne pas pinner.
//
// FORMAT: Map<gatewayId, Set<SHA-256(identityPubKey_Ed25519)>>
// P1-A6: L'empreinte est celle de la clé d'IDENTITÉ Ed25519 du gateway (FIXE).
// Les clés éphémères NaCl (rotées toutes les 24h) sont signées par cette identité.
// Le client vérifie : 1) empreinte identité → 2) signature éphémère → 3) fraîcheur.
//
// REMPLACER l'empreinte ci-dessous par SHA-256(votre_GATEWAY_IDENTITY_PUBLIC_KEY)
// générée avec la commande de l'étape 1 de la procédure P1-A6.
//
const PINNED_GATEWAY_KEY_FINGERPRINTS: Map<string, Set<string>> = new Map([
  ['gw-primary', new Set([
    'b0a2847e96eb787ef40955415e2fa1bdb4fa3ee4f666a8cd7e22296f0f9f855b',
  ])],
]);

// Pinning toujours actif. Pas de bypass, pas de variable, pas de condition.
// Si la clé ne matche pas l'empreinte pinnée, la connexion est refusée.

/**
 * Calcule l'empreinte SHA-256 d'une clé publique gateway.
 * Utilise @noble/hashes (synchrone, compatible Hermes/React Native).
 * crypto.subtle n'est pas disponible sur Hermes.
 */
function computeKeyFingerprint(pubKeyBytes: Uint8Array): string {
  const hash = sha256(pubKeyBytes);
  return Array.from(hash)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * R-03: Vérifie qu'une clé publique reçue correspond à une empreinte pinnée.
 *
 * @param gatewayId  Identifiant du gateway (ex: 'gw-primary')
 * @param pubKeyBytes  Clé publique X25519 reçue depuis le réseau
 * @returns true si la clé est autorisée, false sinon
 */
async function verifyGatewayKey(gatewayId: string, pubKeyBytes: Uint8Array): Promise<boolean> {
  const pinnedSet = PINNED_GATEWAY_KEY_FINGERPRINTS.get(gatewayId);
  if (!pinnedSet || pinnedSet.size === 0) {
    __DEV__ && console.error(`[Relay] ❌ R-03: Aucune empreinte pinnée pour le gateway '${gatewayId}' — clé REJETÉE`);
    return false;
  }

  const fingerprint = computeKeyFingerprint(pubKeyBytes); // sync désormais

  if (!pinnedSet.has(fingerprint)) {
    __DEV__ && console.error(`[Relay] ❌ R-03: Empreinte non reconnue pour '${gatewayId}': ${fingerprint}`);
    __DEV__ && console.error(`[Relay] ❌ Empreintes autorisées: ${[...pinnedSet].join(', ')}`);
    __DEV__ && console.error(`[Relay] ❌ POSSIBLE ATTAQUE MITM — Vérifiez votre infrastructure gateway`);
    return false;
  }

  __DEV__ && console.log(`[Relay] ✅ R-03: Clé gateway '${gatewayId}' vérifiée (${fingerprint.slice(0, 16)}...)`);
  return true;
}

// Whitelisted RPCs (must match gateway whitelist)
const ALLOWED_RPCS = [
  'register_push_token',
  'unregister_push_token',
  // ACTION 01: send_message SUPPRIMÉ — sealed sender uniquement
  'get_messages_by_tags',
  'send_call_signal',
  'get_call_signals_by_tags',
  // Audit Fix C-01: Sealed sender RPCs
  'send_sealed_message',
  'get_sealed_certificate',
  // P0: Key Transparency RPCs (handled by gateway, not forwarded to Supabase)
  'kt_register_key',
  'kt_get_proof',
  'kt_get_sth',
  // ACTION-03 (Phase 1 Security): Blob storage via OHTTP
  'upload_blob',
  'download_blob',
  'delete_blob',
  // ACTION-01 (Phase 1 Security): Legacy media SUPPRIMÉ (P0-A2)
] as const;

type AllowedRpc = typeof ALLOWED_RPCS[number];

// ============================================
// STATE — ACTION 09: Multi-gateway
// ============================================

interface GatewayInfo {
  id: string;
  pubKey: Uint8Array;
  sealedSenderKey?: string; // Base64 — clé publique sealed sender du gateway
}

interface RelayState {
  // ACTION 09: Support multiple gateways
  gateways: GatewayInfo[];
  gatewayPubKey: Uint8Array | null;
  sealedSenderKeyB64: string | null; // Clé sealed sender du gateway actif
  initialized: boolean;
  available: boolean;
  lastKeyRefresh: number;
}

const state: RelayState = {
  gateways: [],
  gatewayPubKey: null,
  sealedSenderKeyB64: null,
  initialized: false,
  available: false,
  lastKeyRefresh: 0,
};

// ACTION 10: Refresh interval for gateway keys (1h)
const KEY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// PERF A8: Timeout sur les requêtes réseau OHTTP.
// Sans timeout, un fetch peut rester en attente 30-60s (timeout TCP de React Native)
// si un des 4 hops (Client → CF Worker → Exit Relay → Gateway → Supabase) est lent
// ou en cold-start. Pendant ce temps, l'app entière est bloquée.
// 15s est suffisant pour couvrir le double-hop OHTTP même sur réseau 4G lent,
// tout en évitant les gels prolongés perçus comme des crashs.
const RELAY_TIMEOUT_MS = 15_000;
// Timeout plus court pour le manifest (simple GET, pas de double-hop)
const MANIFEST_TIMEOUT_MS = 10_000;

/**
 * fetch() avec AbortController timeout.
 * SÉCURITÉ: En cas de timeout, la requête est abandonnée proprement.
 * Aucun fallback vers une connexion directe — l'erreur est remontée à l'appelant.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e?.name === 'AbortError') {
      throw new Error(`Timeout (${Math.round(timeoutMs / 1000)}s)`);
    }
    throw e;
  }
}

// ============================================
// INITIALIZATION — ACTION 09: Multi-gateway
// ============================================

/**
 * Fetch gateway public keys.
 * ACTION 09: Tries multi-gateway manifests first, falls back to single gateway.
 * ACTION 10: Auto-refreshes keys every hour.
 */
export async function initRelay(): Promise<boolean> {
  if (state.initialized && state.available) {
    // ACTION 10: Check if keys need refresh
    if (Date.now() - state.lastKeyRefresh < KEY_REFRESH_INTERVAL_MS) {
      return true;
    }
    __DEV__ && console.log('[Relay] 🔄 Refreshing gateway keys...');
  }
  
  try {
    // ACTION 09: Try multi-gateway manifests first
    let multiGatewaySuccess = false;
    
    if (GATEWAY_MANIFESTS_URL && CF_RELAY_URL) {
      try {
        const manifestResponse = await fetchWithTimeout(GATEWAY_MANIFESTS_URL, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        }, MANIFEST_TIMEOUT_MS);
        
        if (manifestResponse.ok) {
          const manifests = await manifestResponse.json();
          
          if (Array.isArray(manifests) && manifests.length > 0) {
            state.gateways = [];
            
            for (const m of manifests) {
              if (m.id && m.pubkey) {
                const pubKeyBytes = decodeBase64(m.pubkey);
                if (pubKeyBytes.length !== 32) continue;

                // P1-A6: Le manifest DOIT contenir une clé d'identité Ed25519 signant la clé éphémère.
                // Pas de fallback : un gateway sans identityPubkey est rejeté.
                if (!m.identityPubkey || !m.ephemeralSignature || !m.ephemeralSignatureTimestamp) {
                  __DEV__ && console.error(`[Relay] ❌ P1-A6: Gateway '${m.id}' missing identity key or ephemeral signature — REJETÉ`);
                  state.available = false;
                  state.initialized = true;
                  throw new Error(`Gateway '${m.id}' must provide identityPubkey + ephemeralSignature`);
                }

                const identityPubKeyBytes = decodeBase64(m.identityPubkey);

                // 1. Vérifier l'empreinte de la clé d'IDENTITÉ (fixe, pinnée dans le binaire)
                const identityTrusted = await verifyGatewayKey(m.id, identityPubKeyBytes);
                if (!identityTrusted) {
                  __DEV__ && console.error(`[Relay] ❌ P1-A6: Identity key '${m.id}' REJETÉE — empreinte non reconnue`);
                  state.available = false;
                  state.initialized = true;
                  throw new Error(`Gateway identity key pinning failure for '${m.id}' — possible MITM`);
                }

                // 2. Vérifier la signature de la clé éphémère par la clé d'identité
                const sigBytes = decodeBase64(m.ephemeralSignature);
                const ts: number = m.ephemeralSignatureTimestamp;
                const tsBuf = new Uint8Array(8);
                const tsView = new DataView(tsBuf.buffer);
                tsView.setUint32(0, Math.floor(ts / 0x100000000), false);
                tsView.setUint32(4, ts >>> 0, false);
                const signedData = new Uint8Array(32 + 8);
                signedData.set(pubKeyBytes, 0);
                signedData.set(tsBuf, 32);

                const sigValid = nacl.sign.detached.verify(signedData, sigBytes, identityPubKeyBytes);
                if (!sigValid) {
                  __DEV__ && console.error(`[Relay] ❌ P1-A6: Ephemeral key signature INVALID for '${m.id}'`);
                  state.available = false;
                  state.initialized = true;
                  throw new Error(`Ephemeral key signature verification failed for '${m.id}'`);
                }

                // 3. Vérifier que la signature n'est pas trop vieille (max 48h)
                const signatureAge = Date.now() - ts;
                if (signatureAge > 48 * 60 * 60 * 1000) {
                  __DEV__ && console.error(`[Relay] ❌ P1-A6: Ephemeral signature too old (${Math.round(signatureAge / 3600000)}h) for '${m.id}'`);
                  state.available = false;
                  state.initialized = true;
                  throw new Error(`Ephemeral key signature expired for '${m.id}'`);
                }

                __DEV__ && console.log(`[Relay] ✅ P1-A6: '${m.id}' identity verified + ephemeral signed`);

                state.gateways.push({
                  id: m.id,
                  pubKey: pubKeyBytes,
                  sealedSenderKey: m.sealedSenderKey || null,
                });
              }
            }
            
            if (state.gateways.length > 0) {
              multiGatewaySuccess = true;
              state.gatewayPubKey = state.gateways[0].pubKey;
              // Stocker la clé sealed sender du premier gateway
              state.sealedSenderKeyB64 = state.gateways[0].sealedSenderKey || null;
              state.available = true;
              state.lastKeyRefresh = Date.now();
              __DEV__ && console.log(`[Relay] ✅ Multi-gateway: ${state.gateways.length} gateways loaded`);
              __DEV__ && console.log(`[Relay] ✅ Sealed sender key: ${state.sealedSenderKeyB64 ? 'present' : 'MISSING'}`);
              for (const gw of state.gateways) {
                __DEV__ && console.log(`  - ${gw.id}`);
              }
            }
          }
        }
      } catch (e) {
        // Le relay est OBLIGATOIRE. Pas de fallback direct vers le gateway.
        __DEV__ && console.error('[Relay] ❌ Gateway manifests fetch failed:', e);
      }
    }
    
    // PAS DE FALLBACK. Le relay CF doit être disponible.
    // Contacter le gateway directement exposerait l'IP du client.
    if (!multiGatewaySuccess) {
      throw new Error('Relay manifests unavailable — cannot contact gateway directly (IP protection)');
    }
  } catch (error) {
    state.available = false;
    __DEV__ && console.error('[Relay] ❌ Init failed:', error);
  }
  
  state.initialized = true;
  return state.available;
}

/**
 * ACTION 09: Select a random gateway for this request (CSPRNG).
 */
function getRandomGateway(): GatewayInfo {
  if (state.gateways.length === 0) {
    throw new Error('[Relay] No gateways available');
  }
  if (state.gateways.length === 1) {
    return state.gateways[0];
  }
  
  // CSPRNG selection (rejection sampling, no modulo bias)
  const index = secureRandomInt(state.gateways.length);
  return state.gateways[index];
}

// ============================================
// ENCRYPTION
// ============================================

/**
 * ACTION 09: Encrypt a request for a randomly selected gateway using ephemeral NaCl box.
 * Wire format: [16 bytes gateway ID][32 bytes ephemeral pubkey][24 bytes nonce][ciphertext]
 * The CF relay reads the gateway ID to route to the correct gateway.
 */
function encryptForGateway(plaintext: string): {
  encrypted: Uint8Array;
  ephemeralKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  selectedGateway: GatewayInfo;
} {
  // ACTION 09: Select random gateway
  const gateway = getRandomGateway();
  
  const ephemeralKeyPair = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const messageBytes = new TextEncoder().encode(plaintext);
  
  const ciphertext = nacl.box(
    messageBytes,
    nonce,
    gateway.pubKey,
    ephemeralKeyPair.secretKey
  );
  
  if (!ciphertext) {
    throw new Error('[Relay] NaCl box encryption failed');
  }
  
  // ACTION 09: Wire format includes gateway ID for routing
  // [gatewayId (16 bytes, UTF-8 padded)][ephemeral pubkey (32)][nonce (24)][ciphertext]
  const gwIdBytes = new TextEncoder().encode(gateway.id.padEnd(16).slice(0, 16));
  const packed = new Uint8Array(16 + 32 + 24 + ciphertext.length);
  packed.set(gwIdBytes, 0);
  packed.set(ephemeralKeyPair.publicKey, 16);
  packed.set(nonce, 48);
  packed.set(ciphertext, 72);
  
  return { encrypted: packed, ephemeralKeyPair, selectedGateway: gateway };
}

/**
 * Decrypt a response from the gateway.
 * Wire format: [24 bytes nonce][ciphertext]
 */
function decryptFromGateway(
  encryptedResponse: Uint8Array,
  ephemeralKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array },
  gateway: GatewayInfo
): string {
  if (encryptedResponse.length < 24 + 16) {
    throw new Error('[Relay] Response too small');
  }
  
  const nonce = encryptedResponse.slice(0, 24);
  const ciphertext = encryptedResponse.slice(24);
  
  const plaintext = nacl.box.open(
    ciphertext,
    nonce,
    gateway.pubKey,
    ephemeralKeyPair.secretKey
  );
  
  if (!plaintext) {
    throw new Error('[Relay] NaCl box decryption failed');
  }
  
  // Zero out ephemeral secret key (forward secrecy)
  ephemeralKeyPair.secretKey.fill(0);
  
  return new TextDecoder().decode(plaintext);
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Drop-in replacement for supabase.rpc().
 * Encrypts the RPC call, routes through CF Relay → Gateway → Supabase.
 * 
 * @param rpc - RPC function name (must be in ALLOWED_RPCS)
 * @param params - RPC parameters (same as supabase.rpc() params)
 * @returns The same shape as supabase.rpc() response
 */
export async function relayRpc(
  rpc: string,
  params: Record<string, unknown>
): Promise<{ data: unknown; error: { message: string } | null }> {
  if (!state.available || !state.gatewayPubKey) {
    return { data: null, error: { message: 'Relay not available' } };
  }
  
  if (!ALLOWED_RPCS.includes(rpc as AllowedRpc)) {
    return { data: null, error: { message: `RPC ${rpc} not whitelisted` } };
  }
  
  try {
    // Serialize the RPC request
    const requestPayload = JSON.stringify({ rpc, params });
    
    // Encrypt for gateway (ephemeral key per request → perfect forward secrecy)
    // ACTION 09: Gateway selected randomly per-request
    const { encrypted, ephemeralKeyPair, selectedGateway } = encryptForGateway(requestPayload);
    
    // Send through CF Relay (with timeout — PERF A8)
    const relayResponse = await fetchWithTimeout(CF_RELAY_URL + '/relay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: encrypted,
    }, RELAY_TIMEOUT_MS);
    
    if (!relayResponse.ok) {
      // Le gateway chiffre AUSSI les réponses d'erreur — on les déchiffre.
      const errorBuffer = await relayResponse.arrayBuffer();
      const errorBytes = new Uint8Array(errorBuffer);
      if (errorBytes.length >= 24 + 16) {
        const decryptedError = decryptFromGateway(errorBytes, ephemeralKeyPair, selectedGateway);
        const parsed = JSON.parse(decryptedError);
        const errorMsg = parsed.error || parsed.message || JSON.stringify(parsed);
        return { data: null, error: { message: `Gateway ${relayResponse.status}: ${errorMsg}` } };
      }
      // Body trop court pour être chiffré → erreur du relay CF lui-même (pas du gateway)
      return { data: null, error: { message: `Relay HTTP ${relayResponse.status}: response not decryptable` } };
    }
    
    // Decrypt gateway response
    const responseBuffer = await relayResponse.arrayBuffer();
    const responseBytes = new Uint8Array(responseBuffer);
    const decryptedResponse = decryptFromGateway(responseBytes, ephemeralKeyPair, selectedGateway);
    
    const parsed = JSON.parse(decryptedResponse);
    
    if (parsed.error) {
      return { data: null, error: { message: parsed.error } };
    }
    
    return { data: parsed.data, error: null };
    
  } catch (error) {
    return { data: null, error: { message: `Relay error: ${String(error)}` } };
  }
}

// ============================================
// STATUS
// ============================================

export function isRelayAvailable(): boolean {
  return state.available;
}

/**
 * Retourne la clé publique sealed sender obtenue via le relay.
 * Le client ne contacte JAMAIS le gateway directement.
 */
export function getSealedSenderKeyFromRelay(): string | null {
  return state.sealedSenderKeyB64;
}

export function getRelayStatus(): {
  initialized: boolean;
  available: boolean;
  hasPubKey: boolean;
  gatewayCount: number;
} {
  return {
    initialized: state.initialized,
    available: state.available,
    hasPubKey: state.gatewayPubKey !== null,
    gatewayCount: state.gateways.length,
  };
}

// ============================================
// SECURE RPC — RELAY ONLY (Audit Fix M-02)
// ============================================
// Audit Fix M-02: Le fallback silencieux vers Supabase direct a été SUPPRIMÉ.
// Un adversaire pouvait provoquer l'indisponibilité du relay (DoS ciblé) pour
// forcer le fallback, révélant l'IP de tous les clients au serveur Supabase.
// Désormais: si le relay est indisponible, les opérations sont BLOQUÉES
// et l'utilisateur est informé via l'erreur retournée.

/**
 * RPC sécurisé via OHTTP relay UNIQUEMENT.
 * 
 * Audit Fix M-02: PAS de fallback Supabase direct.
 * Si le relay est indisponible → erreur explicite.
 * L'utilisateur doit être informé que la connexion anonyme est impossible.
 * 
 * @param rpc - Nom de la fonction RPC Supabase
 * @param params - Paramètres RPC
 * @returns { data, error } — même format que supabase.rpc()
 */
export async function secureRpc(
  rpc: string,
  params: Record<string, unknown>
): Promise<{ data: any; error: { message: string } | null }> {
  // Lazy init du relay (une seule fois)
  if (!state.initialized) {
    await initRelay();
  }
  
  // Audit Fix M-02: Le relay DOIT être disponible. Pas de fallback.
  if (!state.available) {
    return {
      data: null,
      error: {
        message: 'RELAY_UNAVAILABLE: Le relay OHTTP est indisponible. ' +
          'Impossible d\'envoyer de manière anonyme. Vérifiez votre connexion.',
      },
    };
  }
  
  // Tentative OHTTP relay
  try {
    const result = await relayRpc(rpc, params);
    
    // Si le relay a réussi (même si Supabase a renvoyé une erreur métier)
    if (result.error === null || !result.error.message.startsWith('Relay')) {
      __DEV__ && console.log(`[SecureRpc] ✅ ${rpc} via OHTTP relay`);
      return result;
    }
    
    // Erreur relay → remonter l'erreur (PAS de fallback)
    __DEV__ && console.warn(`[SecureRpc] ❌ Relay error for ${rpc}: ${result.error.message}`);
    return {
      data: null,
      error: {
        message: `RELAY_ERROR: ${result.error.message}. ` +
          'Le message n\'a pas été envoyé pour protéger votre anonymat.',
      },
    };
  } catch (e) {
    __DEV__ && console.warn(`[SecureRpc] ❌ Relay exception for ${rpc}: ${e}`);
    return {
      data: null,
      error: {
        message: `RELAY_ERROR: ${String(e)}. ` +
          'Le message n\'a pas été envoyé pour protéger votre anonymat.',
      },
    };
  }
}