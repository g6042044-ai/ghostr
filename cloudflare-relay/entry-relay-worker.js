// cloudflare-relay/entry-relay-worker.js
// Whisper Entry Relay - Premier hop du double-hop anonymisant
// Version 7.0 - SECURITY HARDENING:
//   - v7.0: Authentification HMAC-SHA256 (relayToken)
//   - v7.0: Rate limiting IP (30 connexions/minute/IP)
//   - v7.0: securityLog() désactivé en production (noop)
//   - v7.0: Constant-time HMAC comparison
//   - v6.0: FIX CRITIQUE https:// au lieu de wss:// pour fetch()
//
// ARCHITECTURE DOUBLE-HOP:
// [Client] ──► [Entry Relay (CF Worker)] ──► [Exit Relay (Fly)] ──► [SFU]
//
// SÉCURITÉ:
// - Le SFU ne voit JAMAIS l'IP du client
// - HMAC empêche les connexions non autorisées
// - Rate limiting protège contre DoS

const CONFIG = {
  DEBUG: false,
  VERSION: '7.0',
  CONNECTION_TIMEOUT_MS: 10000,
  // Rate limiting
  RATE_LIMIT_MAX: 30,       // max connexions par fenêtre
  RATE_LIMIT_WINDOW_MS: 60000, // fenêtre = 1 minute
  // HMAC
  HMAC_MAX_AGE_SECONDS: 300, // token valide 5 minutes
};

function log(...args) {
  if (CONFIG.DEBUG) {
    console.log('[Entry v7]', ...args);
  }
}

// securityLog est un NOOP en production pour minimiser les logs
function securityLog(event) {
  // Désactivé en production - ne rien logger
  // Décommenter pour debug temporaire:
  // console.log(`[Entry] ${event}`);
}

function toHttpsUrl(url) {
  if (url.startsWith('wss://')) return url.replace('wss://', 'https://');
  if (url.startsWith('ws://')) return url.replace('ws://', 'http://');
  return url;
}

// ============================================
// RATE LIMITING (Durable Object - partagé entre toutes les instances)
// ============================================

/**
 * Hash IP pour l'utiliser comme identifiant DO (ne pas stocker l'IP en clair)
 */
async function hashIP(ip) {
  const data = new TextEncoder().encode(ip + ':ghostr-rate-limit-salt');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Vérifie le rate limit via Durable Object (partagé globalement)
 * Fallback sur rate limiting in-memory si le DO n'est pas disponible
 */
async function checkRateLimitDO(clientIP, env) {
  if (!clientIP || clientIP === 'unknown') return true;
  
  try {
    if (env.RATE_LIMITER) {
      const ipHash = await hashIP(clientIP);
      const id = env.RATE_LIMITER.idFromName(ipHash);
      const stub = env.RATE_LIMITER.get(id);
      
      const response = await stub.fetch('https://rate-limiter/check', {
        method: 'POST',
        body: JSON.stringify({
          max: CONFIG.RATE_LIMIT_MAX,
          windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
        }),
      });
      
      const result = await response.json();
      return result.allowed;
    }
  } catch (error) {
    // Fallback silencieux si DO indisponible
  }
  
  // Fallback: rate limiting in-memory (par instance worker)
  return checkRateLimitLocal(clientIP);
}

// Fallback in-memory (même logique qu'avant)
const rateLimitMap = new Map();
let lastCleanup = 0;

function checkRateLimitLocal(clientIP) {
  const now = Date.now();
  
  if (now - lastCleanup > 5 * 60 * 1000) {
    lastCleanup = now;
    for (const [ip, entry] of rateLimitMap) {
      if ((now - entry.windowStart) > CONFIG.RATE_LIMIT_WINDOW_MS * 5) {
        rateLimitMap.delete(ip);
      }
    }
  }
  
  const entry = rateLimitMap.get(clientIP);
  
  if (!entry || (now - entry.windowStart) > CONFIG.RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(clientIP, { count: 1, windowStart: now });
    return true;
  }
  
  entry.count++;
  return entry.count <= CONFIG.RATE_LIMIT_MAX;
}

/**
 * Durable Object: Rate Limiter centralisé
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
// HMAC VERIFICATION (Web Crypto API)
// ============================================

async function verifyRelayToken(token, roomTag, peerId, secret, isBase64Key = false) {
  if (!secret || !token) return false;
  
  try {
    // Format: base64(hmac):timestamp
    const lastColon = token.lastIndexOf(':');
    if (lastColon === -1) return false;
    
    const hmacB64 = token.substring(0, lastColon);
    const timestampStr = token.substring(lastColon + 1);
    const timestamp = parseInt(timestampStr, 10);
    
    if (isNaN(timestamp)) return false;
    
    // Vérifier la fraîcheur (5 minutes max)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > CONFIG.HMAC_MAX_AGE_SECONDS) {
      return false;
    }
    
    // Recalculer le HMAC attendu
    // v2: préfixe "ghostr-relay-v2:" pour distinguer du v1
    const message = isBase64Key
      ? `ghostr-relay-v2:${roomTag}:${peerId}:${timestamp}`
      : `${roomTag}:${peerId}:${timestamp}`;
    const encoder = new TextEncoder();
    
    // Clé: base64-decoded (authToken) ou UTF-8 (legacy RELAY_AUTH_SECRET)
    const keyBytes = isBase64Key
      ? Uint8Array.from(atob(secret), c => c.charCodeAt(0))
      : encoder.encode(secret);
    
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const expectedHmac = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(message)
    );
    
    // Convertir le HMAC reçu de base64
    const receivedBytes = Uint8Array.from(atob(hmacB64), c => c.charCodeAt(0));
    const expectedBytes = new Uint8Array(expectedHmac);
    
    // Comparaison en temps constant
    if (receivedBytes.length !== expectedBytes.length) return false;
    let diff = 0;
    for (let i = 0; i < receivedBytes.length; i++) {
      diff |= receivedBytes[i] ^ expectedBytes[i];
    }
    return diff === 0;
    
  } catch (error) {
    log('HMAC verification error:', error.message);
    return false;
  }
}

// ============================================
// MAIN WORKER
// ============================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    log('Request:', request.method, url.pathname);

    const EXIT_RELAYS = {
      'eu-west': env.EXIT_RELAY_EU_WEST || env.DEFAULT_EXIT_RELAY,
      'eu-central': env.EXIT_RELAY_EU_CENTRAL || env.DEFAULT_EXIT_RELAY,
      'us-east': env.EXIT_RELAY_US_EAST || env.DEFAULT_EXIT_RELAY,
      'us-west': env.EXIT_RELAY_US_WEST || env.DEFAULT_EXIT_RELAY,
      'asia': env.EXIT_RELAY_ASIA || env.DEFAULT_EXIT_RELAY,
    };

    const DEFAULT_EXIT = env.DEFAULT_EXIT_RELAY || 'https://whisper-exit-relay.fly.dev';

    const securityHeaders = {
      'Access-Control-Allow-Origin': 'capacitor://localhost',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol, Sec-WebSocket-Extensions',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...securityHeaders, 'Access-Control-Max-Age': '86400' },
      });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        type: 'entry-relay',
        version: CONFIG.VERSION,
        timestamp: Date.now(),
        regions: Object.keys(EXIT_RELAYS),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...securityHeaders },
      });
    }

    if (url.pathname === '/regions') {
      return new Response(JSON.stringify({
        regions: Object.keys(EXIT_RELAYS),
        default: 'eu-west',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...securityHeaders },
      });
    }

    // Route WebSocket: /relay/:region/room/:roomTag
    const relayMatch = url.pathname.match(/^\/relay\/([a-z-]+)\/room\/([a-f0-9]{32})$/);

    if (relayMatch) {
      const region = relayMatch[1];
      const roomTag = relayMatch[2];
      
      // Rate limiting par IP
      const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
      if (!(await checkRateLimitDO(clientIP, env))) {
        return new Response(JSON.stringify({
          error: 'Rate limit exceeded',
          code: 'RATE_LIMITED',
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', ...securityHeaders, 'Retry-After': '60' },
        });
      }

      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response(JSON.stringify({ error: 'WebSocket upgrade required', code: 'UPGRADE_REQUIRED' }), {
          status: 426,
          headers: { 'Content-Type': 'application/json', ...securityHeaders },
        });
      }

      const peerId = url.searchParams.get('peerId');
      const authToken = url.searchParams.get('authToken');
      const relayToken = url.searchParams.get('relayToken');

      if (!peerId) {
        return new Response(JSON.stringify({ error: 'Missing peerId', code: 'MISSING_PEER_ID' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...securityHeaders },
        });
      }

      if (!/^[a-z0-9_-]{16,64}$/i.test(peerId)) {
        return new Response(JSON.stringify({ error: 'Invalid peerId format', code: 'INVALID_PEER_ID' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...securityHeaders },
        });
      }

      // Authentification relay: authToken-derived (v2) ou legacy RELAY_AUTH_SECRET (v1)
      if (relayToken) {
        // Essayer d'abord avec authToken (v2: pas de secret statique dans le client)
        let isValid = false;
        if (authToken) {
          isValid = await verifyRelayToken(relayToken, roomTag, peerId, authToken, true);
        }
        // Fallback: legacy RELAY_AUTH_SECRET (migration progressive)
        if (!isValid && env.RELAY_AUTH_SECRET) {
          isValid = await verifyRelayToken(relayToken, roomTag, peerId, env.RELAY_AUTH_SECRET, false);
        }
        if (!isValid) {
          return new Response(JSON.stringify({ error: 'Invalid relay token', code: 'RELAY_AUTH_FAILED' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...securityHeaders },
          });
        }
      } else if (env.RELAY_AUTH_SECRET) {
        // Legacy: relayToken obligatoire si RELAY_AUTH_SECRET configuré
        return new Response(JSON.stringify({ error: 'Relay authentication required', code: 'RELAY_AUTH_REQUIRED' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...securityHeaders },
        });
      } else if (!authToken) {
        // Ni relayToken ni authToken: refuser
        return new Response(JSON.stringify({ error: 'Authentication required', code: 'AUTH_REQUIRED' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...securityHeaders },
        });
      }

      // Proxy vers Exit Relay
      const exitRelayBase = EXIT_RELAYS[region] || DEFAULT_EXIT;
      let exitUrl = toHttpsUrl(exitRelayBase);
      exitUrl = `${exitUrl}/room/${roomTag}?peerId=${encodeURIComponent(peerId)}`;
      if (authToken) {
        exitUrl += `&authToken=${encodeURIComponent(authToken)}`;
      }

      try {
        const proxyRequest = new Request(exitUrl, {
          method: 'GET',
          headers: {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Key': request.headers.get('Sec-WebSocket-Key') || crypto.randomUUID(),
            'Sec-WebSocket-Version': request.headers.get('Sec-WebSocket-Version') || '13',
          },
        });

        const wsProtocol = request.headers.get('Sec-WebSocket-Protocol');
        if (wsProtocol) proxyRequest.headers.set('Sec-WebSocket-Protocol', wsProtocol);

        const wsExtensions = request.headers.get('Sec-WebSocket-Extensions');
        if (wsExtensions) proxyRequest.headers.set('Sec-WebSocket-Extensions', wsExtensions);

        const exitResponse = await fetch(proxyRequest);

        if (exitResponse.status === 101) {
          return exitResponse;
        } else {
          return new Response(JSON.stringify({ error: 'Exit relay connection failed', code: 'EXIT_RELAY_ERROR', status: exitResponse.status }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...securityHeaders },
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Exit relay unreachable', code: 'EXIT_RELAY_UNREACHABLE' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...securityHeaders },
        });
      }
    }

    // PRODUCTION FIX (Mod-06): /direct/room/ SUPPRIMÉ
    // Cette route contournait le double-hop et exposait l'IP du client au SFU.
    const directMatch = url.pathname.match(/^\/direct\/room\/([a-f0-9]{32})$/);
    if (directMatch) {
      return new Response(JSON.stringify({
        error: 'Direct SFU access disabled. Use /relay/:region/room/:tag for anonymized routing.',
        code: 'DIRECT_ACCESS_DISABLED',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...securityHeaders },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...securityHeaders },
    });
  },
};