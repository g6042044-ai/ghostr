// src/services/proofOfWork.ts
// PROOF-OF-WORK — Hashcash-style anti-spam for certificate issuance
// Version 1.0 — Audit Fix CRITIQUE-03
//
// Le gateway exige une preuve de travail avant de délivrer un certificat
// sealed sender. Cela empêche le spam massif de certificats (DoS).
//
// Algorithme:
//   1. Client génère un challenge = SHA-256(timestamp || random)
//   2. Client cherche un nonce tel que SHA-256(challenge || nonce) commence
//      par N zéros (difficulté). ~200ms sur mobile pour N=16.
//   3. Le serveur vérifie en O(1) : hash et vérifie les zéros.
//
// Anti-replay:
//   - Le challenge inclut un timestamp. Le serveur rejette si |now - timestamp| > 5 min.
//   - Le serveur maintient un Set des challenges récents pour empêcher la réutilisation.

import { sha256 } from '@noble/hashes/sha256';

// ════════════════════════════════════════════════════════════════════════════
// SHA-256 NATIF (react-native-quick-crypto) — accélération de la boucle PoW
// ════════════════════════════════════════════════════════════════════════════
// PROBLÈME : les ~260k itérations SHA-256 de la recherche de nonce tournaient
// en JS pur (@noble/hashes) sur Hermes (pas de JIT) : 1.5s théorique, 3-30s
// réel sous contention CPU. C'était LA cause du blocage « Préparation de la
// connexion sécurisée » au cold start.
//
// SOLUTION : react-native-quick-crypto expose createHash('sha256') en C++
// pur via JSI/Nitro — appel SYNCHRONE sans traversée de pont, buffers
// partagés par référence. La boucle passe à quelques centaines de ms.
//
// SÉCURITÉ :
//   • Même algorithme, même difficulté, même format — le gateway ne voit
//     aucune différence. Aucun paramètre de sécurité n'est modifié.
//   • SELF-TEST à la première résolution : on vérifie le module natif
//     contre un vecteur de test FIPS 180-2 (sha256("abc")), y compris sur
//     un subarray décalé (les vues sont le hot path de la boucle). S'il
//     échoue, absent (ex: bundle JS poussé avant rebuild natif) ou throw,
//     on retombe sur @noble/hashes — jamais de PoW invalide soumis.
//   • require() lazy et try/catch : zéro impact si le module n'est pas
//     linké (l'app reste 100% fonctionnelle, juste plus lente).
// ════════════════════════════════════════════════════════════════════════════

type Sha256Fn = (data: Uint8Array) => Uint8Array;

let _nativeSha256: Sha256Fn | null | undefined; // undefined = pas encore résolu

function resolveSha256(): Sha256Fn {
  if (_nativeSha256 !== undefined) return _nativeSha256 ?? sha256;
  try {
    const qc = require('react-native-quick-crypto');
    const createHash = qc?.createHash ?? qc?.default?.createHash;
    if (typeof createHash !== 'function') {
      _nativeSha256 = null;
      return sha256;
    }
    const nativeHash: Sha256Fn = (data: Uint8Array) => {
      const d = createHash('sha256').update(data).digest();
      // digest() renvoie un Buffer (sous-classe de Uint8Array) — normaliser
      return d instanceof Uint8Array ? d : new Uint8Array(d);
    };
    // Self-test : sha256("abc") = vecteur FIPS 180-2, passé en subarray
    // décalé pour valider le respect de byteOffset/byteLength des vues.
    const probe = new Uint8Array([0x00, 0x61, 0x62, 0x63, 0x00]);
    const digest = nativeHash(probe.subarray(1, 4));
    const expected = sha256(probe.subarray(1, 4));
    let ok = digest.length === expected.length;
    if (ok) {
      for (let i = 0; i < expected.length; i++) {
        if (digest[i] !== expected[i]) { ok = false; break; }
      }
    }
    if (!ok) {
      __DEV__ && console.warn('[PoW] Native SHA-256 self-test FAILED — falling back to @noble/hashes');
      _nativeSha256 = null;
      return sha256;
    }
    __DEV__ && console.log('[PoW] ⚡ Native SHA-256 active (react-native-quick-crypto)');
    _nativeSha256 = nativeHash;
    return nativeHash;
  } catch {
    __DEV__ && console.log('[PoW] Native SHA-256 unavailable — using @noble/hashes (pure JS)');
    _nativeSha256 = null;
    return sha256;
  }
}

// ============================================
// CONSTANTS
// ============================================

/**
 * PoW difficulty: 18 bits = ~260K iterations = ~1-1.5 second on mobile (pure JS SHA-256).
 * Combined with CF Worker IP rate limiting (30/min) + cert quota (100 msgs/cert),
 * this provides strong anti-spam.
 *
 * Trade-offs:
 *   16 bits = ~65K iter = <500ms mobile, but ~0.0003ms on GPU (trivial)
 *   18 bits = ~260K iter = ~1-1.5s mobile (acceptable: 1x per hour), ~0.001ms on GPU (4× harder)
 *   20 bits = ~1M iter = ~3-5s mobile (noticeable), ~0.005ms on GPU
 *   22 bits = ~4M iter = ~80s on Hermes (unusable)
 *
 * Audit fix: increased from 16 → 18 bits. The PoW is computed ONCE per certificate
 * (valid 1 hour), so ~1.5s once/hour is imperceptible to the user.
 * The async yielding (setTimeout every 50K iterations) prevents UI freezing.
 *
 * GATEWAY COMPAT: The gateway must accept difficulty >= 16 during migration
 * (old clients still send 16-bit PoW). See ohttp-gateway/server.js.
 */
export const POW_DIFFICULTY_BITS = 18;

/** Fenêtre de validité du timestamp (±5 minutes) */
export const POW_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

// ============================================
// CLIENT SIDE — Compute PoW
// ============================================

export interface ProofOfWork {
  /** Timestamp (ms) inclus dans le challenge */
  timestamp: number;
  /** Random 16 bytes hex, inclus dans le challenge */
  salt: string;
  /** Nonce trouvé (nombre) */
  nonce: number;
  /** Difficulté utilisée (bits de zéro) */
  difficulty: number;
}

/**
 * Calcule une preuve de travail de manière ASYNCHRONE.
 *
 * Yield au thread UI toutes les BATCH_SIZE itérations pour ne pas
 * bloquer les animations (~30ms par batch sur mobile).
 *
 * @param difficulty - Nombre de bits de zéro en tête (default: POW_DIFFICULTY_BITS)
 * @returns ProofOfWork prête à envoyer au serveur
 */
export async function computeProofOfWork(
  difficulty: number = POW_DIFFICULTY_BITS
): Promise<ProofOfWork> {
  const timestamp = Date.now();

  const saltBytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(saltBytes);
  } else {
    throw new Error('PoW: crypto.getRandomValues unavailable — cannot generate secure salt');
  }
  const salt = Array.from(saltBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // PERF FIX: Pre-allocate a single mutable buffer instead of creating
  // 3 objects per iteration (toString + TextEncoder + new Uint8Array).
  // This eliminates GC pressure and is ~10x faster on Hermes/mobile.
  const prefix = `${timestamp}:${salt}:`;
  const prefixBytes = new TextEncoder().encode(prefix);
  const prefixLen = prefixBytes.length;
  const maxNonceDigits = 10; // supports nonce up to 9,999,999,999
  const buffer = new Uint8Array(prefixLen + maxNonceDigits);
  buffer.set(prefixBytes, 0);

  // Pre-compute difficulty check values (avoid function call per iteration)
  const fullZeroBytes = Math.floor(difficulty / 8);
  const remainingBits = difficulty % 8;
  const remainingMask = remainingBits > 0 ? (0xFF << (8 - remainingBits)) : 0;

  // ──────────────────────────────────────────────────────────────────────
  // BATCH_SIZE — compromis temps total vs réactivité UI
  // ──────────────────────────────────────────────────────────────────────
  // Le PoW tourne en JS sur le thread principal (pas de Worker en RN). Entre
  // chaque batch, on yield via setTimeout(0). Cette pause libère le JS thread
  // pendant ~16-20ms — fenêtre dans laquelle les événements UI (frappes
  // clavier, animations Animated avec native driver, layout, etc.) peuvent
  // s'exécuter.
  //
  // SUR HERMES (React Native) :
  //   Hermes n'a PAS le JIT TurboFan de V8. Les opérations numériques et
  //   le SHA-256 itératif tournent 3-10× plus lentement que sur V8 (Chrome).
  //
  // PROBLÈME OBSERVÉ EN PROD (avant fix) :
  //   Sur device Hermes en cold start, le PoW pouvait prendre 30-60s+ à
  //   cause de la CONTENTION CPU avec :
  //     • startGlobalPolling1to1 (constant traffic + invite watcher + global poll)
  //     • secureRpc OHTTP double-hop (encrypts + decrypts request/response)
  //     • Décryption des messages entrants
  //     • AsyncStorage I/O
  //   Chaque setTimeout(0) yield laissait passer 2-3 microtasks de polling avant
  //   que la prochaine batch ne reprenne.
  //
  // FIX EN DEUX PARTIES :
  //   1. Polling DIFFÉRÉ jusqu'au bootstrap (api1to1.ts startGlobalPolling1to1)
  //      → CPU dégagé pour le PoW initial
  //   2. BATCH_SIZE 5_000 → 10_000 : 2× moins de yields = 2× moins
  //      d'opportunités d'être starvé par les microtasks restantes
  //      (notamment InviteWatcher qui poll en parallèle).
  //
  // CHOIX DE 10_000 :
  //   • Sur device Hermes typique : ~220ms par batch (vs 110ms à 5k)
  //   • ~26 batches pour 260k iterations (vs 52 à 5k)
  //   • Yield overhead: 26 × 20ms = 520ms (vs 1040ms à 5k) → -520ms total
  //   • UI freeze 220ms : juste sous le seuil de perceptibilité humaine
  //     en saisie clavier (~300ms). Toujours fluide pour PIN.
  //   • Test sur PIN 6 chiffres : ~3 freezes pendant la frappe, à peine
  //     perceptible. À 25k (550ms), ça devient clairement laggy.
  //
  // NE PAS DESCENDRE EN-DESSOUS DE 5_000 ni MONTER AU-DESSUS DE 25_000
  // SANS BENCHMARK DEVICE.
  // ──────────────────────────────────────────────────────────────────────
  const BATCH_SIZE = 10_000;
  let nonce = 0;
  const startedAt = Date.now();
  let lastProgressLog = startedAt;

  // Résolution du hasher UNE fois avant la boucle (natif si sain, sinon
  // @noble). Avec le natif, un batch de 10k passe de ~220ms à ~10-30ms —
  // les yields restent en place pour le fallback JS et coûtent peu.
  const hashFn = resolveSha256();

  while (true) {
    const batchEnd = nonce + BATCH_SIZE;
    while (nonce < batchEnd) {
      // Write nonce digits directly into the pre-allocated buffer (ZERO allocation)
      let n = nonce;
      let digitCount: number;
      if (n === 0) {
        buffer[prefixLen] = 48; // ASCII '0'
        digitCount = 1;
      } else {
        let temp = n;
        digitCount = 0;
        while (temp > 0) { digitCount++; temp = (temp / 10) | 0; }
        let pos = prefixLen + digitCount - 1;
        temp = n;
        while (temp > 0) {
          buffer[pos--] = 48 + (temp % 10);
          temp = (temp / 10) | 0;
        }
      }

      // Hash the exact slice — subarray creates a view, not a copy
      const hash = hashFn(buffer.subarray(0, prefixLen + digitCount));

      // Inline difficulty check (avoid function call overhead)
      let valid = true;
      for (let i = 0; i < fullZeroBytes; i++) {
        if (hash[i] !== 0) { valid = false; break; }
      }
      if (valid && remainingBits > 0 && (hash[fullZeroBytes] & remainingMask) !== 0) {
        valid = false;
      }
      if (valid) {
        return { timestamp, salt, nonce, difficulty };
      }

      nonce++;
    }

    // Progress diagnostic toutes les 10s pour debug device lent
    const now = Date.now();
    if (__DEV__ && now - lastProgressLog > 10_000) {
      console.log(
        `[PoW] Progress: nonce=${nonce}, elapsed=${now - startedAt}ms (still searching for ${difficulty}-bit valid hash)`
      );
      lastProgressLog = now;
    }

    // Yield to event loop
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

/**
 * Vérifie une preuve de travail (utilisable côté client pour tests).
 */
export function verifyProofOfWork(
  pow: ProofOfWork,
  maxTimestampDriftMs: number = POW_TIMESTAMP_WINDOW_MS
): boolean {
  // Check timestamp window
  const now = Date.now();
  if (Math.abs(now - pow.timestamp) > maxTimestampDriftMs) {
    return false;
  }

  // Recompute hash
  const input = new TextEncoder().encode(
    `${pow.timestamp}:${pow.salt}:${pow.nonce}`
  );
  const hash = sha256(input);

  return hasLeadingZeroBits(hash, pow.difficulty);
}

// ============================================
// HELPERS
// ============================================

/**
 * Vérifie que les N premiers bits d'un hash sont à zéro.
 */
function hasLeadingZeroBits(hash: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;

  // Check full zero bytes
  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }

  // Check remaining bits in the next byte
  if (remainingBits > 0) {
    const mask = 0xFF << (8 - remainingBits); // e.g. bits=3 → mask=0xE0
    if ((hash[fullBytes] & mask) !== 0) return false;
  }

  return true;
}