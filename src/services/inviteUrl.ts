// src/services/inviteUrl.ts
// Helpers pour la construction et le parsing des URLs d'invitation Ghostr.
//
// FORMAT DES INVITATIONS :
//   Universal Link : https://theghostr.com/i#<inviteString>
//   Scheme natif   : ghostr://invite#<inviteString>
//   Brut (legacy)  : <inviteString>  (toujours accepté en input manuel)
//
// Le <inviteString> est la même chaîne base64 produite par
// sessionService.createInvite() — soit le format court PQXDH
// {v:2, t:tag, n:displayName} encodé en base64.
//
// SÉCURITÉ — POURQUOI LE FRAGMENT ET PAS LE PATH :
//   Les fragments URL (`#…`) ne sont JAMAIS transmis au serveur HTTP
//   (RFC 9110). Les mettre dans le path les exposerait dans :
//     - les logs Cloudflare/CDN
//     - l'en-tête Referer si l'utilisateur clique un lien externe
//     - les caches de proxy intermédiaires
//     - l'historique navigateur indexé par certains services
//   En les gardant dans le fragment, le tag d'invitation ne quitte
//   jamais le device de l'utilisateur côté HTTP.

const INVITE_DOMAIN = 'theghostr.com';
const INVITE_PATH = '/i';
const INVITE_SCHEME = 'ghostr';

/**
 * Domaine du Universal Link / App Link. Utilisé par App.tsx pour configurer
 * les listeners Linking et par le scanner pour valider les URLs.
 *
 * IMPORTANT : si tu changes ce domaine, mets aussi à jour :
 *   - app.json → ios.associatedDomains et android.intentFilters
 *   - cloudflare-relay/wrangler-invite.toml (route)
 *   - Le Worker Cloudflare déployé sur le bon domaine
 */
export const INVITE_LINK_DOMAIN = INVITE_DOMAIN;

/** Préfixe complet HTTPS pour les URLs partageables. */
export const INVITE_URL_PREFIX = `https://${INVITE_DOMAIN}${INVITE_PATH}`;

/** Préfixe scheme natif pour les deep links internes. */
export const INVITE_SCHEME_PREFIX = `${INVITE_SCHEME}://invite`;

/**
 * Construit une URL HTTPS partageable contenant l'inviteString.
 * Le inviteString est encodé URL-safe pour résister aux canaux qui
 * réécrivent les caractères spéciaux (SMS, certains clients mail).
 *
 * Exemple :
 *   buildInviteUrl("eyJ2IjoyLCJ0Ijoi...")
 *   → "https://theghostr.com/i#eyJ2IjoyLCJ0Ijoi..."
 */
export function buildInviteUrl(inviteString: string): string {
  if (!inviteString) {
    throw new Error('buildInviteUrl: inviteString is empty');
  }
  // encodeURIComponent gère les +, /, = du base64 standard pour qu'ils
  // survivent aux SMS, copy/paste depuis certains apps mail, etc.
  // Le fragment n'a pas de contraintes RFC 3986 strictes mais autant
  // produire une URL portable.
  return `${INVITE_URL_PREFIX}#${encodeURIComponent(inviteString)}`;
}

/**
 * Extrait le inviteString depuis n'importe quel format reçu :
 *   - URL HTTPS Universal Link  : https://theghostr.com/i#abc...
 *   - URL scheme natif fragment : ghostr://invite#abc...
 *   - URL scheme natif path     : ghostr://invite/abc...   (utilisé par intent:// Android)
 *   - Code brut (paste manuel)  : abc...
 *
 * Retourne null si l'input ne contient pas de inviteString valide.
 *
 * Cette fonction est PURE et SANS EFFET DE BORD : elle ne fait pas
 * de requête réseau, elle ne logue rien. Sûre à appeler depuis un
 * scanner QR sans contexte de session.
 */
export function parseInviteString(input: string | null | undefined): string | null {
  if (!input) return null;

  // Strip whitespace + newlines — robuste au copy/paste avec retours chariot.
  const trimmed = input.trim().replace(/[\r\n]+/g, '');
  if (!trimmed) return null;

  // Détecter URL (HTTPS ou scheme natif)
  const lower = trimmed.toLowerCase();
  const isUrl = lower.startsWith('http://') ||
                lower.startsWith('https://') ||
                lower.startsWith(`${INVITE_SCHEME}://`);

  if (isUrl) {
    // Cas 1 : URL avec fragment (#) — c'est notre format primaire
    const hashIdx = trimmed.indexOf('#');
    if (hashIdx !== -1) {
      const fragment = trimmed.slice(hashIdx + 1);
      if (!fragment) return null;
      let decoded: string;
      try { decoded = decodeURIComponent(fragment); }
      catch { decoded = fragment; }
      return decoded.replace(/\s+/g, '') || null;
    }

    // Cas 2 : URL scheme natif sans fragment, format path-based
    // → ghostr://invite/<urlencoded_inviteString>
    // Utilisé quand l'app est lancée via intent:// (Android Chrome) qui ne
    // supporte pas nativement les fragments URL.
    if (lower.startsWith(`${INVITE_SCHEME}://invite/`)) {
      const path = trimmed.slice(`${INVITE_SCHEME}://invite/`.length);
      if (!path) return null;
      // Retirer un éventuel query string ou autre garniture après le inviteString
      const stop = Math.min(
        ...[path.indexOf('?'), path.indexOf('#')]
          .filter(i => i !== -1)
          .concat([path.length])
      );
      const raw = path.slice(0, stop);
      if (!raw) return null;
      let decoded: string;
      try { decoded = decodeURIComponent(raw); }
      catch { decoded = raw; }
      return decoded.replace(/\s+/g, '') || null;
    }

    // URL inconnue (ex: https://example.com sans fragment) → ignorer
    return null;
  }

  // Pas une URL : on suppose que c'est le code brut (collé manuellement).
  return trimmed.replace(/\s+/g, '') || null;
}

/**
 * Détermine si un input est une URL d'invitation Ghostr valide
 * (Universal Link ou scheme natif). Utilisé pour décider si on doit
 * traiter le payload comme un deep link ou comme un autre type de QR.
 */
export function isInviteUrl(input: string | null | undefined): boolean {
  if (!input) return false;
  const lower = input.trim().toLowerCase();
  return (
    lower.startsWith(`https://${INVITE_DOMAIN}${INVITE_PATH}`) ||
    lower.startsWith(`http://${INVITE_DOMAIN}${INVITE_PATH}`) ||
    lower.startsWith(`${INVITE_SCHEME}://invite`)
  );
}
