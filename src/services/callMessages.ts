// src/services/callMessages.ts
// Types et utilitaires d'affichage pour les messages d'appel
//
// v13.0 - NETTOYAGE:
//   - Suppression de createCallEndedMessageFromInfo (utilisait api.ts legacy sendMessage)
//   - Le système actif utilise call1to1Service → api1to1.sendCallEndedMessage1to1
//   - Ce fichier ne conserve que les types et helpers d'affichage purs

// ============================================
// TYPES
// ============================================

export interface CallMessagePayload {
  type: 'call';
  callType: 'voice' | 'video';
  status: 'ended' | 'missed' | 'declined' | 'cancelled';
  duration: number;  // En secondes
  callId: string;
  participantCount: number;
  startedAt: number;
  endedAt: number;
}

// ============================================
// UTILITAIRES D'AFFICHAGE
// ============================================

/**
 * Formate la durée d'appel pour l'affichage
 */
export function formatCallDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}min`;
  }
  
  if (secs === 0) {
    return `${minutes}min`;
  }
  
  return `${minutes}min ${secs.toString().padStart(2, '0')}s`;
}

/**
 * Retourne le texte à afficher selon le statut
 * 
 * @param status - Le statut de l'appel
 * @param isMine - true si j'ai envoyé ce message (= j'ai initié l'appel)
 * @param callerName - Le nom de l'appelant (displayName du message)
 */
export function getCallStatusText(
  status: CallMessagePayload['status'],
  isMine?: boolean,
  callerName?: string
): string {
  // Appel terminé normalement - afficher la durée
  if (status === 'ended') {
    return 'Appel vocal';
  }
  
  // Appel non abouti (missed, declined, cancelled)
  // Si ce n'est pas mon message → quelqu'un m'a appelé → "Appel manqué de XXX"
  if (!isMine && callerName) {
    return `Appel manqué de ${callerName}`;
  }
  
  // Si c'est mon message → j'ai appelé quelqu'un → "Appel sans réponse"
  return 'Appel sans réponse';
}

/**
 * Vérifie si un message est un message d'appel
 */
export function isCallMessage(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return parsed.type === 'call';
  } catch {
    return false;
  }
}

/**
 * Parse le payload d'un message d'appel
 */
export function getCallPayload(content: string): CallMessagePayload | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.type === 'call') {
      return parsed as CallMessagePayload;
    }
    return null;
  } catch {
    return null;
  }
}