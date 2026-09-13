// src/services/sealedSender.ts
// SEALED SENDER — Real Implementation
// Version 5.0 — Audit Fix C-01
//
// AVANT (vulnérable):
//   Le serveur voyait p_device_id (expéditeur) + p_tag (destinataire)
//   → Graphe social complet reconstructible.
//
// APRÈS (sealed sender):
//   Double chiffrement:
//     inner = message Triple Ratchet (E2E, inchangé)
//     outer = NaCl box(inner || senderCertificate, serverPubKey)
//   Le serveur déchiffre l'outer, vérifie le certificat anonyme,
//   route vers le tag, puis SUPPRIME l'outer. Il ne voit jamais l'expéditeur.
//
// CERTIFICAT ANONYME:
//   Le serveur délivre un certificat signé (HMAC) à chaque client.
//   Le certificat prouve "cet utilisateur est légitime" sans contenir d'identité.
//   Format: { nonce (random 32B), expiry, hmac(serverKey, nonce || expiry) }

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { secureRandomInt } from './crypto';
// P1-A1: SHA-256 pour le tag commitment
import { sha256 } from '@noble/hashes/sha256';

// ============================================
// TYPES
// ============================================

/**
 * Certificat anonyme prouvant que l'expéditeur est légitime
 * sans révéler son identité.
 */
export interface SenderCertificate {
  /** Nonce aléatoire 32 bytes (non-corrélé à l'identité) */
  nonce: string; // Base64
  /** Timestamp d'expiration (ms) */
  expiry: number;
  /** HMAC-SHA256(serverHmacKey, nonce || expiry) */
  hmac: string; // Base64
}

/**
 * Envelope sealed sender envoyée au serveur.
 * Le serveur voit UNIQUEMENT le tag destinataire + le blob opaque.
 */
export interface SealedSenderEnvelope {
  /** Version du protocole sealed sender */
  version: 1;
  /** Tag destinataire (epoch tag, visible au serveur pour routage) */
  tag: string;
  /**
   * Contenu chiffré avec NaCl box (clé publique du serveur).
   * Le serveur déchiffre, vérifie le certificat, route, puis SUPPRIME.
   * Wire format: [ephemeralPubKey(32)][nonce(24)][ciphertext]
   */
  sealedContent: string; // Base64
}

/**
 * Contenu interne du sealed_box (visible par le serveur pour routage uniquement).
 */
interface SealedSenderInner {
  /** Le payload Triple Ratchet chiffré E2E (opaque au serveur) */
  innerPayload: string;
  /** Certificat anonyme prouvant la légitimité de l'expéditeur */
  certificate: SenderCertificate;
  /** P1-A1: SHA-256(tag) — le gateway vérifie que ce commitment matche le tag de l'enveloppe */
  tagCommitment: string; // Hex
}

// ============================================
// STATE
// ============================================

let _currentCertificate: SenderCertificate | null = null;
let _serverSealedSenderPubKey: Uint8Array | null = null;
// Copie base64 de la clé serveur — conservée pour pouvoir persister le
// couple (certificat, clé) via les cache hooks sans ré-encoder les bytes.
let _serverSealedSenderPubKeyB64: string | null = null;

// ════════════════════════════════════════════════════════════════════════════
// OBSERVABLE STATE — pour que les composants React puissent réagir
// ════════════════════════════════════════════════════════════════════════════
// Pattern observer/subscriber léger (pas de dépendance externe). Permet à
// l'UI de désactiver/griser visuellement les boutons "Créer"/"Rejoindre"
// pendant que le SS bootstrap, et de réafficher dès qu'il est prêt — sans
// que chaque écran ait à re-call `ensureSealedSenderBootstrap()`.
//
// États possibles :
//   'idle'         — bootstrap pas encore tenté (cold start, post-unlock pré-boot)
//   'bootstrapping'— en cours (PoW + RPC certificat)
//   'ready'        — opérationnel, on peut envoyer
//   'failed'       — bootstrap a échoué, sera retenté au prochain envoi
//
// Note : 'ready' n'est PAS strictement équivalent à `isSealedSenderReady()`
// car le certificat peut expirer entre temps (24h de durée de vie). Pour
// décider d'envoyer, on utilise `isSealedSenderReady()` ; pour décider
// d'afficher un loader UI, on utilise cet état observable.
// ════════════════════════════════════════════════════════════════════════════

export type SealedSenderState = 'idle' | 'bootstrapping' | 'ready' | 'failed';

let _ssState: SealedSenderState = 'idle';
const _ssStateListeners = new Set<(s: SealedSenderState) => void>();

/**
 * Retourne l'état observable courant du sealed sender.
 * NB : pour décider d'envoyer un message, utiliser `isSealedSenderReady()`
 * (qui vérifie aussi l'expiration du certificat) — cet état est pour l'UI.
 */
export function getSealedSenderObservableState(): SealedSenderState {
  return _ssState;
}

/**
 * S'abonne aux changements d'état du sealed sender.
 * Le callback est appelé immédiatement avec l'état courant, puis à chaque
 * transition. Retourne une fonction de désabonnement.
 *
 * Usage React :
 * ```tsx
 * const [s, setS] = useState(getSealedSenderObservableState());
 * useEffect(() => subscribeSealedSenderState(setS), []);
 * ```
 */
export function subscribeSealedSenderState(
  cb: (state: SealedSenderState) => void
): () => void {
  _ssStateListeners.add(cb);
  // Émettre l'état courant immédiatement pour faciliter l'utilisation dans
  // useEffect (pas besoin de getState() séparé).
  try {
    cb(_ssState);
  } catch (e) {
    __DEV__ && console.warn('[SealedSender] subscriber threw on initial emit:', e);
  }
  return () => {
    _ssStateListeners.delete(cb);
  };
}

/**
 * Transitionne vers un nouvel état et notifie les abonnés.
 * Idempotent : ne notifie pas si l'état n'a pas changé.
 */
export function setSealedSenderObservableState(next: SealedSenderState): void {
  if (_ssState === next) return;
  __DEV__ && console.log(`[SealedSender] state: ${_ssState} → ${next}`);
  _ssState = next;
  // Itérer sur une copie pour permettre aux abonnés de se désabonner
  // pendant la notification sans corrompre l'itération.
  for (const cb of Array.from(_ssStateListeners)) {
    try {
      cb(next);
    } catch (e) {
      __DEV__ && console.warn('[SealedSender] listener threw:', e);
    }
  }
}

/**
 * Stocke le certificat anonyme reçu du serveur après authentification.
 */
export function setSenderCertificate(cert: SenderCertificate): void {
  _currentCertificate = cert;
  // Si on stocke un certificat valide et qu'on a aussi la clé serveur,
  // on est officiellement "ready" pour l'observateur.
  if (_serverSealedSenderPubKey !== null) {
    setSealedSenderObservableState('ready');
  }
}

/**
 * Retourne le certificat actuel ou null s'il est expiré/absent.
 */
export function getSenderCertificate(): SenderCertificate | null {
  if (!_currentCertificate) return null;
  if (Date.now() > _currentCertificate.expiry) {
    _currentCertificate = null;
    // L'expiration silencieuse fait basculer vers 'idle' :
    // un nouveau bootstrap sera nécessaire au prochain envoi.
    if (_ssState === 'ready') setSealedSenderObservableState('idle');
    return null;
  }
  return _currentCertificate;
}

/**
 * Invalide le certificat actuel (P6 fix).
 * Appelé lorsque le gateway rejette pour quota dépassé ou expiry.
 * Le prochain envoi déclenchera l'obtention d'un nouveau certificat via PoW.
 */
export function invalidateSenderCertificate(): void {
  _currentCertificate = null;
  // Un certificat rejeté par le gateway (quota/expiry) ne doit pas être
  // restauré au prochain cold start — purge du cache persisté.
  void _cacheHooks?.clear();
  if (_ssState === 'ready') setSealedSenderObservableState('idle');
}

/**
 * R-13: Efface TOUT l'état sealed sender lors du verrouillage de l'application.
 *
 * SÉCURITÉ: _serverSealedSenderPubKey est une clé publique NaCl X25519 (32 bytes).
 * Bien qu'une clé PUBLIQUE ne soit pas secrète, la laisser en mémoire après le
 * verrouillage permet à un attaquant ayant accès au process (ex: memory dump via ADB
 * sur un appareil rooté, ou exploitation d'une CVE JavaScript) de:
 *   - Identifier quelle instance gateway est utilisée (fingerprinting)
 *   - Préparer une attaque par substitution de clé si le verrou est levé
 *
 * Le certificat anonyme (_currentCertificate) contient:
 *   - Un nonce aléatoire de 32 bytes (identifiant de session gateway)
 *   - Un HMAC permettant au gateway de vérifier l'authenticité
 *   → Sa conservation en mémoire après lock expose l'identité de session.
 *
 * Après clearSealedSenderState(), les deux doivent être refetchés au déverrouillage.
 *
 * FIX BUG #4: clearSealedSenderState abort aussi le bootstrap en cours.
 * Sans ça, un bootstrap démarré juste avant le lock pouvait repeupler
 * _serverSealedSenderPubKey + _currentCertificate APRÈS le clear, recréant
 * une identité de session fantôme post-lock. L'incrément de génération
 * garantit en plus que tout setSenderCertificate tardif d'un bootstrap
 * "obsolète" sera ignoré au moment de l'application (voir _runBootstrapAttempt).
 */
export function clearSealedSenderState(): void {
  // 0. Purger le cache persisté (mode PIN : le certificat est éphémère par
  //    design R-13 ; couvre aussi la transition no-PIN → PIN).
  void _cacheHooks?.clear();
  // 1. Invalider la génération pour que tout bootstrap en flight termine en no-op
  _bootstrapGeneration++;
  // 2. Abort le controller (réveille les awaits dans le fetcher + retry loop)
  if (_bootstrapAbortController) {
    try { _bootstrapAbortController.abort(); } catch { /* noop */ }
    _bootstrapAbortController = null;
  }
  // 3. Casser la promesse partagée : le prochain ensureBootstrap démarrera un cycle propre
  _bootstrapPromise = null;
  // 4. Stopper le refresh timer (sinon il pourrait re-fetcher post-lock)
  if (_certificateRefreshTimer) {
    clearTimeout(_certificateRefreshTimer);
    _certificateRefreshTimer = null;
  }
  // 5. Zeroizer les bytes si possible (clé publique dans un Uint8Array)
  if (_serverSealedSenderPubKey) {
    try {
      _serverSealedSenderPubKey.fill(0);
    } catch {
      // Uint8Array potentiellement détaché (ArrayBuffer partagé) — ignorer
    }
    _serverSealedSenderPubKey = null;
  }
  _serverSealedSenderPubKeyB64 = null;
  // 6. Le certificat ne contient pas de Uint8Array — null suffit
  _currentCertificate = null;
  // 7. Repasser à 'idle' pour que les écrans réinitialisent leur UI au prochain unlock.
  setSealedSenderObservableState('idle');
}

/**
 * Définit la clé publique du serveur pour le sealed sender.
 * Distincte de la clé OHTTP gateway.
 */
export function setSealedSenderServerKey(pubKeyB64: string): void {
  _serverSealedSenderPubKey = decodeBase64(pubKeyB64);
  _serverSealedSenderPubKeyB64 = pubKeyB64;
}

/**
 * Vérifie si le sealed sender est opérationnel.
 */
export function isSealedSenderReady(): boolean {
  return _serverSealedSenderPubKey !== null && getSenderCertificate() !== null;
}

// ============================================
// BOOTSTRAP ORCHESTRATOR — Single source of truth
// ============================================
//
// HISTORIQUE :
//   Avant cette refonte, le bootstrap était piloté par 4 boucles de retry
//   indépendantes (App.tsx waitForSealedSender, écrans Create/Join,
//   ConversationList modal, send paths). Le singleton de promesse était dans
//   api1to1.ts. Les boucles foreground faisaient `resetSealedSenderBootstrap`
//   entre tentatives, ce qui pouvait :
//     • Casser la promesse partagée avec le bootstrap background en cours
//     • Créer deux bootstraps concurrents qui consommaient le MÊME PoW
//       (race sur l'invalidation post-await) → gateway 403 replay_detected
//     • Laisser `_ssState` désynchronisé avec la réalité (failed alors que
//       ready, ou ready alors qu'un clear a eu lieu pendant le bootstrap)
//
// NOUVELLE ARCHITECTURE :
//   Tout est ici. Le service expose UNE primitive idempotente :
//     ensureSealedSenderBootstrap() → Promise<boolean>
//   Avec :
//     • Singleton de promesse partagée
//     • Retry exponentiel borné (3 tentatives, ~15s max)
//     • AbortController pour annulation propre (lock, refresh, clear)
//     • Génération pour ignorer les résultats de bootstraps "périmés" qui
//       résoudraient APRÈS un clearSealedSenderState
//     • Application atomique clé+certificat (aucun await entre les deux)
//
//   Le fetcher PoW + RPC est injecté depuis api1to1.ts via
//   setSealedSenderCertificateFetcher (configuration unique au module load).
// ============================================

/** Durée avant renouvellement du certificat (marge de 10min avant expiry) */
const CERTIFICATE_REFRESH_MARGIN_MS = 10 * 60 * 1000;

/**
 * Délais exponentiels entre tentatives (ms).
 *   tentative 1 → 0ms     (immédiat)
 *   tentative 2 → 1.5s    (glitch réseau)
 *   tentative 3 → 4s      (gateway warming up)
 * Budget total ~15s en intégrant le temps d'attente effectif (PoW + RPC).
 * Si tout échoue, l'état passe à 'failed' et un futur appel reprendra
 * un cycle propre depuis 'idle' (transition synchrone à l'entrée).
 */
const BOOTSTRAP_RETRY_DELAYS_MS = [0, 1500, 4000] as const;

/**
 * Signature du fetcher injecté par api1to1.ts.
 * Doit renvoyer un certificat valide ou null en cas d'échec.
 * Doit honorer signal.aborted (court-circuiter PoW/RPC dès que possible).
 */
export type FetchCertificateFn =
  (signal: AbortSignal) => Promise<SenderCertificate | null>;

let _fetchCertificate: FetchCertificateFn | null = null;
let _bootstrapPromise: Promise<boolean> | null = null;
let _bootstrapAbortController: AbortController | null = null;
let _bootstrapGeneration = 0;
let _certificateRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Configure le fetcher de certificat. À appeler UNE FOIS au démarrage,
 * typiquement depuis api1to1.ts (qui possède la logique PoW + secureRpc).
 * Idempotent : appeler à nouveau remplace simplement la fonction.
 */
export function setSealedSenderCertificateFetcher(fn: FetchCertificateFn): void {
  _fetchCertificate = fn;
}

/**
 * Hooks de persistance du couple (certificat, clé SS) — injectés depuis
 * api1to1.ts (implémentation : sealedSenderCache.ts). Même pattern
 * d'injection que le fetcher : sealedSender.ts reste sans dépendance
 * stockage. Tous les hooks sont fire-and-forget et ne throw jamais.
 *
 * Sécurité : la POLITIQUE (chiffrement hardware, refus en mode PIN,
 * validation de forme, marge d'expiration) vit dans sealedSenderCache.ts —
 * ici on ne fait qu'appeler save/load/clear aux transitions d'état.
 */
export interface SealedSenderCacheHooks {
  load: () => Promise<{ cert: SenderCertificate; ssKeyB64: string } | null>;
  save: (cert: SenderCertificate, ssKeyB64: string) => Promise<void>;
  clear: () => Promise<void>;
}

let _cacheHooks: SealedSenderCacheHooks | null = null;

export function setSealedSenderCacheHooks(hooks: SealedSenderCacheHooks): void {
  _cacheHooks = hooks;
}

/**
 * Délai await-able qui se réveille à l'abort.
 * Ne throw jamais — retourne simplement plus tôt si signal aborted.
 */
async function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Exécute UNE tentative de bootstrap.
 *
 * @returns true si la tentative a réussi à appliquer une clé + un certificat valides.
 *          false si la tentative a échoué (network, PoW rejected, etc.) — l'appelant
 *          peut décider de retry.
 *
 * INVARIANT D'ATOMICITÉ :
 *   La clé serveur (`setSealedSenderServerKey`) et le certificat
 *   (`setSenderCertificate`) sont appliqués sans aucun `await` entre les
 *   deux. JS étant single-threaded, aucun `clearSealedSenderState` ne peut
 *   s'intercaler. La transition observable vers 'ready' se fait dans le
 *   même tour synchrone que `setSenderCertificate`.
 *
 * INVARIANT DE GÉNÉRATION :
 *   Avant d'appliquer le résultat, on vérifie que la génération n'a pas
 *   bougé. Si elle a bougé (clear pendant le bootstrap), on jette le
 *   résultat. Ceinture + bretelles vis-à-vis de l'AbortSignal.
 */
async function _runBootstrapAttempt(
  signal: AbortSignal,
  generation: number
): Promise<boolean> {
  // 1. Init relay (récupère manifests + SS key). Singleton dans relayTransport,
  //    donc gratuit si déjà initialisé.
  const { getSealedSenderKeyFromRelay, initRelay } = await import('./relayTransport');
  await initRelay();
  if (signal.aborted || generation !== _bootstrapGeneration) return false;

  const ssKeyB64 = getSealedSenderKeyFromRelay();
  if (!ssKeyB64) {
    __DEV__ && console.warn('[SealedSender] ❌ Sealed sender key not available from relay');
    return false;
  }

  // 2. Fetch certificat (PoW + secureRpc, injecté par api1to1)
  if (!_fetchCertificate) {
    __DEV__ && console.error(
      '[SealedSender] ❌ No certificate fetcher configured. ' +
      'Call setSealedSenderCertificateFetcher() at module init.'
    );
    return false;
  }
  const cert = await _fetchCertificate(signal);
  if (signal.aborted || generation !== _bootstrapGeneration) return false;
  if (!cert) {
    __DEV__ && console.warn('[SealedSender] ❌ Failed to obtain anonymous certificate');
    return false;
  }

  // 3. Application atomique (PAS d'await entre ces deux lignes) — voir invariant
  setSealedSenderServerKey(ssKeyB64);
  setSenderCertificate(cert); // transitionne 'bootstrapping' → 'ready' via l'observable

  // 4. Programme le renouvellement
  scheduleCertificateRefresh(cert.expiry);

  // 5. Persistance (fire-and-forget, no-op en mode PIN — cf. sealedSenderCache.ts)
  void _cacheHooks?.save(cert, ssKeyB64);

  __DEV__ && console.log(
    '[SealedSender] ✅ Bootstrap complete — sealed sender ACTIVE, cert expires:',
    new Date(cert.expiry).toISOString()
  );
  return true;
}

/**
 * Démarre (ou rejoint) un cycle de bootstrap.
 *
 * Comportement :
 *   • Si déjà prêt → Promise.resolve(true) immédiatement, aucun side-effect
 *   • Si un bootstrap est en cours → renvoie la MÊME promesse partagée
 *   • Sinon → démarre un nouveau cycle avec retry exponentiel interne
 *
 * La promesse est nullifiée à la fin (succès ou échec), permettant à un
 * appel ultérieur de relancer un cycle frais sans avoir à `reset` quoi
 * que ce soit.
 */
export function ensureSealedSenderBootstrap(): Promise<boolean> {
  // Fast path : déjà prêt
  if (isSealedSenderReady()) return Promise.resolve(true);

  // Bootstrap en cours : partage la promesse
  if (_bootstrapPromise) return _bootstrapPromise;

  // Garde de configuration
  if (!_fetchCertificate) {
    __DEV__ && console.error(
      '[SealedSender] ensureSealedSenderBootstrap called before setSealedSenderCertificateFetcher'
    );
    return Promise.resolve(false);
  }

  // Nouveau cycle : créer l'abort controller et capturer la génération
  _bootstrapAbortController = new AbortController();
  const signal = _bootstrapAbortController.signal;
  const generation = ++_bootstrapGeneration;

  // Transition synchrone vers 'bootstrapping'. Idempotent si déjà bootstrapping.
  // Note : on ne re-transitionne PAS depuis 'ready' (cas pathologique : si
  // isSealedSenderReady() était true on aurait fast-paté ; donc on est forcément
  // dans 'idle' ou 'failed' à ce point).
  setSealedSenderObservableState('bootstrapping');

  const promise = (async (): Promise<boolean> => {
    // ── Étape 0 : RESTAURATION DEPUIS LE CACHE PERSISTÉ (no-PIN) ──
    // Si un certificat chiffré valide (≥ 10 min restantes) existe sur
    // disque, on l'applique directement : zéro PoW, zéro réseau. La
    // validation (mode PIN, déchiffrement authentifié, forme, expiry)
    // est entièrement dans sealedSenderCache.ts. En cas d'échec ou de
    // cache absent, on retombe sur le bootstrap réseau normal.
    if (_cacheHooks) {
      try {
        const cached = await _cacheHooks.load();
        if (signal.aborted || generation !== _bootstrapGeneration) return false;
        if (cached) {
          // Application atomique (aucun await entre les deux) — même
          // invariant que _runBootstrapAttempt.
          setSealedSenderServerKey(cached.ssKeyB64);
          setSenderCertificate(cached.cert); // → 'ready' via l'observable
          scheduleCertificateRefresh(cached.cert.expiry);
          __DEV__ && console.log('[SealedSender] ✅ Bootstrap via persisted cache — PoW + RPC skipped');
          return true;
        }
      } catch (e) {
        __DEV__ && console.warn('[SealedSender] Cache restore failed, falling back to network bootstrap:', e);
      }
    }

    for (let attempt = 0; attempt < BOOTSTRAP_RETRY_DELAYS_MS.length; attempt++) {
      // Abort/clear pendant le précédent attempt → sortir immédiatement
      if (signal.aborted || generation !== _bootstrapGeneration) {
        return false;
      }

      // Backoff (sauf à la 1re tentative où delay=0)
      if (BOOTSTRAP_RETRY_DELAYS_MS[attempt] > 0) {
        __DEV__ && console.log(
          `[SealedSender] ⏳ Backoff ${BOOTSTRAP_RETRY_DELAYS_MS[attempt]}ms before attempt ${attempt + 1}`
        );
        await delayWithAbort(BOOTSTRAP_RETRY_DELAYS_MS[attempt], signal);
        if (signal.aborted || generation !== _bootstrapGeneration) return false;
      }

      try {
        __DEV__ && console.log(`[SealedSender] 🛡️ Bootstrap attempt ${attempt + 1}/${BOOTSTRAP_RETRY_DELAYS_MS.length}`);
        const ok = await _runBootstrapAttempt(signal, generation);
        if (ok) return true;
        // Tentative échouée mais pas d'exception → on continue la boucle
      } catch (e) {
        if (signal.aborted) return false;
        __DEV__ && console.warn(
          `[SealedSender] ⚠️ Bootstrap attempt ${attempt + 1} threw:`,
          e
        );
        // Continue avec la prochaine tentative
      }
    }
    // Tous les retries épuisés
    __DEV__ && console.error(
      `[SealedSender] ❌ Bootstrap FAILED after ${BOOTSTRAP_RETRY_DELAYS_MS.length} attempts`
    );
    return false;
  })();

  _bootstrapPromise = promise;

  // À la résolution (succès, échec, abort) : libérer le singleton et
  // ajuster l'état observable si on est encore "la génération active".
  promise.finally(() => {
    // Ne casser le singleton QUE s'il pointe encore vers cette promesse
    // (sinon on écrase un cycle plus récent — non, le test ===-promise
    // garantit qu'on ne casse pas un cycle nouveau).
    if (_bootstrapPromise === promise) {
      _bootstrapPromise = null;
      _bootstrapAbortController = null;
    }
    // Ajuster l'état observable seulement si on est encore le cycle "courant"
    // (i.e. la génération n'a pas bougé). Sinon, clearSealedSenderState ou un
    // nouveau bootstrap pilote déjà l'état.
    if (generation === _bootstrapGeneration) {
      if (isSealedSenderReady()) {
        // setSenderCertificate l'a déjà mis à 'ready' — idempotent
        if (_ssState !== 'ready') setSealedSenderObservableState('ready');
      } else if (!signal.aborted) {
        // Aucun cert posé ET pas annulé → vraie défaillance
        setSealedSenderObservableState('failed');
      } else {
        // Annulé proprement (clear) : 'idle' est déjà posé par clearSealedSenderState,
        // mais au cas où on annule via un autre chemin, on retombe sur 'idle'.
        if (_ssState === 'bootstrapping') setSealedSenderObservableState('idle');
      }
    }
  });

  return promise;
}

/**
 * Reset l'état du bootstrap sealed sender pour forcer un nouveau cycle.
 *
 * USAGE : escape hatch défensif. Avec la nouvelle architecture, le bootstrap
 * se reset automatiquement à la fin de chaque cycle (succès ou échec). Cette
 * fonction reste exposée pour le cas où un appelant veut explicitement
 * casser un cycle en cours (ex : avant un clear manuel).
 *
 * Préfère `ensureSealedSenderBootstrap()` ou `clearSealedSenderState()`
 * selon l'intention. Cette fonction est conservée pour la compatibilité
 * avec App.tsx.
 */
export function resetSealedSenderBootstrap(): void {
  if (_bootstrapAbortController) {
    try { _bootstrapAbortController.abort(); } catch { /* noop */ }
    _bootstrapAbortController = null;
  }
  _bootstrapPromise = null;
  // On NE touche PAS à la génération ici (clearSealedSenderState le fait)
  // ni aux clés en mémoire. C'est juste un reset du cycle d'orchestration.
}

/**
 * Programme le rafraîchissement du certificat.
 *
 * Stratégie : à T-10min de l'expiration, lance un fetch en arrière-plan.
 * Si le fetch réussit, le nouveau cert remplace l'ancien (sans rupture
 * de service). Sinon, on invalide et le prochain consommateur déclenchera
 * un bootstrap complet.
 */
function scheduleCertificateRefresh(expiry: number): void {
  if (_certificateRefreshTimer) clearTimeout(_certificateRefreshTimer);

  const refreshAt = expiry - CERTIFICATE_REFRESH_MARGIN_MS;
  const delayMs = Math.max(refreshAt - Date.now(), 60_000); // min 1 minute

  _certificateRefreshTimer = setTimeout(async () => {
    _certificateRefreshTimer = null;
    __DEV__ && console.log('[SealedSender] 🔄 Refreshing anonymous certificate...');

    // Si l'état a été clearé entre-temps, ne rien faire (sécurité)
    if (!_serverSealedSenderPubKey || !_fetchCertificate) {
      __DEV__ && console.log('[SealedSender] 🔄 Refresh skipped (state cleared)');
      return;
    }

    // Refresh indépendant du bootstrap principal : son propre AbortController
    // pour pouvoir l'annuler depuis clearSealedSenderState SANS interférer
    // avec un éventuel bootstrap principal concurrent. NB : le bootstrap
    // principal et le refresh ne sont normalement JAMAIS concurrents
    // (refresh n'est planifié qu'après un cert établi).
    const refreshCtrl = new AbortController();
    try {
      const cert = await _fetchCertificate(refreshCtrl.signal);
      if (cert && _serverSealedSenderPubKey) {
        setSenderCertificate(cert);
        scheduleCertificateRefresh(cert.expiry);
        // Rafraîchir aussi la copie persistée (no-op en mode PIN)
        if (_serverSealedSenderPubKeyB64) {
          void _cacheHooks?.save(cert, _serverSealedSenderPubKeyB64);
        }
        __DEV__ && console.log('[SealedSender] ✅ Certificate refreshed');
      } else {
        // Refresh failed → invalider. Le prochain envoi déclenchera un bootstrap.
        invalidateSenderCertificate();
        __DEV__ && console.warn('[SealedSender] ⚠️ Refresh failed, cert invalidated');
      }
    } catch (e) {
      invalidateSenderCertificate();
      __DEV__ && console.warn('[SealedSender] ⚠️ Refresh threw, cert invalidated:', e);
    }
  }, delayMs);
}

/**
 * Crée une enveloppe sealed sender.
 *
 * Le serveur ne verra que le tag destinataire + un blob opaque chiffré.
 * L'identité de l'expéditeur est masquée : seul le certificat anonyme
 * prouve la légitimité, sans lien avec l'identité.
 *
 * @param tag - Tag epoch destinataire (visible au serveur pour routage)
 * @param innerPayload - Payload Triple Ratchet chiffré E2E (opaque)
 * @returns Enveloppe sealed sender prête à envoyer
 */
/**
 * v25.0: OUTER PADDING TIERS — Normalisation des tailles au dernier point commun.
 *
 * PROBLÈME RÉSOLU:
 *   Les vrais messages et les decoys suivent deux pipelines différents:
 *     - Vrai: InnerPayload → addUniformPadding(2KB/8KB) → TR padMessage(4096/16384)
 *             → encryptAEAD → SealedPayload JSON ~5.8-6.4KB ou ~22-24.5KB
 *     - Decoy: génération directe de fake ciphertext calibré → SealedPayload ~5.9-6.5KB ou ~22-24.5KB
 *   → Malgré la calibration, de petites variations subsistent entre les deux pipelines.
 *
 * SOLUTION:
 *   Padder le SealedPayload JSON (innerPayload) DANS createSealedSenderEnvelope
 *   à des tiers FIXES avant le chiffrement nacl.box. Les deux pipelines
 *   convergent au même point → taille finale strictement identique.
 *
 * Tiers (calculés d'après les tailles réelles):
 *   - 12KB (12288): SealedPayloads de 5-12KB (texte court, receipts, signaux, decoys small)
 *   - 24KB (24576): SealedPayloads de 12-24.5KB (chunks média, texte long, decoys medium)
 *   - Fallback: prochain multiple de 12KB pour les cas rares (PQ rotation sur chunks ~26KB)
 *
 * Le serveur voit p_sealed_content de taille:
 *   - base64(12288 + ~440) ≈ 17KB pour les messages texte
 *   - base64(24576 + ~440) ≈ 33KB pour les chunks média
 *   → Impossible de distinguer vrai/decoy au sein d'un même tier.
 */
const SEALED_PAYLOAD_TIERS = [
  12 * 1024,     // 12 KB — texte court ~6KB, receipts, signaux, decoys small
  36 * 1024,     // 36 KB — chunks média ~23KB, texte long, decoys medium (v25.1: élargi de 24→36KB)
];

/**
 * Padde un SealedPayload JSON string à un tier fixe en ajoutant un champ `_p`.
 * Le récepteur ignore ce champ (il ne lit que type, version, data).
 *
 * Approche: manipulation directe du string JSON (pas de re-parse)
 * pour un contrôle exact de la taille en octets.
 */
function padSealedPayloadToTier(sealedPayloadStr: string): string {
  const currentSize = new TextEncoder().encode(sealedPayloadStr).length;
  
  // Trouver le tier cible
  const targetTier = SEALED_PAYLOAD_TIERS.find(tier => currentSize <= tier);
  
  if (!targetTier || currentSize >= targetTier) {
    // Déjà au-dessus du plus grand tier (ne devrait pas arriver avec le chunking)
    // Fallback: prochain multiple de 12KB
    const fallbackTier = Math.ceil(currentSize / (12 * 1024)) * (12 * 1024);
    return _applyPadding(sealedPayloadStr, currentSize, fallbackTier);
  }
  
  return _applyPadding(sealedPayloadStr, currentSize, targetTier);
}

function _applyPadding(json: string, currentBytes: number, targetBytes: number): string {
  // GH-13 fix: Parse JSON → add _p field → re-serialize for robustness
  // Overhead estimate: ,"_p":"" = 8 bytes min
  const overhead = 8;
  const padNeeded = targetBytes - currentBytes - overhead;
  
  if (padNeeded <= 0) return json;
  
  const padChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let padding = '';
  for (let i = 0; i < padNeeded; i++) {
    padding += padChars[secureRandomInt(padChars.length)];
  }
  
  // GH-13: Safe JSON manipulation — parse, add field, re-serialize
  try {
    const obj = JSON.parse(json);
    obj._p = padding;
    const result = JSON.stringify(obj);
    // Adjust if serialized size differs from estimate (due to escaping etc.)
    const resultBytes = new TextEncoder().encode(result).length;
    if (resultBytes > targetBytes) {
      // Trim padding to fit
      const excess = resultBytes - targetBytes;
      obj._p = padding.slice(0, Math.max(0, padding.length - excess));
      return JSON.stringify(obj);
    }
    return result;
  } catch (e) {
    // Si le JSON est invalide à ce stade, c'est un BUG en amont —
    // ne pas masquer avec du string manipulation qui pourrait produire
    // du JSON invalide et créer un side-channel de taille.
    __DEV__ && console.error('[SealedSender] CRITICAL: Invalid JSON in _applyPadding — this should never happen:', e);
    // Retourner sans padding : le message sera légèrement plus petit que le tier
    // mais au moins le JSON sera valide et déchiffrable.
    return json;
  }
}

export function createSealedSenderEnvelope(
  tag: string,
  innerPayload: string
): SealedSenderEnvelope {
  const cert = getSenderCertificate();
  if (!cert) {
    throw new Error('SealedSender: No valid sender certificate');
  }
  if (!_serverSealedSenderPubKey) {
    throw new Error('SealedSender: Server public key not set');
  }

  // v25.0: OUTER PADDING — normaliser la taille AVANT chiffrement
  // Tous les messages (vrais + decoys) passent par ici → même taille finale
  const paddedPayload = padSealedPayloadToTier(innerPayload);

  // Construire le contenu interne
  // P1-A1: Inclure SHA-256(tag) pour que le gateway vérifie la cohérence
  const tagBytes = new TextEncoder().encode(tag);
  const tagHash = sha256(tagBytes);
  const tagCommitment = Array.from(tagHash).map(b => b.toString(16).padStart(2, '0')).join('');

  const inner: SealedSenderInner = {
    innerPayload: paddedPayload,
    certificate: cert,
    tagCommitment,
  };

  const innerBytes = new TextEncoder().encode(JSON.stringify(inner));

  // Chiffrer avec NaCl box éphémère → le serveur ne peut pas
  // corréler la clé éphémère à un expéditeur.
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);

  const ciphertext = nacl.box(
    innerBytes,
    nonce,
    _serverSealedSenderPubKey,
    ephemeral.secretKey
  );

  if (!ciphertext) {
    throw new Error('SealedSender: Encryption failed');
  }

  // Wire format: [ephemeralPubKey(32)][nonce(24)][ciphertext]
  const sealedContent = new Uint8Array(32 + 24 + ciphertext.length);
  sealedContent.set(ephemeral.publicKey, 0);
  sealedContent.set(nonce, 32);
  sealedContent.set(ciphertext, 56);

  // Zeroize ephemeral secret key
  ephemeral.secretKey.fill(0);

  return {
    version: 1,
    tag,
    sealedContent: encodeBase64(sealedContent),
  };
}

// ============================================
// SEALED SENDER DECRYPTION (SERVER SIDE REFERENCE)
// ============================================
// Ce code est pour référence / tests. En production, le déchiffrement
// se fait côté serveur (Gateway ou Supabase Edge Function).

/**
 * Déchiffre une enveloppe sealed sender (côté serveur).
 *
 * @param envelope - Enveloppe sealed sender
 * @param serverSecretKey - Clé privée NaCl du serveur (32 bytes)
 * @param serverHmacKey - Clé HMAC pour vérifier les certificats (32 bytes)
 * @returns Le payload intérieur ou null si invalide
 */
export function openSealedSenderEnvelope(
  envelope: SealedSenderEnvelope,
  serverSecretKey: Uint8Array,
  serverHmacKey: Uint8Array
): { innerPayload: string; valid: boolean } | null {
  try {
    const sealedContent = decodeBase64(envelope.sealedContent);

    if (sealedContent.length < 32 + 24 + 16) {
      return null;
    }

    const ephemeralPubKey = sealedContent.slice(0, 32);
    const nonce = sealedContent.slice(32, 56);
    const ciphertext = sealedContent.slice(56);

    const plaintext = nacl.box.open(
      ciphertext,
      nonce,
      ephemeralPubKey,
      serverSecretKey
    );

    if (!plaintext) {
      return null;
    }

    const inner: SealedSenderInner = JSON.parse(
      new TextDecoder().decode(plaintext)
    );

    // Vérifier expiration du certificat
    if (Date.now() > inner.certificate.expiry) {
      return { innerPayload: inner.innerPayload, valid: false };
    }

    // Vérifier HMAC(serverHmacKey, nonce || expiry)
    // Ceci utilise @noble/hashes côté serveur
    const { hmac } = require('@noble/hashes/hmac');
    const { sha256 } = require('@noble/hashes/sha256');

    const certNonce = decodeBase64(inner.certificate.nonce);
    const expiryBytes = new Uint8Array(8);
    new DataView(expiryBytes.buffer).setBigUint64(
      0,
      BigInt(inner.certificate.expiry),
      false
    );

    const dataToHmac = new Uint8Array(certNonce.length + expiryBytes.length);
    dataToHmac.set(certNonce, 0);
    dataToHmac.set(expiryBytes, certNonce.length);

    const expectedHmac = hmac(sha256, serverHmacKey, dataToHmac);
    const receivedHmac = decodeBase64(inner.certificate.hmac);

    // Comparaison en temps constant
    let diff = 0;
    const len = Math.max(expectedHmac.length, receivedHmac.length);
    for (let i = 0; i < len; i++) {
      diff |= (expectedHmac[i] || 0) ^ (receivedHmac[i] || 0);
    }

    return {
      innerPayload: inner.innerPayload,
      valid: diff === 0 && expectedHmac.length === receivedHmac.length,
    };
  } catch {
    return null;
  }
}

// ============================================
// DÉLAI ALÉATOIRE (anti-timing, conservé)
// ============================================

/**
 * Calcule un délai aléatoire CSPRNG pour masquer les patterns temporels
 */
export function getRandomDelay(minMs: number = 0, maxMs: number = 3000): number {
  const range = maxMs - minMs;
  if (range <= 0) return minMs;
  return minMs + secureRandomInt(range);
}

/**
 * Attend un délai aléatoire
 */
export async function randomDelay(
  minMs: number = 0,
  maxMs: number = 3000
): Promise<void> {
  const delay = getRandomDelay(minMs, maxMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

// ============================================
// MODE FANTÔME (conservé)
// ============================================

export interface GhostModeConfig {
  enabled: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  coalescingWindowMs: number;
}

export const DEFAULT_GHOST_MODE: GhostModeConfig = {
  enabled: false,
  minDelayMs: 0,
  maxDelayMs: 3000,
  coalescingWindowMs: 0,
};

export const PARANOID_GHOST_MODE: GhostModeConfig = {
  enabled: true,
  minDelayMs: 5000,
  maxDelayMs: 30000,
  coalescingWindowMs: 10000,
};

export async function applyGhostModeDelay(
  config: GhostModeConfig
): Promise<void> {
  if (!config.enabled) {
    return;
  }
  await randomDelay(config.minDelayMs, config.maxDelayMs);
}