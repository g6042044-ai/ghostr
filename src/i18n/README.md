# Internationalization (i18n) — Ghostr

Ce dossier contient toute la configuration multilangue de Ghostr.

## Architecture

```
src/i18n/
├── index.ts          → init i18next, détection device, changement de langue
├── languages.ts      → liste des langues + métadonnées (RTL, nom natif, etc.)
├── storage.ts        → persistance du choix utilisateur (AsyncStorage)
├── types.d.ts        → augmentation TS pour autocomplétion sur t('...')
├── validate.ts       → outil CLI de validation des bundles
├── README.md         → ce fichier
└── resources/
    ├── ar.json   (Arabe,    RTL, 6 formes plurielles)
    ├── de.json   (Allemand, 2 formes)
    ├── en.json   (Anglais,  2 formes)  ← schéma de référence
    ├── es.json   (Espagnol, 2 formes)
    ├── fr.json   (Français, 2 formes)
    ├── it.json   (Italien,  2 formes)
    ├── ru.json   (Russe,    3 formes)
    └── ur.json   (Ourdou,   RTL, 2 formes)
```

## Garanties privacy

- **Détection de langue 100% locale** : `expo-localization` lit le réglage OS sans aucun appel réseau.
- **Aucune préférence langue côté serveur** : ni Supabase, ni les relays, ni les push notifications ne reçoivent l'information.
- **Bundles inlinés** : les JSON sont importés à la compilation (pas de fetch HTTP runtime → pas de fingerprint langue côté CDN).
- **Push notifications localisées localement** : le payload push reste vide ; le rendu se fait sur l'appareil avec la langue active.

## Pluralisation (compatibilityJSON v3)

i18next 23 avec `compatibilityJSON: 'v3'` embarque les règles plurielles CLDR pour toutes les langues majeures, **sans polyfill Intl.PluralRules** (ce qui serait un casse-tête sur Hermes).

Le format v3 utilise des suffixes par catégorie CLDR :

| Langue                  | Formes CLDR | Suffixes à fournir |
|-------------------------|-------------|--------------------|
| en, de, es, fr, it, ur  | 2           | `key`, `key_plural` |
| ru                      | 3           | `key_0`, `key_1`, `key_2` |
| ar                      | 6           | `key_0` … `key_5` |

### Détail Russe (3 formes)

| Suffixe   | Catégorie CLDR | Exemples de count |
|-----------|---------------|--------------------|
| `key_0`   | one           | 1, 21, 31, 41, … (mais pas 11) |
| `key_1`   | few           | 2-4, 22-24, … (mais pas 12-14) |
| `key_2`   | many          | 0, 5-20, 25-30, … |

### Détail Arabe (6 formes)

| Suffixe   | Catégorie CLDR | Exemples de count |
|-----------|---------------|--------------------|
| `key_0`   | zero          | 0 |
| `key_1`   | one           | 1 |
| `key_2`   | two           | 2 |
| `key_3`   | few           | n%100 ∈ [3..10] |
| `key_4`   | many          | n%100 ∈ [11..99] |
| `key_5`   | other         | tous les autres (100, 200, …) |

## Ajouter une nouvelle langue

Trois fichiers à modifier, dans cet ordre :

### 1. Créer `resources/<code>.json`

Partir d'une copie de `en.json` (le schéma de référence) puis traduire toutes les valeurs. Garder **tous les placeholders intacts** (`{{count}}`, `{{name}}`, etc.) et les **noms techniques non traduits** (`Triple Ratchet`, `X25519`, `ML-KEM-768`, `Ghostr`, `OHTTP`).

Pour les langues à 3+ formes plurielles, **remplacer** les paires `key`/`key_plural` par les suffixes numérotés appropriés (cf. tableau ci-dessus).

### 2. Enregistrer dans `languages.ts`

```ts
export const SUPPORTED_LANGUAGES: ReadonlyArray<LanguageInfo> = [
  // … langues existantes …
  { code: 'ja', name: '日本語', englishName: 'Japanese' },
];
```

Ajouter `rtl: true` si la langue s'écrit de droite à gauche.

### 3. Importer le bundle dans `index.ts`

```ts
import ja from './resources/ja.json';
// …
const resources = {
  // … langues existantes …
  ja: { translation: ja },
} as const;
```

### 4. (Recommandé) Lancer le validateur

```bash
npx ts-node src/i18n/validate.ts
```

Le validateur vérifie :
- la complétude des clés vs `en.json`,
- la cohérence des placeholders `{{...}}`,
- l'utilisation du bon format de pluriel.

## Langues RTL

Pour les langues qui s'écrivent de droite à gauche (arabe, ourdou, hébreu, persan), `I18nManager.forceRTL(true)` est appelé automatiquement. **Un reload de l'app est nécessaire** pour que les layouts RN se ré-appliquent ; `LanguageScreen` affiche un Alert "Redémarrer" approprié quand la directionnalité change.

⚠️ **Audit RTL recommandé avant de communiquer largement sur le support arabe/ourdou** :
- vérifier que les chevrons (`chevron-forward`) pointent dans le bon sens,
- vérifier que les marges/paddings asymétriques (paddingLeft/paddingRight) deviennent des `paddingStart`/`paddingEnd`,
- vérifier les transformations (`transform: scaleX`),
- les icônes "retour" et "envoi" doivent souvent être miroir.

## Références dans le code

- `t('namespace.key')` → autocomplété par TypeScript via `types.d.ts` (le schéma est `fr.json`, mais comme `en.json` est synchronisé, c'est équivalent).
- `i18n.t(...)` (sans hook) → utilisable hors composant React (services, helpers).
- `useTranslation()` → re-render automatique au `changeLanguage()`.

Pour ajouter une nouvelle clé :
1. La créer dans **toutes** les langues (ou au moins en/fr — les autres tomberont en fallback EN sinon).
2. Lancer le validateur pour repérer les manques.
