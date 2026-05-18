// src/i18n/storage.ts
// Persistance du choix de langue de l'utilisateur.
//
// SÉCURITÉ : la préférence de langue est de la MÉTADONNÉE comportementale.
// Elle ne doit JAMAIS :
//  - être envoyée au serveur (pas d'header Accept-Language vers le relay)
//  - être stockée dans Supabase
//  - apparaître dans les logs server-side
//
// Stockage local seulement, AsyncStorage suffit (donnée non-sensible).
// Pas de SecureStore pour éviter de gaspiller le store sécurisé qui doit
// rester dédié aux clés crypto.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LanguageCode } from './languages';
import { isSupportedLanguage } from './languages';

// Préfixe identique au reste de l'app (cf. App.tsx LAST_BACKGROUND_TIME_KEY,
// ONBOARDING_COMPLETED_KEY, etc.) pour cohérence de scope.
const STORAGE_KEY = '@ghostr/lang';

// Cache module-level pour bootstrap rapide. Démarre la lecture AU PLUS TÔT
// (avant que React ne mount), même pattern que _lockHintPromise dans App.tsx.
// Au moment où initI18n() est appelé, la promesse est généralement déjà
// résolue → init synchrone effectif → pas de flash de la mauvaise langue.
let _cache: LanguageCode | null | 'unloaded' = 'unloaded';

const _bootPromise: Promise<LanguageCode | null> = AsyncStorage.getItem(STORAGE_KEY)
  .then(v => {
    const code = isSupportedLanguage(v) ? v : null;
    _cache = code;
    return code;
  })
  .catch(() => {
    _cache = null;
    return null;
  });

/**
 * Lit la langue stockée. Renvoie null si l'utilisateur n'a jamais fait
 * de choix explicite (= "Système par défaut").
 *
 * Bloque uniquement si la promesse top-level n'est pas encore résolue,
 * ce qui n'arrive qu'au tout début du boot.
 */
export async function loadStoredLanguage(): Promise<LanguageCode | null> {
  if (_cache !== 'unloaded') return _cache;
  return _bootPromise;
}

/**
 * Version synchrone : renvoie la valeur cachée si déjà chargée, sinon null.
 * Utile pour le 1er render quand on ne peut pas bloquer.
 */
export function loadStoredLanguageSync(): LanguageCode | null {
  if (_cache === 'unloaded') return null;
  return _cache;
}

/**
 * Persiste le choix de langue. Passer null = "Système par défaut" =
 * supprime l'override (l'app suivra à nouveau la langue de l'OS).
 */
export async function storeLanguage(code: LanguageCode | null): Promise<void> {
  try {
    if (code === null) {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } else {
      await AsyncStorage.setItem(STORAGE_KEY, code);
    }
    _cache = code;
  } catch {
    // Silencieux : la pref n'est pas critique. L'utilisateur pourra
    // simplement re-choisir au prochain démarrage.
  }
}
