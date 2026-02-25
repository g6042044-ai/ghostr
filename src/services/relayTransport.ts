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

// ============================================
// CONFIGURATION
// ============================================

// URLs configurées depuis les variables d'environnement (.env)
const CF_RELAY_URL = process.env.EXPO_PUBLIC_RELAY_URL;

// ACTION 09: Multi-gateway support
// Le client récupère les clés publiques de TOUS les gateways via le CF relay.
// Chaque requête est chiffrée pour un gateway choisi aléatoirement.
// PAS de GATEWAY_URL directe — le client ne contacte JAMAIS le gateway directement.
// Tout passe par le CF relay (IP protection).
const GATEWAY_MANIFESTS_URL = CF_RELAY_URL + '/gateway-manifests';

// Audit Fix L-01: Le fallback hardcodé a été SUPPRIMÉ.
// Si le endpoint /pubkey est injoignable, les opérations relay sont bloquées.

// Whitelisted RPCs (must match gateway whitelist)
const ALLOWED_RPCS = [
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
        const manifestResponse = await fetch(GATEWAY_MANIFESTS_URL, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });
        
        if (manifestResponse.ok) {
          const manifests = await manifestResponse.json();
          
          if (Array.isArray(manifests) && manifests.length > 0) {
            state.gateways = [];
            
            for (const m of manifests) {
              if (m.id && m.pubkey) {
                const pubKeyBytes = decodeBase64(m.pubkey);
                if (pubKeyBytes.length === 32) {
                  state.gateways.push({
                    id: m.id,
                    pubKey: pubKeyBytes,
                    sealedSenderKey: m.sealedSenderKey || null,
                  });
                }
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
    
    // Send through CF Relay
    const relayResponse = await fetch(CF_RELAY_URL + '/relay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: encrypted,
    });
    
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