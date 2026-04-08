// push-proxy/keygen.js
// Génère les clés NaCl du Push Proxy et le secret partagé Gateway↔Proxy
//
// Usage: node keygen.js
//
// Sortie: les variables d'environnement à configurer sur le Push Proxy et le Gateway

const nacl = require('tweetnacl');
const crypto = require('crypto');

// 1. Clé NaCl box du Push Proxy (pour chiffrer/déchiffrer les push tokens)
const proxyKeyPair = nacl.box.keyPair();
const proxySecretKeyB64 = Buffer.from(proxyKeyPair.secretKey).toString('base64');
const proxyPublicKeyB64 = Buffer.from(proxyKeyPair.publicKey).toString('base64');

// 2. Secret partagé Gateway ↔ Push Proxy (pour authentifier les requêtes internes)
const gatewaySharedSecret = crypto.randomBytes(32).toString('hex');

console.log('=== GHOSTR PUSH PROXY — GENERATED KEYS ===\n');

console.log('--- Push Proxy server (.env) ---');
console.log(`PUSH_PROXY_SECRET_KEY=${proxySecretKeyB64}`);
console.log(`PUSH_PROXY_PUBLIC_KEY=${proxyPublicKeyB64}`);
console.log(`GATEWAY_SHARED_SECRET=${gatewaySharedSecret}`);
console.log('');

console.log('--- Gateway server (.env) — add these ---');
console.log(`PUSH_PROXY_URL=https://your-push-proxy-host:3200`);
console.log(`PUSH_PROXY_PUBLIC_KEY=${proxyPublicKeyB64}`);
console.log(`PUSH_PROXY_SHARED_SECRET=${gatewaySharedSecret}`);
console.log('');

console.log('--- Client app (.env) — add this ---');
console.log(`EXPO_PUBLIC_PUSH_PROXY_PUBLIC_KEY=${proxyPublicKeyB64}`);
console.log('');

console.log('⚠️  SAVE THESE VALUES SECURELY. The secret key and shared secret');
console.log('   should NEVER be committed to version control or shared publicly.');