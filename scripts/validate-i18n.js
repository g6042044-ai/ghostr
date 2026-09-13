#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// validate-i18n.js
// ────────────────────────────────────────────────────────────────────────────
// Vérifie que TOUT ce qui s'affiche dans l'app existe dans les 8 langues.
//
//   $ node scripts/validate-i18n.js        (ou : npm run i18n:check)
//
// Sort en code 1 si un contrôle bloquant échoue — utilisable en pre-commit/CI.
//
// CONTRÔLES BLOQUANTS
//   1. Chaque clé `t('…')` littérale du code existe dans les 8 bundles
//      (formes plurielles `_plural` / `_0…_5` comprises).
//   2. Parité des clés entre chaque bundle et en.json (référence de schéma).
//   3. Placeholders `{{…}}` identiques à ceux d'en.json.
//   4. Aucune valeur vide.
//   5. Tout repli littéral (`t('cle', 'repli')` ou `defaultValue:`) est
//      IDENTIQUE à la valeur d'en.json. Un repli qui diverge ment sur ce que
//      l'app affiche ; un repli en français rend surtout un trou de traduction
//      invisible depuis une session française (le français s'affiche alors
//      dans les 8 langues — c'est le bug qu'avait `conversation.tapToRetry`).
//
// AVERTISSEMENTS (non bloquants)
//   6. Valeurs identiques à l'anglais dans une langue à script non latin
//      (ar, ru, ur) : traduction probablement oubliée.
//   7. Clés définies mais jamais référencées littéralement (peuvent être des
//      clés construites dynamiquement : `t(\`terms.${key}Title\`)`).
// ════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RES_DIR = path.join(ROOT, 'src/i18n/resources');
const SRC_DIRS = [path.join(ROOT, 'src')];
const EXTRA_FILES = [path.join(ROOT, 'App.tsx')];
const REFERENCE = 'en';
/** Langues dont le script d'écriture n'est pas latin (contrôle n°6). */
const NON_LATIN = { ar: /[؀-ۿ]/, ur: /[؀-ۿ]/, ru: /[Ѐ-ӿ]/ };
/** Valeurs volontairement non traduites : marque, protocoles, produits. */
const ALLOWED_UNTRANSLATED = /^(Ghostr|OK|QR|PIN|Admin|Spam|Audio|Video|Photo|Contact|File|Status|System|Scanner|Code|Password|Privacy|Smileys|GENERAL|PRIVACY|Triple Ratchet|X25519|ML-KEM-768|OHTTP|Argon2id|Triple Ratchet · X25519 · ML-KEM-768|Argon2id \(64 MiB\)|iCloud Drive, Google Drive, Proton Drive…|v\{\{version\}\}|📎 \{\{name\}\}|\{\{count\}\} min|online)$/;

let errors = 0;
let warnings = 0;
const fail = (msg) => { errors++; console.error('  ✗ ' + msg); };
const warn = (msg) => { warnings++; console.warn('  ! ' + msg); };

// ── Chargement des bundles ──────────────────────────────────────────────────
const langs = fs.readdirSync(RES_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
const flat = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
};
const bundles = {};
for (const lang of langs) {
  bundles[lang] = flat(JSON.parse(fs.readFileSync(path.join(RES_DIR, `${lang}.json`), 'utf8')));
}
if (!bundles[REFERENCE]) { console.error(`Bundle de référence ${REFERENCE}.json introuvable`); process.exit(1); }

const PLURAL_SUFFIXES = ['_plural', '_0', '_1', '_2', '_3', '_4', '_5'];
const baseKey = (k) => k.replace(/_(plural|[0-5])$/, '');
const hasKey = (lang, key) =>
  key in bundles[lang] || PLURAL_SUFFIXES.some(s => (key + s) in bundles[lang]);

// ── Collecte des clés utilisées dans le code ────────────────────────────────
const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'resources') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) acc.push(p);
  }
  return acc;
};
const files = [...SRC_DIRS.flatMap(d => walk(d)), ...EXTRA_FILES].filter(f => fs.existsSync(f));

const used = new Map();               // clé littérale → première occurrence
const fallbacks = [];                 // { key, text, where } — replis littéraux

for (const file of files) {
  const rel = path.relative(ROOT, file);
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    // `t(…)` et les helpers locaux qui l'enrobent (`tr(…)` d'ErrorBoundary).
    const re = /\b(?:t|tr)\(\s*(['"])((?:[^'"\\]|\\.)*)\1\s*(,\s*(.*))?/g;
    let m;
    while ((m = re.exec(line))) {
      const key = m[2];
      if (key.includes('${')) continue;                       // clé construite
      if (!used.has(key)) used.set(key, `${rel}:${i + 1}`);
      const rest = m[4] || '';
      const dv = rest.match(/defaultValue:\s*(['"`])((?:[^'"`\\]|\\.)*)\1/)
              || rest.match(/^\s*(['"`])((?:[^'"`\\]|\\.)*)\1/);
      if (dv) fallbacks.push({ key, text: dv[2], where: `${rel}:${i + 1}` });
    }
    // `defaultValue:` isolé sur sa ligne (objet d'options multi-lignes) : le
    // `t(` est alors plusieurs lignes plus haut, hors de portée du motif ci-dessus.
    if (!/\bt\(/.test(line)) {
      const lone = line.match(/defaultValue:\s*(['"`])((?:[^'"`\\]|\\.)*)\1/);
      if (lone) fallbacks.push({ key: null, text: lone[2], where: `${rel}:${i + 1}` });
    }
  });
}

// ── 1. Clés utilisées présentes partout ─────────────────────────────────────
console.log(`\n[1/7] Clés utilisées dans le code : ${used.size}`);
for (const lang of langs) {
  const missing = [...used.keys()].filter(k => !hasKey(lang, k));
  for (const k of missing) fail(`[${lang}] clé manquante : ${k}  (${used.get(k)})`);
}

// ── 2. Parité avec la référence ─────────────────────────────────────────────
console.log(`[2/7] Parité des bundles avec ${REFERENCE}.json`);
const refKeys = Object.keys(bundles[REFERENCE]);
for (const lang of langs) {
  if (lang === REFERENCE) continue;
  for (const k of refKeys) {
    if (!(k in bundles[lang]) && !hasKey(lang, baseKey(k))) fail(`[${lang}] absente : ${k}`);
  }
  for (const k of Object.keys(bundles[lang])) {
    if (!(k in bundles[REFERENCE]) && !(baseKey(k) in bundles[REFERENCE])) fail(`[${lang}] clé orpheline : ${k}`);
  }
}

// ── 3. Placeholders ─────────────────────────────────────────────────────────
console.log('[3/7] Cohérence des placeholders {{…}}');
const placeholders = (s) => (String(s).match(/\{\{[^}]+\}\}/g) || []).sort().join(',');
for (const lang of langs) {
  if (lang === REFERENCE) continue;
  for (const k of refKeys) {
    if (!(k in bundles[lang])) continue;
    const a = placeholders(bundles[REFERENCE][k]);
    const b = placeholders(bundles[lang][k]);
    if (a !== b) fail(`[${lang}] ${k} : placeholders [${b}] ≠ [${a}]`);
  }
}

// ── 4. Valeurs vides ────────────────────────────────────────────────────────
console.log('[4/7] Valeurs vides');
for (const lang of langs) {
  for (const [k, v] of Object.entries(bundles[lang])) {
    if (typeof v === 'string' && !v.trim()) fail(`[${lang}] valeur vide : ${k}`);
  }
}

// ── 5. Replis conformes à en.json ───────────────────────────────────────────
console.log('[5/7] Replis (defaultValue) identiques à en.json');
for (const { key, text, where } of fallbacks) {
  if (key === null) {
    // Repli sans clé rattachable (objet multi-lignes) : on ne peut pas le
    // comparer, mais il est de toute façon superflu si la clé existe partout.
    fail(`repli non rattachable à une clé, à supprimer : ${where}  '${text.slice(0, 45)}'`);
    continue;
  }
  const ref = bundles[REFERENCE][key];
  if (ref === undefined) continue;                       // signalé par le contrôle 1
  if (text !== ref) fail(`repli ≠ en.json : ${where}  t('${key}', '${text.slice(0, 45)}')  — en.json dit "${String(ref).slice(0, 45)}"`);
}

// ── 6. Traductions probablement oubliées ────────────────────────────────────
console.log('[6/7] Valeurs restées en anglais (scripts non latins)');
for (const [lang, scriptRe] of Object.entries(NON_LATIN)) {
  if (!bundles[lang]) continue;
  for (const [k, v] of Object.entries(bundles[lang])) {
    if (typeof v !== 'string' || !/[A-Za-z]{3}/.test(v) || scriptRe.test(v)) continue;
    if (ALLOWED_UNTRANSLATED.test(v.trim())) continue;
    warn(`[${lang}] non traduite ? ${k} = "${v.slice(0, 60)}"`);
  }
}

// ── 7. Clés jamais référencées ──────────────────────────────────────────────
console.log('[7/7] Clés définies mais jamais référencées littéralement');
const unused = refKeys.filter(k => !used.has(k) && !used.has(baseKey(k)));
if (unused.length) warn(`${unused.length}/${refKeys.length} clés sans référence littérale (clés dynamiques possibles)`);

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(70));
console.log(`Langues : ${langs.join(', ')}  |  ${refKeys.length} clés de référence`);
console.log(`${errors} erreur(s), ${warnings} avertissement(s)`);
if (errors) {
  console.error('\nVALIDATION i18n : ÉCHEC\n');
  process.exit(1);
}
console.log('\nVALIDATION i18n : OK\n');
