// src/services/sealedSenderCache.ts
// PERSISTANCE DU CERTIFICAT SEALED SENDER — mode sans PIN uniquement
//
// PROBLÈME RÉSOLU :
//   Le certificat anonyme (valide 1h côté gateway) et la clé publique sealed
//   sender n'existaient qu'en RAM (sealedSender.ts). Chaque cold start
//   refaisait donc le cycle complet : PoW SHA-256 (~260k itérations, 3-30s
//   sur Hermes sous contention) + fetch manifest + RPC certificat. Résultat :
//   « Préparation de la connexion sécurisée… » à chaque relance de l'app.
//
// SOLUTION :
//   Persister { certificat, clé SS, savedAt } chiffrés via localCrypto
//   (clé hardware Keystore/Keychain — même niveau de protection que les
//   états Triple Ratchet et les OTPK déjà persistés). Au cold start dans
//   l'heure : restauration → isSealedSenderReady() vrai immédiatement,
//   zéro PoW, zéro réseau.
//
// SÉCURITÉ — INVARIANTS :
//   • MODE PIN : JAMAIS persisté. Le choix R-13 (clearSealedSenderState au
//     lock + clear explicite au cold start avec PIN, App.tsx) traite le
//     certificat comme strictement éphémère quand un PIN existe. save() et
//     load() vérifient isLockEnabled() et load() PURGE tout résidu si un
//     PIN a été activé entre-temps (transition no-PIN → PIN couverte).
//   • CHIFFREMENT AUTHENTIFIÉ : nacl.secretbox via localCrypto (format
//     'enc1:'). Un attaquant sans la clé hardware ne peut ni lire ni
//     FORGER le cache (tag d'authentification) — impossible de substituer
//     une clé gateway malveillante. Un payload en clair ou indéchiffrable
//     est détruit, jamais accepté.
//   • ANTI-STALE : restauré uniquement s'il reste ≥ 10 min de validité
//     (aligné sur CERTIFICATE_REFRESH_MARGIN_MS). Le refresh planifié
//     re-fetche ensuite un certificat frais via le chemin normal (manifest
//     re-vérifié Ed25519 + pinning), donc toute clé restaurée est
//     re-validée au plus tard au refresh.
//   • Le certificat est un jeton anonyme (nonce aléatoire + HMAC serveur,
//     aucune identité) — sa persistance ne crée aucun lien identitaire.
//
// Les hooks sont injectés dans sealedSender.ts via setSealedSenderCacheHooks
// (même pattern que setSealedSenderCertificateFetcher) pour garder
// sealedSender.ts sans dépendance stockage.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { decodeBase64 } from 'tweetnacl-util';
import { isLockEnabled } from './appLock';
import {
  encrypt as localCryptoEncrypt,
  decrypt as localCryptoDecrypt,
  hasAnyEncryptionKey,
} from './localCrypto';
import type { SenderCertificate } from './sealedSender';

const CACHE_KEY = 'ghostr_ss_cert_cache_v1';

/** Prefix localCrypto — un cache qui ne commence pas par ça est détruit. */
const ENCRYPTED_PREFIX = 'enc1:';

/**
 * Validité restante minimale pour accepter un certificat restauré.
 * Aligné sur CERTIFICATE_REFRESH_MARGIN_MS (sealedSender.ts) : en dessous,
 * le refresh serait immédiat — autant laisser le bootstrap normal tourner.
 */
const MIN_REMAINING_VALIDITY_MS = 10 * 60 * 1000;

interface SealedSenderCachePayload {
  cert: SenderCertificate;
  ssKeyB64: string;
  savedAt: number;
}

function isValidPayload(p: any): p is SealedSenderCachePayload {
  if (!p || typeof p !== 'object') return false;
  const cert = p.cert;
  if (!cert || typeof cert !== 'object') return false;
  if (typeof cert.nonce !== 'string' || cert.nonce.length === 0) return false;
  if (typeof cert.expiry !== 'number' || !Number.isFinite(cert.expiry)) return false;
  if (typeof cert.hmac !== 'string' || cert.hmac.length === 0) return false;
  if (typeof p.ssKeyB64 !== 'string' || p.ssKeyB64.length === 0) return false;
  // La clé publique NaCl X25519 fait exactement 32 bytes — un base64
  // malformé ou d'une autre taille est rejeté ici plutôt que de laisser
  // decodeBase64 throw plus tard dans setSealedSenderServerKey.
  try {
    if (decodeBase64(p.ssKeyB64).length !== 32) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Persiste le certificat + la clé SS, chiffrés. No-op silencieux si :
 *   - un PIN est configuré (R-13 : certificat éphémère en mode PIN)
 *   - la clé localCrypto n'est pas active (rien ne doit partir en clair)
 * Ne throw jamais (fire-and-forget depuis sealedSender.ts).
 */
export async function saveSealedSenderCache(
  cert: SenderCertificate,
  ssKeyB64: string
): Promise<void> {
  try {
    if (await isLockEnabled()) {
      // Mode PIN : ne jamais persister, et purger tout résidu d'une époque
      // no-PIN antérieure.
      await AsyncStorage.removeItem(CACHE_KEY);
      return;
    }
    if (!hasAnyEncryptionKey()) {
      // Pas de clé hardware active → on refuse d'écrire (jamais de clair).
      return;
    }
    const payload: SealedSenderCachePayload = {
      cert,
      ssKeyB64,
      savedAt: Date.now(),
    };
    await AsyncStorage.setItem(CACHE_KEY, localCryptoEncrypt(JSON.stringify(payload)));
    __DEV__ && console.log('[SSCache] 💾 Certificate cached (encrypted, no-PIN mode)');
  } catch (e) {
    __DEV__ && console.warn('[SSCache] save failed (non-fatal):', e);
  }
}

/**
 * Tente de restaurer un état sealed sender valide.
 * Retourne null (et purge le cache) dans TOUS les cas douteux :
 * PIN activé, clair, indéchiffrable, forme invalide, expiration proche.
 * Ne throw jamais.
 */
export async function loadSealedSenderCache(): Promise<{
  cert: SenderCertificate;
  ssKeyB64: string;
} | null> {
  try {
    if (await isLockEnabled()) {
      // Transition no-PIN → PIN : purge du résidu, aucune restauration.
      await AsyncStorage.removeItem(CACHE_KEY);
      return null;
    }

    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    if (!raw.startsWith(ENCRYPTED_PREFIX)) {
      // Jamais écrit en clair par ce module → corrompu ou altéré : détruire.
      await AsyncStorage.removeItem(CACHE_KEY);
      return null;
    }

    if (!hasAnyEncryptionKey()) {
      // Clé hardware pas encore installée (appelé trop tôt) : ne pas
      // détruire, le prochain bootstrap re-tentera après initHardwareEncryption.
      return null;
    }

    let payload: any;
    try {
      payload = JSON.parse(localCryptoDecrypt(raw));
    } catch {
      // Clé changée ou données corrompues (le tag secretbox a rejeté) : détruire.
      await AsyncStorage.removeItem(CACHE_KEY);
      return null;
    }

    if (!isValidPayload(payload)) {
      await AsyncStorage.removeItem(CACHE_KEY);
      return null;
    }

    const remaining = payload.cert.expiry - Date.now();
    if (remaining < MIN_REMAINING_VALIDITY_MS) {
      __DEV__ && console.log(
        `[SSCache] Cached cert too close to expiry (${Math.round(remaining / 1000)}s left) — discarding`
      );
      await AsyncStorage.removeItem(CACHE_KEY);
      return null;
    }

    __DEV__ && console.log(
      `[SSCache] ✅ Restored cached certificate (${Math.round(remaining / 60000)}min validity left) — PoW + RPC skipped`
    );
    return { cert: payload.cert, ssKeyB64: payload.ssKeyB64 };
  } catch (e) {
    __DEV__ && console.warn('[SSCache] load failed (non-fatal):', e);
    return null;
  }
}

/**
 * Supprime le cache. Appelé quand le certificat est invalidé (quota gateway
 * dépassé, expiry) ou quand l'état sealed sender est clearé (lock R-13).
 * Ne throw jamais.
 */
export async function clearSealedSenderCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch {
    // AsyncStorage indisponible — au pire le load-time guard re-purgera.
  }
}
