// src/hooks/useChunkingProgress.ts
// v25.0: Hook React pour la progression du media chunking
//
// USAGE:
//   const { getSendProgress, getReceiveProgress, hasActiveTransfers } = useChunkingProgress(sessionId);
//
//   // Dans un composant de message:
//   const progress = getSendProgress(messageId);
//   if (progress) {
//     return <MediaProgressOverlay progress={progress.progress} phase={progress.phase} />;
//   }

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  subscribeToProgress,
  ChunkingProgressEntry,
} from '../services/chunkingProgress';

export interface UseChunkingProgressResult {
  /** Obtenir la progression d'envoi pour un messageId */
  getSendProgress: (messageId: string) => ChunkingProgressEntry | null;
  
  /** Obtenir les progressions de réception actives pour la session */
  receiveEntries: ChunkingProgressEntry[];
  
  /** Y a-t-il des transferts actifs dans cette session ? */
  hasActiveTransfers: boolean;
}

/**
 * Hook qui s'abonne aux événements de progression du media chunking.
 *
 * Optimisé pour minimiser les re-renders:
 * - Utilise un ref pour le state complet
 * - Ne trigger un re-render que quand les données changent réellement
 * - Filtre par sessionId pour ne pas re-render sur des sessions non pertinentes
 */
export function useChunkingProgress(sessionId: string): UseChunkingProgressResult {
  // Ref pour stocker toutes les entrées sans trigger de re-render
  const entriesRef = useRef<Map<string, ChunkingProgressEntry>>(new Map());
  
  // State léger pour forcer les re-renders quand nécessaire
  const [revision, setRevision] = useState(0);
  
  useEffect(() => {
    const unsubscribe = subscribeToProgress((entries) => {
      // Vérifier si quelque chose a changé pour NOTRE session
      let changed = false;
      
      for (const [key, entry] of entries) {
        if (entry.sessionId !== sessionId) continue;
        
        const existing = entriesRef.current.get(key);
        if (
          !existing ||
          existing.progress !== entry.progress ||
          existing.phase !== entry.phase ||
          existing.completedChunks !== entry.completedChunks
        ) {
          changed = true;
          break;
        }
      }
      
      // Vérifier si des entrées ont été supprimées
      if (!changed) {
        for (const [key, entry] of entriesRef.current) {
          if (entry.sessionId === sessionId && !entries.has(key)) {
            changed = true;
            break;
          }
        }
      }
      
      if (changed) {
        entriesRef.current = entries;
        setRevision(r => r + 1);
      }
    });
    
    return unsubscribe;
  }, [sessionId]);
  
  const getSendProgress = useCallback((messageId: string): ChunkingProgressEntry | null => {
    const entry = entriesRef.current.get(messageId);
    if (!entry || entry.direction !== 'send') return null;
    return entry;
  }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  
  const receiveEntries: ChunkingProgressEntry[] = [];
  for (const entry of entriesRef.current.values()) {
    if (entry.sessionId === sessionId && entry.direction === 'receive' && entry.phase !== 'complete') {
      receiveEntries.push(entry);
    }
  }
  
  const hasActiveTransfers = (() => {
    for (const entry of entriesRef.current.values()) {
      if (entry.sessionId === sessionId && entry.phase !== 'complete' && entry.phase !== 'error') {
        return true;
      }
    }
    return false;
  })();
  
  return { getSendProgress, receiveEntries, hasActiveTransfers };
}
