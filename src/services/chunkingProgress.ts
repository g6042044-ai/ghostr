// src/services/chunkingProgress.ts
// v25.0: Système de progression pour le media chunking
//
// ARCHITECTURE:
//   Service layer (api1to1)  →  chunkingProgress  →  useChunkingProgress hook  →  UI components
//
// Ce module sert de pont entre la couche service (qui ne connaît pas React)
// et la couche UI (qui affiche la progression). Il utilise un pattern
// pub/sub minimaliste sans dépendances externes.
//
// ENVOI:
//   sendInnerPayload() met à jour la progression au fur et à mesure
//   que les chunks sont envoyés (via Promise.all résolutions individuelles).
//
// RÉCEPTION:
//   processReceivedChunk() met à jour la progression au fur et à mesure
//   que les chunks arrivent et sont assemblés.

// ============================================
// TYPES
// ============================================

export interface ChunkingProgressEntry {
  /** Direction du transfert */
  direction: 'send' | 'receive';
  
  /** Identifiant du message (pour l'envoi) ou du mediaId (pour la réception) */
  messageId: string;
  
  /** ID de session (pour associer à la bonne conversation) */
  sessionId: string;
  
  /** Nombre de chunks envoyés/reçus */
  completedChunks: number;
  
  /** Nombre total de chunks */
  totalChunks: number;
  
  /** Progression 0.0 → 1.0 */
  progress: number;
  
  /** Phase actuelle */
  phase: 'preparing' | 'transferring' | 'assembling' | 'complete' | 'error';
  
  /** Timestamp de début */
  startedAt: number;
  
  /** Timestamp de dernière mise à jour */
  updatedAt: number;
  
  /** Type de média si connu */
  mediaType?: 'image' | 'file' | 'voice';
  
  /** Taille totale estimée en bytes */
  totalSizeBytes?: number;
  
  /** Message d'erreur si phase === 'error' */
  error?: string;
}

type ProgressListener = (entries: Map<string, ChunkingProgressEntry>) => void;

// ============================================
// STATE
// ============================================

/** Toutes les progressions actives, indexées par messageId (envoi) ou mediaId (réception) */
const activeProgress = new Map<string, ChunkingProgressEntry>();

/** Listeners abonnés aux changements */
const listeners = new Set<ProgressListener>();

/** Timer de nettoyage des entrées terminées */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Durée avant suppression d'une entrée 'complete' (ms) */
const COMPLETED_TTL_MS = 5_000;

// ============================================
// NOTIFICATION DES LISTENERS
// ============================================

function notifyListeners(): void {
  // Copie shallow pour éviter les mutations pendant l'itération
  const snapshot = new Map(activeProgress);
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (e) {
      // Listener failures are silent
    }
  }
}

// ============================================
// API PUBLIQUE — CÔTÉ SERVICE (api1to1.ts)
// ============================================

/**
 * Enregistre le début d'un envoi chunké.
 * Appelé par sendInnerPayload() juste avant le batch enqueue.
 */
export function reportChunkingSendStart(
  messageId: string,
  sessionId: string,
  totalChunks: number,
  options?: { mediaType?: 'image' | 'file' | 'voice'; totalSizeBytes?: number }
): void {
  activeProgress.set(messageId, {
    direction: 'send',
    messageId,
    sessionId,
    completedChunks: 0,
    totalChunks,
    progress: 0,
    phase: 'preparing',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    mediaType: options?.mediaType,
    totalSizeBytes: options?.totalSizeBytes,
  });
  notifyListeners();
}

/**
 * Met à jour la progression d'envoi (un chunk de plus envoyé).
 * Appelé dans le .then() de chaque enqueueMessage dans le Promise.all.
 */
export function reportChunkingSendProgress(
  messageId: string,
  completedChunks: number,
  totalChunks: number
): void {
  const entry = activeProgress.get(messageId);
  if (!entry) return;
  
  entry.completedChunks = completedChunks;
  entry.totalChunks = totalChunks;
  entry.progress = totalChunks > 0 ? completedChunks / totalChunks : 0;
  entry.phase = completedChunks >= totalChunks ? 'complete' : 'transferring';
  entry.updatedAt = Date.now();
  
  notifyListeners();
}

/**
 * Marque un envoi comme terminé.
 */
export function reportChunkingSendComplete(messageId: string): void {
  const entry = activeProgress.get(messageId);
  if (!entry) return;
  
  entry.progress = 1;
  entry.phase = 'complete';
  entry.completedChunks = entry.totalChunks;
  entry.updatedAt = Date.now();
  
  notifyListeners();
}

/**
 * Marque un envoi comme échoué.
 */
export function reportChunkingSendError(messageId: string, error: string): void {
  const entry = activeProgress.get(messageId);
  if (!entry) return;
  
  entry.phase = 'error';
  entry.error = error;
  entry.updatedAt = Date.now();
  
  notifyListeners();
}

/**
 * Met à jour la progression de réception (assemblage de chunks).
 * Appelé par processReceivedChunk() dans doFetchMessages1to1.
 */
export function reportChunkingReceiveProgress(
  mediaId: string,
  sessionId: string,
  receivedChunks: number,
  totalChunks: number
): void {
  let entry = activeProgress.get(mediaId);
  
  if (!entry) {
    entry = {
      direction: 'receive',
      messageId: mediaId,
      sessionId,
      completedChunks: receivedChunks,
      totalChunks,
      progress: totalChunks > 0 ? receivedChunks / totalChunks : 0,
      phase: 'transferring',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    activeProgress.set(mediaId, entry);
  } else {
    entry.completedChunks = receivedChunks;
    entry.totalChunks = totalChunks;
    entry.progress = totalChunks > 0 ? receivedChunks / totalChunks : 0;
    entry.phase = receivedChunks >= totalChunks ? 'assembling' : 'transferring';
    entry.updatedAt = Date.now();
  }
  
  notifyListeners();
}

/**
 * Marque une réception comme terminée.
 */
export function reportChunkingReceiveComplete(mediaId: string): void {
  const entry = activeProgress.get(mediaId);
  if (!entry) return;
  
  entry.progress = 1;
  entry.phase = 'complete';
  entry.completedChunks = entry.totalChunks;
  entry.updatedAt = Date.now();
  
  notifyListeners();
}

// ============================================
// API PUBLIQUE — CÔTÉ UI (hooks React)
// ============================================

/**
 * S'abonner aux changements de progression.
 * Retourne une fonction de désabonnement.
 */
export function subscribeToProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  
  // Envoi immédiat de l'état actuel
  if (activeProgress.size > 0) {
    listener(new Map(activeProgress));
  }
  
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Obtenir la progression pour un messageId spécifique.
 */
export function getProgressForMessage(messageId: string): ChunkingProgressEntry | null {
  return activeProgress.get(messageId) || null;
}

/**
 * Obtenir toutes les progressions actives pour une session.
 */
export function getProgressForSession(sessionId: string): ChunkingProgressEntry[] {
  const results: ChunkingProgressEntry[] = [];
  for (const entry of activeProgress.values()) {
    if (entry.sessionId === sessionId && entry.phase !== 'complete') {
      results.push(entry);
    }
  }
  return results;
}

// ============================================
// NETTOYAGE
// ============================================

/**
 * Démarre le nettoyage automatique des entrées terminées.
 */
export function startProgressCleanup(): void {
  if (cleanupTimer) return;
  
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    
    for (const [key, entry] of activeProgress.entries()) {
      if (
        (entry.phase === 'complete' || entry.phase === 'error') &&
        now - entry.updatedAt > COMPLETED_TTL_MS
      ) {
        activeProgress.delete(key);
        changed = true;
      }
    }
    
    if (changed) {
      notifyListeners();
    }
  }, 2_000);
}

/**
 * Arrête le nettoyage et vide toutes les progressions.
 */
export function stopProgressCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  activeProgress.clear();
  listeners.clear();
}
