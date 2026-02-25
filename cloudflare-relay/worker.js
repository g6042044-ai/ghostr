// cloudflare-relay/worker.js
// Ghostr Anonymous Relay - Cloudflare Worker
// Version 2.0 — Split-Trust OHTTP support
//
// DEUX MODES:
//   /relay  → OHTTP split-trust (forward blobs opaques vers le gateway)
//   /*      → Legacy relay (forward vers Supabase avec IP strippée)
//
// Le worker voit l'IP du client mais PAS le contenu des requêtes /relay
// (car elles sont chiffrées pour le gateway avec NaCl box)

export default {
  async fetch(request, env, ctx) {
    const SUPABASE_URL = env.SUPABASE_URL;
    
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

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    const url = new URL(request.url);

    // ================================================================
    // ACTION 09: Gateway manifests endpoint (for multi-gateway client)
    // ================================================================
    if (url.pathname === '/gateway-manifests' && request.method === 'GET') {
      if (gatewayIds.length === 0) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      
      // Fetch pubkeys AND sealed sender keys from all gateways in parallel
      const manifests = await Promise.all(
        gatewayIds.map(async (gwId) => {
          try {
            const gwUrl = GATEWAYS[gwId];
            // Fetch both keys in parallel
            const [pubkeyResp, ssKeyResp] = await Promise.all([
              fetch(gwUrl + '/pubkey', { method: 'GET', headers: { 'Accept': 'text/plain' } }),
              fetch(gwUrl + '/sealed-sender-key', { method: 'GET', headers: { 'Accept': 'text/plain' } }),
            ]);
            if (pubkeyResp.ok) {
              const pubkey = (await pubkeyResp.text()).trim();
              const sealedSenderKey = ssKeyResp.ok ? (await ssKeyResp.text()).trim() : null;
              return { id: gwId, pubkey, sealedSenderKey };
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
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
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
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Lire le blob opaque (chiffré pour le gateway, on ne peut pas le lire)
      const encryptedBody = await request.arrayBuffer();

      if (encryptedBody.byteLength < 72) { // 16 gwId + 32 pubkey + 24 nonce minimum
        return new Response(JSON.stringify({ error: 'Payload too small' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      if (encryptedBody.byteLength > 22 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Payload too large (max 22MB)' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
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
            'Access-Control-Allow-Origin': '*',
          }
        });
      } else {
        return new Response(JSON.stringify({ error: 'Unknown gateway ID: ' + gwId }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
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
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // ================================================================
    // MODE 2: Supabase Storage Proxy (P14 fix: RPC routes blocked)
    // ================================================================
    // Only Storage routes (/storage/v1/*) are allowed through the legacy proxy.
    // RPC calls MUST go through the OHTTP relay (/relay endpoint) to prevent
    // Authorization header leakage and identity correlation.
    
    if (!url.pathname.startsWith('/storage/')) {
      return new Response(JSON.stringify({ error: 'Only /storage/* routes allowed. RPCs must use OHTTP relay.' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (!SUPABASE_URL) {
      return new Response(JSON.stringify({ error: 'SUPABASE_URL not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const targetUrl = new URL(url.pathname + url.search, SUPABASE_URL);

      // ACTION 05: Strict header whitelist — prevent device fingerprinting.
      // Only forward headers strictly necessary for Supabase Storage API calls.
      // NEVER forward User-Agent, Accept-Language, Referer, etc.
      const headers = new Headers();
      const contentType = request.headers.get('Content-Type');
      if (contentType) headers.set('Content-Type', contentType);
      const authorization = request.headers.get('Authorization');
      if (authorization) headers.set('Authorization', authorization);
      const apikey = request.headers.get('apikey');
      if (apikey) headers.set('apikey', apikey);
      const contentLength = request.headers.get('Content-Length');
      if (contentLength) headers.set('Content-Length', contentLength);
      const accept = request.headers.get('Accept');
      if (accept) headers.set('Accept', accept);
      // Supabase Storage needs these for uploads/downloads
      const xUpsert = request.headers.get('x-upsert');
      if (xUpsert) headers.set('x-upsert', xUpsert);
      const range = request.headers.get('Range');
      if (range) headers.set('Range', range);
      headers.set('X-Whisper-Relay', 'cloudflare-v2');

      const response = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: 'follow',
      });

      const modifiedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });

      modifiedResponse.headers.set('Access-Control-Allow-Origin', '*');
      modifiedResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      modifiedResponse.headers.set('Access-Control-Allow-Headers', '*');

      return modifiedResponse;
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Relay error', message: error.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  },
};