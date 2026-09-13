// src/services/reportService.ts
// Signalement de contenu à la modération — Guideline App Store 1.2
//
// PRINCIPE DE CONFIDENTIALITÉ (modèle Signal "user reporting") :
//   Le serveur ne peut PAS lire les messages (E2EE, sealed sender). Le
//   signalement est donc un acte VOLONTAIRE du destinataire : le contenu
//   signalé est déchiffré sur SON appareil, et c'est lui qui choisit de le
//   transmettre à la modération. Rien d'autre ne quitte l'appareil.
//   L'envoi passe par le tunnel OHTTP (secureRpc) : le serveur de modération
//   ne voit pas l'IP du signaleur.
//
// REPORTER TAG :
//   Identifiant ALÉATOIRE local (16 bytes hex), généré au premier signalement,
//   sans aucun lien avec l'identité crypto ni les conversations. Il sert
//   uniquement au rate-limit côté serveur (anti-spam de signalements).
//
// UTILISATION:
//   - ConversationScreen: signaler un message (long-press → Signaler)
//   - ContactInfoScreen: bloquer et signaler un contact

import AsyncStorage from '@react-native-async-storage/async-storage';
import nacl from 'tweetnacl';
import { secureRpc } from './relayTransport';

const REPORTER_TAG_KEY = '@ghostr_reporter_tag';

// Doit rester aligné avec la contrainte CHECK de la table `reports`
// (supabase/migration_reports.sql).
export type ReportCategory = 'spam' | 'harassment' | 'illegal' | 'other';

export type ReportContext = 'message' | 'contact';

// Aligné avec la contrainte CHECK `reports_content_size` (4000 chars).
const MAX_CONTENT_LENGTH = 4000;

let _reporterTagCache: string | null = null;

/**
 * Retourne le tag anonyme de signalement, généré au premier appel.
 * Purement aléatoire — aucun lien avec les clés ou sessions de l'utilisateur.
 */
async function getReporterTag(): Promise<string> {
  if (_reporterTagCache) return _reporterTagCache;

  try {
    const stored = await AsyncStorage.getItem(REPORTER_TAG_KEY);
    if (stored && /^[0-9a-f]{32}$/.test(stored)) {
      _reporterTagCache = stored;
      return stored;
    }
  } catch {}

  const bytes = nacl.randomBytes(16);
  const tag = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  try {
    await AsyncStorage.setItem(REPORTER_TAG_KEY, tag);
  } catch {}
  _reporterTagCache = tag;
  return tag;
}

/**
 * Envoie un signalement à la modération via le tunnel OHTTP.
 *
 * @param category  Catégorie choisie par l'utilisateur
 * @param content   Contenu signalé (texte du message, ou description du
 *                  contact bloqué). Déjà déchiffré côté signaleur — c'est
 *                  lui qui consent à le transmettre.
 * @param context   'message' (signalement d'un message) ou 'contact'
 *                  (blocage d'un contact)
 * @returns { ok } ou { ok: false, error } — jamais de throw.
 */
export async function submitReport(
  category: ReportCategory,
  content: string,
  context: ReportContext
): Promise<{ ok: boolean; error?: string }> {
  try {
    const reporterTag = await getReporterTag();
    const { error } = await secureRpc('submit_report', {
      p_category: category,
      p_content: (content || '').slice(0, MAX_CONTENT_LENGTH),
      p_context: context,
      p_reporter_tag: reporterTag,
    });
    if (error) {
      __DEV__ && console.warn('[ReportService] submit_report failed:', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    __DEV__ && console.warn('[ReportService] submit_report exception:', e);
    return { ok: false, error: String(e?.message || e) };
  }
}
