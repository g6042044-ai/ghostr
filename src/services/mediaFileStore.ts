// src/services/mediaFileStore.ts
// v25.2: Externalisation des données média du SQLite vers le filesystem
//
// PROBLÈME RÉSOLU:
//   saveLocalMessage1to1 stocke les 500 derniers messages comme un JSON blob
//   dans AsyncStorage (SQLite). Chaque image = 200KB-5MB de base64 inline.
//   20 images → 12MB dans UNE SEULE ligne SQLite → SQLITE_FULL.
//
// SOLUTION:
//   Extraire les champs base64 volumineux vers des fichiers sur le filesystem.
//   Les messages ne stockent qu'une référence (file URI ~80 bytes).
//   Réduction: 99.9% de la taille en SQLite.
//
// ARCHITECTURE:
//   Save: message.imageData (500KB base64) → fichier sur disque → message.imageData = "mfs://<path>"
//   Load: message.imageData = "mfs://<path>" (gardé tel quel, résolu à la demande)
//   UI:   resolveMediaUri(message.imageData) → "file:///..." (pour <Image>) ou base64 (pour legacy)
//
// COMPATIBILITÉ:
//   Messages existants (base64 inline) fonctionnent toujours.
//   Les composants UI vérifient le préfixe avant d'appliquer la résolution.

import * as FileSystem from 'expo-file-system/legacy';

// ============================================
// CONSTANTS
// ============================================

/** Préfixe identifiant une référence fichier (pas un vrai base64) */
const MFS_PREFIX = 'mfs://';

/** Seuil: les champs > 4KB sont externalisés. Couvre tous les médias
 *  tout en gardant les petites données inline (texte, emojis, etc.) */
const EXTERNALIZE_THRESHOLD = 4096;

/** Répertoire racine du media store */
const MEDIA_ROOT = 'ghostr_media/';

/** Champs à externaliser dans Message1to1 */
const MEDIA_FIELDS = [
  'imageData',
  'thumbnailData',
  'fileData',
  'voiceData',
  'senderAvatarBase64',
] as const;

type MediaField = typeof MEDIA_FIELDS[number];

// ============================================
// DIRECTORY MANAGEMENT
// ============================================

/** Cache des répertoires déjà créés (évite mkdir répétés) */
const createdDirs = new Set<string>();

/**
 * Obtient le répertoire média pour une session, le crée si nécessaire.
 * Format: ${documentDirectory}ghostr_media/${sessionId_short}/
 */
async function ensureMediaDir(sessionId: string): Promise<string> {
  // Utiliser les 16 premiers chars du sessionId pour éviter les paths trop longs
  const shortId = sessionId.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16);
  const dir = `${FileSystem.documentDirectory}${MEDIA_ROOT}${shortId}/`;
  
  if (!createdDirs.has(dir)) {
    try {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    } catch {
      // Directory already exists — OK
    }
    createdDirs.add(dir);
  }
  
  return dir;
}

/**
 * Génère le chemin de fichier pour un champ média d'un message.
 */
function mediaFilePath(dir: string, messageId: string, field: MediaField): string {
  // messageId peut contenir des caractères spéciaux (UUID), sanitize
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return `${dir}${safeId}_${field}`;
}

// ============================================
// EXTERNALIZE (Save path)
// ============================================

/**
 * Externalise les données média volumineuses d'un message vers le filesystem.
 * Les champs base64 > EXTERNALIZE_THRESHOLD sont écrits sur disque et
 * remplacés par des références "mfs://path".
 *
 * Les messages déjà externalisés (champs commençant par "mfs://") sont ignorés.
 * Les messages sans média sont retournés tels quels (pas de copie).
 *
 * @returns Une copie du message avec les champs média remplacés par des refs
 */
export async function externalizeMedia(
  sessionId: string,
  message: Record<string, any>
): Promise<Record<string, any>> {
  let hasMediaToExternalize = false;
  
  // Fast check: y a-t-il des champs à externaliser?
  for (const field of MEDIA_FIELDS) {
    const value = message[field];
    if (
      value &&
      typeof value === 'string' &&
      value.length > EXTERNALIZE_THRESHOLD &&
      !value.startsWith(MFS_PREFIX)
    ) {
      hasMediaToExternalize = true;
      break;
    }
  }
  
  if (!hasMediaToExternalize) return message;
  
  const dir = await ensureMediaDir(sessionId);
  const stripped = { ...message };
  
  for (const field of MEDIA_FIELDS) {
    const value = stripped[field];
    if (
      value &&
      typeof value === 'string' &&
      value.length > EXTERNALIZE_THRESHOLD &&
      !value.startsWith(MFS_PREFIX)
    ) {
      const filePath = mediaFilePath(dir, message.id || 'unknown', field);
      
      try {
        await FileSystem.writeAsStringAsync(filePath, value, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        stripped[field] = `${MFS_PREFIX}${filePath}`;
      } catch (error) {
        // Si l'écriture échoue, garder le base64 inline (dégradation gracieuse)
        console.warn(`[MediaFileStore] ⚠️ Failed to externalize ${field}:`, error);
      }
    }
  }
  
  return stripped;
}

// ============================================
// RESOLVE (Load path)
// ============================================

/**
 * Vérifie si une valeur est une référence MediaFileStore.
 */
export function isMediaRef(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(MFS_PREFIX);
}

/**
 * Résout une référence média en file URI utilisable par React Native.
 * - Pour les images: retourne "file:///..." directement utilisable dans <Image>
 * - Pour les fichiers/vocaux: retourne le chemin du fichier
 *
 * Si la valeur n'est pas une référence (base64 inline), retourne null.
 * L'appelant doit alors utiliser la valeur directement.
 */
export function resolveMediaToFileUri(value: string | undefined): string | null {
  if (!value || !value.startsWith(MFS_PREFIX)) return null;
  return value.slice(MFS_PREFIX.length);
}

/**
 * Résout un champ média pour affichage dans un composant <Image>.
 * Retourne un URI prêt à l'emploi:
 *   - "file:///..." si externalisé
 *   - "data:image/jpeg;base64,..." si base64 inline
 *
 * @param value - La valeur du champ (base64 ou "mfs://path")
 * @param mimePrefix - Préfixe MIME (default: "data:image/jpeg;base64,")
 */
export function resolveImageUri(
  value: string | undefined,
  mimePrefix: string = 'data:image/jpeg;base64,'
): string | undefined {
  if (!value) return undefined;
  if (value.startsWith(MFS_PREFIX)) {
    return value.slice(MFS_PREFIX.length);
  }
  // Base64 inline (legacy ou données < seuil)
  return `${mimePrefix}${value}`;
}

/**
 * Lit le contenu base64 d'une référence média.
 * Utilisé quand le composant a besoin du base64 brut (ex: FileSystem.writeAsStringAsync).
 *
 * @param value - "mfs://path" ou base64 inline
 * @returns Le contenu base64
 */
export async function resolveMediaToBase64(value: string): Promise<string> {
  if (!value.startsWith(MFS_PREFIX)) return value;
  
  const filePath = value.slice(MFS_PREFIX.length);
  try {
    return await FileSystem.readAsStringAsync(filePath, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch (error) {
    console.error('[MediaFileStore] ❌ Failed to read media file:', filePath, error);
    return ''; // Fichier manquant → données perdues
  }
}

// ============================================
// MIGRATION (pour messages existants déjà en SQLite)
// ============================================

/**
 * Migre un tableau de messages en externalisant les médias volumineux.
 * Appelé lors du premier load d'une conversation. Retourne true si
 * des messages ont été modifiés (le caller doit re-sauvegarder).
 */
export async function migrateMessagesToFileStore(
  sessionId: string,
  messages: Record<string, any>[]
): Promise<{ migrated: boolean; messages: Record<string, any>[] }> {
  let migrated = false;
  const result: Record<string, any>[] = [];
  
  for (const msg of messages) {
    let needsMigration = false;
    
    // v27.1: Supprimer senderAvatarBase64 des messages PROPRES uniquement.
    // L'avatar est résolu à l'affichage depuis le profil, pas depuis chaque message.
    // L'avatar des messages reçus est conservé (source d'avatar du contact).
    if (msg.isMine && msg.senderAvatarBase64) {
      delete msg.senderAvatarBase64;
      needsMigration = true; // marquer comme modifié pour sauvegarder
    }
    
    for (const field of MEDIA_FIELDS) {
      // v27.1: Skip senderAvatarBase64 — on le supprime, pas l'externalise
      if (field === 'senderAvatarBase64') continue;
      const val = msg[field];
      if (val && typeof val === 'string' && val.length > EXTERNALIZE_THRESHOLD && !val.startsWith(MFS_PREFIX)) {
        needsMigration = true;
        break;
      }
    }
    
    if (needsMigration) {
      const externalized = await externalizeMedia(sessionId, msg);
      result.push(externalized);
      migrated = true;
    } else {
      result.push(msg);
    }
  }
  
  return { migrated, messages: result };
}

// ============================================
// CLEANUP
// ============================================

/**
 * Supprime les fichiers média d'un message (quand il est supprimé).
 */
export async function deleteMediaFiles(sessionId: string, messageId: string): Promise<void> {
  try {
    const dir = await ensureMediaDir(sessionId);
    const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    
    for (const field of MEDIA_FIELDS) {
      const filePath = `${dir}${safeId}_${field}`;
      try {
        await FileSystem.deleteAsync(filePath, { idempotent: true });
      } catch {
        // File doesn't exist — OK
      }
    }
  } catch (error) {
    console.warn('[MediaFileStore] Cleanup error:', error);
  }
}

/**
 * Supprime tous les fichiers média d'une session.
 */
export async function deleteSessionMedia(sessionId: string): Promise<void> {
  try {
    const shortId = sessionId.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16);
    const dir = `${FileSystem.documentDirectory}${MEDIA_ROOT}${shortId}/`;
    await FileSystem.deleteAsync(dir, { idempotent: true });
    createdDirs.delete(dir);
  } catch (error) {
    console.warn('[MediaFileStore] Session cleanup error:', error);
  }
}

/**
 * Supprime tout le media store (reset complet).
 */
export async function clearAllMediaFiles(): Promise<void> {
  try {
    const rootDir = `${FileSystem.documentDirectory}${MEDIA_ROOT}`;
    await FileSystem.deleteAsync(rootDir, { idempotent: true });
    createdDirs.clear();
  } catch (error) {
    console.warn('[MediaFileStore] Full cleanup error:', error);
  }
}