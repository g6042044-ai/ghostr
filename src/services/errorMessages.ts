// ════════════════════════════════════════════════════════════════════════════
// errorMessages.ts — Traduction des erreurs techniques pour l'affichage UI
// ════════════════════════════════════════════════════════════════════════════
//
// PROBLÈME RÉSOLU : les écrans faisaient `message: e?.message || t('…')`. Le
// `e.message` gagne toujours quand il existe, et il vient des services, où il
// est écrit en anglais technique (« Not admin », « create failed »…). Résultat :
// un utilisateur russe ou arabe voyait ces chaînes brutes, dans toutes les
// langues.
//
// CONVENTION : les services lèvent/retournent des CODES stables (`ERR_*`),
// jamais de phrase destinée à l'écran. L'UI appelle `errorMessage(e, clé)` :
//   - code connu   → message localisé dédié,
//   - code inconnu → message localisé de repli fourni par l'écran.
// Le texte technique n'est jamais affiché ; il reste disponible dans les logs.
//
// Ajouter un code : l'exporter dans `GroupError`, puis lui associer une clé
// dans `CODE_TO_KEY` (la clé doit exister dans les 8 bundles).
// ════════════════════════════════════════════════════════════════════════════

import i18n from '../i18n';
import { MAX_GROUP_MEMBERS } from './groupService';

/** Codes d'erreur des opérations de groupe (services → UI). */
export const GroupError = {
  UNKNOWN_GROUP: 'ERR_UNKNOWN_GROUP',
  NOT_ADMIN: 'ERR_NOT_ADMIN',
  GROUP_FULL: 'ERR_GROUP_FULL',
  NO_SESSION: 'ERR_NO_SESSION',
  NO_IDENTITY: 'ERR_NO_IDENTITY',
  ENCRYPT_FAILED: 'ERR_GROUP_ENCRYPT',
  ADD_MEMBER_FAILED: 'ERR_ADD_MEMBER',
  REMOVE_MEMBER_FAILED: 'ERR_REMOVE_MEMBER',
  PROMOTE_FAILED: 'ERR_PROMOTE',
  ROSTER_FAILED: 'ERR_ROSTER_STATE',
  TICKET_FAILED: 'ERR_INVITE_TICKET',
  BUNDLE_FAILED: 'ERR_INVITE_BUNDLE',
  CREATE_FAILED: 'ERR_GROUP_CREATE',
  JOIN_REQUEST_FAILED: 'ERR_JOIN_REQUEST',
} as const;

/**
 * Codes qui méritent un message précis. Les autres retombent volontairement
 * sur le repli de l'écran appelant, qui sait décrire l'action tentée
 * (« Échec de la création du groupe. », « Échec de l'envoi de la demande. »…).
 */
const CODE_TO_KEY: Readonly<Record<string, string>> = {
  [GroupError.UNKNOWN_GROUP]: 'groups.notFound',
  [GroupError.NOT_ADMIN]: 'groups.adminOnlyAction',
  [GroupError.GROUP_FULL]: 'groups.maxReachedExisting',
};

/** Interpolations spécifiques à certaines clés (pluriels/placeholders). */
function paramsFor(key: string): Record<string, unknown> | undefined {
  if (key === 'groups.maxReachedExisting') return { count: MAX_GROUP_MEMBERS };
  return undefined;
}

/**
 * Erreur dont le message est DÉJÀ traduit (levée par un écran qui connaît le
 * contexte précis : « Ce QR code a expiré. », « Invitation illisible. »…).
 * `errorMessage()` la laisse passer telle quelle au lieu de la remplacer par
 * le message de repli.
 */
export class LocalizedError extends Error {
  readonly isLocalized = true;
  constructor(message: string) {
    super(message);
    this.name = 'LocalizedError';
    // Chaîne de prototype : nécessaire pour qu'`instanceof` survive à la
    // transpilation TS vers ES5 côté Hermes.
    Object.setPrototypeOf(this, LocalizedError.prototype);
  }
}

/** Raccourci : lève-la avec `throw localizedError('groups.qrExpired')`. */
export function localizedError(key: string, params?: Record<string, unknown>): LocalizedError {
  return new LocalizedError(i18n.t(key, params) as string);
}

/**
 * Message localisé à afficher pour une erreur remontée d'un service.
 *
 * @param error       ce qui a été attrapé (Error, string, objet `{ error }`, null…)
 * @param fallbackKey clé i18n décrivant l'action échouée, utilisée dès que le
 *                    code n'est pas reconnu. Doit exister dans les 8 bundles.
 */
export function errorMessage(error: unknown, fallbackKey = 'common.unknownError'): string {
  if (error instanceof LocalizedError) return error.message;
  const code = extractCode(error);
  const key = code ? CODE_TO_KEY[code] : undefined;
  if (key) return i18n.t(key, paramsFor(key)) as string;
  return i18n.t(fallbackKey) as string;
}

/** Extrait le code `ERR_*` d'une erreur, quelle que soit sa forme. */
function extractCode(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === 'string') return error.startsWith('ERR_') ? error : null;
  if (error instanceof Error) return error.message.startsWith('ERR_') ? error.message : null;
  if (typeof error === 'object') {
    const raw = (error as { message?: unknown; error?: unknown }).message
      ?? (error as { error?: unknown }).error;
    if (typeof raw === 'string' && raw.startsWith('ERR_')) return raw;
  }
  return null;
}
