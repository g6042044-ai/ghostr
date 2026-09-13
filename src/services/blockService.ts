// src/services/blockService.ts
// Blocage de contacts — Guideline App Store 1.2
//
// ARCHITECTURE (même modèle que muteService) :
//   - Cache mémoire pour les lectures synchrones
//   - AsyncStorage chiffré pour la persistance (encryptIfEnabled)
//
// CE QUE BLOQUE LE BLOCAGE :
//   L'app est invitation-only : sans nouvelle invitation mutuellement
//   acceptée, un contact dont la conversation est supprimée ne peut plus
//   JAMAIS joindre l'utilisateur (aucun annuaire, aucun identifiant public).
//   Le blocage ajoute par-dessus une liste noire d'empreintes d'identité :
//   si le contact bloqué renvoie une NOUVELLE invitation et que l'utilisateur
//   tente de l'accepter, Join1to1Screen détecte l'empreinte bloquée et
//   refuse la connexion (avec option de déblocage explicite).
//
// UTILISATION:
//   - ContactInfoScreen: « Bloquer et signaler » → blockContact()
//   - Join1to1Screen: garde anti-reconnexion → isBlockedFingerprint()

import AsyncStorage from '@react-native-async-storage/async-storage';
import { encryptIfEnabled, decryptIfNeeded } from './localCrypto';

const BLOCKED_KEY = '@ghostr_blocked_contacts';

interface BlockedEntry {
  displayName: string;
  blockedAt: number;
}

// Cache mémoire — Map<fingerprint, BlockedEntry>
let _blockedCache: Map<string, BlockedEntry> | null = null;

async function loadCache(): Promise<Map<string, BlockedEntry>> {
  if (_blockedCache) return _blockedCache;

  const cache = new Map<string, BlockedEntry>();
  try {
    const raw = await AsyncStorage.getItem(BLOCKED_KEY);
    if (raw) {
      let value: string;
      try {
        value = decryptIfNeeded(raw);
      } catch {
        value = raw; // Rétrocompatibilité données en clair
      }
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        for (const [fp, entry] of Object.entries(parsed)) {
          const e = entry as BlockedEntry;
          if (fp && e && typeof e.blockedAt === 'number') {
            cache.set(fp, { displayName: String(e.displayName || ''), blockedAt: e.blockedAt });
          }
        }
      }
    }
  } catch (error) {
    __DEV__ && console.error('[BlockService] Error loading blocked list:', error);
  }
  _blockedCache = cache;
  return cache;
}

async function persistCache(): Promise<void> {
  if (!_blockedCache) return;
  try {
    const obj: Record<string, BlockedEntry> = {};
    for (const [fp, entry] of _blockedCache) obj[fp] = entry;
    await AsyncStorage.setItem(BLOCKED_KEY, encryptIfEnabled(JSON.stringify(obj)));
  } catch (error) {
    __DEV__ && console.error('[BlockService] Error saving blocked list:', error);
  }
}

/**
 * Vérifie si une empreinte d'identité est bloquée.
 */
export async function isBlockedFingerprint(fingerprint: string | null | undefined): Promise<boolean> {
  if (!fingerprint) return false;
  const cache = await loadCache();
  return cache.has(fingerprint);
}

/**
 * Ajoute une empreinte à la liste noire.
 */
export async function blockFingerprint(fingerprint: string, displayName: string): Promise<void> {
  if (!fingerprint) return;
  const cache = await loadCache();
  cache.set(fingerprint, { displayName, blockedAt: Date.now() });
  await persistCache();
  __DEV__ && console.log(`[BlockService] Blocked ${fingerprint.slice(0, 12)}...`);
}

/**
 * Retire une empreinte de la liste noire (déblocage explicite depuis la
 * garde de Join1to1Screen).
 */
export async function unblockFingerprint(fingerprint: string): Promise<void> {
  if (!fingerprint) return;
  const cache = await loadCache();
  cache.delete(fingerprint);
  await persistCache();
}

/**
 * Nettoie le cache mémoire (reset complet / effacement des données).
 */
export function clearBlockCache(): void {
  _blockedCache = null;
}
