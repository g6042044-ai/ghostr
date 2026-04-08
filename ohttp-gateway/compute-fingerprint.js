#!/usr/bin/env node
// ohttp-gateway/compute-fingerprint.js
// R-03: Calcule l'empreinte SHA-256 d'une clé publique gateway pour le pinning.
//
// USAGE:
//   node compute-fingerprint.js <GATEWAY_PUBLIC_KEY_BASE64>
//
//   ou depuis le .env du gateway:
//   node compute-fingerprint.js $(grep GATEWAY_PUBLIC_KEY .env | cut -d= -f2)
//
// RÉSULTAT: Collez l'empreinte dans relayTransport.ts PINNED_GATEWAY_KEY_FINGERPRINTS.

const crypto = require('crypto');

const pubKeyB64 = process.argv[2];

if (!pubKeyB64) {
  console.error('Usage: node compute-fingerprint.js <GATEWAY_PUBLIC_KEY_BASE64>');
  console.error('');
  console.error('Example:');
  console.error('  node compute-fingerprint.js $(cat gateway_pubkey.b64)');
  process.exit(1);
}

let pubKeyBytes;
try {
  pubKeyBytes = Buffer.from(pubKeyB64.trim(), 'base64');
} catch (e) {
  console.error('Invalid base64:', e.message);
  process.exit(1);
}

if (pubKeyBytes.length !== 32) {
  console.error(`Invalid key length: ${pubKeyBytes.length} bytes (expected 32)`);
  process.exit(1);
}

const fingerprint = crypto.createHash('sha256').update(pubKeyBytes).digest('hex');

console.log('');
console.log('Gateway Key Fingerprint (SHA-256):');
console.log('  ' + fingerprint);
console.log('');
console.log('Add this to relayTransport.ts PINNED_GATEWAY_KEY_FINGERPRINTS:');
console.log('');
console.log("  ['gw-primary', new Set([");
console.log(`    '${fingerprint}', // Active key — generated ${new Date().toISOString().split('T')[0]}`);
console.log("  ])],");
console.log('');
console.log('Then set EXPO_PUBLIC_GATEWAY_PINNING_ENFORCED=true in your .env');