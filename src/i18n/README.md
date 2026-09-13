# Internationalization (i18n) — Ghostr

Ce dossier contient toute la configuration multilangue de Ghostr.

## Architecture

```
src/i18n/
├── index.ts          → init i18next, détection device, changement de langue
├── languages.ts      → liste des langues + métadonnées (RTL, nom natif, etc.)
├── storage.ts        → persistance du choix utilisateur (AsyncStorage)
├── types.d.ts        → augmentation TS pour autocomplétion sur t('...')
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

Quatre fichiers à modifier, dans cet ordre :

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

### 4. Ajouter les chaînes natives

Créer `locales/<code>.json` (à la racine du repo, PAS dans ce dossier) sur le
modèle de `locales/en.json`, puis le déclarer dans `app.json` :

```json
"locales": { "ja": "./locales/ja.json" }
```

Sans cette étape, les dialogues de permission iOS restent en anglais pour
cette langue. Voir la section « Chaînes natives » en bas de ce fichier.

### 5. (Obligatoire) Lancer le validateur

```bash
npm run i18n:check          # = node scripts/validate-i18n.js
```

Il sort en code 1 si un contrôle **bloquant** échoue (utilisable en
pre-commit / CI) :

1. chaque clé `t('…')` littérale du code existe dans **les 8 bundles**
   (formes plurielles comprises),
2. parité des clés avec `en.json` (aucune absente, aucune orpheline),
3. placeholders `{{…}}` identiques à ceux d'`en.json`,
4. aucune valeur vide,
5. tout repli littéral (`defaultValue` / 2ᵉ argument de `t()`) est identique
   à la valeur d'`en.json`.

Et **avertit** (non bloquant) sur :

6. les valeurs restées en alphabet latin dans une langue à script non latin
   (ar, ru, ur) → traduction probablement oubliée,
7. les clés jamais référencées littéralement (souvent des clés construites :
   ``t(`terms.${key}Title`)``).

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

## Règle : pas de repli, ou alors identique à `en.json`

`t('clé', 'repli')` et `t('clé', { defaultValue: '…' })` n'affichent leur repli
que si la clé manque dans le bundle actif **et** dans `en.json`. Quand la clé
existe partout, le repli est donc du code mort — et un repli mort masque les
régressions.

Pire, un repli **français** rend un trou de traduction **invisible depuis une
session française** : le français s'affiche alors pour tout le monde, y compris
en russe ou en arabe. C'est exactement ce qui s'était produit pour
`conversation.tapToRetry`, `conversation.decrypting`, `conversation.file` et
`conversation.tap` : absentes des 8 bundles, elles affichaient « Réessayer »,
« Déchiffrement… », « Fichier » et « Appuyer » dans toutes les langues.

Règle appliquée dans le code, vérifiée par le contrôle n°5 :

- par défaut, **pas de repli** : `t('groups.leave')` ;
- si un repli est vraiment nécessaire (garde-fou d'`ErrorBoundary`, qui
  s'exécute dans un `catch` où i18next peut être HS), il doit reproduire
  **mot pour mot** la valeur d'`en.json` — cohérent avec `fallbackLng: 'en'`.

## Règle : les services renvoient des CODES, pas des phrases

Un message d'erreur destiné à l'écran ne doit jamais venir d'un `throw new
Error('create failed')` de service : il s'afficherait tel quel, en anglais
technique, dans les 8 langues.

Les services renvoient des codes `ERR_*` (`src/services/errorMessages.ts`,
objet `GroupError`) et l'UI les traduit :

```ts
// service
if (!groups.amIAdmin(groupId)) return { success: false, error: GroupError.NOT_ADMIN };

// écran — le code connu donne un message dédié, sinon le repli de l'écran
showAlert({ title: t('common.error'), message: errorMessage(e, 'groups.createFailed') });

// écran qui connaît déjà le message exact à afficher
throw localizedError('groups.qrExpired');
```

`errorMessage()` n'affiche **jamais** le texte technique : celui-ci reste dans
les logs.

## Chaînes natives (dialogues de permission iOS)

Les descriptions de permissions (`NSCameraUsageDescription`…) ne passent pas
par i18next : elles sont lues par iOS dans le bundle de l'app. Elles vivent
dans `locales/<code>.json` à la racine et sont déclarées par `expo.locales`
dans `app.json`.

Au `prebuild`, Expo écrit `ios/Ghostr/Supporting/<code>.lproj/InfoPlist.strings`
(et `android/app/src/main/res/values-b+<code>/strings.xml`) et les ajoute au
projet Xcode. **Toute nouvelle langue doit donc être ajoutée aux deux
endroits** : `src/i18n/resources/` (interface) et `locales/` (dialogues
système).

⚠️ Le générateur écrit `CLÉ = "valeur";` : une valeur contenant un guillemet
droit (`"`) casserait le fichier `.strings`. Utiliser des guillemets
typographiques (« », “ ”) le cas échéant.
