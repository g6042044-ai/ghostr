// src/services/securityLogger.ts
// Logging sécurisé des événements de sécurité
// Version 1.0 - Sans données sensibles
//
// IMPORTANT: Ce logger n'enregistre JAMAIS de données sensibles :
// - Pas de clés, tokens complets, mots de passe
// - Pas de contenu de messages
// - Pas d'identifiants complets (max 4 caractères de préfixe)

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from './crypto';

// ============================================
// TYPES
// ============================================

export type SecurityEventType =
  // Erreurs de chiffrement
  | 'DECRYPTION_FAILED'
  | 'ENCRYPTION_FAILED'
  | 'RATCHET_DESYNC'
  | 'INVALID_NONCE'
  
  // Erreurs d'authentification
  | 'AUTH_FAILED'
  | 'INVALID_SIGNATURE'
  | 'INVALID_TOKEN'
  | 'PIN_ATTEMPT_FAILED'
  
  // Erreurs réseau/certificat
  | 'CERTIFICATE_MISMATCH'
  | 'SSL_ERROR'
  | 'NETWORK_TAMPERING'
  
  // Détections de menaces
  | 'REPLAY_DETECTED'
  | 'ROOT_DETECTED'
  | 'JAILBREAK_DETECTED'
  | 'HOOK_DETECTED'
  | 'DEBUGGER_DETECTED'
  | 'EMULATOR_DETECTED'
  
  // Activités suspectes
  | 'SUSPICIOUS_ACTIVITY'
  | 'BRUTE_FORCE_ATTEMPT'
  | 'RATE_LIMIT_EXCEEDED'
  
  // Événements informatifs
  | 'SECURITY_CHECK_PASSED'
  | 'KEY_ROTATION'
  | 'SESSION_STARTED'
  | 'SESSION_ENDED';

export interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  timestamp: number;
  context?: {
    conversationPrefix?: string;
    errorCode?: string;
    count?: number;
    source?: string;
    appVersion?: string;
  };
  severity: 'info' | 'warning' | 'error' | 'critical';
}

export interface SecurityStats {
  totalEvents: number;
  eventsByType: Record<string, number>;
  criticalCount: number;
  lastCriticalAt: number | null;
  firstEventAt: number | null;
  lastEventAt: number | null;
}

// ============================================
// CONFIGURATION
// ============================================

const SECURITY_LOG_KEY = 'whisper_security_log_v1';
const MAX_EVENTS = 200;
const ALERT_THRESHOLDS: Partial<Record<SecurityEventType, { count: number; windowMs: number }>> = {
  DECRYPTION_FAILED: { count: 10, windowMs: 60000 },
  PIN_ATTEMPT_FAILED: { count: 5, windowMs: 300000 },
  CERTIFICATE_MISMATCH: { count: 1, windowMs: 60000 },
  BRUTE_FORCE_ATTEMPT: { count: 3, windowMs: 60000 },
  REPLAY_DETECTED: { count: 5, windowMs: 60000 },
  SUSPICIOUS_ACTIVITY: { count: 10, windowMs: 60000 },
};

const DEFAULT_THRESHOLD = { count: 10, windowMs: 60000 };

// ============================================
// LOGGER CLASS
// ============================================

class SecurityLoggerImpl {
  private events: SecurityEvent[] = [];
  private loaded = false;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onAlert: ((event: SecurityEvent, recentCount: number) => void) | null = null;
  
  async load(): Promise<void> {
    if (this.loaded) return;
    
    try {
      const stored = await AsyncStorage.getItem(SECURITY_LOG_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.events = Array.isArray(parsed) ? parsed : [];
      }
      this.loaded = true;
    } catch (error) {
      __DEV__ && console.error('Failed to load security log:', error);
      this.events = [];
      this.loaded = true;
    }
  }
  
  async log(
    type: SecurityEventType,
    context?: SecurityEvent['context']
  ): Promise<void> {
    await this.load();
    
    const severity = this.getSeverity(type);
    
    const event: SecurityEvent = {
      id: this.generateEventId(),
      type,
      timestamp: Date.now(),
      context: this.sanitizeContext(context),
      severity,
    };
    
    this.events.push(event);
    
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
    
    this.logToConsole(event);
    await this.checkAlertThreshold(event);
    this.scheduleSave();
  }
  
  async logDecryptionError(conversationId: string, errorCode?: string): Promise<void> {
    await this.log('DECRYPTION_FAILED', {
      conversationPrefix: conversationId.slice(0, 4),
      errorCode: errorCode?.slice(0, 50),
      source: 'crypto',
    });
  }
  
  async logRatchetDesync(
    conversationId: string,
    expectedIndex: number,
    receivedIndex: number
  ): Promise<void> {
    await this.log('RATCHET_DESYNC', {
      conversationPrefix: conversationId.slice(0, 4),
      errorCode: `exp:${expectedIndex},got:${receivedIndex}`,
      source: 'ratchet',
    });
  }
  
  async logAuthFailure(source: string, errorCode?: string): Promise<void> {
    await this.log('AUTH_FAILED', {
      source: source.slice(0, 20),
      errorCode: errorCode?.slice(0, 50),
    });
  }
  
  async logPinAttempt(success: boolean, attemptCount?: number): Promise<void> {
    if (!success) {
      await this.log('PIN_ATTEMPT_FAILED', {
        source: 'appLock',
        count: attemptCount,
      });
    }
  }
  
  async logDeviceSecurity(
    type: 'ROOT_DETECTED' | 'JAILBREAK_DETECTED' | 'EMULATOR_DETECTED' | 'HOOK_DETECTED' | 'DEBUGGER_DETECTED',
    details?: string
  ): Promise<void> {
    await this.log(type, {
      source: 'deviceSecurity',
      errorCode: details?.slice(0, 50),
    });
  }
  
  async logCertificateError(hostname: string, errorCode?: string): Promise<void> {
    await this.log('CERTIFICATE_MISMATCH', {
      source: hostname.split('.').slice(-2).join('.').slice(0, 20),
      errorCode: errorCode?.slice(0, 50),
    });
  }
  
  private getSeverity(type: SecurityEventType): SecurityEvent['severity'] {
    const criticalTypes: SecurityEventType[] = [
      'CERTIFICATE_MISMATCH', 'HOOK_DETECTED', 'BRUTE_FORCE_ATTEMPT', 'NETWORK_TAMPERING',
    ];
    const errorTypes: SecurityEventType[] = [
      'DECRYPTION_FAILED', 'RATCHET_DESYNC', 'INVALID_SIGNATURE', 'REPLAY_DETECTED',
      'ROOT_DETECTED', 'JAILBREAK_DETECTED',
    ];
    const warningTypes: SecurityEventType[] = [
      'AUTH_FAILED', 'PIN_ATTEMPT_FAILED', 'EMULATOR_DETECTED', 'DEBUGGER_DETECTED',
      'SUSPICIOUS_ACTIVITY',
    ];
    
    if (criticalTypes.includes(type)) return 'critical';
    if (errorTypes.includes(type)) return 'error';
    if (warningTypes.includes(type)) return 'warning';
    return 'info';
  }
  
  private sanitizeContext(context?: SecurityEvent['context']): SecurityEvent['context'] | undefined {
    if (!context) return undefined;
    
    const sanitized: SecurityEvent['context'] = {};
    
    if (context.conversationPrefix) {
      sanitized.conversationPrefix = context.conversationPrefix.slice(0, 4);
    }
    if (context.errorCode) {
      sanitized.errorCode = context.errorCode.slice(0, 100);
    }
    if (typeof context.count === 'number') {
      sanitized.count = context.count;
    }
    if (context.source) {
      sanitized.source = context.source.slice(0, 20);
    }
    if (context.appVersion) {
      sanitized.appVersion = context.appVersion.slice(0, 20);
    }
    
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }
  
  private generateEventId(): string {
    const timestamp = Date.now().toString(36);
    const random = Array.from(getRandomBytes(4))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `${timestamp}-${random}`;
  }
  
  private logToConsole(event: SecurityEvent): void {
    if (!__DEV__ && event.severity !== 'critical') return;
    
    const prefix = {
      info: 'ℹ️',
      warning: '⚠️',
      error: '❌',
      critical: '🚨',
    }[event.severity];
    
    __DEV__ && console.log(`${prefix} [Security] ${event.type}`, event.context || '');
  }
  
  private async checkAlertThreshold(event: SecurityEvent): Promise<void> {
    const threshold = ALERT_THRESHOLDS[event.type] || DEFAULT_THRESHOLD;
    const now = Date.now();
    
    const recentCount = this.events.filter(
      e => e.type === event.type && now - e.timestamp < threshold.windowMs
    ).length;
    
    if (recentCount >= threshold.count) {
      __DEV__ && console.warn(`🚨 Security Alert: ${recentCount} ${event.type} events in ${threshold.windowMs / 1000}s`);
      this.onAlert?.(event, recentCount);
    }
  }
  
  private scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    
    this.saveDebounceTimer = setTimeout(async () => {
      try {
        await AsyncStorage.setItem(SECURITY_LOG_KEY, JSON.stringify(this.events));
      } catch (error) {
        __DEV__ && console.error('Failed to save security log:', error);
      }
    }, 1000);
  }
  
  async getRecentEvents(count: number = 50): Promise<SecurityEvent[]> {
    await this.load();
    return this.events.slice(-count);
  }
  
  async getEventsByType(type: SecurityEventType, count: number = 20): Promise<SecurityEvent[]> {
    await this.load();
    return this.events.filter(e => e.type === type).slice(-count);
  }
  
  async getStats(): Promise<SecurityStats> {
    await this.load();
    
    const eventsByType: Record<string, number> = {};
    let criticalCount = 0;
    let lastCriticalAt: number | null = null;
    
    for (const event of this.events) {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
      
      if (event.severity === 'critical') {
        criticalCount++;
        if (!lastCriticalAt || event.timestamp > lastCriticalAt) {
          lastCriticalAt = event.timestamp;
        }
      }
    }
    
    return {
      totalEvents: this.events.length,
      eventsByType,
      criticalCount,
      lastCriticalAt,
      firstEventAt: this.events[0]?.timestamp || null,
      lastEventAt: this.events[this.events.length - 1]?.timestamp || null,
    };
  }
  
  setAlertCallback(callback: (event: SecurityEvent, recentCount: number) => void): void {
    this.onAlert = callback;
  }
  
  async clear(): Promise<void> {
    this.events = [];
    await AsyncStorage.removeItem(SECURITY_LOG_KEY);
  }
  
  async pruneOldEvents(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    await this.load();
    
    const cutoff = Date.now() - maxAgeMs;
    const originalCount = this.events.length;
    
    this.events = this.events.filter(e => e.timestamp > cutoff);
    
    const removedCount = originalCount - this.events.length;
    if (removedCount > 0) {
      await AsyncStorage.setItem(SECURITY_LOG_KEY, JSON.stringify(this.events));
    }
    
    return removedCount;
  }
}

export const securityLogger = new SecurityLoggerImpl();

export async function withSecurityLogging<T>(
  operation: () => Promise<T>,
  errorType: SecurityEventType,
  context?: SecurityEvent['context']
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await securityLogger.log(errorType, {
      ...context,
      errorCode: error instanceof Error ? error.message.slice(0, 50) : 'unknown',
    });
    throw error;
  }
}