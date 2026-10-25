// Lance chaque fichier `*.test.js` sous src/ dans un processus Node séparé,
// avec le chargeur TypeScript de load-ts.js. Un test est un script ordinaire
// qui sort avec un code non nul en cas d'échec. Pas de framework : le projet
// n'en a pas et un seul fichier de test existe.
//
// Usage : npm run test
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const LOADER = path.join(__dirname, 'load-ts.js');

function findTests(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTests(full));
    else if (entry.name.endsWith('.test.js')) found.push(full);
  }
  return found.sort();
}

const tests = findTests(SRC);
if (tests.length === 0) {
  console.error('Aucun fichier *.test.js sous src/.');
  process.exit(1);
}

let failed = 0;
for (const file of tests) {
  console.log('\n### ' + path.relative(ROOT, file));
  const result = spawnSync(process.execPath, ['-r', LOADER, file], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) failed++;
}

console.log('\n' + tests.length + ' fichier(s) de test, ' + failed + ' en échec');
process.exit(failed === 0 ? 0 : 1);
