// src/services/haptics.ts
// ════════════════════════════════════════════════════════════════════════════
// RETOUR HAPTIQUE — grammaire unique de l'application
// ════════════════════════════════════════════════════════════════════════════
//
// Avant ce module, l'app utilisait `Vibration.vibrate(ms)` de React Native.
// C'est un moteur de vibration brut : sur iOS il ignore la durée demandée
// (une seule vibration de ~400 ms), sur Android il fait tourner le moteur
// à pleine puissance. Résultat : un feel daté et bruyant, très éloigné du
// Taptic Engine attendu en 2026.
//
// `expo-haptics` s'appuie sur les API natives (UIImpactFeedbackGenerator /
// HapticFeedbackConstants) et produit les micro-impulsions courtes des apps
// système.
//
// ────────────────────────────────────────────────────────────────────────────
// GRAMMAIRE — à respecter pour que l'app parle d'une seule voix
// ────────────────────────────────────────────────────────────────────────────
//   selection()  → franchissement de seuil dans un geste, changement de
//                  sélection, tick de curseur. Le plus léger, le plus fréquent.
//   impact()     → action confirmée par l'utilisateur : envoi d'un message,
//                  verrouillage de l'enregistrement vocal, appui long qui
//                  ouvre un menu.
//   success()    → une opération asynchrone s'est bien terminée.
//   warning()    → l'action a abouti mais mérite l'attention.
//   error()      → l'action a échoué : mot de passe faux, envoi impossible.
//
// ────────────────────────────────────────────────────────────────────────────
// ROBUSTESSE
// ────────────────────────────────────────────────────────────────────────────
// Toutes les fonctions sont « fire and forget » et n'échouent JAMAIS :
//   - le module natif peut être absent (Expo Go, build sans le plugin) ;
//   - l'appareil peut ne pas avoir de moteur haptique ;
//   - l'utilisateur peut avoir désactivé le retour haptique au niveau OS.
// Dans tous ces cas on ne veut ni crash ni log bruyant — le retour haptique
// est un enrichissement, jamais une dépendance fonctionnelle.
//
// ────────────────────────────────────────────────────────────────────────────
// PRIVACY
// ────────────────────────────────────────────────────────────────────────────
// Aucun appel réseau, aucune permission, aucune donnée collectée.

import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

// Le web n'a pas de moteur haptique ; on court-circuite pour éviter un
// aller-retour inutile vers le bridge.
const SUPPORTED = Platform.OS === 'ios' || Platform.OS === 'android';

/**
 * Exécute un effet haptique en avalant toute erreur.
 *
 * `expo-haptics` renvoie une promesse rejetée quand le moteur natif est
 * indisponible. Sans le `.catch`, cela produit une « unhandled promise
 * rejection » qui remonte jusqu'au handler global en dev.
 */
function fire(run: () => Promise<void>): void {
  if (!SUPPORTED) return;
  try {
    run().catch(() => {
      /* moteur haptique absent ou désactivé — non bloquant */
    });
  } catch {
    /* module natif absent (Expo Go, build sans plugin) — non bloquant */
  }
}

/**
 * Franchissement de seuil dans un geste, changement de sélection.
 * Le plus léger : peut être déclenché plusieurs fois par seconde.
 */
export function selection(): void {
  fire(() => Haptics.selectionAsync());
}

/**
 * Action confirmée par l'utilisateur.
 *
 * @param strength 'light' pour un geste discret, 'medium' pour une action
 *                 réelle (défaut), 'heavy' pour un seuil irréversible.
 */
export function impact(strength: 'light' | 'medium' | 'heavy' = 'medium'): void {
  const style =
    strength === 'light'
      ? Haptics.ImpactFeedbackStyle.Light
      : strength === 'heavy'
        ? Haptics.ImpactFeedbackStyle.Heavy
        : Haptics.ImpactFeedbackStyle.Medium;
  fire(() => Haptics.impactAsync(style));
}

/** Une opération asynchrone s'est bien terminée. */
export function success(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** L'action a abouti mais mérite l'attention de l'utilisateur. */
export function warning(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}

/** L'action a échoué. */
export function error(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}

export const haptics = { selection, impact, success, warning, error };

export default haptics;
