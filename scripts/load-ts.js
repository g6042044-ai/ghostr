// Charge des fichiers .ts dans Node sans étape de build ni dépendance
// supplémentaire : transpilation à la volée par le compilateur TypeScript
// déjà présent en devDependency. Aucune vérification de types ici, c'est le
// rôle de `npx tsc --noEmit`.
//
// Usage : node -r ./scripts/load-ts.js <script.js>, puis require('./x.ts').
'use strict';

const fs = require('fs');
const ts = require('typescript');

const COMPILER_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
};

require.extensions['.ts'] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: COMPILER_OPTIONS,
    fileName: filename,
    reportDiagnostics: false,
  });
  module._compile(outputText, filename);
};
