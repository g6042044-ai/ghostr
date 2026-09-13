// src/services/screenCaptureGuard.ts
// Point d'entrée UNIQUE de la protection anti-capture d'écran.
//
// ═══════════════════════════════════════════════════════════════════════════
// POURQUOI CE MODULE
// ═══════════════════════════════════════════════════════════════════════════
// La protection était armée depuis deux endroits indépendants (App.tsx au
// boot, lockGuard.releaseLock() après chaque picker/partage). Pour tourner la
// vidéo de démo exigée par App Review, il fallait commenter la ligne d'App.tsx
// — mais lockGuard la ré-armait dès la première pièce jointe, et sur iOS la
// `blockView` noire posée par expo-screen-capture n'est JAMAIS retirée par
// `allowScreenCapture` (cf. ios/ScreenCaptureModule.swift:140). Résultat :
// enregistrement d'écran noir, sans moyen de revenir en arrière.
//
// Désormais tous les chemins passent par ici, et l'autorisation est décidée
// par une SEULE expression, évaluée au chargement du module.
//
// ═══════════════════════════════════════════════════════════════════════════
// RÈGLE D'AUTORISATION — allowlist, jamais un simple interrupteur
// ═══════════════════════════════════════════════════════════════════════════
// La capture n'est autorisée QUE si les DEUX conditions sont réunies :
//
//   1. le profil de build déclaré est explicitement `development` ou
//      `preview` (variable posée par eas.json, cf. `CAPTURE_ALLOWED_PROFILES`) ;
//   2. le profil demande explicitement l'autorisation via
//      EXPO_PUBLIC_ALLOW_SCREEN_CAPTURE=1.
//
// Conséquences voulues :
//   - Le profil `production` déclare `EXPO_PUBLIC_BUILD_PROFILE=production` et
//     ne pose PAS le flag → protection armée, quoi qu'il arrive.
//   - Variable absente (build local `expo run:ios`, oubli de configuration,
//     .env bricolé) → `BUILD_PROFILE` retombe sur 'production' → protection
//     armée. Le défaut est le comportement le plus strict, jamais l'inverse.
//   - Un `.env` local qui poserait ALLOW_SCREEN_CAPTURE=1 ne suffit pas à
//     désarmer un build production : la condition 1 le bloque.
//
// Seul le mode développement (Metro, `__DEV__`) autorise la capture sans
// configuration : il ne produit aucun binaire distribuable.
//
// ═══════════════════════════════════════════════════════════════════════════
// CE QUE LA PROTECTION BLOQUE RÉELLEMENT (à connaître avant de promettre)
// ═══════════════════════════════════════════════════════════════════════════
//   Android : FLAG_SECURE — screenshots, enregistrement d'écran, scrcpy,
//             casting et miniature de l'app switcher sont bloqués par l'OS.
//             Garantie forte.
//   iOS     : l'enregistrement d'écran et le casting sont bloqués de façon
//             fiable (vue noire posée dès que `UIScreen.isCaptured` passe à
//             true). Le screenshot, lui, n'est PAS blocable : iOS n'expose
//             aucune API pour ça. expo-screen-capture applique un contournement
//             (hiérarchie de layers réparentée dans un UITextField sécurisé)
//             qui fonctionne de façon inégale selon les versions d'iOS. La
//             détection après coup (`addScreenshotListener`) et l'overlay de
//             confidentialité d'App.tsx restent les compléments côté iOS.
// ═══════════════════════════════════════════════════════════════════════════

import { Platform } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';

// Tag unique partagé par tous les appelants. expo-screen-capture maintient la
// protection tant qu'AU MOINS un tag est actif ; utiliser plusieurs tags en
// parallèle a déjà provoqué des races natives sur Android Samsung.
const SCREEN_CAPTURE_TAG = 'ghostr-global';

// Profils de build autorisés à laisser passer screenshots et enregistrements.
// Toute valeur hors de cette liste — y compris l'absence de valeur — est
// traitée comme un build de production.
const CAPTURE_ALLOWED_PROFILES = ['development', 'preview'];

const BUILD_PROFILE = process.env.EXPO_PUBLIC_BUILD_PROFILE ?? 'production';

/**
 * True uniquement dans les builds où l'on accepte que l'écran soit capturé
 * (démos App Review, tests internes, développement).
 *
 * Exporté pour que l'appelant puisse tracer la décision au boot ; la logique
 * d'armement elle-même ne doit PAS être réimplémentée ailleurs.
 */
export const SCREEN_CAPTURE_ALLOWED: boolean =
  __DEV__ ||
  (process.env.EXPO_PUBLIC_ALLOW_SCREEN_CAPTURE === '1' &&
    CAPTURE_ALLOWED_PROFILES.includes(BUILD_PROFILE));

/**
 * Arme la protection. Idempotent, sans effet dans un build autorisé à la
 * capture. À appeler au plus tôt au boot, puis après chaque désarmement
 * temporaire (cf. `disarmScreenCaptureProtection`).
 */
export function armScreenCaptureProtection(): void {
  if (SCREEN_CAPTURE_ALLOWED) return;
  ScreenCapture.preventScreenCaptureAsync(SCREEN_CAPTURE_TAG).catch(() => {});
}

/**
 * Désarme temporairement la protection — ANDROID UNIQUEMENT.
 *
 * Nécessaire car sur certains modèles Android, FLAG_SECURE noircit la preview
 * caméra et la galerie des pickers système.
 *
 * Volontairement no-op sur iOS : le besoin n'y existe pas (les pickers iOS
 * s'affichent normalement), et `allowScreenCapture` y laisse la vue noire
 * orpheline si un enregistrement est en cours au moment de l'appel — l'écran
 * resterait noir jusqu'au redémarrage de l'app, même après l'arrêt de
 * l'enregistrement.
 */
export function disarmScreenCaptureProtection(): void {
  if (SCREEN_CAPTURE_ALLOWED) return;
  if (Platform.OS !== 'android') return;
  ScreenCapture.allowScreenCaptureAsync(SCREEN_CAPTURE_TAG).catch(() => {});
}

/**
 * Ré-arme après `disarmScreenCaptureProtection`. Symétrique de celle-ci :
 * no-op sur iOS, où l'on n'a jamais désarmé.
 */
export function rearmScreenCaptureProtection(): void {
  if (SCREEN_CAPTURE_ALLOWED) return;
  if (Platform.OS !== 'android') return;
  ScreenCapture.preventScreenCaptureAsync(SCREEN_CAPTURE_TAG).catch(() => {});
}
