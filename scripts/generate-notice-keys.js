#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// generate-notice-keys.js
// ────────────────────────────────────────────────────────────────────────────
// Génère une paire Ed25519 pour signer les avis d'app (kill-switch).
//
// À EXÉCUTER UNE SEULE FOIS sur une machine de confiance (idéalement hors-
// ligne ou virtualisée). La clé secrète DOIT rester offline (gestionnaire
// de mots de passe, YubiKey, papier dans un coffre). Toute personne qui
// obtient cette clé peut afficher un message arbitraire à TOUS les
// utilisateurs de Ghostr — c'est la pire compromission possible.
//
// Utilise `tweetnacl` qui est déjà dans les dépendances du projet, donc :
//   $ cd ton_repo_ghostr
//   $ node scripts/generate-notice-keys.js
//
// (si tu veux le rendre encore plus paranoïaque, fais-le sur un Pi non
// connecté, ou dans un container Docker éphémère)
// ════════════════════════════════════════════════════════════════════════════

const nacl = require('tweetnacl');

const kp = nacl.sign.keyPair();
const pub = Buffer.from(kp.publicKey).toString('base64');
const sec = Buffer.from(kp.secretKey).toString('base64');

console.log('');
console.log('════════════════════════════════════════════════════════════════');
console.log('  GHOSTR APP NOTICE — Ed25519 keypair generated');
console.log('════════════════════════════════════════════════════════════════');
console.log('');
console.log('PUBLIC KEY (32 bytes, base64) — À EMBARQUER DANS L\'APP');
console.log('────────────────────────────────────────────────────────────────');
console.log(pub);
console.log('');
console.log('  → Coller dans : src/services/appNotice.ts');
console.log('  → Remplacer  : NOTICE_PUBKEY_B64 = \'REPLACE_ME_...\'');
console.log('  → Par        : NOTICE_PUBKEY_B64 = \'' + pub + '\'');
console.log('');
console.log('');
console.log('SECRET KEY (64 bytes, base64) — À GARDER OFFLINE, JAMAIS DANS LE REPO');
console.log('────────────────────────────────────────────────────────────────');
console.log(sec);
console.log('');
console.log('  ⚠️  Mets cette clé dans :');
console.log('       - un gestionnaire de mots de passe (1Password, Bitwarden)');
console.log('       - et/ou imprimée sur papier dans un coffre');
console.log('       - et/ou sur une YubiKey ou un Pi air-gappé');
console.log('  ⚠️  N\'envoie JAMAIS cette clé sur Supabase, GitHub, Slack, etc.');
console.log('  ⚠️  Si elle fuite, un attaquant peut phisher tous les utilisateurs.');
console.log('');
console.log('────────────────────────────────────────────────────────────────');
console.log('USAGE pour signer un avis :');
console.log('  $ NOTICE_SECRET_KEY_B64="' + sec.slice(0, 16) + '..." \\');
console.log('      node scripts/sign-notice.js');
console.log('════════════════════════════════════════════════════════════════');
console.log('');
