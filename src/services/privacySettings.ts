// src/services/privacySettings.ts
// Gestion de la confidentialité - AUTOMATIQUE, pas de choix utilisateur

import {
  startDecoyService,
  stopDecoyService,
  getDecoyServiceStatus,
} from './decoyService';
import { isRelayEnabled, getApiUrl } from './api';
import i18n, { getActiveLanguage } from '../i18n';

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
  if (!date) return i18n.t('time.never');
  
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  
  if (diffSeconds < 60) {
    return i18n.t('time.justNow');
  } else if (diffMinutes < 60) {
    return i18n.t('time.minutesAgoFull', { count: diffMinutes });
  } else if (diffHours < 24) {
    return i18n.t('time.hoursAgoFull', { count: diffHours });
  } else {
    return date.toLocaleDateString(getActiveLanguage(), { day: 'numeric', month: 'short' });
  }
}