// src/i18n/index.ts
// Configuration principale i18next pour Ghostr.
//
// ════════════════════════════════════════════════════════════════════════════
// PRINCIPES SÉCURITÉ / PRIVACY
// ════════════════════════════════════════════════════════════════════════════
//  - Détection de langue 100% locale (expo-localization lit le réglage OS,
//    aucun appel réseau).
//  - Aucune préférence langue envoyée à Supabase ou aux relays.
//  - Toutes les ressources de traduction sont BUNDLÉES dans l'app
//    (pas de chargement HTTP runtime → pas de fuite de langue côté serveur).
//  - Le rendu des push notifications se fait localement avec la langue
//    utilisateur courante (le payload push reste vide / chiffré).
//
// ════════════════════════════════════════════════════════════════════════════
// STRATÉGIE RTL : "TEXT-ONLY"  ⚠️ DESIGN CHOICE
// ════════════════════════════════════════════════════════════════════════════
// Pour les langues RTL (arabe, ourdou…), on N'APPELLE PAS `I18nManager.forceRTL`.
// Le LAYOUT (boutons, padding, flex, icônes) reste identique entre toutes les
// langues ; seul le TEXTE s'écrit de droite à gauche grâce à l'algorithme
// Unicode bidi (UAX#9), qui est intégré nativement à React Native.
//
// Concrètement :
//   - Une bulle de message contenant "مرحبا" → le texte s'enchaîne RTL DANS
//     la bulle, mais la bulle elle-même reste à la même place (à droite pour
//     les messages sortants, à gauche pour les entrants — comme en français).
//   - Le bouton d'envoi reste à droite, le bouton retour reste à gauche.
//   - Les `paddingLeft`/`paddingRight` ne sont pas inversés.
//   - Le flex `row` ne devient pas `row-reverse`.
//   - Aucun redémarrage d'app n'est requis au changement de langue.
//
// Pourquoi ce choix vs full-RTL (à la WhatsApp/Telegram) ?
//   1. Cohérence multilingue : un utilisateur qui jongle entre fr/en/ar n'a
//      pas à réapprendre où sont les boutons.
//   2. Stabilité du muscle memory pour les utilisateurs.
//   3. Évite les bugs RTL classiques (chevrons mal orientés, gestures
//      inversées, animations qui partent du mauvais côté).
//   4. RN gère déjà correctement le bidi du texte sans forceRTL.
//
// Si à l'avenir on souhaite basculer en full-RTL (à la convention iOS native),
// il faudra :
//   1. Réactiver `I18nManager.forceRTL(rtl)` dans `applyLayoutDirection()`
//      ci-dessous.
//   2. Auditer chaque écran pour `paddingStart`/`paddingEnd` (au lieu de
//      `paddingLeft`/`paddingRight`).
//   3. Auditer les icônes directionnelles (chevrons, retour, envoi).
//   4. Gérer le prompt de redémarrage côté UI (le code historique est dans
//      l'historique git).
//
// ════════════════════════════════════════════════════════════════════════════
// PERF
// ════════════════════════════════════════════════════════════════════════════
//  - Init synchrone après lecture AsyncStorage (5-30ms typique au cold start).
//  - useSuspense: false → pas d'overhead Suspense en RN.
//
// ════════════════════════════════════════════════════════════════════════════
// PLURALISATION : compatibilityJSON v3 (pas de polyfill Intl)
// ════════════════════════════════════════════════════════════════════════════
// Hermes (le moteur JS de RN) n'expose pas Intl.PluralRules. Plutôt que de
// charger le polyfill @formatjs/intl-pluralrules (fragile selon les versions
// Metro/Hermes/exports field), on utilise le pluralResolver EMBARQUÉ
// d'i18next via `compatibilityJSON: 'v3'`.
//
// Le format v3 utilise des SUFFIXES NUMÉRIQUES par catégorie CLDR :
//
//   ┌──────────────────┬─────────────────────────────────────────────────────┐
//   │ Langue           │ Suffixes nécessaires                                │
//   ├──────────────────┼─────────────────────────────────────────────────────┤
//   │ en, de, es, fr,  │ key   (singulier)                                   │
//   │ it, ur           │ key_plural   (pluriel)                              │
//   ├──────────────────┼─────────────────────────────────────────────────────┤
//   │ ru               │ key_0  (one  : 1, 21, 31, …)                        │
//   │                  │ key_1  (few  : 2-4, 22-24, …)                       │
//   │                  │ key_2  (many : 0, 5-20, 25-30, …)                   │
//   ├──────────────────┼─────────────────────────────────────────────────────┤
//   │ ar               │ key_0 (zero), key_1 (one), key_2 (two),             │
//   │                  │ key_3 (few),  key_4 (many), key_5 (other)           │
//   └──────────────────┴─────────────────────────────────────────────────────┘
// ════════════════════════════════════════════════════════════════════════════

import i18next, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { I18nManager } from 'react-native';
import { getLocales } from 'expo-localization';

import {
  SUPPORTED_LANGUAGES,
  FALLBACK_LANGUAGE,
  isSupportedLanguage,
  getLanguageInfo,
  normalizeLanguageTag,
  type LanguageCode,
} from './languages';
import { loadStoredLanguage, storeLanguage } from './storage';

// ── Bundles de traduction ──────────────────────────────────────────────────
// /!\ TOUTES les langues déclarées dans SUPPORTED_LANGUAGES doivent avoir leur
//     bundle importé ici. Ajout d'une langue = 3 fichiers à modifier :
//     1. resources/<code>.json   (les traductions)
//     2. languages.ts             (les métadonnées)
//     3. index.ts                 (cet import + l'enregistrement ci-dessous)
import ar from './resources/ar.json';
import de from './resources/de.json';
import en from './resources/en.json';
import es from './resources/es.json';
import fr from './resources/fr.json';
import it from './resources/it.json';
import ru from './resources/ru.json';
import ur from './resources/ur.json';

const resources = {
  ar: { translation: ar },
  de: { translation: de },
  en: { translation: en },
  es: { translation: es },
  fr: { translation: fr },
  it: { translation: it },
  ru: { translation: ru },
  ur: { translation: ur },
} as const;

/**
 * Détecte la langue de l'OS via expo-localization.
 *
 * `getLocales()` renvoie un tableau ORDONNÉ par préférence utilisateur. Pour
 * chaque locale, on essaie d'abord la balise complète (ex: `fr-CA`), puis on
 * retombe sur la primary subtag. On retient le PREMIER code supporté ; sinon
 * FALLBACK.
 *
 * Aucun appel réseau, aucune télémétrie. Appelé :
 *  - au boot pour décider la langue initiale,
 *  - quand l'utilisateur choisit "Système" dans le picker.
 */
export function detectDeviceLanguage(): LanguageCode {
  try {
    const locales = getLocales();
    for (const loc of locales) {
      const tag = (loc as { languageTag?: string }).languageTag;
      const primary = (loc.languageCode || '').toLowerCase();

      const fromTag = normalizeLanguageTag(tag);
      if (fromTag) return fromTag;

      const fromPrimary = normalizeLanguageTag(primary);
      if (fromPrimary) return fromPrimary;
    }
  } catch {
    // getLocales peut throw sur certaines builds. Fallback.
  }
  return FALLBACK_LANGUAGE;
}

/**
 * Initialise i18next.
 *
 * À appeler UNE SEULE FOIS au boot, avant le premier render qui utilise t().
 * Idempotent : un 2e appel renvoie la même promesse.
 *
 * Stratégie de résolution de la langue initiale :
 *   1. Préférence stockée (AsyncStorage @ghostr/lang) — choix explicite user
 *   2. Sinon, langue de l'OS (expo-localization, normalisée)
 *   3. Sinon, FALLBACK_LANGUAGE (en)
 */
let _initialized = false;
let _initPromise: Promise<I18nInstance> | null = null;

export function initI18n(): Promise<I18nInstance> {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    if (_initialized) return i18next;

    const stored = await loadStoredLanguage();
    const initial = stored ?? detectDeviceLanguage();

    await i18next.use(initReactI18next).init({
      resources,
      lng: initial,
      fallbackLng: FALLBACK_LANGUAGE,
      // Contraint i18next à ne pas tenter de résoudre des langues non supportées.
      // La normalisation BCP-47 est faite en amont par detectDeviceLanguage().
      supportedLngs: SUPPORTED_LANGUAGES.map(l => l.code),
      // RN ne fait pas de rendu HTML, pas besoin d'escape XSS.
      interpolation: { escapeValue: false },
      // v3 : pluralResolver embarqué d'i18next, pas de dépendance Intl.
      // Cf. en-tête du fichier pour la justification + table des suffixes.
      compatibilityJSON: 'v3',
      // Pas de Suspense en RN : l'init est synchrone après bootstrap.
      react: { useSuspense: false },
      debug: false,
      // Si une clé est manquante, retourner la clé brute plutôt que null.
      returnNull: false,
      saveMissing: false,
    });

    _initialized = true;
    applyLayoutDirection();
    return i18next;
  })();

  return _initPromise;
}

/**
 * Change la langue active.
 *
 * Passer null = "Système par défaut" : supprime l'override stocké et applique
 * la langue détectée de l'OS au moment de l'appel.
 *
 * Tous les composants qui utilisent useTranslation() se re-renderent
 * automatiquement via le contexte react-i18next.
 *
 * Aucun redémarrage d'app n'est requis : le moteur de rendu de texte de RN
 * gère le bidi du texte (arabe, ourdou) par caractères, sans toucher au
 * layout. Voir la doc "STRATÉGIE RTL" en en-tête de fichier.
 */
export async function changeLanguage(
  code: LanguageCode | null,
): Promise<{ effective: LanguageCode }> {
  const effective = code ?? detectDeviceLanguage();
  await i18next.changeLanguage(effective);
  await storeLanguage(code);
  return { effective };
}

/**
 * Renvoie le code langue actuellement actif.
 * Utilisé par les helpers Intl (toLocaleDateString, etc.).
 */
export function getActiveLanguage(): LanguageCode {
  const lng = i18next.language;
  if (isSupportedLanguage(lng)) return lng;
  return FALLBACK_LANGUAGE;
}

/**
 * Renvoie la direction d'écriture du texte pour la langue active : 'rtl' ou
 * 'ltr'. À utiliser au cas par cas dans des composants qui ont VRAIMENT besoin
 * d'aligner du texte selon la langue (ex: une longue prose dans un onboarding,
 * ou un alignement spécifique sur un placeholder).
 *
 * 99% du temps, vous N'EN AVEZ PAS BESOIN — RN gère le bidi automatiquement
 * pour le texte à l'intérieur des composants `<Text>` et `<TextInput>`.
 *
 * @example
 * ```tsx
 * const dir = getTextDirection();
 * <Text style={{ writingDirection: dir, textAlign: dir === 'rtl' ? 'right' : 'left' }}>
 *   {longProseText}
 * </Text>
 * ```
 */
export function getTextDirection(): 'rtl' | 'ltr' {
  const info = getLanguageInfo(getActiveLanguage());
  return info?.rtl ? 'rtl' : 'ltr';
}

/**
 * Hook React équivalent à `getTextDirection()` qui re-render automatiquement
 * au changement de langue.
 *
 * Utilise `useTranslation()` en interne, donc s'inscrit au contexte i18next
 * et déclenche un re-render quand `i18n.changeLanguage()` est appelé.
 */
export function useTextDirection(): 'rtl' | 'ltr' {
  // useTranslation déclenche un re-render au changement de langue ; on peut
  // ignorer la valeur retournée et utiliser i18next.language (cohérent).
  useTranslation();
  return getTextDirection();
}

/**
 * Applique la direction de layout RN.
 *
 * Stratégie actuelle : on FORCE le layout en LTR (no-op pour les nouveaux
 * users, migration douce pour les anciens). Voir la doc "STRATÉGIE RTL".
 *
 * Si une version PRÉCÉDENTE de l'app avait appelé `I18nManager.forceRTL(true)`
 * pour un user en arabe, l'état `isRTL=true` persiste dans le storage natif RN
 * jusqu'au prochain reload. On force `forceRTL(false)` pour le réinitialiser.
 * L'effet visuel n'est complet qu'au prochain démarrage de l'app — acceptable
 * comme migration ponctuelle.
 */
function applyLayoutDirection(): void {
  if (I18nManager.isRTL) {
    try {
      I18nManager.allowRTL(false);
      I18nManager.forceRTL(false);
    } catch {
      // Ignore — certaines builds RN throw ici.
    }
  }
}

// Re-exports pratiques.
export {
  SUPPORTED_LANGUAGES,
  FALLBACK_LANGUAGE,
  getLanguageInfo,
  isSupportedLanguage,
  normalizeLanguageTag,
} from './languages';
export type { LanguageCode, LanguageInfo } from './languages';
export { loadStoredLanguage } from './storage';

export default i18next;
