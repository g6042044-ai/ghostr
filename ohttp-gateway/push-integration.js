// ohttp-gateway/push-integration.js
// GHOSTR — Push Integration (Sender-Side Architecture)
//
// Le Gateway NE FAIT AUCUN LOOKUP. Il forward simplement le blob opaque
// reçu dans p_push_blob au Push Proxy. Le Push Proxy déchiffre:
//   - Succès → envoie le push FCM/APNs
//   - Échec (blob aléatoire d'un decoy) → ignoré silencieusement
//
// SÉCURITÉ: Le Gateway ne peut pas distinguer vrais messages et decoys.
// Tous les messages incluent un p_push_blob de taille identique.
//
// FIX: Jitter élargi de 200-2000ms → 1000-8000ms.
//      CSPRNG au lieu de Math.random pour le jitter.
//      Cover traffic : le Gateway envoie des blobs aléatoires à intervalle
//      régulier pour masquer les patterns d'activité réelle.

const crypto = require('crypto');

// ============================================
// CONFIGURATION
// ============================================

const PUSH_PROXY_URL = process.env.PUSH_PROXY_URL;
const PUSH_PROXY_SHARED_SECRET = process.env.PUSH_PROXY_SHARED_SECRET;

// Jitter anti-timing (ms) — FIX: élargi de [200,2000] → [1000,8000]
// Un adversaire observant Gateway→Proxy a besoin d'une fenêtre >8s
// pour tenter une corrélation temporelle.
const JITTER_MIN_MS = 1000;
const JITTER_MAX_MS = 8000;

// Cover traffic: intervalle entre les faux push blobs (ms)
// Envoie un blob aléatoire toutes les 30-90s pour masquer le trafic réel.
const COVER_TRAFFIC_MIN_MS = 30_000;
const COVER_TRAFFIC_MAX_MS = 90_000;

// ============================================
// STATE
// ============================================

let pushEnabled = false;
let coverTrafficTimer = null;

// ============================================
// CSPRNG JITTER
// ============================================

function secureJitter(minMs, maxMs) {
  const range = maxMs - minMs;
  if (range <= 0) return minMs;
  return minMs + crypto.randomInt(range);
}

// ============================================
// INIT
// ============================================

function initPushIntegration() {
  if (!PUSH_PROXY_URL || !PUSH_PROXY_SHARED_SECRET) {
    console.warn('⚠️ Push integration disabled: PUSH_PROXY_URL or PUSH_PROXY_SHARED_SECRET not set');
    return;
  }
  pushEnabled = true;
  console.log(`✅ Push integration enabled (proxy: ${PUSH_PROXY_URL})`);
  console.log(`   Jitter: ${JITTER_MIN_MS}-${JITTER_MAX_MS}ms, cover traffic: ${COVER_TRAFFIC_MIN_MS/1000}-${COVER_TRAFFIC_MAX_MS/1000}s`);

  scheduleCoverTraffic();
}

// ============================================
// COVER TRAFFIC
// ============================================

function scheduleCoverTraffic() {
  if (!pushEnabled) return;

  const delayMs = secureJitter(COVER_TRAFFIC_MIN_MS, COVER_TRAFFIC_MAX_MS);
  coverTrafficTimer = setTimeout(() => {
    const fakeBlob = crypto.randomBytes(328).toString('base64');
    sendBlobToProxy(fakeBlob);
    scheduleCoverTraffic();
  }, delayMs);
}

// ============================================
// FORWARD BLOB TO PUSH PROXY
// ============================================

async function sendBlobToProxy(pushBlob) {
  try {
    const sharedSecret = Buffer.from(PUSH_PROXY_SHARED_SECRET, 'hex');

    const body = JSON.stringify({
      encrypted_push_blob: pushBlob,
    });

    const timestamp = Date.now().toString();
    const auth = crypto
      .createHmac('sha256', sharedSecret)
      .update(`${timestamp}:${body}`)
      .digest('hex');

    const response = await fetch(`${PUSH_PROXY_URL}/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Push-Auth': auth,
        'X-Push-Timestamp': timestamp,
      },
      body,
    });

    if (!response.ok) {
      const errBody = await response.text();
      if (!errBody.includes('decryption')) {
        console.warn(`⚠️ Push proxy error: ${response.status}`);
      }
    }
  } catch (err) {
    // Best-effort, silencieux
  }
}

function triggerPushNotification(pushBlob) {
  if (!pushEnabled) return;

  const jitterMs = secureJitter(JITTER_MIN_MS, JITTER_MAX_MS);

  setTimeout(() => {
    sendBlobToProxy(pushBlob);
  }, jitterMs);
}

module.exports = {
  initPushIntegration,
  triggerPushNotification,
};
