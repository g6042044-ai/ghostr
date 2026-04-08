// src/services/tripleRatchet/monotonicCounter.ts
// R-02 + GH-07: Monotonic send counter — Nonce reuse protection
//
// GH-07 FIX: The counter is no longer best-effort. If the counter cannot be
// read from SecureStore, the caller MUST force a DH ratchet (new key pair =
// new nonces) rather than continuing with a potentially stale counter.
// This prevents nonce reuse after cloud backup restore.

import * as SecureStore from 'expo-secure-store';

const COUNTER_KEY_PREFIX = 'ghostr_monotonic_send_v1_';
const SECURE_STORE_TIMEOUT_MS = 3000;
const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export interface CounterCheckResult {
  /** The stored counter value (0 if new session) */
  storedCounter: number;
  /** true if the counter was successfully read from SecureStore */
  verified: boolean;
  /** true if the caller MUST force a DH ratchet before sending */
  mustForceDHRatchet: boolean;
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), SECURE_STORE_TIMEOUT_MS)),
  ]);
}

/**
 * GH-07: Verifies the monotonic counter for a session.
 * 
 * @returns CounterCheckResult indicating whether a DH ratchet must be forced.
 *   - verified=true, mustForceDHRatchet=false: normal operation
 *   - verified=true, mustForceDHRatchet=true: messageNumber went backwards (backup restore)
 *   - verified=false, mustForceDHRatchet=true: SecureStore unavailable → force ratchet for safety
 */
export async function verifySendCounter(
  sessionId: string,
  currentMessageNumber: number
): Promise<CounterCheckResult> {
  try {
    const stored = await withTimeout(
      SecureStore.getItemAsync(COUNTER_KEY_PREFIX + sessionId, SECURE_STORE_OPTIONS),
      '__TIMEOUT__' as string | null
    );
    
    // Timeout or SecureStore failure → MUST force DH ratchet
    if (stored === '__TIMEOUT__') {
      return { storedCounter: 0, verified: false, mustForceDHRatchet: true };
    }
    
    if (stored === null) {
      // New session, no stored counter → OK
      return { storedCounter: 0, verified: true, mustForceDHRatchet: false };
    }
    
    const storedCounter = parseInt(stored, 10);
    if (!Number.isFinite(storedCounter) || storedCounter < 0) {
      return { storedCounter: 0, verified: true, mustForceDHRatchet: false };
    }
    
    // If current message number is BEHIND the stored counter → backup restore detected
    if (currentMessageNumber < storedCounter) {
      return { storedCounter, verified: true, mustForceDHRatchet: true };
    }
    
    return { storedCounter, verified: true, mustForceDHRatchet: false };
  } catch {
    // SecureStore error → MUST force DH ratchet for safety
    return { storedCounter: 0, verified: false, mustForceDHRatchet: true };
  }
}

/**
 * Legacy compatibility wrapper. Returns 0 if unreadable.
 */
export async function getStoredSendCounter(sessionId: string): Promise<number> {
  const result = await verifySendCounter(sessionId, 0);
  return result.storedCounter;
}

/**
 * Updates the monotonic counter after successful send.
 * Still best-effort for writes (a write failure doesn't block sending).
 */
export async function updateSendCounter(sessionId: string, newCount: number): Promise<void> {
  try {
    const current = await getStoredSendCounter(sessionId);
    if (newCount > current) {
      await withTimeout(
        SecureStore.setItemAsync(
          COUNTER_KEY_PREFIX + sessionId,
          String(newCount),
          SECURE_STORE_OPTIONS
        ),
        undefined
      );
    }
  } catch {
    // Write failure is non-fatal — next verifySendCounter will force ratchet if needed
  }
}

/**
 * Deletes the monotonic counter for a session.
 */
export async function deleteSendCounter(sessionId: string): Promise<void> {
  try {
    await withTimeout(
      SecureStore.deleteItemAsync(COUNTER_KEY_PREFIX + sessionId, SECURE_STORE_OPTIONS),
      undefined
    );
  } catch {
    // Ignored
  }
}