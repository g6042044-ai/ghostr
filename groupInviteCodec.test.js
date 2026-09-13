const codec = require('./groupInviteCodec.js');
const crypto = require('crypto');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}
const b64 = (n) => crypto.randomBytes(n).toString('base64');
const hex = (n) => crypto.randomBytes(n).toString('hex');

function makeBundle(withOpk) {
  const b = {
    v: 2,
    ik: b64(32),
    spk: { id: 7, pk: b64(32), sig: b64(64) },
    pqk: { id: 3, pk: b64(1184), sig: b64(64) },
  };
  if (withOpk) b.opk = { id: 42, pk: b64(32) };
  return b;
}

function makePayload(withOpk, name) {
  return {
    groupId: hex(16),
    ticketId: hex(16),
    ticketSecret: b64(32),
    bundleJson: JSON.stringify(makeBundle(withOpk)),
    name: name !== undefined ? name : 'Équipe Sécurité',
  };
}

// ── 1. Round-trip avec OPK ───────────────────────────────────────────────────
console.log('\n[1] Round-trip v4 avec one-time prekey');
{
  const p = makePayload(true);
  const enc = codec.encodeGroupInvite(p);
  const d = codec.decodeGroupInvite(enc);
  check('décodage non nul', d !== null);
  check('groupId', d.groupId === p.groupId, `${d && d.groupId} vs ${p.groupId}`);
  check('ticketId', d.ticketId === p.ticketId);
  check('ticketSecret', d.ticketSecret === p.ticketSecret);
  check('name', d.name === p.name);
  const a = JSON.parse(p.bundleJson), b = JSON.parse(d.bundleJson);
  check('bundle.v', b.v === 2);
  check('bundle.ik', a.ik === b.ik);
  check('bundle.spk.id', a.spk.id === b.spk.id);
  check('bundle.spk.pk', a.spk.pk === b.spk.pk);
  check('bundle.spk.sig', a.spk.sig === b.spk.sig);
  check('bundle.opk.id', a.opk.id === b.opk.id);
  check('bundle.opk.pk', a.opk.pk === b.opk.pk);
  check('bundle.pqk.id', a.pqk.id === b.pqk.id);
  check('bundle.pqk.pk', a.pqk.pk === b.pqk.pk);
  check('bundle.pqk.sig', a.pqk.sig === b.pqk.sig);
}

// ── 2. Round-trip sans OPK ───────────────────────────────────────────────────
console.log('\n[2] Round-trip v4 sans one-time prekey');
{
  const p = makePayload(false);
  const d = codec.decodeGroupInvite(codec.encodeGroupInvite(p));
  check('décodage non nul', d !== null);
  const b = JSON.parse(d.bundleJson);
  check('pas de champ opk', b.opk === undefined);
  check('pqk.pk préservé', b.pqk.pk === JSON.parse(p.bundleJson).pqk.pk);
}

// ── 3. Noms Unicode / vides / longs ──────────────────────────────────────────
console.log('\n[3] Noms de groupe');
for (const name of ['', 'A', 'Équipe 🔐 Sécurité — Ω', '日本語のグループ', 'x'.repeat(200)]) {
  const p = makePayload(true, name);
  const d = codec.decodeGroupInvite(codec.encodeGroupInvite(p));
  check(`nom "${name.slice(0, 20)}" (${Buffer.byteLength(name)} o)`, d !== null && d.name === name);
}

// ── 4. Taille réelle : v3 vs v4 ──────────────────────────────────────────────
console.log('\n[4] Taille de la charge utile');
{
  const p = makePayload(true);

  const v4 = codec.encodeGroupInvite(p);
  const v4url = 'https://theghostr.com/i#' + encodeURIComponent(v4);

  const v3obj = { v: 3, k: 'group', g: p.groupId, ti: p.ticketId, ts: p.ticketSecret, ab: p.bundleJson, n: p.name };
  const v3 = Buffer.from(JSON.stringify(v3obj), 'utf8').toString('base64');
  const v3url = 'https://theghostr.com/i#' + encodeURIComponent(v3);

  console.log(`     v3 base64        : ${v3.length} car.`);
  console.log(`     v3 URL finale    : ${v3url.length} car.   (capacité ECL-M = 2331, ECL-L = 2953)`);
  console.log(`     v4 base64        : ${v4.length} car.`);
  console.log(`     v4 URL finale    : ${v4url.length} car.`);
  console.log(`     réduction        : ${(100 * (1 - v4url.length / v3url.length)).toFixed(1)} %`);

  check('v3 dépassait ECL-L (donc QR impossible)', v3url.length > 2953, `${v3url.length}`);
  check('v4 tient en ECL-L', codec.qrFitsCapacity(v4url, 'L'), `${codec.qrPayloadByteLength(v4url)} o`);
  check('v4 tient en ECL-M', codec.qrFitsCapacity(v4url, 'M'), `${codec.qrPayloadByteLength(v4url)} o`);
}

// ── 5. Compatibilité descendante v3 ──────────────────────────────────────────
console.log('\n[5] Lecture des anciennes invitations v3');
{
  const p = makePayload(true);
  const v3obj = { v: 3, k: 'group', g: p.groupId, ti: p.ticketId, ts: p.ticketSecret, ab: p.bundleJson, n: p.name };
  const v3 = Buffer.from(JSON.stringify(v3obj), 'utf8').toString('base64');
  const d = codec.decodeGroupInvite(v3);
  check('v3 décodé', d !== null);
  check('v3 groupId', d && d.groupId === p.groupId);
  check('v3 bundle identique', d && d.bundleJson === p.bundleJson);
}

// ── 6. Robustesse : rien ne doit lever ───────────────────────────────────────
console.log('\n[6] Entrées hostiles ou étrangères (doivent retourner null, jamais lever)');
{
  const p = makePayload(true);
  const good = codec.encodeGroupInvite(p);
  const oneToOne = Buffer.from(JSON.stringify({ v: 2, t: hex(16), n: 'Alice' })).toString('base64');

  const cases = [
    ['null', null],
    ['undefined', undefined],
    ['chaîne vide', ''],
    ['texte brut', 'bonjour le monde'],
    ['base64 aléatoire', b64(64)],
    ['invitation 1:1', oneToOne],
    ['JSON non-groupe', Buffer.from('{"hello":1}').toString('base64')],
    ['v4 tronqué (moitié)', good.slice(0, Math.floor(good.length / 2))],
    ['v4 tronqué (1 car.)', good.slice(0, 1)],
    ['v4 + octets en trop', Buffer.concat([Buffer.from(good, 'base64'), Buffer.from([1, 2, 3])]).toString('base64')],
    ['numérique', 12345],
    ['objet', {}],
  ];
  for (const [label, input] of cases) {
    let threw = false, res;
    try { res = codec.decodeGroupInvite(input); } catch (e) { threw = true; }
    check(`${label} → null sans exception`, !threw && res === null, threw ? 'a levé' : `a retourné ${JSON.stringify(res && res.groupId)}`);
  }
  check('la bonne valeur décode toujours', codec.decodeGroupInvite(good) !== null);
}

// ── 7. Corruption d'un octet : ne doit pas planter ───────────────────────────
console.log('\n[7] Fuzz léger — corruption aléatoire d’un octet (200 essais)');
{
  const p = makePayload(true);
  const raw = Buffer.from(codec.encodeGroupInvite(p), 'base64');
  let crashes = 0, decoded = 0;
  for (let i = 0; i < 200; i++) {
    const c = Buffer.from(raw);
    const pos = crypto.randomInt(c.length);
    c[pos] = c[pos] ^ (1 << crypto.randomInt(8));
    try {
      const r = codec.decodeGroupInvite(c.toString('base64'));
      if (r) decoded++;
    } catch { crashes++; }
  }
  check('aucune exception sur 200 corruptions', crashes === 0, `${crashes} exceptions`);
  console.log(`     (${decoded}/200 corruptions restent structurellement décodables — normal, il n’y a pas de somme de contrôle : l’authenticité est garantie par les signatures Ed25519 du bundle, vérifiées par validatePQPreKeyBundle)`);
}

// ── 8. Rejet à l'encodage des entrées malformées ─────────────────────────────
console.log('\n[8] Encodage : rejet explicite des champs invalides');
{
  const bad = [
    ['groupId trop court', { ...makePayload(true), groupId: 'abcd' }],
    ['groupId non-hex', { ...makePayload(true), groupId: 'z'.repeat(32) }],
    ['ticketSecret mauvaise taille', { ...makePayload(true), ticketSecret: b64(16) }],
    ['bundle illisible', { ...makePayload(true), bundleJson: 'pas du json' }],
    ['bundle incomplet', { ...makePayload(true), bundleJson: JSON.stringify({ v: 2, ik: b64(32) }) }],
    ['ik mauvaise taille', { ...makePayload(true), bundleJson: JSON.stringify({ ...makeBundle(true), ik: b64(16) }) }],
    ['nom trop long', { ...makePayload(true, 'x'.repeat(600)) }],
  ];
  for (const [label, p] of bad) {
    let threw = false;
    try { codec.encodeGroupInvite(p); } catch { threw = true; }
    check(`${label} → lève`, threw);
  }
}

// ── 9. Format v5 (référence par tag serveur) ─────────────────────────────────
console.log('\n[9] Format v5 — QR court par tag');
{
  const p = makePayload(true);
  const tag = hex(16);
  const v5 = codec.encodeGroupInviteWithTag({
    groupId: p.groupId, ticketId: p.ticketId, ticketSecret: p.ticketSecret,
    bundleTag: tag, name: p.name,
  });
  const d = codec.decodeGroupInvite(v5);
  check('décodage non nul', d !== null);
  check('groupId', d && d.groupId === p.groupId);
  check('ticketId', d && d.ticketId === p.ticketId);
  check('ticketSecret', d && d.ticketSecret === p.ticketSecret);
  check('bundleTag', d && d.bundleTag === tag);
  check('name', d && d.name === p.name);
  check('bundleJson absent (à récupérer côté serveur)', d && d.bundleJson === undefined);

  const v5url = 'https://theghostr.com/i#' + encodeURIComponent(v5);
  const v4url = 'https://theghostr.com/i#' + encodeURIComponent(codec.encodeGroupInvite(p));
  console.log('     v5 base64     : ' + v5.length + ' car.');
  console.log('     v5 URL finale : ' + v5url.length + ' car.   (v4 = ' + v4url.length + ')');
  check('v5 tient en ECL-H (correction maximale)', codec.qrFitsCapacity(v5url, 'H'));
  check('v5 < 300 car. → QR basse densité', v5url.length < 300, String(v5url.length));
}

// ── 10. Discrimination des formats + robustesse v5 ───────────────────────────
console.log('\n[10] Discrimination v3/v4/v5 et robustesse');
{
  const p = makePayload(true);
  const tag = hex(16);
  const v5 = codec.encodeGroupInviteWithTag({
    groupId: p.groupId, ticketId: p.ticketId, ticketSecret: p.ticketSecret,
    bundleTag: tag, name: p.name,
  });
  const v4 = codec.encodeGroupInvite(p);
  const v3obj = { v: 3, k: 'group', g: p.groupId, ti: p.ticketId, ts: p.ticketSecret, ab: p.bundleJson, n: p.name };
  const v3 = Buffer.from(JSON.stringify(v3obj), 'utf8').toString('base64');

  const d5 = codec.decodeGroupInvite(v5);
  const d4 = codec.decodeGroupInvite(v4);
  const d3 = codec.decodeGroupInvite(v3);
  check('v5 → bundleTag seul', d5.bundleTag === tag && !d5.bundleJson);
  check('v4 → bundleJson seul', !!d4.bundleJson && !d4.bundleTag);
  check('v3 → bundleJson seul', !!d3.bundleJson && !d3.bundleTag);
  check('v3 et v4 donnent le même bundle', d3.bundleJson === d4.bundleJson);

  const raw = Buffer.from(v5, 'base64');
  let crashes = 0;
  for (let i = 0; i < 200; i++) {
    const c = Buffer.from(raw);
    const pos = crypto.randomInt(c.length);
    c[pos] = c[pos] ^ (1 << crypto.randomInt(8));
    try { codec.decodeGroupInvite(c.toString('base64')); } catch { crashes++; }
  }
  check('v5 : aucune exception sur 200 corruptions', crashes === 0, String(crashes));

  const badCases = [
    ['tag trop court', { groupId: p.groupId, ticketId: p.ticketId, ticketSecret: p.ticketSecret, bundleTag: 'abcd', name: 'x' }],
    ['tag non-hex', { groupId: p.groupId, ticketId: p.ticketId, ticketSecret: p.ticketSecret, bundleTag: 'z'.repeat(32), name: 'x' }],
    ['groupId invalide', { groupId: 'nope', ticketId: p.ticketId, ticketSecret: p.ticketSecret, bundleTag: tag, name: 'x' }],
  ];
  for (const [label, bad] of badCases) {
    let threw = false;
    try { codec.encodeGroupInviteWithTag(bad); } catch { threw = true; }
    check(label + ' → lève', threw);
  }
  check('v5 tronqué → null', codec.decodeGroupInvite(v5.slice(0, 20)) === null);
  check('v5 + octets en trop → null',
    codec.decodeGroupInvite(Buffer.concat([raw, Buffer.from([9, 9])]).toString('base64')) === null);
}

console.log('\n' + '='.repeat(60));
console.log(pass + ' réussis, ' + fail + ' échoués');
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
