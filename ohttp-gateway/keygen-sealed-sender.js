#!/usr/bin/env node
// keygen-sealed-sender.js
// Generates the 3 keys needed for Sealed Sender (Audit Fix C-01):
//   1. SEALED_SENDER_SECRET_KEY — NaCl box secret key (decrypts sealed envelopes)
//   2. SEALED_SENDER_PUBLIC_KEY — NaCl box public key (distributed to clients)
//   3. SEALED_SENDER_HMAC_KEY  — HMAC-SHA256 key (issues & verifies anonymous certificates)
//
// Usage: node keygen-sealed-sender.js
//
// These keys are DISTINCT from the OHTTP gateway keys.
// Add them to your gateway's environment variables.

const nacl = require('tweetnacl');
const crypto = require('crypto');

console.log('🛡️  Generating Sealed Sender keys...\n');

// 1. NaCl box keypair for sealed envelope encryption
const sealedKeyPair = nacl.box.keyPair();
const sealedSecretB64 = Buffer.from(sealedKeyPair.secretKey).toString('base64');
const sealedPublicB64 = Buffer.from(sealedKeyPair.publicKey).toString('base64');

// 2. HMAC key for anonymous certificates
const hmacKey = crypto.randomBytes(32);
const hmacKeyB64 = hmacKey.toString('base64');

console.log('Add these to your gateway environment:\n');
console.log(`SEALED_SENDER_SECRET_KEY=${sealedSecretB64}`);
console.log(`SEALED_SENDER_PUBLIC_KEY=${sealedPublicB64}`);
console.log(`SEALED_SENDER_HMAC_KEY=${hmacKeyB64}`);
console.log('\n⚠️  Keep SEALED_SENDER_SECRET_KEY and SEALED_SENDER_HMAC_KEY secret!');
console.log('   SEALED_SENDER_PUBLIC_KEY is distributed to clients via GET /sealed-sender-key');
