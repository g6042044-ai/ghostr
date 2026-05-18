// src/services/appNotice.ts
// ════════════════════════════════════════════════════════════════════════════
// APP NOTICE — Avis de dépréciation / kill-switch contrôlé à distance.
// ════════════════════════════════════════════════════════════════════════════
//
// OBJECTIF
//   Permettre d'afficher un message critique à tous les utilisateurs sans
//   release de l'app — typiquement « Cette version est compromise, migrez
//   votre compte vers TheGhostr ».
//
// MODÈLE DE SÉCURITÉ
//   Le serveur Supabase est explicitement NON-CONFIANCE pour ce contenu. Le
//   payload est signé Ed25519 avec une clé dont la moitié privée vit hors-
//   ligne (jamais sur serveur, jamais dans le repo). La clé publique est
//   embarquée dans le bundle. Un attaquant qui obtient l'accès à Supabase ne
//   peut PAS afficher un avis arbitraire — sa modification sera rejetée par
//   la vérification de signature côté client.
//
// FORMAT DU PAYLOAD STOCKÉ EN BDD
//   "<base64(canonical_json_payload)>.<base64(ed25519_signature_64bytes)>"
//
//   où canonical_json_payload = JSON.stringify avec clés triées
//                               récursivement, sans whitespace.
//
// CARACTÉRISTIQUES PERFORMANCE
//   - Bootstrap lancé au module load (parallèle avec les autres prefetch).
//   - Lecture AsyncStorage du cache en arrière-plan (~5ms), montre
//     instantanément un avis déjà vu (mode offline OK).
//   - Fetch RPC en arrière-plan avec timeout 5s — JAMAIS attendu par le
//     render principal. Si réseau KO, on garde le cache.
//   - Coût steady-state : 0 (early return dans le composant si pas d'avis).
//
// RÉVOCATION
//   Mettre `signed_payload = NULL` dans la table app_notice. Le client
//   purge son cache au prochain fetch réussi et l'overlay disparaît.
// ════════════════════════════════════════════════════════════════════════════

import AsyncStorage from '@react-native-async-storage/async-storage';
import nacl from 'tweetnacl';
import { decodeBase64, encodeUTF8 } from 'tweetnacl-util';
import { secureRpc } from './relayTransport';

// ════════════════════════════════════════════════════════════════════════════
// CLÉ PUBLIQUE DE VÉRIFICATION
// ════════════════════════════════════════════════════════════════════════════
// ⚠️ À REMPLACER par la clé publique générée via `scripts/generate-notice-keys.js`.
// La clé privée correspondante DOIT rester offline (coffre-fort, YubiKey,
// papier). Tant que cette constante vaut la valeur placeholder ci-dessous,
// AUCUN avis ne pourra être affiché (la vérification rejette tout).
//
// Pour révoquer la clé compromise : générer une nouvelle paire, mettre la
// nouvelle clé publique ici, et publier une nouvelle release de l'app.
// ════════════════════════════════════════════════════════════════════════════
const NOTICE_PUBKEY_B64 = 'xxO4ajUxE8xFYQmfaAGg3kaDqibZaclV95Wy88+3VR4=';

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ════════════════════════════════════════════════════════════════════════════
const CACHE_KEY = 'app_notice_v1';
const FETCH_TIMEOUT_MS = 5000;
const MAX_AGE_MS = 90 * 24 * 3600 * 1000; // Rejet des payloads > 90 jours (anti-replay).
const PAYLOAD_VERSION = 1;

// Domaines de store autorisés. Tout autre domaine fait rejeter le payload.
// Prévient un attaquant qui aurait la clé Supabase ET la clé privée de
// signature d'orienter les utilisateurs vers un site malveillant — il devrait
// au moins compromettre un compte développeur sur Apple/Google.
const ALLOWED_STORE_HOSTS = new Set<string>([
  'apps.apple.com',
  'play.google.com',
]);

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════
export type NoticeSeverity = 'info' | 'warning' | 'critical';

export interface AppNotice {
  /** Sévérité — pilote la couleur et la possibilité de fermer */
  severity: NoticeSeverity;
  /** Map locale → texte. Le client choisit la locale courante avec fallback 'en'. */
  title: Record<string, string>;
  /** Map locale → texte */
  body: Record<string, string>;
  /** URLs des stores (HTTPS, domaines whitelistés uniquement) */
  store: { ios?: string; android?: string };
  /** Timestamp d'émission (epoch seconds) — utilisé pour le debug */
  issued_at: number;
}

// ════════════════════════════════════════════════════════════════════════════
// ÉTAT MODULE — pattern listener identique à InAppNotification
// ════════════════════════════════════════════════════════════════════════════
let currentNotice: AppNotice | null = null;
let bootstrapStarted = false;
let pubKeyBytes: Uint8Array | null = null;

const listeners = new Set<(n: AppNotice | null) => void>();

function getPubKey(): Uint8Array | null {
  if (pubKeyBytes) return pubKeyBytes;
  try {
    const bytes = decodeBase64(NOTICE_PUBKEY_B64);
    if (bytes.length !== 32) {
      __DEV__ && console.error('[AppNotice] Invalid public key length:', bytes.length);
      return null;
    }
    pubKeyBytes = bytes;
    return bytes;
  } catch (e) {
    __DEV__ && console.error('[AppNotice] Public key decode error:', e);
    return null;
  }
}

function emit(n: AppNotice | null): void {
  currentNotice = n;
  for (const cb of listeners) {
    try {
      cb(n);
    } catch (e) {
      __DEV__ && console.error('[AppNotice] listener error:', e);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// API PUBLIQUE
// ════════════════════════════════════════════════════════════════════════════

export function getCurrentAppNotice(): AppNotice | null {
  return currentNotice;
}

export function subscribeAppNotice(cb: (n: AppNotice | null) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Sélectionne le texte localisé. Fallback en cascade :
 *   1. locale exacte (ex: "fr")
 *   2. langue de base (ex: "fr-CA" → "fr")
 *   3. "en"
 *   4. première valeur disponible
 */
export function pickLocalized(map: Record<string, string>, locale: string): string {
  if (!map) return '';
  if (map[locale]) return map[locale];
  const base = locale.split('-')[0];
  if (base !== locale && map[base]) return map[base];
  if (map.en) return map.en;
  const first = Object.values(map)[0];
  return first ?? '';
}

// ════════════════════════════════════════════════════════════════════════════
// VÉRIFICATION + PARSING
// ════════════════════════════════════════════════════════════════════════════

function isValidStoreUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  if (!url.startsWith('https://')) return false;
  try {
    // RN ne fournit pas l'API URL standard partout ; on parse manuellement.
    const afterScheme = url.slice('https://'.length);
    const slash = afterScheme.indexOf('/');
    const host = (slash < 0 ? afterScheme : afterScheme.slice(0, slash)).toLowerCase();
    return ALLOWED_STORE_HOSTS.has(host);
  } catch {
    return false;
  }
}

function verifyAndParse(raw: string): AppNotice | null {
  const pub = getPubKey();
  if (!pub) return null;

  try {
    const dot = raw.indexOf('.');
    if (dot < 0 || dot === raw.length - 1) return null;

    const payloadB64 = raw.slice(0, dot);
    const sigB64 = raw.slice(dot + 1);

    let payloadBytes: Uint8Array;
    let sigBytes: Uint8Array;
    try {
      payloadBytes = decodeBase64(payloadB64);
      sigBytes = decodeBase64(sigB64);
    } catch {
      return null;
    }
    if (sigBytes.length !== 64) return null;
    if (payloadBytes.length === 0 || payloadBytes.length > 8192) return null;

    if (!nacl.sign.detached.verify(payloadBytes, sigBytes, pub)) {
      __DEV__ && console.warn('[AppNotice] Signature verification failed — rejected.');
      return null;
    }

    // Le payload est UTF-8 du JSON canonique.
    let parsed: any;
    try {
      parsed = JSON.parse(encodeUTF8(payloadBytes));
    } catch {
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null) return null;
    if (parsed.v !== PAYLOAD_VERSION) {
      __DEV__ && console.warn('[AppNotice] Unsupported payload version:', parsed.v);
      return null;
    }

    if (typeof parsed.issued_at !== 'number') return null;
    const ageMs = Date.now() - parsed.issued_at * 1000;
    // Tolérance future de 24h (clock skew). Rejet si trop ancien (replay).
    if (ageMs > MAX_AGE_MS) {
      __DEV__ && console.warn('[AppNotice] Payload too old — replay rejected.');
      return null;
    }
    if (ageMs < -24 * 3600 * 1000) {
      __DEV__ && console.warn('[AppNotice] Payload from too far future — rejected.');
      return null;
    }

    // Expiration optionnelle
    if (parsed.expires_at != null) {
      if (typeof parsed.expires_at !== 'number') return null;
      if (parsed.expires_at * 1000 < Date.now()) {
        return null; // Avis expiré, on retourne null silencieusement.
      }
    }

    const severity: NoticeSeverity =
      parsed.severity === 'info' || parsed.severity === 'critical' ? parsed.severity : 'warning';

    // i18n maps : on accepte uniquement des objets string→string.
    const sanitizeI18n = (m: any): Record<string, string> => {
      if (typeof m !== 'object' || m === null) return {};
      const out: Record<string, string> = {};
      for (const k of Object.keys(m)) {
        if (typeof m[k] === 'string' && m[k].length > 0 && m[k].length <= 1024) {
          out[k] = m[k];
        }
      }
      return out;
    };

    const title = sanitizeI18n(parsed.title);
    const body = sanitizeI18n(parsed.body);
    if (Object.keys(title).length === 0 || Object.keys(body).length === 0) return null;

    // Store URLs : on whiteliste les hosts.
    const store: { ios?: string; android?: string } = {};
    if (parsed.store && typeof parsed.store === 'object') {
      if (isValidStoreUrl(parsed.store.ios)) store.ios = parsed.store.ios as string;
      if (isValidStoreUrl(parsed.store.android)) store.android = parsed.store.android as string;
    }

    return {
      severity,
      title,
      body,
      store,
      issued_at: parsed.issued_at,
    };
  } catch (e) {
    __DEV__ && console.error('[AppNotice] verifyAndParse error:', e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ════════════════════════════════════════════════════════════════════════════
/**
 * Lance le check à l'ouverture de l'app. Idempotent — peut être appelé
 * plusieurs fois sans effet.
 *
 * Étape 1 : restaure le cache local (instantané, fonctionne offline).
 * Étape 2 : en arrière-plan, fetch le serveur et met à jour si différent.
 *
 * Cette fonction ne RETOURNE PAS de promesse à attendre — elle est
 * volontairement fire-and-forget pour ne jamais bloquer le boot.
 */
export function bootstrapAppNotice(): void {
  if (bootstrapStarted) return;
  bootstrapStarted = true;

  // ── Étape 1 : cache local ────────────────────────────────────────────
  AsyncStorage.getItem(CACHE_KEY)
    .then((cached) => {
      if (cached) {
        const parsed = verifyAndParse(cached);
        if (parsed) {
          emit(parsed);
        } else {
          // Cache invalide (clé publique changée ? payload expiré ?) → purge.
          AsyncStorage.removeItem(CACHE_KEY).catch(() => {});
        }
      }
    })
    .catch(() => {});

  // ── Étape 2 : fetch serveur en parallèle ─────────────────────────────
  (async () => {
    try {
      // Promise.race avec timeout pour ne jamais traîner.
      const fetchPromise = secureRpc('get_app_notice', {});
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), FETCH_TIMEOUT_MS),
      );
      const result = await Promise.race([fetchPromise, timeoutPromise]);

      if (!result) {
        __DEV__ && console.log('[AppNotice] Fetch timeout — keeping cache.');
        return;
      }
      if (result.error) {
        __DEV__ && console.log('[AppNotice] Fetch error:', result.error.message);
        return; // Garde le cache.
      }

      // ── Réponse VALIDE attendue : array d'au moins 1 ligne avec ──
      // ── la propriété `signed_payload` présente.                   ──
      //
      // Si l'array est vide ou la réponse est malformée (anomalie réseau,
      // changement de schéma, etc.), on NE FAIT RIEN — on garde l'état
      // courant. Sans cette garde, une RPC qui retournerait [] (ligne
      // singleton disparue) ferait disparaître l'overlay à tort.
      if (!Array.isArray(result.data) || result.data.length === 0) {
        __DEV__ && console.warn('[AppNotice] Empty/invalid response shape — keeping cache.');
        return;
      }
      const row = result.data[0];
      if (
        typeof row !== 'object' ||
        row === null ||
        !Object.prototype.hasOwnProperty.call(row, 'signed_payload')
      ) {
        __DEV__ && console.warn('[AppNotice] Row missing signed_payload field — keeping cache.');
        return;
      }
      const raw: unknown = row.signed_payload;

      if (raw === null) {
        // Révocation explicite : le serveur a la ligne mais signed_payload = NULL.
        await AsyncStorage.removeItem(CACHE_KEY).catch(() => {});
        if (currentNotice !== null) {
          emit(null);
        }
        return;
      }

      if (typeof raw !== 'string') {
        // Type inattendu — on garde l'état courant plutôt que de risquer
        // une disparition d'overlay accidentelle.
        return;
      }

      const verified = verifyAndParse(raw);
      if (verified) {
        await AsyncStorage.setItem(CACHE_KEY, raw).catch(() => {});
        emit(verified);
      } else {
        __DEV__ && console.warn('[AppNotice] Server returned a payload that failed verification.');
      }
    } catch (e) {
      __DEV__ && console.warn('[AppNotice] Bootstrap fetch exception:', e);
    }
  })();
}

/**
 * Re-fetch manuel (par ex. au retour de l'app en foreground). Idempotent
 * vis-à-vis du bootstrap initial : on autorise un re-fetch même si
 * `bootstrapAppNotice` a déjà tourné, en sautant juste l'étape cache.
 */
export async function refetchAppNotice(): Promise<void> {
  try {
    const fetchPromise = secureRpc('get_app_notice', {});
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), FETCH_TIMEOUT_MS),
    );
    const result = await Promise.race([fetchPromise, timeoutPromise]);

    if (!result || result.error) return;

    // Même garde défensive que bootstrap : ne JAMAIS émettre null à cause
    // d'une réponse malformée. Seule une ligne avec signed_payload=NULL
    // explicitement compte comme révocation.
    if (!Array.isArray(result.data) || result.data.length === 0) return;
    const row = result.data[0];
    if (
      typeof row !== 'object' ||
      row === null ||
      !Object.prototype.hasOwnProperty.call(row, 'signed_payload')
    ) {
      return;
    }
    const raw: unknown = row.signed_payload;

    if (raw === null) {
      await AsyncStorage.removeItem(CACHE_KEY).catch(() => {});
      if (currentNotice !== null) emit(null);
      return;
    }

    if (typeof raw !== 'string') return;

    const verified = verifyAndParse(raw);
    if (verified) {
      await AsyncStorage.setItem(CACHE_KEY, raw).catch(() => {});
      // Émettre uniquement si différent du courant (évite re-render inutile).
      const sameContent =
        currentNotice &&
        currentNotice.issued_at === verified.issued_at &&
        currentNotice.severity === verified.severity;
      if (!sameContent) emit(verified);
    }
  } catch {
    // Silencieux : si réseau KO, on garde l'état courant.
  }
}
