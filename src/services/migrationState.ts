// src/services/migrationState.ts
// Migration state machine — tracks "device export → wipe" lifecycle.
//
// CHANGELOG vs prior version:
//   - Removed the 'frozen' state from the active flow. The product behaviour
//     is now: after the dump is generated AND the user confirmed the file is
//     saved, the device is wiped IMMEDIATELY (no intermediate lockdown).
//   - markFrozen() is gone; markWiping() is the only "block all ops" gate.
//   - For BACKWARD COMPATIBILITY: if a marker on disk is found in the legacy
//     'frozen' state (e.g. user upgraded from a previous build mid-migration),
//     it is reinterpreted as 'wiping' so that the next boot resumes the wipe
//     instead of leaving the device permanently locked.
//
// CRITICAL INVARIANT:
//   When state is 'wiping', NO operation can advance any ratchet state.
//   This is enforced by:
//     1. App.tsx boot guard: if wiping, render the recovery screen and
//        SKIP sessionService.initialize() entirely.
//     2. relayTransport.ts secureRpc: if wiping, every RPC throws.
//   These two gates are INDEPENDENT — the second is a defense in depth.

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha256';

declare const __DEV__: boolean;

// ============================================
// TYPES
// ============================================

/**
 * 'active'    — normal device, no migration in progress
 * 'exporting' — dump is being built (transient, useful for crash recovery)
 * 'wiping'    — dump was successfully shared and the device is being wiped.
 *               If found at boot, the wipe is automatically resumed.
 * 'frozen'    — LEGACY only. Treated as 'wiping' for upgrade safety.
 */
export type MigrationStateValue = 'active' | 'exporting' | 'wiping' | 'frozen';

export interface MigrationMarker {
  /** Current state */
  state: MigrationStateValue;
  /** Unix ms when the dump was finalized */
  exportedAt: number;
  /** SHA-256 hex of the dump file — informational only */
  dumpHash: string;
  /** App version at export time — for forward compatibility */
  exportAppVersion?: string;
  /** Local cache path of the encrypted dump.
   *  Persisted so that wipeAfterExport() can delete the file as part of
   *  the wipe (otherwise the .ghostrbk would linger in cacheDirectory). */
  filePath?: string;
  /** Original file size in bytes (informational) */
  fileSize?: number;
}

// ============================================
// STORAGE KEYS
// ============================================

/** SecureStore — source of truth (tamper-resistant) */
const MIGRATION_MARKER_KEY = 'ghostr_migration_marker_v1';

/** AsyncStorage — fast hint for cold-start UI decision */
export const MIGRATION_HINT_KEY = '@ghostr_migration_hint_v1';

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

// ============================================
// IN-MEMORY CACHE
// ============================================

let _marker: MigrationMarker | null | undefined = undefined; // undefined = not loaded yet

// ============================================
// CHANGE NOTIFICATIONS
// ============================================

type StateChangeListener = () => void;
const _listeners = new Set<StateChangeListener>();

export function subscribeMigrationStateChange(fn: StateChangeListener): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

function notifyStateChange(): void {
  _listeners.forEach(fn => {
    try { fn(); } catch (e) { __DEV__ && console.warn('[migrationState] listener error:', e); }
  });
}

// ============================================
// HELPERS
// ============================================

/**
 * Returns true if the marker indicates an active/pending wipe.
 * Legacy 'frozen' markers are coerced to 'wiping' here so an interrupted
 * upgrade resumes correctly.
 */
function isWipingState(state: MigrationStateValue | undefined): boolean {
  return state === 'wiping' || state === 'frozen';
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Read the migration marker from SecureStore (slow path, ~50-300ms cold start).
 * Should be called ONCE during app boot.
 */
export async function loadMarkerFromDisk(): Promise<MigrationMarker | null> {
  try {
    const raw = await SecureStore.getItemAsync(MIGRATION_MARKER_KEY, SECURE_OPTIONS);
    if (!raw) {
      _marker = null;
      AsyncStorage.setItem(MIGRATION_HINT_KEY, 'false').catch(() => {});
      notifyStateChange();
      return null;
    }
    const parsed = JSON.parse(raw) as MigrationMarker;
    if (!parsed || typeof parsed.state !== 'string') {
      _marker = null;
      return null;
    }
    _marker = parsed;
    AsyncStorage.setItem(
      MIGRATION_HINT_KEY,
      isWipingState(parsed.state) ? 'true' : 'false'
    ).catch(() => {});
    notifyStateChange();
    return parsed;
  } catch (e) {
    __DEV__ && console.error('[migrationState] loadMarkerFromDisk error:', e);
    _marker = null;
    return null;
  }
}

/**
 * Synchronous read of the cached marker. Returns undefined if not yet loaded.
 */
export function getMigrationMarkerSync(): MigrationMarker | null | undefined {
  return _marker;
}

/**
 * Returns true if the device is currently in wipe mode (or a legacy frozen
 * marker that needs to be resumed as a wipe).
 *
 * NAME KEPT for ABI compatibility with relayTransport.ts and App.tsx — the
 * function is not literally about "frozen" anymore; it's about "any state
 * where outgoing operations must be blocked".
 */
export function isMigrationFrozen(): boolean {
  if (_marker === undefined) {
    __DEV__ && console.warn('[migrationState] isMigrationFrozen() called before loadMarkerFromDisk()');
    return false;
  }
  if (!_marker) return false;
  return isWipingState(_marker.state);
}

/**
 * AsyncStorage fast hint for the very first render (before SecureStore read).
 */
export async function getMigrationHint(): Promise<boolean | null> {
  try {
    const v = await AsyncStorage.getItem(MIGRATION_HINT_KEY);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist a new marker. Updates SecureStore (truth), AsyncStorage hint, and the cache.
 */
export async function setMarker(marker: MigrationMarker): Promise<void> {
  await SecureStore.setItemAsync(
    MIGRATION_MARKER_KEY,
    JSON.stringify(marker),
    SECURE_OPTIONS
  );

  _marker = marker;

  AsyncStorage.setItem(
    MIGRATION_HINT_KEY,
    isWipingState(marker.state) ? 'true' : 'false'
  ).catch(() => {});

  notifyStateChange();
}

/**
 * Clear the marker entirely (return to 'active', no record).
 * Called after the wipe completes, or after the user cancels an export
 * during the 'exporting' phase.
 */
export async function clearMarker(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(MIGRATION_MARKER_KEY, SECURE_OPTIONS);
  } catch (e) {
    __DEV__ && console.warn('[migrationState] clearMarker SecureStore delete failed:', e);
  }
  _marker = null;
  AsyncStorage.setItem(MIGRATION_HINT_KEY, 'false').catch(() => {});
  notifyStateChange();
}

/**
 * Compute the SHA-256 hex of a dump byte array.
 */
export function computeDumpHash(bytes: Uint8Array): string {
  const h = sha256(bytes);
  return Array.from(h).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================
// EXPLICIT STATE TRANSITIONS
// ============================================

/**
 * Transition: active → exporting
 * Marks the device as currently writing a dump. If the export crashes or is
 * cancelled before completion, clearMarker() returns the device to 'active'.
 *
 * NOTE: 'exporting' does NOT block secureRpc. It's purely informational —
 * the user is still allowed to send/receive while the (read-only) export
 * runs. This is intentional: collectExportData is a snapshot.
 */
export async function markExporting(): Promise<void> {
  await setMarker({
    state: 'exporting',
    exportedAt: Date.now(),
    dumpHash: '',
  });
}

/**
 * Transition: exporting/active → wiping
 * Called the moment the user confirms "yes, wipe this device".
 *
 * From this moment on:
 *   - secureRpc rejects every call (relayTransport.ts guard)
 *   - App.tsx renders the recovery screen which runs the wipe
 *
 * If the wipe completes normally, clearMarker() removes this marker.
 * If the app is killed mid-wipe, the next boot finds 'wiping' here and
 * resumes the operation automatically.
 *
 * @param dumpHash  SHA-256 hex of the dump file (informational)
 * @param appVersion Informational app version
 * @param filePath  Cache path of the dump file. Persisted so the wipe path
 *                  can delete it (the user already saved it externally).
 * @param fileSize  Informational size for display.
 */
export async function markWiping(
  dumpHash: string = '',
  appVersion?: string,
  filePath?: string,
  fileSize?: number,
): Promise<void> {
  const m = _marker;
  await setMarker({
    state: 'wiping',
    exportedAt: m?.exportedAt ?? Date.now(),
    dumpHash: dumpHash || m?.dumpHash || '',
    exportAppVersion: appVersion ?? m?.exportAppVersion,
    filePath: filePath ?? m?.filePath,
    fileSize: fileSize ?? m?.fileSize,
  });
}
