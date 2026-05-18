// src/services/hardwareKeyProvider.ts
// ACTION-04 (Phase 2 Security): Hardware-backed transparent encryption key
//
// PROBLEM FIXED:
//   When the user has no PIN/password, localCrypto.encryptionKey is null,
//   and encryptIfEnabled() returns plaintext. ALL local data is stored in
//   cleartext in AsyncStorage. A forensic tool extracts everything.
//
// FIX:
//   Generate a random 256-bit key at first launch and store it in the
//   platform's secure hardware (Android Keystore / iOS Secure Enclave)
//   via expo-secure-store. This key is loaded automatically at app startup.
//
// TWO-LAYER ARCHITECTURE:
//   Layer 1 (always active, transparent): Hardware key → encrypts AsyncStorage
//   Layer 2 (optional, user choice): PIN → PBKDF2 → wraps hardware key → rotation

import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

declare const __DEV__: boolean;

const HARDWARE_KEY_STORE = 'ghostr_hardware_enc_key_v1';
const HARDWARE_CONV_KEY_STORE = 'ghostr_hardware_conv_key_v1';

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

function generateKey(): Uint8Array {
  return nacl.randomBytes(32);
}

/**
 * Retrieves the hardware-backed encryption key, generating it if needed.
 * Idempotent: calling multiple times returns the same key.
 */
export async function getOrCreateHardwareKey(): Promise<Uint8Array> {
  const stored = await SecureStore.getItemAsync(HARDWARE_KEY_STORE, SECURE_STORE_OPTIONS);

  if (stored) {
    const key = decodeBase64(stored);
    if (key.length === 32) {
      __DEV__ && console.log('[HardwareKey] ✅ Loaded existing hardware key');
      return key;
    }
  }

  const newKey = generateKey();
  await SecureStore.setItemAsync(HARDWARE_KEY_STORE, encodeBase64(newKey), SECURE_STORE_OPTIONS);
  __DEV__ && console.log('[HardwareKey] 🔑 Generated new hardware encryption key');
  return newKey;
}

/**
 * Retrieves the hardware-backed conversations encryption key, generating it if needed.
 */
export async function getOrCreateHardwareConvKey(): Promise<Uint8Array> {
  const stored = await SecureStore.getItemAsync(HARDWARE_CONV_KEY_STORE, SECURE_STORE_OPTIONS);

  if (stored) {
    const key = decodeBase64(stored);
    if (key.length === 32) return key;
  }

  const newKey = generateKey();
  await SecureStore.setItemAsync(HARDWARE_CONV_KEY_STORE, encodeBase64(newKey), SECURE_STORE_OPTIONS);
  __DEV__ && console.log('[HardwareKey] 🔑 Generated new hardware conversations key');
  return newKey;
}

/**
 * Deletes both hardware keys from SecureStore.
 * WARNING: Makes ALL encrypted data permanently unrecoverable.
 */
export async function deleteHardwareKeys(): Promise<void> {
  await SecureStore.deleteItemAsync(HARDWARE_KEY_STORE);
  await SecureStore.deleteItemAsync(HARDWARE_CONV_KEY_STORE);
  __DEV__ && console.log('[HardwareKey] 🗑️ Hardware keys deleted');
}

/**
 * Verifies that BOTH hardware keys are actually persisted in SecureStore
 * with the expected format (32-byte base64).
 *
 * RATIONALE — bug de migration (mai 2026)
 *
 * `getOrCreateHardwareKey` calls `SecureStore.setItemAsync` and returns the
 * generated key. On some devices (older Android keystore, emulators with
 * partial Keychain implementations) the write can return successfully without
 * actually persisting. The in-RAM key is fine for the current session, but
 * at the next cold boot SecureStore returns null and a fresh key is generated
 * — orphaning every piece of data encrypted with the previous one.
 *
 * This function does a readback check immediately after init to detect that
 * failure mode synchronously. Callers should fail closed if it returns false.
 *
 * @returns true if both keys are present and 32 bytes; false otherwise.
 */
export async function verifyHardwareKeysPersisted(): Promise<boolean> {
  try {
    const enc = await SecureStore.getItemAsync(HARDWARE_KEY_STORE, SECURE_STORE_OPTIONS);
    if (!enc) {
      __DEV__ && console.error('[HardwareKey] ❌ Verification failed: HARDWARE_KEY_STORE missing');
      return false;
    }
    if (decodeBase64(enc).length !== 32) {
      __DEV__ && console.error('[HardwareKey] ❌ Verification failed: HARDWARE_KEY_STORE wrong length');
      return false;
    }

    const conv = await SecureStore.getItemAsync(HARDWARE_CONV_KEY_STORE, SECURE_STORE_OPTIONS);
    if (!conv) {
      __DEV__ && console.error('[HardwareKey] ❌ Verification failed: HARDWARE_CONV_KEY_STORE missing');
      return false;
    }
    if (decodeBase64(conv).length !== 32) {
      __DEV__ && console.error('[HardwareKey] ❌ Verification failed: HARDWARE_CONV_KEY_STORE wrong length');
      return false;
    }

    return true;
  } catch (e) {
    __DEV__ && console.error('[HardwareKey] ❌ Verification threw:', e);
    return false;
  }
}