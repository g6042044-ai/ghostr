// src/i18n/languages.ts
// Métadonnées des langues supportées.
//
// Principes :
//  - Le `name` est dans la langue elle-même (jamais de drapeaux : un drapeau
//    représente un pays, pas une langue).
//  - `englishName` sert d'aide secondaire pour quelqu'un qui s'est trompé de
//    langue et ne reconnaît plus son script.
//  - `rtl: true` est un flag MÉTADONNÉE — il N'enclenche PAS automatiquement
//    `I18nManager.forceRTL`. Voir le bloc "STRATÉGIE RTL" dans index.ts.
//    Ce flag est consommé par `getTextDirection()` / `useTextDirection()`
//    pour les rares composants qui veulent aligner explicitement du texte.
//
// Pour ajouter une langue, voir src/i18n/README.md.

export interface LanguageInfo {
  code: string;
  /** Nom dans la langue elle-même (utilisé dans le picker). */
  name: string;
  /** Nom en anglais (sous-titre du picker, aide à se réorienter). */
  englishName: string;
  /**
   * Direction d'écriture droite→gauche (métadonnée uniquement, n'enclenche
   * pas le flip de layout RN). Utilisé par `getTextDirection()`.
   */
  rtl?: boolean;
}

/**
 * Liste maître des langues supportées.
 *
 * Maintenance : trier alphabétiquement par `code`. Le tri d'AFFICHAGE dans le
 * picker (par `name` natif) est fait par LanguageScreen pour rester cohérent
 * avec l'attente des utilisateurs (qui scannent par leur propre alphabet).
 */
export const SUPPORTED_LANGUAGES: ReadonlyArray<LanguageInfo> = [
  { code: 'ar', name: 'العربية',  englishName: 'Arabic',  rtl: true },
  { code: 'de', name: 'Deutsch',   englishName: 'German'             },
  { code: 'en', name: 'English',   englishName: 'English'            },
  { code: 'es', name: 'Español',   englishName: 'Spanish'            },
  { code: 'fr', name: 'Français',  englishName: 'French'             },
  { code: 'it', name: 'Italiano',  englishName: 'Italian'            },
  { code: 'ru', name: 'Русский',   englishName: 'Russian'            },
  { code: 'ur', name: 'اردو',      englishName: 'Urdu',    rtl: true },
] as const;

export type LanguageCode = typeof SUPPORTED_LANGUAGES[number]['code'];

/**
 * Langue de fallback : utilisée quand
 *  - l'OS est dans une langue non supportée
 *  - une clé est manquante dans la langue active
 *
 * L'anglais est le choix le plus prudent : couverture maximale.
 */
export const FALLBACK_LANGUAGE: LanguageCode = 'en';

/**
 * Normalise un code BCP-47 renvoyé par l'OS vers un code supporté.
 *
 * Couvre les variantes régionales courantes :
 *   - "fr-CA", "fr-FR"  → "fr"
 *   - "en-US", "en-GB"  → "en"
 *   - "ar-SA", "ar-EG"  → "ar"
 *   - "ur-PK", "ur-IN"  → "ur"
 *
 * @returns le code supporté correspondant, ou null si non supporté.
 */
export function normalizeLanguageTag(tag: string | null | undefined): LanguageCode | null {
  if (!tag) return null;
  const normalized = tag.toLowerCase().replace(/_/g, '-');

  // 1) Match direct sur le code complet.
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang.code.toLowerCase() === normalized) return lang.code;
  }

  // 2) Match sur la primary subtag (ex: "fr-CA" → "fr").
  const primary = normalized.split('-')[0];
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang.code.toLowerCase() === primary) return lang.code;
  }

  return null;
}

export function isSupportedLanguage(code: string | null | undefined): code is LanguageCode {
  if (!code) return false;
  return SUPPORTED_LANGUAGES.some(l => l.code === code);
}

export function getLanguageInfo(code: string): LanguageInfo | undefined {
  return SUPPORTED_LANGUAGES.find(l => l.code === code);
}
