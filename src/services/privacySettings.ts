// src/services/privacySettings.ts
// Gestion de la confidentialité - AUTOMATIQUE, pas de choix utilisateur

import {
  startDecoyService,
  stopDecoyService,
  getDecoyServiceStatus,
} from './decoyService';
import { isRelayEnabled, getApiUrl } from './api';

// ============================================
// TYPES
// ============================================

export interface PrivacyStatus {
  decoyEnabled: boolean;
  decoysSentCount: number;
  lastDecoyTime: Date | null;
  relayEnabled: boolean;
  apiUrl: string;
}

// ============================================
// INITIALISATION (appelé au démarrage)
// ============================================

export function initializePrivacyServices(): void {
  startDecoyService();
}

export function pausePrivacyServices(): void {
  stopDecoyService();
}

export function resumePrivacyServices(): void {
  startDecoyService();
}

// ============================================
// STATUS
// ============================================

export function getPrivacyStatus(): PrivacyStatus {
  const decoyStatus = getDecoyServiceStatus();
  
  return {
    decoyEnabled: decoyStatus.isRunning,
    decoysSentCount: decoyStatus.decoysSentCount,
    lastDecoyTime: decoyStatus.lastDecoyTime,
    relayEnabled: isRelayEnabled(),
    apiUrl: getApiUrl(),
  };
}

export function formatRelativeTime(date: Date | null): string {
  if (!date) return 'Jamais';
  
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  
  if (diffSeconds < 60) {
    return 'À l\'instant';
  } else if (diffMinutes < 60) {
    return `Il y a ${diffMinutes} min`;
  } else if (diffHours < 24) {
    return `Il y a ${diffHours}h`;
  } else {
    return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
}