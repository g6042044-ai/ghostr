// cloudflare-relay/worker.js
// Ghostr Anonymous Relay - Cloudflare Worker
// Version 3.0 — P0-A7: Rate limiting IP via Durable Object
//
// DEUX MODES:
//   /relay  → OHTTP split-trust (forward blobs opaques vers le gateway)
//   /gateway-manifests → fetch les clés publiques des gateways
//
// Le worker voit l'IP du client mais PAS le contenu des requêtes /relay
// (car elles sont chiffrées pour le gateway avec NaCl box)
//
// P0-A7 (NEW): Rate limiting par IP via Durable Object.
// Sans cela, un attaquant pouvait DDoS Cloud Run en envoyant 100K req/s de
// blobs invalides — chaque tentative coûte un nacl.box.open() côté gateway.
// 100K req/s × 0.1ms = 10s CPU/s → satura un core en permanence.

// R-15: Origines autorisées.
const ALLOWED_ORIGINS = [
  'capacitor://localhost',       // iOS Capacitor / Expo
  'http://localhost',            // Dev local
  'http://localhost:19006',      // Expo web dev
  'http://localhost:8081',       // Metro bundler
];

// P0-A7: Rate limit config
// 120 req/min/IP couvre largement un user normal :
//   - 1 send/30s = 2/min (constant traffic slot)
//   - 1 poll/5s = 12/min
//   - Endpoints retry, certificate refresh, manifest reload : ~10/min
//   - Total ~25-30 req/min en usage soutenu
// 120/min laisse 4× de marge mais coupe à >2 req/s sustained = spam évident.
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

function getAllowedOrigin(requestOrigin) {
  if (!requestOrigin) return null;
  if (ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  return null;
}

function corsHeaders(requestOrigin) {
  const origin = getAllowedOrigin(requestOrigin) || ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-upsert, Range',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// ============================================
// P0-A7: HASH IP (ne pas stocker l'IP en clair dans le DO)
// ============================================
async function hashIP(ip) {
  const data = new TextEncoder().encode(ip + ':ghostr-relay-rate-limit');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * P0-A7: Vérifie le rate limit via Durable Object (compteur atomique partagé
 * entre toutes les instances Workers du même hash d'IP).
 *
 * Fallback silencieux : si le DO est indisponible, on autorise (mode défensif
 * inverse pour ne pas casser le service ; en cas de fail, on perd la protection
 * mais le service continue. Le gateway a son propre rate limit gateway-level
 * en defense-in-depth — cf P1-B3).
 */
async function checkRateLimitDO(clientIP, env) {
  if (!clientIP || clientIP === 'unknown') return true;
  if (!env.RATE_LIMITER) return true; // Pas configuré = bypass

  try {
    const ipHash = await hashIP(clientIP);
    const id = env.RATE_LIMITER.idFromName(ipHash);
    const stub = env.RATE_LIMITER.get(id);

    const response = await stub.fetch('https://rate-limiter/check', {
      method: 'POST',
      body: JSON.stringify({
        max: RATE_LIMIT_MAX,
        windowMs: RATE_LIMIT_WINDOW_MS,
      }),
    });

    if (!response.ok) return true; // Fail open
    const result = await response.json();
    return result.allowed;
  } catch {
    return true; // Fail open en cas d'erreur DO
  }
}

/**
 * P0-A7: Durable Object Rate Limiter.
 * Un DO par hash d'IP, maintient un compteur atomique par fenêtre de temps.
 */
export class RateLimiter {
  constructor(state, env) {
    this.state = state;
    this.count = 0;
    this.windowStart = 0;
  }

  async fetch(request) {
    const { max, windowMs } = await request.json();
    const now = Date.now();

    // Nouvelle fenêtre ?
    if (now - this.windowStart > windowMs) {
      this.count = 0;
      this.windowStart = now;
    }

    this.count++;
    const allowed = this.count <= max;

    return new Response(JSON.stringify({ allowed, count: this.count }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================
// MAIN WORKER
// ============================================

export default {
  async fetch(request, env, ctx) {
    const SUPABASE_URL = env.SUPABASE_URL;
    const requestOrigin = request.headers.get('Origin') || '';
    
    // ACTION 09: Multi-gateway support
    // Primary gateway (required)
    const GATEWAY_URL = env.GATEWAY_URL;
    // Additional gateways (optional — add for multi-gateway resilience)
    const GATEWAY_2_URL = env.GATEWAY_2_URL || null;
    const GATEWAY_3_URL = env.GATEWAY_3_URL || null;
    
    // Build gateway routing table
    const GATEWAYS = {};
    if (GATEWAY_URL) GATEWAYS[env.GATEWAY_1_ID || 'gw-primary'] = GATEWAY_URL;
    if (GATEWAY_2_URL) GATEWAYS[env.GATEWAY_2_ID || 'gw-secondary'] = GATEWAY_2_URL;
    if (GATEWAY_3_URL) GATEWAYS[env.GATEWAY_3_ID || 'gw-tertiary'] = GATEWAY_3_URL;
    const gatewayIds = Object.keys(GATEWAYS);

    // R-15: CORS preflight — restreint aux origines autorisées
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(requestOrigin),
      });
    }

    const url = new URL(request.url);
    const ch = corsHeaders(requestOrigin);

    // P0-A7: Rate limiting IP avant tout traitement.
    // Appliqué sur /relay et /gateway-manifests uniformément.
    // Health checks Cloudflare ne sont pas affectés (pas de path de santé ici).
    const clientIP = request.headers.get('CF-Connecting-IP')
      || request.headers.get('X-Forwarded-For')
      || 'unknown';

    if (!(await checkRateLimitDO(clientIP, env))) {
      return new Response(JSON.stringify({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          ...ch,
        }
      });
    }

    // ================================================================
    // ACTION 09 + P1-A6: Gateway manifests endpoint
    // Fetches /manifest from each gateway (includes identity key + ephemeral signature)
    // ================================================================
    if (url.pathname === '/gateway-manifests' && request.method === 'GET') {
      if (gatewayIds.length === 0) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...ch }
        });
      }
      
      // P1-A6: Fetch le manifest complet de chaque gateway (inclut identityPubkey + signature)
      const manifests = await Promise.all(
        gatewayIds.map(async (gwId) => {
          try {
            const gwUrl = GATEWAYS[gwId];
            const manifestResp = await fetch(gwUrl + '/manifest', {
              method: 'GET',
              headers: { 'Accept': 'application/json' },
            });
            if (manifestResp.ok) {
              const manifest = await manifestResp.json();
              // Retransmettre le manifest complet au client
              // Le client vérifie l'identité + la signature lui-même
              return {
                id: manifest.id || gwId,
                pubkey: manifest.pubkey,
                sealedSenderKey: manifest.sealedSenderPubkey || null,
                // P1-B1: Pendant la fenêtre overlap (7j post-rotation), expose la clé previous
                // pour permettre aux clients en transition de continuer à fonctionner.
                sealedSenderPreviousKey: manifest.sealedSenderPreviousPubkey || null,
                // P1-A6: Clé d'identité et signature éphémère
                identityPubkey: manifest.identityPubkey || null,
                ephemeralSignature: manifest.ephemeralSignature || null,
                ephemeralSignatureTimestamp: manifest.ephemeralSignatureTimestamp || null,
              };
            }
          } catch (e) {
            // Gateway unreachable — skip
          }
          return null;
        })
      );
      
      const validManifests = manifests.filter(m => m !== null);
      
      return new Response(JSON.stringify(validManifests), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...ch }
      });
    }

    // ================================================================
    // MODE 1: OHTTP Split-Trust Relay (/relay)
    // ACTION 09: Multi-gateway routing by gateway ID in payload
    // ================================================================
    if (url.pathname === '/relay' && request.method === 'POST') {
      if (gatewayIds.length === 0) {
        return new Response(JSON.stringify({ error: 'No gateways configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...ch }
        });
      }

      // Lire le blob opaque (chiffré pour le gateway, on ne peut pas le lire)
      const encryptedBody = await request.arrayBuffer();

      if (encryptedBody.byteLength < 72) { // 16 gwId + 32 pubkey + 24 nonce minimum
        return new Response(JSON.stringify({ error: 'Payload too small' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...ch }
        });
      }

      if (encryptedBody.byteLength > 22 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Payload too large (max 22MB)' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json', ...ch }
        });
      }

      // ACTION 09: Read gateway ID from first 16 bytes
      const gwIdBytes = new Uint8Array(encryptedBody, 0, 16);
      const gwId = new TextDecoder().decode(gwIdBytes).trim();
      
      // Select target gateway
      let targetGatewayUrl;
      if (GATEWAYS[gwId]) {
        // Known gateway ID — route to it
        targetGatewayUrl = GATEWAYS[gwId];
      } else if (gatewayIds.length === 1) {
        // Legacy client (no gateway ID in payload) — use single gateway
        // In this case, forward the FULL payload including the first 16 bytes
        targetGatewayUrl = GATEWAYS[gatewayIds[0]];
        
        // Forward the full blob (legacy format without gateway ID prefix)
        const gatewayResponse = await fetch(targetGatewayUrl + '/relay', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': encryptedBody.byteLength.toString(),
          },
          body: encryptedBody,
        });
        
        const responseBody = await gatewayResponse.arrayBuffer();
        return new Response(responseBody, {
          status: gatewayResponse.status,
          headers: {
            'Content-Type': 'application/octet-stream',
            ...ch,
          }
        });
      } else {
        return new Response(JSON.stringify({ error: 'Unknown gateway ID: ' + gwId }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...ch }
        });
      }
      
      // ACTION 09: Strip the gateway ID (16 bytes) and forward the rest
      const payload = encryptedBody.slice(16);

      // Forwarding opaque vers le gateway — PAS de headers client transférés
      const gatewayResponse = await fetch(targetGatewayUrl + '/relay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': payload.byteLength.toString(),
          // Aucun header du client n'est transmis
        },
        body: payload,
      });

      // Retransmettre la réponse du gateway (aussi chiffrée)
      const responseBody = await gatewayResponse.arrayBuffer();

      return new Response(responseBody, {
        status: gatewayResponse.status,
        headers: {
          'Content-Type': 'application/octet-stream',
          ...ch,
        }
      });
    }

    // ================================================================
    // P0-A2: ALL OTHER ROUTES BLOCKED
    // ================================================================
    // Le proxy /storage/* legacy a été SUPPRIMÉ. Toutes les opérations
    // (messages, médias, blobs) DOIVENT passer par le relay OHTTP (/relay)
    // pour protéger l'IP du client. Aucun accès direct à Supabase.
    return new Response(JSON.stringify({ 
      error: 'Only /relay and /gateway-manifests are allowed. All storage operations must use OHTTP relay.' 
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...ch }
    });
  },
};
