// src/i18n/types.d.ts
// Augmentation TypeScript pour que `t('settings.title')` soit autocomplété
// et que `t('settings.tytle')` lève une erreur compile-time.
//
// Le module se base sur fr.json comme référence de schéma — les autres
// langues sont obligatoires en runtime mais TypeScript ne vérifie pas
// l'exhaustivité (utiliser un linter type i18next-parser pour ça).

import 'react-i18next';
import fr from './resources/fr.json';

declare module 'react-i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof fr;
    };
  }
}
