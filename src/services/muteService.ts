// src/services/muteService.ts
// Service de mute par conversation — persistant et réactif
//
// ARCHITECTURE:
//   - Cache mémoire (Map) pour les lectures synchrones à haute fréquence
//     (vérifié à chaque message reçu dans le poll)
//   - AsyncStorage chiffré pour la persistance (via secureGet/secureSet pattern)
//   - Pas de dépendance vers api1to1 pour éviter les imports circulaires
//
// UTILISATION:
//   - ContactInfoScreen: toggle mute via setSessionMuted()
//   - ConversationListScreen: filtre les toasts in-app via isSessionMutedSync()
//   - api1to1.ts: filtre incrementUnreadCount via isSessionMutedSync()
//   - pushNotificationService: filtre les notifications locales (pas les push OS)

import AsyncStorage from '@react-native-async-storage/async-storage';
import { encryptIfEnabled, decryptIfNeeded } from './localCrypto';

const MUTE_PREFIX = '@ghostr_muted_';

// Cache mémoire pour accès synchrone (le poll vérifie à chaque message)
const _muteCache = new Map<string, boolean>();

// Sessions déjà chargées depuis AsyncStorage (évite les lectures répétées)
const _loadedFromStorage = new Set<string>();

/**
 * Vérifie si une session est mutée — SYNCHRONE (cache mémoire uniquement).
 *
 * Si la session n'a jamais été chargée depuis AsyncStorage, retourne false
 * (non-muté par défaut). Appeler loadMuteState() au mount de l'écran
 * pour peupler le cache.
 *
 * PERF: Appelé à chaque message reçu dans le poll — doit être O(1).
 */
export function isSessionMutedSync(sessionId: string): boolean {
  return _muteCache.get(sessionId) ?? false;
}

/**
 * Charge l'état de mute depuis AsyncStorage vers le cache mémoire.
 * À appeler au mount de ContactInfoScreen et au démarrage de l'app.
 * Idempotent — ne relit pas si déjà chargé.
 */
export async function loadMuteState(sessionId: string): Promise<boolean> {
  if (_loadedFromStorage.has(sessionId)) {
    return _muteCache.get(sessionId) ?? false;
  }

  try {
    const key = MUTE_PREFIX + sessionId;
    const raw = await AsyncStorage.getItem(key);
    if (raw) {
      let value: string;
      try {
        value = decryptIfNeeded(raw);
      } catch {
        value = raw; // Rétrocompatibilité données en clair
      }
      const muted = value === 'true';
      _muteCache.set(sessionId, muted);
      _loadedFromStorage.add(sessionId);
      return muted;
    }
  } catch (error) {
    __DEV__ && console.error('[MuteService] Error loading mute state:', error);
  }

  _muteCache.set(sessionId, false);
  _loadedFromStorage.add(sessionId);
  return false;
}

/**
 * Active ou désactive le mute pour une session.
 * Met à jour le cache mémoire ET persiste dans AsyncStorage.
 */
export async function setSessionMuted(sessionId: string, muted: boolean): Promise<void> {
  // Cache mémoire immédiat
  _muteCache.set(sessionId, muted);
  _loadedFromStorage.add(sessionId);

  // Persistance chiffrée
  try {
    const key = MUTE_PREFIX + sessionId;
    const encrypted = encryptIfEnabled(muted ? 'true' : 'false');
    await AsyncStorage.setItem(key, encrypted);
    __DEV__ && console.log(`[MuteService] Session ${sessionId.slice(0, 12)}... muted: ${muted}`);
  } catch (error) {
    __DEV__ && console.error('[MuteService] Error saving mute state:', error);
  }

  // v28.0: Envoyer la préférence au pair via message E2E chiffré.
  // Le pair utilisera un blob push aléatoire → aucun push FCM/APNs ne sera envoyé.
  // Dynamic import pour éviter l'import circulaire (muteService ↔ api1to1).
  try {
    const { sendMutePreference } = await import('./api1to1');
    await sendMutePreference(sessionId, muted);
  } catch (error) {
    __DEV__ && console.warn('[MuteService] Failed to send mute preference to peer:', error);
  }
}

/**
 * Supprime l'état de mute d'une session (nettoyage à la suppression).
 */
export async function clearMuteState(sessionId: string): Promise<void> {
  _muteCache.delete(sessionId);
  _loadedFromStorage.delete(sessionId);
  try {
    await AsyncStorage.removeItem(MUTE_PREFIX + sessionId);
  } catch {}
}

/**
 * Charge les états de mute pour TOUTES les sessions connues.
 * À appeler au démarrage de l'app, après sessionService.initialize().
 *
 * @param sessionIds - Liste des IDs de sessions actives
 */
export async function loadAllMuteStates(sessionIds: string[]): Promise<void> {
  for (const id of sessionIds) {
    await loadMuteState(id);
  }
}

/**
 * Nettoie tout le cache mémoire (logout / reset complet).
 */
export function clearAllMuteCache(): void {
  _muteCache.clear();
  _loadedFromStorage.clear();
}