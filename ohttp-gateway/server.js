// ohttp-gateway/server.js
// GHOSTR — OHTTP Gateway (Split-Trust)
//
// This server:
//   - Sees the CONTENT of requests (decrypts NaCl box)
//   - Does NOT see the IP of clients (CF relay strips it)
//   - Forwards decrypted RPC calls to Supabase
//   - Re-encrypts Supabase responses for the client
//
// DEPLOYMENT: Run on a VPS in a privacy-friendly jurisdiction (Iceland, Switzerland)
// NEVER co-locate with the CF Worker or Supabase instance.

const http = require('http');
const nacl = require('tweetnacl');

// P0: Key Transparency — optional, gateway works without it
let createTransparencyTree = null;
try {
  createTransparencyTree = require('./keyTransparencyTree').createTransparencyTree;
} catch (e) {
  console.warn('keyTransparencyTree.js not found — Key Transparency DISABLED.');
  console.warn('  Make sure keyTransparencyTree.js is in the same directory as server.js.');
}

// ============================================
// CONFIGURATION (from environment variables)
// ============================================

const PORT = parseInt(process.env.PORT || '3100', 10);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GATEWAY_SECRET_KEY = process.env.GATEWAY_SECRET_KEY; // Base64 NaCl box secret key
const GATEWAY_PUBLIC_KEY = process.env.GATEWAY_PUBLIC_KEY; // Base64 NaCl box public key

// P0: Key Transparency HMAC key (distinct from sealed sender HMAC)
const KT_HMAC_KEY = process.env.KT_HMAC_KEY; // Base64, 32 bytes
const KT_PERSIST_PATH = process.env.KT_PERSIST_PATH || '/tmp/kt_data'; // /tmp is writable on Cloud Run

// Whitelisted RPCs (only these can be called through the relay)
const ALLOWED_RPCS = new Set([
  // ACTION 01: send_message SUPPRIMÉ — sealed sender uniquement
  'get_messages_by_tags',
  'send_call_signal',
  'get_call_signals_by_tags',
  // Audit Fix C-01: Sealed sender RPC
  'send_sealed_message',
  // Audit Fix C-01: Certificate issuance (internal, not forwarded to Supabase)
  'get_sealed_certificate',
  // P0: Key Transparency RPCs (internal, handled by gateway)
  'kt_register_key',
  'kt_get_proof',
  'kt_get_sth',
]);

// ============================================
// SEALED SENDER (Audit Fix C-01)
// ============================================
// Le sealed sender utilise une paire de clés DISTINCTE du gateway OHTTP.
// Le client chiffre l'enveloppe avec cette clé ; le gateway déchiffre,
// vérifie le certificat anonyme, puis forward le payload au Supabase.
// La clé HMAC sert à émettre et vérifier les certificats anonymes.

const SEALED_SENDER_SECRET_KEY = process.env.SEALED_SENDER_SECRET_KEY; // Base64, 32 bytes
const SEALED_SENDER_PUBLIC_KEY = process.env.SEALED_SENDER_PUBLIC_KEY; // Base64, 32 bytes
const SEALED_SENDER_HMAC_KEY = process.env.SEALED_SENDER_HMAC_KEY;    // Base64, 32 bytes
const CERTIFICATE_VALIDITY_MS = 60 * 60 * 1000; // P5 fix: 1h (was 24h)

// ============================================
// CERTIFICATE RATE LIMITING (P6 fix)
// ============================================
// Track certificate nonce usage. Each certificate allows MAX_MESSAGES_PER_CERT
// messages before the client must obtain a new one (via PoW).
// This prevents a single certificate from enabling unlimited tag-rotation DoS.

const MAX_MESSAGES_PER_CERT = 200; // ~3.3 msg/min covers normal + decoy traffic (1h cert)
const certUsage = new Map(); // nonce_b64 → { count, expiry }
let lastCertCleanup = Date.now();

function cleanupCertUsage() {
  const now = Date.now();
  if (now - lastCertCleanup > 5 * 60 * 1000) { // cleanup every 5 min
    for (const [nonce, info] of certUsage) {
      if (now > info.expiry) certUsage.delete(nonce);
    }
    lastCertCleanup = now;
  }
}

/**
 * Check if a certificate nonce has exceeded its message quota.
 * Returns true if allowed, false if rate limited.
 */
function checkCertRateLimit(nonceB64, expiry) {
  cleanupCertUsage();
  const existing = certUsage.get(nonceB64);
  if (existing) {
    if (existing.count >= MAX_MESSAGES_PER_CERT) {
      return false;
    }
    existing.count++;
    return true;
  }
  certUsage.set(nonceB64, { count: 1, expiry });
  return true;
}

// ============================================
// PROOF-OF-WORK VERIFICATION (Audit Fix CRITIQUE-03)
// ============================================
// Anti-spam: Require a Hashcash-style proof-of-work before issuing certificates.
// The client must find a nonce such that SHA-256(timestamp:salt:nonce) has N leading zero bits.
//
// ACTION 8 (Audit Fix): Difficulté augmentée de 16 à 20 bits + système adaptatif.
// 20 bits = ~1M itérations = ~3s sur mobile (UX acceptable, calculé une seule fois).
// Si le serveur détecte un pic de demandes (>50 certs/min), la difficulté monte
// temporairement à 24 bits (~15s mobile) pour décourager les attaques par spam.

const POW_BASE_DIFFICULTY = 18;
const POW_SURGE_DIFFICULTY = 24;
const POW_SURGE_THRESHOLD = 50; // Requêtes par minute déclenchant le mode surge
const POW_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // ±5 minutes

// Adaptive difficulty: track cert request rate (sliding window 60s)
const certRequestTimestamps = [];
function getCurrentDifficulty() {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  // Purge old entries
  while (certRequestTimestamps.length > 0 && certRequestTimestamps[0] < oneMinuteAgo) {
    certRequestTimestamps.shift();
  }
  certRequestTimestamps.push(now);
  if (certRequestTimestamps.length > POW_SURGE_THRESHOLD) {
    console.log(`⚠️ PoW SURGE: ${certRequestTimestamps.length} certs/min > ${POW_SURGE_THRESHOLD}, difficulty raised to ${POW_SURGE_DIFFICULTY}`);
    return POW_SURGE_DIFFICULTY;
  }
  return POW_BASE_DIFFICULTY;
}

// ACTION 12 (Audit Fix): Replay protection with per-entry timestamps instead of bulk clear.
// Each challenge is stored with its insertion time and cleaned up individually.
const recentChallenges = new Map(); // challengeId -> timestamp

function cleanupRecentChallenges() {
  const expiry = Date.now() - (POW_TIMESTAMP_WINDOW_MS + 60_000); // Keep 1min margin
  for (const [key, ts] of recentChallenges) {
    if (ts < expiry) {
      recentChallenges.delete(key);
    } else {
      break; // Map preserves insertion order; once we hit a valid entry, stop
    }
  }
}

/**
 * Verify a Proof-of-Work submitted by the client.
 * Returns true if valid, false otherwise.
 */
function verifyProofOfWork(pow) {
  if (!pow || typeof pow.timestamp !== 'number' || typeof pow.salt !== 'string' ||
      typeof pow.nonce !== 'number' || typeof pow.difficulty !== 'number') {
    return false;
  }

  // Get current required difficulty (may be elevated during surge)
  const requiredDifficulty = getCurrentDifficulty();

  // Check difficulty meets current requirement
  if (pow.difficulty < requiredDifficulty) {
    return false;
  }

  // Check timestamp window (anti-replay)
  const now = Date.now();
  if (Math.abs(now - pow.timestamp) > POW_TIMESTAMP_WINDOW_MS) {
    return false;
  }

  // Check replay (same challenge used twice)
  cleanupRecentChallenges();
  const challengeId = `${pow.timestamp}:${pow.salt}`;
  if (recentChallenges.has(challengeId)) {
    return false;
  }

  // Verify the hash has required leading zero bits
  const crypto = require('crypto');
  const input = `${pow.timestamp}:${pow.salt}:${pow.nonce}`;
  const hash = crypto.createHash('sha256').update(input).digest();

  // Verify against the difficulty the CLIENT used (which must be >= our requirement)
  const verifyBits = pow.difficulty;
  const fullBytes = Math.floor(verifyBits / 8);
  const remainingBits = verifyBits % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }
  if (remainingBits > 0) {
    const mask = 0xFF << (8 - remainingBits);
    if ((hash[fullBytes] & mask) !== 0) return false;
  }

  // Mark challenge as used with timestamp
  recentChallenges.set(challengeId, now);

  return true;
}

let sealedSenderKeyPair = null;
let sealedSenderHmacKey = null;

function loadSealedSenderKeys() {
  if (!SEALED_SENDER_SECRET_KEY || !SEALED_SENDER_PUBLIC_KEY || !SEALED_SENDER_HMAC_KEY) {
    // ACTION 4 (Audit Fix): En production, les clés sealed sender DOIVENT être
    // fournies via env vars. Sans ça, un redémarrage du container = nouvelles clés
    // = tous les certificats en vol invalides = messages perdus silencieusement.
    if (process.env.NODE_ENV === 'production') {
      console.error('❌ FATAL: SEALED_SENDER_SECRET_KEY, SEALED_SENDER_PUBLIC_KEY, and SEALED_SENDER_HMAC_KEY must be set in production.');
      console.error('   Generate keys with: node -e "const nacl=require(\'tweetnacl\');const c=require(\'crypto\');const kp=nacl.box.keyPair();console.log(\'SK:\',Buffer.from(kp.secretKey).toString(\'base64\'));console.log(\'PK:\',Buffer.from(kp.publicKey).toString(\'base64\'));console.log(\'HMAC:\',c.randomBytes(32).toString(\'base64\'));"');
      process.exit(1);
    }
    // Dev only: auto-generate ephemeral keys for local testing
    console.log('🛡️ [DEV] Sealed sender keys not in env, auto-generating (ephemeral)...');
    const crypto = require('crypto');
    sealedSenderKeyPair = nacl.box.keyPair();
    sealedSenderHmacKey = new Uint8Array(crypto.randomBytes(32));
    console.log('🛡️ [DEV] Ephemeral keys generated. Public key:', Buffer.from(sealedSenderKeyPair.publicKey).toString('base64').slice(0, 16) + '...');
    console.log('   ⚠️  Keys are ephemeral — set env vars for persistence.');
    return;
  }
  const sk = Buffer.from(SEALED_SENDER_SECRET_KEY, 'base64');
  const pk = Buffer.from(SEALED_SENDER_PUBLIC_KEY, 'base64');
  const hmac = Buffer.from(SEALED_SENDER_HMAC_KEY, 'base64');
  if (sk.length !== 32 || pk.length !== 32 || hmac.length !== 32) {
    console.error('Invalid sealed sender key lengths.');
    return;
  }
  sealedSenderKeyPair = { publicKey: new Uint8Array(pk), secretKey: new Uint8Array(sk) };
  sealedSenderHmacKey = new Uint8Array(hmac);
  console.log('🛡️ Sealed sender keys loaded. Public key:', SEALED_SENDER_PUBLIC_KEY.slice(0, 16) + '...');
}

/**
 * Issue an anonymous certificate. The certificate proves the holder is
 * a legitimate user without revealing their identity.
 * Format: { nonce: Base64(random 32B), expiry: timestamp, hmac: Base64(HMAC) }
 */
function issueAnonymousCertificate() {
  if (!sealedSenderHmacKey) return null;
  const crypto = require('crypto');
  const nonce = nacl.randomBytes(32);
  const expiry = Date.now() + CERTIFICATE_VALIDITY_MS;
  // HMAC(key, nonce || expiry)
  const expiryBuf = Buffer.alloc(8);
  expiryBuf.writeBigUInt64BE(BigInt(expiry), 0);
  const dataToHmac = Buffer.concat([Buffer.from(nonce), expiryBuf]);
  const hmacResult = crypto.createHmac('sha256', Buffer.from(sealedSenderHmacKey))
    .update(dataToHmac).digest();
  return {
    nonce: Buffer.from(nonce).toString('base64'),
    expiry,
    hmac: hmacResult.toString('base64'),
  };
}

// ============================================
// KEY LOADING — ACTION 10: Automatic rotation
// ============================================

let gatewayKeyPair = null;
let previousGatewayKeyPair = null; // Keep old keys for 1h overlap
const KEY_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const KEY_OVERLAP_MS = 60 * 60 * 1000; // 1h overlap for in-transit requests
let keyRotationTimestamp = 0;

// ACTION 09: Gateway ID for multi-gateway routing
const GATEWAY_ID = process.env.GATEWAY_ID || 'gw-primary';

function loadKeys() {
  if (!GATEWAY_SECRET_KEY || !GATEWAY_PUBLIC_KEY) {
    console.error('GATEWAY_SECRET_KEY and GATEWAY_PUBLIC_KEY must be set.');
    console.error('Generate with: npm run keygen');
    process.exit(1);
  }

  const secretKey = Buffer.from(GATEWAY_SECRET_KEY, 'base64');
  const publicKey = Buffer.from(GATEWAY_PUBLIC_KEY, 'base64');

  if (secretKey.length !== 32 || publicKey.length !== 32) {
    console.error('Invalid key length. Keys must be 32 bytes (base64 encoded).');
    process.exit(1);
  }

  gatewayKeyPair = {
    publicKey: new Uint8Array(publicKey),
    secretKey: new Uint8Array(secretKey),
  };
  keyRotationTimestamp = Date.now();

  console.log('🔑 Gateway keys loaded. Public key:', GATEWAY_PUBLIC_KEY.slice(0, 16) + '...');
}

/**
 * ACTION 10: Rotate gateway keys every 24h.
 * Previous key pair is kept for 1h overlap to handle in-transit requests.
 */
function rotateGatewayKeys() {
  console.log('🔑 ACTION 10: Rotating gateway keys...');
  
  // Archive current keys
  previousGatewayKeyPair = gatewayKeyPair;
  
  // Generate new key pair
  gatewayKeyPair = nacl.box.keyPair();
  keyRotationTimestamp = Date.now();
  
  console.log('🔑 New gateway pubkey:', Buffer.from(gatewayKeyPair.publicKey).toString('base64').slice(0, 16) + '...');
  
  // Zeroize old keys after overlap period
  setTimeout(() => {
    if (previousGatewayKeyPair) {
      console.log('🔑 Zeroizing previous key pair (overlap period ended)');
      previousGatewayKeyPair.secretKey.fill(0);
      previousGatewayKeyPair = null;
    }
  }, KEY_OVERLAP_MS);
}

// Schedule automatic rotation
function startKeyRotation() {
  // Only rotate if using env-provided keys (not for auto-generated testing keys)
  if (GATEWAY_SECRET_KEY && GATEWAY_PUBLIC_KEY) {
    setInterval(() => {
      rotateGatewayKeys();
    }, KEY_ROTATION_INTERVAL_MS);
    
    console.log(`🔑 ACTION 10: Key rotation scheduled every ${KEY_ROTATION_INTERVAL_MS / 3600000}h`);
  }
}

// ============================================
// CRYPTO HELPERS
// ============================================

/**
 * Decrypt a client request blob.
 * Wire format: [32 bytes ephemeral pubkey][24 bytes nonce][ciphertext]
 * ACTION 10: Tries current key first, then previous key (overlap period).
 * BUG FIX: Returns the secret key that was used for decryption,
 * so encryptResponse uses the SAME key (otherwise client can't decrypt response).
 */
function decryptBlob(encryptedBuf) {
  const data = new Uint8Array(encryptedBuf);

  if (data.length < 32 + 24 + 16) { // pubkey + nonce + minimum poly1305 tag
    throw new Error('Blob too small');
  }

  const ephemeralPubKey = data.slice(0, 32);
  const nonce = data.slice(32, 56);
  const ciphertext = data.slice(56);

  // Try current key pair first
  let plaintext = nacl.box.open(ciphertext, nonce, ephemeralPubKey, gatewayKeyPair.secretKey);
  let usedSecretKey = gatewayKeyPair.secretKey;
  
  // ACTION 10: If decryption fails and we have a previous key (overlap period), try that
  if (!plaintext && previousGatewayKeyPair) {
    plaintext = nacl.box.open(ciphertext, nonce, ephemeralPubKey, previousGatewayKeyPair.secretKey);
    usedSecretKey = previousGatewayKeyPair.secretKey;
  }

  if (!plaintext) {
    throw new Error('Decryption failed (invalid key or corrupted data)');
  }

  return {
    plaintext: new TextDecoder().decode(plaintext),
    ephemeralPubKey, // Keep for encrypting the response back
    usedSecretKey,   // BUG FIX: The key that successfully decrypted the request
  };
}

/**
 * Encrypt a response for the client.
 * Wire format: [24 bytes nonce][ciphertext]
 * BUG FIX: Uses the same secret key that decrypted the request (usedSecretKey).
 */
function encryptResponse(plaintext, ephemeralPubKey, usedSecretKey) {
  const nonce = nacl.randomBytes(24);
  const ciphertext = nacl.box(
    typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext,
    nonce,
    ephemeralPubKey,
    usedSecretKey  // BUG FIX: Must match the key used for decryption
  );

  // Response format: [24 bytes nonce][... ciphertext ...]
  const packed = new Uint8Array(24 + ciphertext.length);
  packed.set(nonce, 0);
  packed.set(ciphertext, 24);

  return packed;
}

// ============================================
// SUPABASE RPC FORWARDING
// ============================================

async function forwardToSupabase(rpc, params) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase not configured');
  }

  const url = `${SUPABASE_URL}/rest/v1/rpc/${rpc}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(params),
  });

  const text = await response.text();

  if (!response.ok) {
    return { error: `Supabase ${response.status}: ${text}` };
  }

  try {
    return { data: JSON.parse(text) };
  } catch {
    return { data: text };
  }
}

// ============================================
// HTTP SERVER
// ============================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    const MAX_SIZE = 22 * 1024 * 1024; // 22MB — couvre 10MB fichier après chiffrement + base64

    req.on('data', chunk => {
      totalLength += chunk.length;
      if (totalLength > MAX_SIZE) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /pubkey — return the gateway's CURRENT public key
  // ACTION 10: Always returns the latest key (rotated every 24h)
  if (req.method === 'GET' && req.url === '/pubkey') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(Buffer.from(gatewayKeyPair.publicKey).toString('base64'));
    return;
  }

  // GET /manifest — ACTION 09: Return gateway identity for multi-gateway routing
  if (req.method === 'GET' && req.url === '/manifest') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: GATEWAY_ID,
      pubkey: Buffer.from(gatewayKeyPair.publicKey).toString('base64'),
      sealedSenderPubkey: sealedSenderKeyPair 
        ? Buffer.from(sealedSenderKeyPair.publicKey).toString('base64') 
        : null,
      keyRotatedAt: keyRotationTimestamp,
      version: '2.0',
    }));
    return;
  }

  // GET /sealed-sender-key — Audit Fix C-01
  // Returns the sealed sender public key (distinct from OHTTP gateway key)
  if (req.method === 'GET' && req.url === '/sealed-sender-key') {
    if (!sealedSenderKeyPair) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sealed sender not configured' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(Buffer.from(sealedSenderKeyPair.publicKey).toString('base64'));
    return;
  }

  // POST /certificate — Audit Fix C-01 + CRITIQUE-03 (PoW required)
  // Issues an anonymous certificate. The request goes through the OHTTP relay,
  // so the gateway sees the auth token (to verify legitimacy) but NOT the IP.
  // The certificate itself contains no identity — just a random nonce + HMAC.
  if (req.method === 'POST' && req.url === '/certificate') {
    if (!sealedSenderHmacKey) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sealed sender not configured' }));
      return;
    }
    // CRITIQUE-03: Require Proof-of-Work to prevent certificate spam
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body.toString('utf-8'));
      if (!parsed.pow || !verifyProofOfWork(parsed.pow)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        // ACTION 8: Inclure la difficulté requise pour que le client puisse réessayer
        res.end(JSON.stringify({ 
          error: 'Invalid or missing proof-of-work',
          requiredDifficulty: getCurrentDifficulty(),
        }));
        return;
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body — JSON with pow required' }));
      return;
    }
    const cert = issueAnonymousCertificate();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cert));
    return;
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    const sealedSenderOk = sealedSenderKeyPair !== null && sealedSenderHmacKey !== null;
    const ktOk = ktTree !== null && ktTree.getStats().treeSize >= 0;
    const status = (sealedSenderOk && ktOk) ? 'ok' : 'degraded';
    const code = sealedSenderOk ? 200 : 503;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status,
      uptime: process.uptime(),
      sealedSender: sealedSenderOk ? 'loaded' : 'MISSING — messages will fail',
      keyTransparency: ktOk ? `${ktTree.getStats().treeSize} keys` : 'NOT INITIALIZED',
    }));
    return;
  }

  // GET /kt/sth — P0: Public Signed Tree Head for external auditors
  // This endpoint is NOT encrypted — it's intentionally public so that
  // independent auditors can verify the tree is append-only.
  if (req.method === 'GET' && req.url === '/kt/sth') {
    if (!ktTree) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key Transparency not initialized' }));
      return;
    }
    const sth = ktTree.getLatestSTH();
    const stats = ktTree.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sth, stats }));
    return;
  }

  // POST /relay — main OHTTP endpoint
  if (req.method === 'POST' && req.url === '/relay') {
    try {
      const body = await readBody(req);

      // Decrypt the client's request
      const { plaintext, ephemeralPubKey, usedSecretKey } = decryptBlob(body);
      const request = JSON.parse(plaintext);

      // Validate RPC name
      if (!request.rpc || !ALLOWED_RPCS.has(request.rpc)) {
        console.log(`❌ Blocked RPC: ${request.rpc}`);
        const errorResponse = encryptResponse(
          JSON.stringify({ error: `RPC '${request.rpc}' not allowed` }),
          ephemeralPubKey, usedSecretKey
        );
        res.writeHead(403, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from(errorResponse));
        return;
      }

      // Audit Fix C-01 + CRITIQUE-03: Internal RPCs (handled by gateway, not forwarded to Supabase)
      if (request.rpc === 'get_sealed_certificate') {
        // CRITIQUE-03: Verify Proof-of-Work before issuing certificate
        const pow = request.params && request.params.pow;
        if (!verifyProofOfWork(pow)) {
          const errResp = encryptResponse(
            JSON.stringify({ data: null, error: 'Invalid or missing proof-of-work' }),
            ephemeralPubKey, usedSecretKey
          );
          res.writeHead(403, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(errResp));
          return;
        }
        const cert = issueAnonymousCertificate();
        const result = cert
          ? { data: cert, error: null }
          : { data: null, error: 'Sealed sender not configured' };
        const certResponse = encryptResponse(JSON.stringify(result), ephemeralPubKey, usedSecretKey);
        console.log(`✅ get_sealed_certificate (PoW verified) → ${cert ? 'issued' : 'not configured'}`);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from(certResponse));
        return;
      }

      // Audit Fix C-01: Sealed sender — decrypt envelope, verify cert, forward inner payload
      // The gateway strips the sealed sender layer so the recipient gets the plain
      // Triple Ratchet payload, exactly like a regular send_message.

      // ============================================
      // P0: KEY TRANSPARENCY RPCs (internal, not forwarded to Supabase)
      // ============================================

      // Guard: if KT tree is not initialized, return a clean error
      if ((request.rpc === 'kt_register_key' || request.rpc === 'kt_get_proof' || request.rpc === 'kt_get_sth') && !ktTree) {
        const errResp = encryptResponse(
          JSON.stringify({ data: null, error: 'Key Transparency not initialized on this gateway' }),
          ephemeralPubKey, usedSecretKey
        );
        res.writeHead(503, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from(errResp));
        return;
      }

      if (request.rpc === 'kt_register_key') {
        // Register an identity key in the transparency log.
        // Params: { identity_key_b64: string }
        // Returns: { index, rootHash, treeSize, alreadyRegistered }
        try {
          const identityKeyB64 = request.params && request.params.identity_key_b64;
          if (!identityKeyB64 || typeof identityKeyB64 !== 'string' || identityKeyB64.length < 20 || identityKeyB64.length > 200) {
            throw new Error('Invalid identity_key_b64');
          }

          const result = ktTree.registerKey(identityKeyB64);

          // Sign a new STH if the tree changed
          let sth = null;
          if (!result.alreadyRegistered) {
            sth = ktTree.getLatestSTH();
          }

          const resp = encryptResponse(JSON.stringify({
            data: { ...result, sth },
            error: null,
          }), ephemeralPubKey, usedSecretKey);

          console.log(`🌳 kt_register_key → ${result.alreadyRegistered ? 'already exists' : 'registered'} #${result.index} (tree: ${result.treeSize})`);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(resp));
        } catch (e) {
          const errResp = encryptResponse(
            JSON.stringify({ data: null, error: e.message }),
            ephemeralPubKey, usedSecretKey
          );
          res.writeHead(400, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(errResp));
        }
        return;
      }

      if (request.rpc === 'kt_get_proof') {
        // Get an inclusion proof for an identity key.
        // Params: { identity_key_b64: string }
        // Returns: { proof, index, treeSize, rootHash, commitment } | null
        try {
          const identityKeyB64 = request.params && request.params.identity_key_b64;
          if (!identityKeyB64 || typeof identityKeyB64 !== 'string') {
            throw new Error('Invalid identity_key_b64');
          }

          const proof = ktTree.getInclusionProof(identityKeyB64);
          const sth = ktTree.getLatestSTH();

          const resp = encryptResponse(JSON.stringify({
            data: proof ? { ...proof, sth } : null,
            error: proof ? null : 'Key not found in transparency log',
          }), ephemeralPubKey, usedSecretKey);

          console.log(`🌳 kt_get_proof → ${proof ? 'found #' + proof.index : 'NOT FOUND'}`);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(resp));
        } catch (e) {
          const errResp = encryptResponse(
            JSON.stringify({ data: null, error: e.message }),
            ephemeralPubKey, usedSecretKey
          );
          res.writeHead(400, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(errResp));
        }
        return;
      }

      if (request.rpc === 'kt_get_sth') {
        // Get the latest Signed Tree Head.
        // No params required.
        try {
          const sth = ktTree.getLatestSTH();
          const stats = ktTree.getStats();

          const resp = encryptResponse(JSON.stringify({
            data: { sth, stats },
            error: sth ? null : 'Tree is empty',
          }), ephemeralPubKey, usedSecretKey);

          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(resp));
        } catch (e) {
          const errResp = encryptResponse(
            JSON.stringify({ data: null, error: e.message }),
            ephemeralPubKey, usedSecretKey
          );
          res.writeHead(400, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(errResp));
        }
        return;
      }

      // ============================================
      // END KEY TRANSPARENCY RPCs
      // ============================================
      if (request.rpc === 'send_sealed_message') {
        if (!sealedSenderKeyPair || !sealedSenderHmacKey) {
          const errResp = encryptResponse(JSON.stringify({ error: 'Sealed sender not configured' }), ephemeralPubKey, usedSecretKey);
          res.writeHead(503, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(errResp));
          return;
        }

        try {
          const params = request.params || {};
          const sealedContentB64 = params.p_sealed_content;
          const tag = params.p_tag;

          // 1. Decode and decrypt the sealed sender envelope
          const sealedContent = Buffer.from(sealedContentB64, 'base64');
          if (sealedContent.length < 32 + 24 + 16) {
            throw new Error('Sealed content too small');
          }
          const ssEphPubKey = sealedContent.slice(0, 32);
          const ssNonce = sealedContent.slice(32, 56);
          const ssCiphertext = sealedContent.slice(56);

          const ssPlaintext = nacl.box.open(
            new Uint8Array(ssCiphertext),
            new Uint8Array(ssNonce),
            new Uint8Array(ssEphPubKey),
            sealedSenderKeyPair.secretKey
          );
          if (!ssPlaintext) {
            throw new Error('Sealed sender decryption failed');
          }

          const inner = JSON.parse(new TextDecoder().decode(ssPlaintext));
          // inner = { innerPayload: string, certificate: { nonce, expiry, hmac } }

          // 2. Verify the anonymous certificate
          const cert = inner.certificate;
          if (!cert || !cert.nonce || !cert.expiry || !cert.hmac) {
            throw new Error('Missing certificate');
          }
          if (Date.now() > cert.expiry) {
            throw new Error('Certificate expired');
          }

          const crypto = require('crypto');
          const certNonce = Buffer.from(cert.nonce, 'base64');
          const expiryBuf = Buffer.alloc(8);
          expiryBuf.writeBigUInt64BE(BigInt(cert.expiry), 0);
          const dataToHmac = Buffer.concat([certNonce, expiryBuf]);
          const expectedHmac = crypto.createHmac('sha256', Buffer.from(sealedSenderHmacKey))
            .update(dataToHmac).digest();
          const receivedHmac = Buffer.from(cert.hmac, 'base64');

          if (!crypto.timingSafeEqual(expectedHmac, receivedHmac)) {
            throw new Error('Certificate HMAC invalid');
          }

          // P6 fix: Rate limit per certificate nonce
          // Each cert allows MAX_MESSAGES_PER_CERT messages before requiring a new PoW
          if (!checkCertRateLimit(cert.nonce, cert.expiry)) {
            throw new Error('Certificate message quota exceeded — obtain a new certificate');
          }

          // 3. Forward the INNER payload as send_sealed_message
          // ACTION 01+02: send_message has been REMOVED. Forward via send_sealed_message.
          // The Supabase RPC stores the payload without device_id.
          const supabaseResult = await forwardToSupabase('send_sealed_message', {
            p_tag: tag,
            p_sealed_content: inner.innerPayload,
            p_version: params.p_version || 1,
          });

          const sealedResp = encryptResponse(JSON.stringify(supabaseResult), ephemeralPubKey, usedSecretKey);
          console.log(`✅ send_sealed_message → unwrapped & forwarded (cert valid, tag: ${tag.slice(0, 12)}...)`);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(sealedResp));

        } catch (sealedErr) {
          console.error(`❌ send_sealed_message failed: ${sealedErr.message}`);
          const errResp = encryptResponse(
            JSON.stringify({ error: `Sealed sender: ${sealedErr.message}` }),
            ephemeralPubKey, usedSecretKey
          );
          res.writeHead(400, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(errResp));
        }
        return;
      }

      // Forward to Supabase
      const supabaseResult = await forwardToSupabase(request.rpc, request.params || {});

      // Encrypt the response
      const encryptedResponse = encryptResponse(
        JSON.stringify(supabaseResult),
        ephemeralPubKey, usedSecretKey
      );

      console.log(`✅ ${request.rpc} → ${supabaseResult.error ? 'error' : 'ok'} (${body.length}B in, ${encryptedResponse.length}B out)`);

      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(encryptedResponse));

    } catch (error) {
      if (error.message === 'Payload too large') {
        console.error('❌ Payload too large');
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large (max 22MB)' }));
      } else {
        console.error('❌ Relay error:', error.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    }
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ============================================
// STARTUP
// ============================================

loadKeys();
loadSealedSenderKeys();
startKeyRotation(); // ACTION 10: Schedule automatic key rotation

// P0: Initialize Key Transparency Merkle Tree
let ktTree = null;
function initKeyTransparency() {
  if (!createTransparencyTree) {
    console.warn('Key Transparency module not available — skipping init.');
    return;
  }
  let hmacKey;
  if (KT_HMAC_KEY) {
    hmacKey = Buffer.from(KT_HMAC_KEY, 'base64');
    if (hmacKey.length !== 32) {
      console.error('KT_HMAC_KEY must be 32 bytes (base64 encoded). Key Transparency DISABLED.');
      return;
    }
    console.log('KT HMAC key loaded from env.');
  } else {
    // Auto-generate ephemeral key. KT works but tree resets on restart.
    // In production, set KT_HMAC_KEY for persistent STH signatures.
    const crypto = require('crypto');
    hmacKey = crypto.randomBytes(32);
    console.log('KT_HMAC_KEY not set. Auto-generated ephemeral key.');
    console.log('   Tree will reset on restart. Set KT_HMAC_KEY for persistence.');
  }

  // Ensure persistence directory exists (/tmp is writable on Cloud Run)
  try {
    const fs = require('fs');
    if (!fs.existsSync(KT_PERSIST_PATH)) {
      fs.mkdirSync(KT_PERSIST_PATH, { recursive: true });
    }
  } catch (e) {
    console.warn('Could not create KT persist dir:', e.message, '- running in-memory only.');
  }

  try {
    ktTree = createTransparencyTree(hmacKey, KT_PERSIST_PATH);
    const stats = ktTree.getStats();
    console.log('Key Transparency: ' + stats.treeSize + ' keys, root: ' + (stats.rootHash ? stats.rootHash.slice(0, 16) + '...' : 'empty'));

    // Sign initial tree head
    if (stats.treeSize > 0) {
      ktTree.signTreeHead();
    }
  } catch (e) {
    console.error('Key Transparency init failed:', e.message, '- KT DISABLED.');
    ktTree = null;
  }
}
initKeyTransparency();

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set.');
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`🔒 GHOSTR OHTTP Gateway listening on port ${PORT}`);
  console.log(`   Supabase: ${SUPABASE_URL}`);
  console.log(`   Allowed RPCs: ${[...ALLOWED_RPCS].join(', ')}`);
});