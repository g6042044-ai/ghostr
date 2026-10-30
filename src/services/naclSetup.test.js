// Test de fillRandomBytes / getSecureRandomBytes (tâche 0.12).
//
// Reproduit le comportement natif d'expo-crypto 15 sur Android (SDK 54) :
// l'écriture dans un TypedArray applique le byteOffset deux fois. Toute vue
// décalée passée à crypto.getRandomValues est donc écrite hors du buffer,
// d'où le SIGSEGV à l'envoi d'un média. Ce test installe un getRandomValues
// qui simule exactement ce défaut (et lève là où le natif plantait) : le code
// corrigé ne doit jamais le déclencher, et la cible doit être entièrement
// remplie, sans déborder sur le préfixe (le ciphertext dans padToTier).
//
// Exécuté par `npm run test` (scripts/run-tests.js, chargeur load-ts.js).
'use strict';

const crypto = require('crypto');

// naclSetup.ts importe expo-crypto, qui exige React Native : on fournit un
// substitut minimal AVANT le chargement, par le cache de require.
{
  const expoCryptoPath = require.resolve('expo-crypto');
  require.cache[expoCryptoPath] = {
    id: expoCryptoPath,
    filename: expoCryptoPath,
    loaded: true,
    exports: { getRandomBytes: (n) => new Uint8Array(crypto.randomBytes(n)) },
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

// ── Simulation du natif Android défectueux ──────────────────────────────────
// Kotlin : typedArray.write(bytes, typedArray.byteOffset, byteLength)
// C++    : memcpy(rawPointer + position, …) avec rawPointer = data + byteOffset
// ⇒ écriture à data + 2 × byteOffset. Au-delà du buffer : SIGSEGV.
const calls = [];
function androidLikeGetRandomValues(arr) {
  if (!(arr instanceof Uint8Array)) throw new TypeError('Uint8Array attendu');
  if (arr.byteLength > 65536) throw new Error('QuotaExceededError (> 65536)');
  calls.push({ byteOffset: arr.byteOffset, byteLength: arr.byteLength });
  const whole = new Uint8Array(arr.buffer);
  const position = arr.byteOffset * 2; // le défaut
  if (position + arr.byteLength > whole.byteLength) {
    throw new Error(`SIGSEGV simulé : écriture à ${position}+${arr.byteLength} dans un buffer de ${whole.byteLength}`);
  }
  whole.set(crypto.randomBytes(arr.byteLength), position);
  return arr;
}
Object.defineProperty(globalThis, 'crypto', {
  value: { getRandomValues: androidLikeGetRandomValues },
  configurable: true, writable: true,
});

const { fillRandomBytes, getSecureRandomBytes } = require('./naclSetup.ts');
const nacl = require('tweetnacl');

function hasZeroRun(view, runLength) {
  let run = 0;
  for (let i = 0; i < view.length; i++) {
    run = view[i] === 0 ? run + 1 : 0;
    if (run >= runLength) return true;
  }
  return false;
}

// ── 1. Le cas réel : padToTier, ciphertext de 75 Ko dans un palier de 256 Ko ─
console.log('\n[1] Vue décalée (scénario padToTier) sur le natif Android simulé');
{
  calls.length = 0;
  const PREFIX = 75_000, TIER = 256 * 1024;
  const padded = new Uint8Array(TIER);
  padded.fill(0xAA, 0, PREFIX);
  let threw = null;
  try { fillRandomBytes(padded.subarray(PREFIX)); } catch (e) { threw = e; }
  check('aucun SIGSEGV simulé', threw === null, threw && threw.message);
  check('le natif ne reçoit que des vues à byteOffset 0', calls.every(c => c.byteOffset === 0),
    JSON.stringify(calls));
  check('tranches ≤ 64 Ko', calls.every(c => c.byteLength <= 65536));
  check('nombre d\'appels natifs = ceil(queue / 64 Ko) = 3', calls.length === Math.ceil((TIER - PREFIX) / 65536), String(calls.length));
  check('préfixe (ciphertext) intact', padded.subarray(0, PREFIX).every(b => b === 0xAA));
  check('queue entièrement remplie (aucune plage de 64 zéros)', !hasZeroRun(padded.subarray(PREFIX), 64));
  check('dernier octet de la queue écrit', padded[TIER - 1] !== 0 || padded[TIER - 2] !== 0);
}

// ── 2. Témoin : l'algorithme d'avant 0.12 plante sur le même scénario ──────
// Rejoue mot pour mot l'ancienne boucle (vues décalées données au natif).
// Les deux premières tranches débordent en silence (corruption mémoire),
// la troisième sort du buffer : c'est le SIGSEGV observé sur l'émulateur.
console.log('\n[2] Témoin : l\'ancien fillRandomBytes sur le natif Android simulé');
{
  const PREFIX = 75_000, TIER = 256 * 1024;
  const padded = new Uint8Array(TIER);
  const view = padded.subarray(PREFIX);
  let threw = null;
  try {
    let offset = 0;
    while (offset < view.byteLength) {
      const chunkSize = Math.min(65536, view.byteLength - offset);
      const slice = new Uint8Array(view.buffer, view.byteOffset + offset, chunkSize);
      globalThis.crypto.getRandomValues(slice);
      offset += chunkSize;
    }
  } catch (e) { threw = e; }
  check('SIGSEGV simulé levé', threw !== null && /SIGSEGV/.test(threw.message), threw && threw.message);
}

// ── 3. Tailles limites ──────────────────────────────────────────────────────
console.log('\n[3] Tailles limites');
{
  calls.length = 0;
  fillRandomBytes(new Uint8Array(0));
  check('0 octet : aucun appel natif', calls.length === 0);

  calls.length = 0;
  const one = new Uint8Array(1); fillRandomBytes(one);
  check('1 octet : 1 appel de 1', calls.length === 1 && calls[0].byteLength === 1);

  calls.length = 0;
  const exact = new Uint8Array(65536); fillRandomBytes(exact);
  check('65536 octets : 1 appel', calls.length === 1 && calls[0].byteLength === 65536);
  check('65536 octets remplis', !hasZeroRun(exact, 64));

  calls.length = 0;
  const plusOne = new Uint8Array(65537); fillRandomBytes(plusOne);
  check('65537 octets : 2 appels (65536 + 1)', calls.length === 2 && calls[0].byteLength === 65536 && calls[1].byteLength === 1,
    JSON.stringify(calls));
  check('65537e octet écrit (ou 65536e, aléa)', plusOne[65536] !== 0 || plusOne[65535] !== 0);
}

// ── 4. getSecureRandomBytes > 64 Ko (deuxième tranche décalée avant 0.12) ───
console.log('\n[4] getSecureRandomBytes au-delà d\'une tranche');
{
  calls.length = 0;
  const big = getSecureRandomBytes(100_000);
  check('longueur 100 000', big.length === 100_000);
  check('2 appels natifs à byteOffset 0', calls.length === 2 && calls.every(c => c.byteOffset === 0), JSON.stringify(calls));
  check('rempli de bout en bout', !hasZeroRun(big, 64));
  let threw = null;
  try { getSecureRandomBytes(0); } catch (e) { threw = e; }
  check('taille 0 refusée', threw !== null);
}

// ── 5. Le PRNG de TweetNaCl passe par fillRandomBytes ──────────────────────
console.log('\n[5] PRNG NaCl');
{
  calls.length = 0;
  const a = nacl.randomBytes(32), b = nacl.randomBytes(32);
  check('32 octets, deux tirages différents', a.length === 32 && b.length === 32 && !a.every((v, i) => v === b[i]));
  check('appels natifs à byteOffset 0', calls.every(c => c.byteOffset === 0));
  const kp = nacl.box.keyPair();
  check('nacl.box.keyPair fonctionne', kp.publicKey.length === 32 && kp.secretKey.length === 32);
}

console.log(`\n${pass} ok, ${fail} échec(s)`);
process.exit(fail === 0 ? 0 : 1);
