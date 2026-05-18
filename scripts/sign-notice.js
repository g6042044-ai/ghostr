#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// sign-notice.js
// ────────────────────────────────────────────────────────────────────────────
// Signe un payload d'avis (kill-switch) avec la clé Ed25519 hors-ligne.
// Sortie : la chaîne à coller dans la table `app_notice.signed_payload`.
//
// USAGE
//   1. Édite le bloc `payload` ci-dessous (titre, body, store, severity…).
//   2. Lance :
//        $ NOTICE_SECRET_KEY_B64="..." node scripts/sign-notice.js
//   3. Copie la requête SQL affichée et exécute-la dans Supabase SQL Editor.
//
// FORMAT DU PAYLOAD STOCKÉ
//   "<base64(canonical_json_payload)>.<base64(ed25519_signature_64bytes)>"
//
//   où canonical_json_payload = JSON.stringify avec clés triées récursivement,
//   sans aucun whitespace. La fonction `canonical()` ci-dessous produit
//   exactement les mêmes bytes que ceux que le client va vérifier après
//   décodage base64 du payload — la signature est valide bit-à-bit.
// ════════════════════════════════════════════════════════════════════════════

const nacl = require('tweetnacl');

// ── 1) Récupération de la clé secrète ──────────────────────────────────────
const SECRET_B64 = process.env.NOTICE_SECRET_KEY_B64;
if (!SECRET_B64) {
  console.error('❌ Set NOTICE_SECRET_KEY_B64 in your environment.');
  console.error('   Example:');
  console.error('     export NOTICE_SECRET_KEY_B64="ta_clef_secrete_base64"');
  console.error('     node scripts/sign-notice.js');
  process.exit(1);
}

let secretBytes;
try {
  secretBytes = Buffer.from(SECRET_B64, 'base64');
} catch (e) {
  console.error('❌ Invalid base64 in NOTICE_SECRET_KEY_B64.');
  process.exit(1);
}
if (secretBytes.length !== 64) {
  console.error('❌ Secret key must decode to 64 bytes (got ' + secretBytes.length + ').');
  console.error('   Use the SECRET output of scripts/generate-notice-keys.js.');
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════════════════
// 2) ÉDITE CE PAYLOAD AVANT DE SIGNER
// ════════════════════════════════════════════════════════════════════════════
//
// Champs :
//   v          : toujours 1 (réservé pour évolutions futures)
//   issued_at  : epoch seconds. Ne pas changer : Math.floor(Date.now()/1000).
//   expires_at : null ou epoch seconds. Si dépassé → l'avis ne s'affiche plus.
//   severity   : 'info' | 'warning' | 'critical'.
//                Critical = pas de bouton « Plus tard », overlay non-fermable.
//   title/body : maps locale → texte. Le client choisit selon i18n.language,
//                fallback 'en'. Ajoute autant de langues que tu veux.
//   store.ios  : doit commencer par https://apps.apple.com/
//   store.android : doit commencer par https://play.google.com/
//   (autres domaines = payload REJETÉ par le client)
// ════════════════════════════════════════════════════════════════════════════

const payload = {
  v: 1,
  issued_at: Math.floor(Date.now() / 1000),
  expires_at: null,
  severity: 'critical',
  title: {
    fr: 'Arrêtez d\'utiliser Ghostr',
    en: 'Stop using Ghostr',
    es: 'Deja de usar Ghostr',
    de: 'Verwende Ghostr nicht mehr',
    it: 'Smetti di usare Ghostr',
  },
  body: {
    fr: 'Cette version est compromise. Migrez votre compte et téléchargez TheGhostr pour continuer en sécurité.',
    en: 'This version is compromised. Migrate your account and download TheGhostr to stay secure.',
    es: 'Esta versión está comprometida. Migra tu cuenta y descarga TheGhostr para seguir seguro.',
    de: 'Diese Version ist kompromittiert. Migriere dein Konto und lade TheGhostr herunter.',
    it: 'Questa versione è compromessa. Migra il tuo account e scarica TheGhostr.',
  },
  store: {
    ios:     'https://apps.apple.com/app/idXXXXXXXXX',
    android: 'https://play.google.com/store/apps/details?id=com.theghostr',
  },
};

// ════════════════════════════════════════════════════════════════════════════
// 3) Canonicalisation récursive (clés triées, no whitespace)
// ════════════════════════════════════════════════════════════════════════════
function canonical(obj) {
  if (obj === null) return 'null';
  if (typeof obj === 'number') {
    // Évite les `1e21` etc. ; pour des epoch seconds on est tranquille.
    if (!Number.isFinite(obj)) throw new Error('Non-finite number in payload');
    return JSON.stringify(obj);
  }
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  }
  throw new Error('Unsupported type in payload: ' + typeof obj);
}

// ── 4) Validation pré-vol ──────────────────────────────────────────────────
function validate(p) {
  if (p.v !== 1) throw new Error('v must be 1');
  if (typeof p.issued_at !== 'number') throw new Error('issued_at must be a number');
  if (p.expires_at !== null && typeof p.expires_at !== 'number') {
    throw new Error('expires_at must be null or number');
  }
  if (!['info', 'warning', 'critical'].includes(p.severity)) {
    throw new Error('severity must be info | warning | critical');
  }
  if (!p.title || Object.keys(p.title).length === 0) throw new Error('title required');
  if (!p.body  || Object.keys(p.body).length === 0)  throw new Error('body required');
  // Store URLs
  const checkUrl = (u, prefix) => {
    if (!u) return;
    if (typeof u !== 'string' || !u.startsWith(prefix)) {
      throw new Error('Invalid store URL (must start with ' + prefix + '): ' + u);
    }
  };
  if (p.store) {
    checkUrl(p.store.ios,     'https://apps.apple.com/');
    checkUrl(p.store.android, 'https://play.google.com/');
  }
  if (!p.store || (!p.store.ios && !p.store.android)) {
    console.warn('⚠️  No store URL set — download buttons will be hidden.');
  }
}

try {
  validate(payload);
} catch (e) {
  console.error('❌ Payload validation failed: ' + e.message);
  process.exit(1);
}

// ── 5) Sign ────────────────────────────────────────────────────────────────
const canonicalStr = canonical(payload);
const payloadBytes = Buffer.from(canonicalStr, 'utf8');

if (payloadBytes.length > 6144) {
  console.error('❌ Payload too large (' + payloadBytes.length +
                ' bytes, max 6144). Shorten titles/bodies.');
  process.exit(1);
}

const sigBytes = nacl.sign.detached(payloadBytes, secretBytes);

const payloadB64 = payloadBytes.toString('base64');
const sigB64     = Buffer.from(sigBytes).toString('base64');
const finalStr   = payloadB64 + '.' + sigB64;

if (finalStr.length > 8192) {
  console.error('❌ Final signed payload exceeds 8192 chars (DB CHECK constraint).');
  process.exit(1);
}

// ── 6) Output ──────────────────────────────────────────────────────────────
console.log('');
console.log('════════════════════════════════════════════════════════════════');
console.log('  SIGNED PAYLOAD (' + finalStr.length + ' chars)');
console.log('════════════════════════════════════════════════════════════════');
console.log(finalStr);
console.log('');
console.log('════════════════════════════════════════════════════════════════');
console.log('  SQL TO RUN IN SUPABASE SQL EDITOR');
console.log('════════════════════════════════════════════════════════════════');
console.log('UPDATE public.app_notice');
console.log('SET signed_payload = \'' + finalStr + '\',');
console.log('    updated_at = now()');
console.log('WHERE id = 1;');
console.log('');
console.log('-- Vérifier :');
console.log('SELECT length(signed_payload), updated_at FROM public.app_notice WHERE id = 1;');
console.log('');
console.log('-- Pour révoquer l\'avis plus tard :');
console.log('-- UPDATE public.app_notice SET signed_payload = NULL, updated_at = now() WHERE id = 1;');
console.log('════════════════════════════════════════════════════════════════');
console.log('');
console.log('Payload summary:');
console.log('  severity   : ' + payload.severity);
console.log('  issued_at  : ' + new Date(payload.issued_at * 1000).toISOString());
console.log('  expires_at : ' + (payload.expires_at ? new Date(payload.expires_at * 1000).toISOString() : 'never'));
console.log('  languages  : ' + Object.keys(payload.title).join(', '));
console.log('  ios store  : ' + (payload.store?.ios     || '(none)'));
console.log('  android    : ' + (payload.store?.android || '(none)'));
console.log('');
