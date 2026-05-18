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
// VERSION 2.0 — P0-A4 + P1-B5:
//   - P0-A4: jitter différencié (urgent calls 200-1500ms vs messages 1000-8000ms)
//   - P1-B5: cover traffic intelligent (rate normal en activité, ralenti en idle)

const crypto = require('crypto');

// ============================================
// CONFIGURATION
// ============================================

const PUSH_PROXY_URL = process.env.PUSH_PROXY_URL;
const PUSH_PROXY_SHARED_SECRET = process.env.PUSH_PROXY_SHARED_SECRET;

// P0-A4: Jitter différencié.
//
// MESSAGES NORMAUX (1000-8000ms):
//   Un adversaire observant Gateway→Proxy a besoin d'une fenêtre >8s
//   pour tenter une corrélation temporelle.
//
// SIGNAUX URGENTS — APPELS (200-1500ms):
//   Pour un call signal (offer, hangup, decline, busy), 8s de jitter
//   rend l'UX d'appel inacceptable. 200-1500ms est encore largement assez
//   pour briser la corrélation directe (un adversaire ne peut pas mapper
//   "send T0" → "push T0+50ms"), tout en gardant la latence d'appel sous 2s.
//
// TRADE-OFF: Le push proxy peut maintenant inférer "ceci est un signal d'appel"
// par la fenêtre de jitter observée. Mais le push proxy DÉCHIFFRE déjà le blob
// et voit `is_call`/`is_call_cancel`/`is_missed_call` flags → il sait déjà.
// Donc aucune fuite supplémentaire vers le push proxy. Côté observateur réseau
// entre gateway et proxy, la distinction est binaire (urgent oui/non) et déjà
// inférable par les patterns temporels d'appel (rafale offer→answer→hangup).
const JITTER_NORMAL_MIN_MS = 1000;
const JITTER_NORMAL_MAX_MS = 8000;
const JITTER_URGENT_MIN_MS = 200;
const JITTER_URGENT_MAX_MS = 1500;

// Cover traffic: intervalles entre les faux push blobs (ms).
//
// P1-B5: Rate adaptatif basé sur l'activité réelle récente.
//
//   ACTIVE (activité réelle <5min)  → 30-90s : masque le trafic réel
//   IDLE  (silence >5min)            → 5-15min : rythme minimal pour
//      éviter de signaler "le gateway est inactif" aux observateurs
//      sans payer le coût d'un trafic permanent.
//
// RATIONALE: À 3h du matin avec 0 user actif, un faux blob isolé ne masque
// rien (rien à masquer) et signale juste "le gateway est up". Le rate
// adaptatif réduit ce signaling tout en maintenant un baseline minimal.
const COVER_TRAFFIC_ACTIVE_MIN_MS = 30_000;
const COVER_TRAFFIC_ACTIVE_MAX_MS = 90_000;
const COVER_TRAFFIC_IDLE_MIN_MS = 5 * 60_000;
const COVER_TRAFFIC_IDLE_MAX_MS = 15 * 60_000;
const ACTIVITY_IDLE_THRESHOLD_MS = 5 * 60_000; // 5 min sans activité = "idle"

// ============================================
// STATE
// ============================================

let pushEnabled = false;
let coverTrafficTimer = null;

// P1-B5: Tracking activité réelle (incrémenté par recordRealActivity)
let lastRealActivityAt = 0;
let totalRealActivities = 0;

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
  console.log(`   Jitter normal: ${JITTER_NORMAL_MIN_MS}-${JITTER_NORMAL_MAX_MS}ms`);
  console.log(`   Jitter urgent: ${JITTER_URGENT_MIN_MS}-${JITTER_URGENT_MAX_MS}ms`);
  console.log(`   Cover traffic active: ${COVER_TRAFFIC_ACTIVE_MIN_MS / 1000}-${COVER_TRAFFIC_ACTIVE_MAX_MS / 1000}s`);
  console.log(`   Cover traffic idle:   ${COVER_TRAFFIC_IDLE_MIN_MS / 60000}-${COVER_TRAFFIC_IDLE_MAX_MS / 60000}min`);

  scheduleCoverTraffic();
}

// ============================================
// P1-B5: ACTIVITY TRACKING (cover traffic intelligence)
// ============================================

/**
 * Appelé par server.js quand un vrai message est forwardé au push proxy.
 * Permet au cover traffic de basculer entre rythme actif (30-90s) et idle (5-15min).
 */
function recordRealActivity() {
  lastRealActivityAt = Date.now();
  totalRealActivities++;
}

function isCurrentlyIdle() {
  return Date.now() - lastRealActivityAt > ACTIVITY_IDLE_THRESHOLD_MS;
}

// ============================================
// COVER TRAFFIC (rate adaptatif)
// ============================================

function scheduleCoverTraffic() {
  if (!pushEnabled) return;

  const idle = isCurrentlyIdle();
  const [minMs, maxMs] = idle
    ? [COVER_TRAFFIC_IDLE_MIN_MS, COVER_TRAFFIC_IDLE_MAX_MS]
    : [COVER_TRAFFIC_ACTIVE_MIN_MS, COVER_TRAFFIC_ACTIVE_MAX_MS];

  const delayMs = secureJitter(minMs, maxMs);
  coverTrafficTimer = setTimeout(() => {
    // Génère un blob aléatoire de taille identique aux vrais push blobs (328 bytes b64).
    // Le push proxy va tenter de le déchiffrer, échouer, et retourner un succès factice.
    // Un observateur entre gateway et proxy ne peut pas distinguer cover et vrai trafic.
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
    // Best-effort, silencieux (un observateur ne doit pas distinguer succès/échec)
  }
}

/**
 * Déclenche un push pour un blob réel (envoi de message ou signal d'appel).
 *
 * @param {string} pushBlob - Le blob opaque chiffré pour le push proxy
 * @param {boolean} urgent - true pour les call signals (jitter court 200-1500ms)
 *                           false pour les messages normaux (jitter standard 1-8s)
 */
function triggerPushNotification(pushBlob, urgent = false) {
  if (!pushEnabled) return;

  const [minMs, maxMs] = urgent
    ? [JITTER_URGENT_MIN_MS, JITTER_URGENT_MAX_MS]
    : [JITTER_NORMAL_MIN_MS, JITTER_NORMAL_MAX_MS];

  const jitterMs = secureJitter(minMs, maxMs);

  setTimeout(() => {
    sendBlobToProxy(pushBlob);
  }, jitterMs);
}

module.exports = {
  initPushIntegration,
  triggerPushNotification,
  recordRealActivity,    // P1-B5: exposé pour server.js
};
