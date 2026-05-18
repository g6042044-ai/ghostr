// src/services/deviceSecurity.ts
// Détection d'environnement compromis (root/jailbreak)
// Version 1.0
//
// Ce service détecte les appareils potentiellement compromis et avertit l'utilisateur.
// Les vérifications ne sont pas infaillibles mais ajoutent une couche de défense.

import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { securityLogger } from './securityLogger';
import i18n from '../i18n';

// ============================================
// TYPES
// ============================================

export type SecurityLevel = 'safe' | 'warning' | 'compromised';

export interface SecurityCheckResult {
  level: SecurityLevel;
  checks: {
    isRooted: boolean;
    isEmulator: boolean;
    hasSecureStorage: boolean;
    isDebuggerAttached: boolean;
    hasHookingFramework: boolean;
  };
  warnings: string[];
  timestamp: number;
}

// ============================================
// CHEMINS SUSPECTS
// ============================================

const SUSPICIOUS_PATHS_ANDROID = [
  '/system/app/Superuser.apk',
  '/system/xbin/su',
  '/system/bin/su',
  '/sbin/su',
  '/su/bin/su',
  '/data/local/xbin/su',
  '/data/local/bin/su',
  '/data/local/su',
  '/data/adb/magisk',
  '/sbin/.magisk',
  '/cache/.disable_magisk',
  '/dev/.magisk.unblock',
  '/data/adb/ksu',
  '/system/app/Superuser',
  '/system/app/SuperSU',
  '/system/app/KingRoot',
  '/system/app/Kinguser',
  '/system/xbin/busybox',
  '/system/bin/busybox',
  '/system/framework/XposedBridge.jar',
  '/system/bin/app_process.orig',
  '/system/bin/app_process32_original',
  '/data/data/de.robv.android.xposed.installer',
  '/data/local/tmp/frida-server',
  '/data/local/tmp/re.frida.server',
];

const SUSPICIOUS_PATHS_IOS = [
  '/Applications/Cydia.app',
  '/Applications/Sileo.app',
  '/Applications/Zebra.app',
  '/Applications/Installer.app',
  '/Applications/Icy.app',
  '/Applications/SBSettings.app',
  '/Applications/blackra1n.app',
  '/Library/MobileSubstrate/MobileSubstrate.dylib',
  '/usr/lib/libjailbreak.dylib',
  '/usr/lib/libhooker.dylib',
  '/usr/lib/libsubstitute.dylib',
  '/usr/lib/TweakInject.dylib',
  '/bin/bash',
  '/bin/sh',
  '/usr/sbin/sshd',
  '/usr/bin/ssh',
  '/etc/apt',
  '/etc/ssh/sshd_config',
  '/private/var/lib/apt',
  '/private/var/lib/cydia',
  '/private/var/stash',
  '/private/var/mobile/Library/SBSettings/Themes',
  '/var/cache/apt',
  '/var/lib/apt',
  '/var/lib/cydia',
  '/var/tmp/cydia.log',
  '/.bootstrapped_electra',
  '/.installed_unc0ver',
  '/jb/lzma',
  '/jb/offsets.plist',
  '/usr/share/jailbreak/injectme.plist',
  '/private/var/lib/undecimus/apt',
  '/Applications/FakeCarrier.app',
];

// ============================================
// VÉRIFICATIONS
// ============================================

async function checkSuspiciousPaths(): Promise<boolean> {
  const paths = Platform.OS === 'ios' 
    ? SUSPICIOUS_PATHS_IOS 
    : SUSPICIOUS_PATHS_ANDROID;
  
  for (const path of paths) {
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) {
        __DEV__ && console.warn(`⚠️ Suspicious path detected: ${path}`);
        return true;
      }
    } catch {
      // Chemin inaccessible = normal
    }
  }
  
  return false;
}

function checkEmulator(): boolean {
  if (!Device.isDevice) {
    return true;
  }
  
  if (Platform.OS === 'android') {
    const brand = (Device.brand || '').toLowerCase();
    const model = (Device.modelName || '').toLowerCase();
    const product = (Device.productName || '').toLowerCase();
    
    const emulatorIndicators = [
      'generic', 'unknown', 'google_sdk', 'emulator',
      'android sdk built for x86', 'genymotion', 'bluestacks',
      'nox', 'andy', 'memu', 'ldplayer',
    ];
    
    for (const indicator of emulatorIndicators) {
      if (brand.includes(indicator) || model.includes(indicator) || product.includes(indicator)) {
        return true;
      }
    }
  }
  
  if (Platform.OS === 'ios') {
    const model = Device.modelName || '';
    if (model.includes('Simulator')) {
      return true;
    }
  }
  
  return false;
}

async function checkSecureStorage(): Promise<boolean> {
  try {
    const testKey = '__whisper_security_test__';
    const testValue = `test_${Date.now()}_${Array.from(Crypto.getRandomBytes(4)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
    
    await SecureStore.setItemAsync(testKey, testValue);
    const readBack = await SecureStore.getItemAsync(testKey);
    await SecureStore.deleteItemAsync(testKey);
    
    if (readBack !== testValue) {
      __DEV__ && console.warn('⚠️ SecureStore integrity check failed');
      return false;
    }
    
    return true;
  } catch (error) {
    __DEV__ && console.warn('⚠️ SecureStore not available:', error);
    return false;
  }
}

function checkDebugger(): boolean {
  if (__DEV__) {
    return false;
  }
  return false;
}

async function checkHookingFramework(): Promise<boolean> {
  if (Platform.OS === 'android') {
    const hookingPaths = [
      '/system/framework/XposedBridge.jar',
      '/data/local/tmp/frida-server',
      '/data/data/de.robv.android.xposed.installer',
      '/data/data/io.va.exposed',
      '/data/data/org.lsposed.manager',
    ];
    
    for (const path of hookingPaths) {
      try {
        const info = await FileSystem.getInfoAsync(path);
        if (info.exists) return true;
      } catch {}
    }
  }
  
  if (Platform.OS === 'ios') {
    const hookingPaths = [
      '/Library/MobileSubstrate/MobileSubstrate.dylib',
      '/usr/lib/TweakInject.dylib',
      '/usr/lib/libhooker.dylib',
    ];
    
    for (const path of hookingPaths) {
      try {
        const info = await FileSystem.getInfoAsync(path);
        if (info.exists) return true;
      } catch {}
    }
  }
  
  return false;
}

// ============================================
// VÉRIFICATION COMPLÈTE
// ============================================

export async function performSecurityCheck(): Promise<SecurityCheckResult> {
  const warnings: string[] = [];
  
  const [isRooted, isEmulator, hasSecureStorage, hasHookingFramework] = await Promise.all([
    checkSuspiciousPaths(),
    Promise.resolve(checkEmulator()),
    checkSecureStorage(),
    checkHookingFramework(),
  ]);
  
  const isDebuggerAttached = checkDebugger();
  
  if (isRooted) {
    const type = Platform.OS === 'ios' ? 'JAILBREAK_DETECTED' : 'ROOT_DETECTED';
    await securityLogger.logDeviceSecurity(type);
    warnings.push(Platform.OS === 'ios' 
      ? i18n.t('deviceSecurity.warnings.jailbroken')
      : i18n.t('deviceSecurity.warnings.rooted')
    );
  }
  
  if (isEmulator) {
    await securityLogger.logDeviceSecurity('EMULATOR_DETECTED');
    warnings.push(i18n.t('deviceSecurity.warnings.emulator'));
  }
  
  if (!hasSecureStorage) {
    warnings.push(i18n.t('deviceSecurity.warnings.secureStorageUnavailable'));
  }
  
  if (isDebuggerAttached) {
    await securityLogger.logDeviceSecurity('DEBUGGER_DETECTED');
    warnings.push(i18n.t('deviceSecurity.warnings.debuggerDetected'));
  }
  
  if (hasHookingFramework) {
    await securityLogger.logDeviceSecurity('HOOK_DETECTED', 'Xposed/Frida/Substrate');
    warnings.push(i18n.t('deviceSecurity.warnings.hookingFramework'));
  }
  
  let level: SecurityLevel = 'safe';
  
  if (warnings.length > 0) {
    level = 'warning';
  }
  
  if (
    (isRooted && !hasSecureStorage) ||
    (isRooted && hasHookingFramework) ||
    (hasHookingFramework && isDebuggerAttached)
  ) {
    level = 'compromised';
  }
  
  if (level === 'safe') {
    await securityLogger.log('SECURITY_CHECK_PASSED', { source: 'deviceSecurity' });
  }
  
  return {
    level,
    checks: {
      isRooted,
      isEmulator,
      hasSecureStorage,
      isDebuggerAttached,
      hasHookingFramework,
    },
    warnings,
    timestamp: Date.now(),
  };
}

// ============================================
// MESSAGES UTILISATEUR
// ============================================

export function getSecurityWarningMessage(result: SecurityCheckResult): string | null {
  if (result.level === 'safe') {
    return null;
  }
  
  if (result.level === 'compromised') {
    return (
      i18n.t('deviceSecurity.compromisedHeader') +
      `• ${result.warnings.join('\n• ')}\n\n` +
      i18n.t('deviceSecurity.encryptionRiskMessage') +
      i18n.t('deviceSecurity.notRecommendedMessage')
    );
  }
  
  return (
    `${result.warnings.join('. ')}.\n\n` +
    i18n.t('deviceSecurity.warningMessage')
  );
}

export function getSecurityAlertTitle(result: SecurityCheckResult): string {
  switch (result.level) {
    case 'compromised':
      return i18n.t('deviceSecurity.titles.compromised');
    case 'warning':
      return i18n.t('deviceSecurity.titles.warning');
    default:
      return i18n.t('deviceSecurity.titles.security');
  }
}

// ============================================
// POLITIQUE DE SÉCURITÉ
// ============================================

export interface SecurityPolicy {
  blockOnCompromised: boolean;
  showWarning: boolean;
  disableSensitiveFeatures: boolean;
  logSecurityEvents: boolean;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  blockOnCompromised: false,
  showWarning: true,
  disableSensitiveFeatures: true,
  logSecurityEvents: true,
};

export function applySecurityPolicy(
  result: SecurityCheckResult,
  policy: SecurityPolicy = DEFAULT_SECURITY_POLICY
): {
  shouldBlock: boolean;
  shouldWarn: boolean;
  disabledFeatures: string[];
} {
  const disabledFeatures: string[] = [];
  
  if (result.level === 'compromised' && policy.disableSensitiveFeatures) {
    disabledFeatures.push('export_keys', 'backup', 'share_link_without_pin');
  }
  
  if (result.checks.isEmulator && policy.disableSensitiveFeatures) {
    disabledFeatures.push('biometric_auth');
  }
  
  return {
    shouldBlock: result.level === 'compromised' && policy.blockOnCompromised,
    shouldWarn: result.level !== 'safe' && policy.showWarning,
    disabledFeatures,
  };
}

// ============================================
// CACHE DU RÉSULTAT
// ============================================

let cachedResult: SecurityCheckResult | null = null;

export async function getSecurityCheckResult(forceRefresh: boolean = false): Promise<SecurityCheckResult> {
  if (cachedResult && !forceRefresh) {
    if (Date.now() - cachedResult.timestamp < 3600000) {
      return cachedResult;
    }
  }
  
  cachedResult = await performSecurityCheck();
  return cachedResult;
}

export function clearSecurityCache(): void {
  cachedResult = null;
}