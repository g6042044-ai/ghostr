// cloudflare-relay/worker.js
// Ghostr Anonymous Relay - Cloudflare Worker
// Version 2.1 — R-15: CORS restreint aux origines autorisées
//
// DEUX MODES:
//   /relay  → OHTTP split-trust (forward blobs opaques vers le gateway)
//   /*      → Legacy relay (forward vers Supabase avec IP strippée)
//
// Le worker voit l'IP du client mais PAS le contenu des requêtes /relay
// (car elles sont chiffrées pour le gateway avec NaCl box)

// R-15: Origines autorisées.
// En React Native le CORS n'est pas appliqué (il n'y a pas de navigateur),
// mais des clients web pourraient appeler ce Worker. On restreint donc
// à des origines explicitement reconnues pour éviter la corrélation
// temporelle OPTIONS→POST observable sur un réseau local.
const ALLOWED_ORIGINS = [
  'capacitor://localhost',       // iOS Capacitor / Expo
  'http://localhost',            // Dev local
  'http://localhost:19006',      // Expo web dev
  'http://localhost:8081',       // Metro bundler
];

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