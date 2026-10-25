// push-proxy/server.js
// GHOSTR — Push Notification Proxy (Split-Trust)
// v3.0 — Unified generic texts + client routing flags
//
// Ce serveur est ISOLÉ du Gateway OHTTP et du Cloudflare Relay.
// Il reçoit des blobs chiffrés du Gateway, les déchiffre pour obtenir
// le push token natif, envoie un ping vide via FCM/APNs, puis EFFACE
// immédiatement le token de la mémoire.
//
// CE SERVEUR NE VOIT JAMAIS:
//   - L'IP du client (protégée par CF Relay)
//   - Le contenu des messages (chiffré E2E Triple Ratchet)
//   - Les tags de routage (le Gateway ne les transmet pas)
//   - L'identité de l'expéditeur (Sealed Sender)
//
// CE SERVEUR VOIT TEMPORAIREMENT:
//   - Le push token natif FCM/APNs (en mémoire, effacé après envoi)
//   - La plateforme (fcm/apns) pour router le ping
//
// DÉPLOIEMENT: VPS séparé du Gateway, juridiction privacy-friendly.
// ACCÈS: Uniquement depuis le Gateway via mTLS ou IP whitelist + secret.
//
// AUCUN LOG de push tokens. Les logs ne contiennent que des métriques
// anonymisées (compteurs succès/échec, sans identifiants).
//
// v3.0 CHANGEMENTS:
//   - APNs appels: texte harmonisé "Quelqu'un essaie de vous joindre"
//   - APNs appels: ajout t:'c' hors aps pour routage client
//   - APNs appels manqués: ajout t:'missed' hors aps
//   - FCM inchangé (data-only pour appels, notification pour messages)
//   - Sécurité: aucun nom d'appelant dans aucun payload

const http = require('http');
const https = require('https');
const http2 = require('http2');
const nacl = require('tweetnacl');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');

// ============================================
// CONFIGURATION
// ============================================

const PORT = parseInt(process.env.PORT || '3200', 10);

const PROXY_SECRET_KEY = process.env.PUSH_PROXY_SECRET_KEY;
const PROXY_PUBLIC_KEY = process.env.PUSH_PROXY_PUBLIC_KEY;
const GATEWAY_SHARED_SECRET = process.env.GATEWAY_SHARED_SECRET;

// --- FCM (Android) ---
const FCM_SERVICE_ACCOUNT_PATH = process.env.FCM_SERVICE_ACCOUNT_PATH || './fcm-service-account.json';
const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID;

// --- APNs (iOS) ---
const APNS_KEY_PATH = process.env.APNS_KEY_PATH || './apns-key.p8';
const APNS_KEY_ID = process.env.APNS_KEY_ID;
const APNS_TEAM_ID = process.env.APNS_TEAM_ID;
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.ghostr.app';
const APNS_PRODUCTION = process.env.APNS_PRODUCTION === 'true';

// Tâche 0.5 : aucune donnée de trafic dans les logs (jetons d'appareil compris,
// même tronqués : un préfixe de jeton APNs identifie l'appareil chez Apple).
// PUSH_PROXY_VERBOSE_LOGS=true réactive les logs de diagnostic par envoi.
const PUSH_PROXY_VERBOSE_LOGS = process.env.PUSH_PROXY_VERBOSE_LOGS === 'true';
function diag(...args) {
  if (PUSH_PROXY_VERBOSE_LOGS) console.log(...args);
}

// ============================================
// VALIDATION
// ============================================

if (!PROXY_SECRET_KEY || !PROXY_PUBLIC_KEY) {
  console.error('FATAL: PUSH_PROXY_SECRET_KEY and PUSH_PROXY_PUBLIC_KEY are required');
  process.exit(1);
}
if (!GATEWAY_SHARED_SECRET) {
  console.error('FATAL: GATEWAY_SHARED_SECRET is required');
  process.exit(1);
}

const proxyKeyPair = {
  publicKey: Buffer.from(PROXY_PUBLIC_KEY, 'base64'),
  secretKey: Buffer.from(PROXY_SECRET_KEY, 'base64'),
};

const gatewaySecret = Buffer.from(GATEWAY_SHARED_SECRET, 'hex');

// ============================================
// FCM v1 — OAuth 2.0 Access Token
// ============================================

let fcmAccessToken = null;
let fcmTokenExpiry = 0;
let fcmServiceAccount = null;

try {
  if (fs.existsSync(FCM_SERVICE_ACCOUNT_PATH)) {
    fcmServiceAccount = JSON.parse(fs.readFileSync(FCM_SERVICE_ACCOUNT_PATH, 'utf8'));
    console.log(`✅ FCM service account loaded from file (project: ${fcmServiceAccount.project_id})`);
  }
  else if (process.env.FCM_SERVICE_ACCOUNT_B64) {
    fcmServiceAccount = JSON.parse(Buffer.from(process.env.FCM_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    console.log(`✅ FCM service account loaded from env (project: ${fcmServiceAccount.project_id})`);
  }
  else {
    console.warn('⚠️ FCM service account not found — Android push disabled');
  }
} catch (e) {
  console.warn(`⚠️ FCM service account error: ${e.message}`);
}

async function getFcmAccessToken() {
  if (fcmAccessToken && Date.now() < fcmTokenExpiry - 60_000) {
    return fcmAccessToken;
  }
  if (!fcmServiceAccount) return null;

  const now = Math.floor(Date.now() / 1000);
  const jwtPayload = {
    iss: fcmServiceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const signedJwt = jwt.sign(jwtPayload, fcmServiceAccount.private_key, { algorithm: 'RS256' });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`,
  });

  const data = await response.json();
  if (data.access_token) {
    fcmAccessToken = data.access_token;
    fcmTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    return fcmAccessToken;
  }
  console.error('❌ FCM OAuth token error:', data);
  return null;
}

// ============================================
// APNs — JWT Authentication
// ============================================

let apnsKey = null;
let apnsJwtToken = null;
let apnsJwtExpiry = 0;

try {
  if (fs.existsSync(APNS_KEY_PATH)) {
    apnsKey = fs.readFileSync(APNS_KEY_PATH, 'utf8');
    console.log(`✅ APNs key loaded from file (keyId: ${APNS_KEY_ID})`);
  }
  else if (process.env.APNS_KEY_B64) {
    apnsKey = Buffer.from(process.env.APNS_KEY_B64, 'base64').toString('utf8');
    console.log(`✅ APNs key loaded from env (keyId: ${APNS_KEY_ID})`);
  }
  else {
    console.warn('⚠️ APNs key not found — iOS push disabled');
  }
} catch (e) {
  console.warn(`⚠️ APNs key error: ${e.message}`);
}

function getApnsJwt() {
  if (apnsJwtToken && Date.now() < apnsJwtExpiry - 60_000) {
    return apnsJwtToken;
  }
  if (!apnsKey || !APNS_KEY_ID || !APNS_TEAM_ID) return null;

  const now = Math.floor(Date.now() / 1000);
  apnsJwtToken = jwt.sign(
    { iss: APNS_TEAM_ID, iat: now },
    apnsKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: APNS_KEY_ID } }
  );
  apnsJwtExpiry = Date.now() + 50 * 60 * 1000;
  return apnsJwtToken;
}

// ============================================
// APNs HTTP/2 Connection Pool
// ============================================

let apnsClient = null;

function getApnsClient() {
  if (apnsClient && !apnsClient.closed && !apnsClient.destroyed) {
    return apnsClient;
  }
  const host = APNS_PRODUCTION
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
  
  apnsClient = http2.connect(host);
  apnsClient.on('error', (err) => {
    console.error('APNs connection error:', err.message);
    apnsClient = null;
  });
  apnsClient.on('close', () => { apnsClient = null; });
  return apnsClient;
}

// ============================================
// SEND FUNCTIONS — Payload toujours GÉNÉRIQUE
// ============================================

/**
 * Envoie un wake-up ping via FCM (Android).
 *
 * APPEL ENTRANT:
 *   - Data-only (PAS de clé "notification") → Android ne crée rien automatiquement
 *   - HIGH priority → réveille l'app même tuée/Doze
 *   - TTL 30s → expire vite si le device est hors-ligne
 *   - Le background task Expo reçoit le data push et crée localement
 *     la notification d'appel avec sonnerie en boucle + boutons
 *   - C'est le même pattern que WhatsApp et Signal
 *
 * MESSAGE:
 *   - Notification + data → Android affiche "Ghostr - Nouveau message"
 *   - HIGH priority + TTL 300s
 *   - Canal ghostr-messages (discret)
 */
async function sendFcmPing(deviceToken, isCall = false, isCallCancel = false, isMissedCall = false) {
  const accessToken = await getFcmAccessToken();
  if (!accessToken) throw new Error('FCM not configured');

  const projectId = fcmServiceAccount?.project_id || FCM_PROJECT_ID;
  
  let message;

  if (isCallCancel) {
    // ════════════════════════════════════════════════════
    // ANNULATION D'APPEL — Data-only, HIGH priority, TTL court
    // ════════════════════════════════════════════════════
    // L'appelant a raccroché AVANT que le destinataire ne réponde.
    // PAS de clé "notification" → Android n'affiche RIEN automatiquement.
    // Le background task reçoit t:'h' → stoppe la sonnerie + affiche "Appel manqué".
    //
    // SÉCURITÉ: Même pattern que l'appel entrant (data-only).
    // Le contenu 't':'h' est un simple flag de routage, aucune donnée E2E.
    // Le Push Proxy ne sait pas qui a appelé ni le contenu du signal.
    message = {
      message: {
        token: deviceToken,
        data: {
          t: 'h',
        },
        android: {
          priority: 'HIGH',
          ttl: '30s',
        },
      },
    };
  } else if (isCall) {
    // ════════════════════════════════════════════════════
    // APPEL ENTRANT — Notification + data, HIGH priority
    // ════════════════════════════════════════════════════
    // POURQUOI notification (pas data-only):
    //   expo-notifications a un bug (#30762) où le channelId
    //   passé dans le JS content est IGNORÉ en background.
    //   La notification tombe dans le canal fallback "Miscellaneous"
    //   → vibration/son par défaut, identique aux messages.
    //
    //   En mettant channel_id dans la clé "notification" du FCM,
    //   Android route la notification nativement vers le bon canal
    //   AVANT que le JS ne tourne. Le vibrationPattern et le son
    //   du canal s'appliquent correctement.
    //
    // FOREGROUND:
    //   expo-notifications appelle handleNotification() qui retourne
    //   shouldShowBanner:false pour t='c'. La notification FCM est
    //   supprimée. IncomingCallOverlay React gère l'affichage.
    //
    // BACKGROUND / KILLED:
    //   Android affiche la notification sur le bon canal.
    //   Le plugin withInsistentRingtone ajoute FLAG_INSISTENT
    //   (détecté via channelId contenant "incoming-calls").
    //   L'utilisateur tape → l'app s'ouvre → IncomingCallOverlay.
    //
    // SÉCURITÉ: Contenu 100% anonyme, identique à l'ancien.
    //   Pas de nom d'appelant, pas de metadata E2E.
    message = {
      message: {
        token: deviceToken,
        notification: {
          title: 'Ghostr',
          body: 'Quelqu\'un essaie de vous joindre',
        },
        data: {
          t: 'c',
          isCall: 'true',
        },
        android: {
          priority: 'HIGH',
          ttl: '30s',
          notification: {
            channel_id: 'ghostr-incoming-calls-v2',
            default_vibrate_timings: false,
            sticky: true,
          },
        },
      },
    };
  } else if (isMissedCall) {
    // ════════════════════════════════════════════════════
    // APPEL MANQUÉ — Notification avec texte "Appel manqué"
    // ════════════════════════════════════════════════════
    // L'initiateur envoie le message call-ended avec status missed/cancelled.
    // On affiche "Appel manqué" au lieu de "Nouveau message" pour que le
    // destinataire voie immédiatement qu'il a raté un appel.
    //
    // SÉCURITÉ: Le texte "Appel manqué" est 100% générique.
    // Pas de nom d'appelant, pas de durée, pas de metadata.
    // Le Push Proxy sait déjà qu'un appel a eu lieu (is_call + is_call_cancel
    // envoyés précédemment). is_missed_call ne révèle rien de plus.
    message = {
      message: {
        token: deviceToken,
        notification: {
          title: 'Ghostr',
          body: 'Appel manqué',
        },
        data: {
          t: 'w',
        },
        android: {
          priority: 'HIGH',
          ttl: '300s',
          notification: {
            channel_id: 'ghostr-missed-calls',
          },
        },
      },
    };
  } else {
    // ════════════════════════════════════════════════════
    // MESSAGE — Notification discrète + data wake-up
    // ════════════════════════════════════════════════════
    message = {
      message: {
        token: deviceToken,
        notification: {
          title: 'Ghostr',
          body: 'Nouveau message',
        },
        data: {
          t: 'w',
        },
        android: {
          priority: 'HIGH',
          ttl: '300s',
          notification: {
            channel_id: 'ghostr-messages',
          },
        },
      },
    };
  }

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    }
  );

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`FCM error ${response.status}: ${errBody}`);
  }
  return true;
}

/**
 * Envoie un wake-up ping via APNs (iOS).
 *
 * APPEL ENTRANT:
 *   - push-type: alert → affichage immédiat garanti
 *   - priority: 10 → livraison immédiate, même en économie d'énergie
 *   - category: incoming_call → boutons Répondre/Refuser natifs
 *   - interruption-level: time-sensitive → bypass Focus (iOS 15+)
 *   - sound: ghostr_ringtone.mp3 → sonnerie personnalisée
 *   - content-available: 1 → réveille l'app en background pour polling
 *   - Titre/body GÉNÉRIQUES (aucune info sur l'appelant — anonymat)
 *   - TTL court (30s via apns-expiration)
 *
 * MESSAGE:
 *   - push-type: background → silent push
 *   - content-available: 1, mutable-content: 1
 *   - priority: 5 → livraison normale
 *
 * SÉCURITÉ:
 *   - Contenu 100% générique — le Push Proxy ne connaît pas l'appelant
 *   - Le seul rôle du push est de RÉVEILLER l'app client
 *   - Le client fetch ensuite le signal d'appel chiffré E2E via polling
 *   - Pas de fuite de métadonnées dans le push payload
 */
async function sendApnsPing(deviceToken, isCall = false, isCallCancel = false, isMissedCall = false) {
  // Sanitize token: expo-notifications may return iOS tokens with <>, spaces, or uppercase
  // APNs HTTP/2 requires lowercase hex without separators
  const cleanToken = deviceToken.replace(/[<>\s]/g, '').toLowerCase();
  if (cleanToken.length < 32 || !/^[0-9a-f]+$/.test(cleanToken)) {
    throw new Error(`Invalid APNs token format (len=${cleanToken.length})`);
  }
  if (cleanToken !== deviceToken) {
    diag('📱 APNs token sanitized');
  }

  const jwtToken = getApnsJwt();
  if (!jwtToken) throw new Error('APNs not configured');

  const client = getApnsClient();
  
  let payload;
  let pushType;
  let priority;
  let expiration;

  if (isCallCancel) {
    // ════════════════════════════════════════════════════
    // ANNULATION D'APPEL — Alert push haute priorité
    // ════════════════════════════════════════════════════
    // L'appelant a raccroché → réveiller l'app pour stopper la sonnerie.
    //
    // FIX: push-type DOIT être 'alert' quand priority=10.
    // APNs iOS 16+ REJETTE les combinaisons background+priority:10.
    // L'ancien code utilisait pushType='background' + priority='10'
    // → le push n'arrivait jamais → sonnerie infinie (90s timeout).
    //
    // SOLUTION: push-type 'alert' avec un payload alert minimal.
    // Le client iOS reçoit cette notification, la dismiss immédiatement
    // via le handler setNotificationHandler (shouldShowBanner:false pour t:'h'),
    // puis poll pour traiter le signal hangup chiffré E2E.
    //
    // Le titre/body sont 100% génériques — aucune info sur l'appelant.
    // category 'call_cancel' permet au client de router ce push.
    // content-available:1 réveille l'app en background pour le polling.
    payload = JSON.stringify({
      aps: {
        alert: {
          title: 'Ghostr',
          body: ' ',
        },
        'content-available': 1,
        'mutable-content': 1,
        category: 'call_cancel',
        'interruption-level': 'time-sensitive',
      },
      t: 'h',
    });
    pushType = 'alert';    // FIX: était 'background' → rejeté par APNs iOS 16+
    priority = '10';       // Immédiat — la sonnerie doit s'arrêter vite
    expiration = '30';     // 30s TTL
  } else if (isCall) {
    // ════════════════════════════════════════════════════
    // APPEL ENTRANT — Alert push avec catégorie + sonnerie
    // ════════════════════════════════════════════════════
    // Texte 100% générique — aucune info sur l'appelant.
    // t:'c' hors aps → le client détecte l'appel dans handleNotification
    // et supprime la notification en foreground (IncomingCallOverlay gère).
    // category 'incoming_call' → boutons Ouvrir/Ignorer (définis côté client).
    payload = JSON.stringify({
      aps: {
        alert: {
          title: 'Ghostr',
          body: 'Quelqu\'un essaie de vous joindre',
        },
        sound: {
          name: 'ghostr_ringtone.mp3',
          critical: 0,
          volume: 1.0,
        },
        category: 'incoming_call',
        'interruption-level': 'time-sensitive',
        'content-available': 1,
        badge: 1,
      },
      t: 'c',
    });
    pushType = 'alert';
    priority = '10';  // Immédiat
    expiration = '30'; // 30s TTL — pas utile si device hors-ligne longtemps
  } else if (isMissedCall) {
    // ════════════════════════════════════════════════════
    // APPEL MANQUÉ — Alert push avec texte "Appel manqué"
    // ════════════════════════════════════════════════════
    // Même logique que FCM: afficher "Appel manqué" au lieu de "Nouveau message".
    // SÉCURITÉ: Texte 100% générique, pas de nom d'appelant.
    payload = JSON.stringify({
      aps: {
        alert: {
          title: 'Ghostr',
          body: 'Appel manqué',
        },
        sound: 'default',
        'content-available': 1,
        'interruption-level': 'time-sensitive',
        badge: 1,
      },
      t: 'missed',
    });
    pushType = 'alert';
    priority = '10';   // Immédiat
    expiration = '300'; // 5min TTL
  } else {
    // ════════════════════════════════════════════════════
    // MESSAGE — Alert push visible (modèle Signal)
    // ════════════════════════════════════════════════════
    // FIX: Les background push (content-available only) sont
    // sévèrement throttlés par iOS (quelques par heure, retardés
    // en Low Power Mode, ignorés si app force-quittée).
    //
    // SOLUTION: push-type 'alert' avec notification visible générique
    // ("Ghostr — Nouveau message") + mutable-content:1 pour permettre
    // une future Notification Service Extension de modifier le contenu
    // après déchiffrement E2E (comme Signal).
    //
    // SÉCURITÉ: Le contenu reste 100% générique — aucun nom ni aperçu.
    // content-available:1 réveille l'app en background pour le polling.
    payload = JSON.stringify({
      aps: {
        alert: {
          title: 'Ghostr',
          body: 'Nouveau message',
        },
        sound: 'default',
        'content-available': 1,
        'mutable-content': 1,
        badge: 1,
      },
      t: 'w',
    });
    pushType = 'alert';    // FIX: était 'background' → throttlé par iOS
    priority = '10';       // FIX: était '5' → garantir livraison immédiate
    expiration = '300'; // 5min TTL
  }

  return new Promise((resolve, reject) => {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${cleanToken}`,
      'authorization': `bearer ${jwtToken}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': pushType,
      'apns-priority': priority,
      'apns-expiration': expiration,
    });

    let responseData = '';
    req.on('response', (headers) => {
      const status = headers[':status'];
      if (status === 200) {
        resolve(true);
      } else {
        req.on('data', (chunk) => { responseData += chunk; });
        req.on('end', () => {
          reject(new Error(`APNs error ${status}: ${responseData}`));
        });
      }
    });

    req.on('error', (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

// ============================================
// DECRYPT PUSH TOKEN BLOB
// ============================================

function decryptPushBlob(encryptedBlobB64) {
  const blob = Buffer.from(encryptedBlobB64, 'base64');
  
  if (blob.length < 32 + 24 + 16) {
    throw new Error('Push blob too small');
  }

  const ephemeralPubKey = blob.slice(0, 32);
  const nonce = blob.slice(32, 56);
  const ciphertext = blob.slice(56);

  const plaintext = nacl.box.open(
    new Uint8Array(ciphertext),
    new Uint8Array(nonce),
    new Uint8Array(ephemeralPubKey),
    new Uint8Array(proxyKeyPair.secretKey)
  );

  if (!plaintext) {
    throw new Error('Push blob decryption failed (likely random/decoy)');
  }

  const dataLen = (plaintext[0] << 8) | plaintext[1];
  if (dataLen < 2 || dataLen > plaintext.length - 2) {
    throw new Error('Invalid padding in push blob');
  }
  const dataBytes = plaintext.slice(2, 2 + dataLen);

  const tokenData = JSON.parse(new TextDecoder().decode(dataBytes));
  return tokenData;
}

// ============================================
// DEDUPLICATION
// ============================================

const DEDUP_WINDOW_MS = 5000;
const recentPushes = new Map();

function getTokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function isDuplicate(token) {
  const hash = getTokenHash(token);
  const lastPush = recentPushes.get(hash);
  const now = Date.now();
  
  if (recentPushes.size > 1000) {
    for (const [k, v] of recentPushes) {
      if (now - v > DEDUP_WINDOW_MS * 2) recentPushes.delete(k);
    }
  }
  
  if (lastPush && now - lastPush < DEDUP_WINDOW_MS) {
    return true;
  }
  
  recentPushes.set(hash, now);
  return false;
}

// ============================================
// REQUEST AUTHENTICATION
// ============================================

function authenticateGatewayRequest(req, bodyStr) {
  const authHeader = req.headers['x-push-auth'];
  const timestamp = req.headers['x-push-timestamp'];

  if (!authHeader || !timestamp) return false;

  const ts = parseInt(timestamp, 10);
  const now = Date.now();
  if (Math.abs(now - ts) > 2 * 60 * 1000) {
    console.warn('⚠️ Push auth: timestamp out of window');
    return false;
  }

  const expected = crypto
    .createHmac('sha256', gatewaySecret)
    .update(`${timestamp}:${bodyStr}`)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(authHeader, 'hex')
  );
}

// ============================================
// METRICS (anonymisées)
// ============================================

const metrics = {
  fcmSent: 0,
  fcmFailed: 0,
  apnsSent: 0,
  apnsFailed: 0,
  fcmCallSent: 0,
  apnsCallSent: 0,
  authFailed: 0,
  decryptFailed: 0,
};

// ============================================
// HTTP SERVER
// ============================================

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    // FIX: /health exposait les métriques détaillées sans auth.
    // Maintenant: réponse publique minimale (status only).
    // Métriques complètes uniquement avec auth Gateway.
    const authHeader = req.headers['x-push-auth'];
    if (authHeader) {
      // Auth présente → vérifier et retourner les métriques complètes
      const ts = req.headers['x-push-timestamp'] || '';
      const bodyStr = '';
      const expected = crypto
        .createHmac('sha256', gatewaySecret)
        .update(`${ts}:${bodyStr}`)
        .digest('hex');
      const isAuthed = authHeader.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(authHeader, 'hex'));
      if (isAuthed) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', metrics }));
        return;
      }
    }
    // Sans auth → status minimal uniquement
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Clé publique (route non-sensible)
  if (req.method === 'GET' && req.url === '/public-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      publicKey: Buffer.from(proxyKeyPair.publicKey).toString('base64'),
    }));
    return;
  }

  // Endpoint principal
  if (req.method === 'POST' && req.url === '/notify') {
    let bodyChunks = [];
    req.on('data', (chunk) => bodyChunks.push(chunk));
    req.on('end', async () => {
      const bodyStr = Buffer.concat(bodyChunks).toString('utf8');

      if (!authenticateGatewayRequest(req, bodyStr)) {
        metrics.authFailed++;
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication failed' }));
        return;
      }

      let tokenData = null;
      try {
        const body = JSON.parse(bodyStr);
        const encryptedBlob = body.encrypted_push_blob;

        if (!encryptedBlob) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing encrypted_push_blob' }));
          return;
        }

        try {
          tokenData = decryptPushBlob(encryptedBlob);
        } catch (decryptErr) {
          // Blob aléatoire (decoy) — réponse identique à un succès
          metrics.decryptFailed++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        const isCall = tokenData.is_call === true;
        const isCallCancel = tokenData.is_call_cancel === true;
        const isMissedCall = tokenData.is_missed_call === true;

        // Déduplication (sauf appels et annulations d'appel — toujours notifier)
        if (!isCall && !isCallCancel && isDuplicate(tokenData.token)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, deduped: true }));
          return;
        }

        // Envoyer le push
        const pushLabel = isCallCancel ? 'CALL_CANCEL' : isCall ? 'CALL' : isMissedCall ? 'MISSED' : 'msg';
        if (tokenData.platform === 'fcm') {
          await sendFcmPing(tokenData.token, isCall, isCallCancel, isMissedCall);
          metrics.fcmSent++;
          if (isCall || isCallCancel) metrics.fcmCallSent++;
        } else if (tokenData.platform === 'apns') {
          await sendApnsPing(tokenData.token, isCall, isCallCancel, isMissedCall);
          metrics.apnsSent++;
          if (isCall || isCallCancel) metrics.apnsCallSent++;
        } else {
          throw new Error(`Unknown platform: ${tokenData.platform}`);
        }

        diag(`🔔 Push sent (${pushLabel}, ${tokenData.platform})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

      } catch (err) {
        if (tokenData?.platform === 'fcm') {
          metrics.fcmFailed++;
        } else {
          metrics.apnsFailed++;
        }
        console.error(`❌ Push error: ${err.message}`);
        // Réponse identique pour ne pas leak le type d'erreur
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } finally {
        // Effacement immédiat du token de la mémoire
        if (tokenData) {
          tokenData.token = null;
          tokenData = null;
        }
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`🔔 Ghostr Push Proxy v2.0 listening on port ${PORT}`);
  console.log(`   FCM:  ${fcmServiceAccount ? 'ENABLED' : 'DISABLED'}`);
  console.log(`   APNs: ${apnsKey ? 'ENABLED' : 'DISABLED'}`);
  console.log(`   Proxy public key: ${Buffer.from(proxyKeyPair.publicKey).toString('base64')}`);
});