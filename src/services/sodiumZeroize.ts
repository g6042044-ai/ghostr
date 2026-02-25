// src/services/sodiumZeroize.ts
// Abstraction pour zeroization sécurisée via libsodium
// Version 1.0
//
// POURQUOI CE MODULE:
// En JavaScript/Hermes/V8, Uint8Array.fill(0) peut être optimisé par le JIT
// (dead store elimination) car le compilateur voit que le buffer n'est plus lu
// après le fill. La technique du volatile sink dans primitives.ts mitigue ce
// risque, mais n'offre pas de GARANTIE formelle — c'est un best-effort.
//
// libsodium.memzero() utilise une implémentation C compilée en asm.js qui
// appelle sodium_memzero(), lequel est marqué comme "volatile" au niveau C.
// Le compilateur C ne peut pas éliminer cet appel. Le runtime JS ne peut pas
// non plus l'optimiser car c'est du code opaque (asm.js/WASM).
//
// RÉSULTAT: Garantie formelle d'effacement, pas seulement best-effort.
//
// ARCHITECTURE:
//   - initSodiumZeroize() doit être appelé au démarrage de l'app (async)
//   - sodiumMemzero() est synchrone après initialisation
//   - Si libsodium n'est pas disponible → retourne false, le fallback JS est utilisé
//   - isSodiumReady() permet de vérifier l'état à tout moment
//
// COMPATIBILITÉ REACT NATIVE:
//   libsodium-wrappers compile en asm.js (fallback si WASM indisponible),
//   compatible Hermes/JSC/V8 sans module natif.

// React Native global — défini par Metro bundler
declare const __DEV__: boolean;

// ============================================
// TYPES
// ============================================

interface SodiumLibrary {
  memzero: (buf: Uint8Array) => void;
  ready: Promise<void>;
}

// ============================================
// STATE
// ============================================

let _sodium: SodiumLibrary | null = null;
let _initPromise: Promise<boolean> | null = null;
let _ready = false;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialise libsodium pour le zeroize sécurisé.
 * Doit être appelé une seule fois au démarrage de l'app.
 *
 * @returns true si libsodium est chargé et prêt, false sinon.
 *
 * Idempotent: les appels suivants retournent le même résultat
 * sans ré-initialiser.
 */
export async function initSodiumZeroize(): Promise<boolean> {
  // Idempotent — retourne la même promesse si déjà lancé
  if (_initPromise !== null) {
    return _initPromise;
  }

  _initPromise = _doInit();
  return _initPromise;
}

async function _doInit(): Promise<boolean> {
  // Déclaré ici pour être accessible dans le catch
  const originalWarn = console.warn;
  try {
    // SUPPRESSION WARNING WASM:
    // libsodium tente de charger WebAssembly au démarrage. Sur Hermes (React Native),
    // WebAssembly n'existe pas → libsodium log un warning "Aborted(ReferenceError...)"
    // AVANT de retomber sur asm.js. Le warning est inoffensif mais pollue les logs.
    // On supprime temporairement console.warn pendant le chargement.
    console.warn = (...args: any[]) => {
      const msg = typeof args[0] === 'string' ? args[0] : '';
      if (msg.includes('WebAssembly') || msg.includes('Aborted')) return;
      originalWarn.apply(console, args);
    };
    
    // IMPORTANT: On pointe EXPLICITEMENT vers le build CJS.
    // Metro résout le champ "module" du package.json vers
    // dist/modules-esm/libsodium-wrappers.mjs qui importe "./libsodium.mjs"
    // — un import relatif que Metro ne sait pas résoudre (extensions .mjs
    // non listées dans le resolver par défaut de Hermes).
    //
    // Le build CJS (dist/modules/libsodium-wrappers.js) utilise require()
    // classique et fonctionne parfaitement sur React Native/Hermes.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sodium = require('libsodium-wrappers/dist/modules/libsodium-wrappers.js');

    // Restaurer console.warn APRÈS le require (qui est synchrone)
    // mais AVANT await sodium.ready (qui est async et pourrait aussi warn)
    // On attend ready avec le filtre encore actif, puis on restaure.
    await sodium.ready;
    
    console.warn = originalWarn;

    // Vérifier que memzero existe
    if (typeof sodium.memzero !== 'function') {
      console.warn('[SodiumZeroize] ⚠️ sodium.memzero not found — using JS fallback');
      return false;
    }

    // Test fonctionnel: vérifier que memzero efface réellement
    const testBuf = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    sodium.memzero(testBuf);
    const allZero = testBuf[0] === 0 && testBuf[1] === 0 && testBuf[2] === 0 && testBuf[3] === 0;

    if (!allZero) {
      console.warn('[SodiumZeroize] ⚠️ sodium.memzero self-test FAILED — using JS fallback');
      return false;
    }

    _sodium = sodium;
    _ready = true;

    if (__DEV__) {
      console.log('[SodiumZeroize] ✅ libsodium memzero ready (guaranteed zeroization)');
    }

    return true;
  } catch (err) {
    // Restaurer console.warn en cas d'erreur
    console.warn = originalWarn;
    // Pas de dépendance libsodium installée, ou erreur d'init.
    // Pas grave — le fallback JS dans primitives.ts prend le relais.
    if (__DEV__) {
      console.log(
        '[SodiumZeroize] ℹ️ libsodium-wrappers not available, using JS fallback.',
        (err as Error)?.message ?? err,
      );
    }
    return false;
  }
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Retourne true si libsodium est initialisé et prêt.
 */
export function isSodiumReady(): boolean {
  return _ready;
}

/**
 * Efface un buffer via sodium.memzero() si disponible.
 *
 * @returns true si sodium a été utilisé, false si fallback nécessaire.
 *
 * IMPORTANT: L'appelant (primitives.zeroize) doit TOUJOURS exécuter
 * le fallback JS si cette fonction retourne false, pour garantir
 * qu'un effacement a bien eu lieu même sans libsodium.
 */
export function sodiumMemzero(data: Uint8Array): boolean {
  if (!_ready || _sodium === null) {
    return false;
  }

  try {
    _sodium.memzero(data);
    return true;
  } catch {
    // Si memzero échoue (ex: buffer detached, SharedArrayBuffer non supporté),
    // retourner false pour que le fallback JS prenne le relais.
    return false;
  }
}

/**
 * Retourne des statistiques pour le debug/audit.
 */
export function getSodiumZeroizeStats(): {
  ready: boolean;
  backend: 'libsodium' | 'js-fallback';
} {
  return {
    ready: _ready,
    backend: _ready ? 'libsodium' : 'js-fallback',
  };
}