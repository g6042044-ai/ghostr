// src/services/migrationService.ts
// Orchestration of the device-migration flow (export + import + wipe).
//
// FLOW (atomic single-device migration):
//
// EXPORT:
//   1. collectExportData() reads everything from SecureStore + AsyncStorage
//      while the user is unlocked (so localCrypto is active and decryption
//      of stored data works).
//   2. buildEncryptedDump() encrypts via Argon2id KEK / random DEK.
//   3. The caller persists the file (expo-sharing or expo-file-system).
//   4. wipeAfterExport() is called → device is wiped IMMEDIATELY.
//      No intermediate "frozen" lockdown state — the user has the dump
//      and confirmed it, so we destroy everything in one step.
//
// IMPORT:
//   1. parseAndDecryptDump() decrypts the file with the user's password.
//   2. nuclearReset() wipes any pre-existing local state.
//   3. initHardwareEncryptionAll() re-bootstraps the device-level key.
//      ⚠️ If this fails, the import ABORTS (we do not write data in plaintext).
//   4. applyImportData() writes everything back to SecureStore + AsyncStorage,
//      bypassing the lock entirely (the imported data is its own ground truth).
//   5. After this, the user must enter the app and the boot routine will
//      pick up the restored identity keys, sessions, and history naturally.
//
// CRITICAL: storage key constants below MUST stay in sync with
//   - src/services/tripleRatchet/sessionService.ts (STORAGE_KEYS)
//   - src/services/storage.ts (top-level constants)
//   - src/services/api1to1.ts (MESSAGES_1TO1_PREFIX, etc.)

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import {
  buildEncryptedDump,
  parseAndDecryptDump,
  ProgressFn,
  BuildResult,
  DumpDecryptError,
} from './secureBackup';
import {
  markExporting,
  markWiping,
  clearMarker,
  getMigrationMarkerSync,
} from './migrationState';
import {
  decryptIfNeeded,
  encryptIfEnabled,
  hasAnyEncryptionKey,
  promoteHardwareKeyToDeviceKey,
} from './localCrypto';
import {
  nuclearReset,
  initHardwareEncryptionAll,
  getConversations,
  saveConversations,
} from './storage';
import { resetLockConfiguredCache } from './tripleRatchet/sessionService';
import { deleteSendCounter } from './tripleRatchet/monotonicCounter';

declare const __DEV__: boolean;

// ============================================
// STORAGE KEYS — mirror the rest of the codebase
// ============================================

// SessionService (sessionService.ts STORAGE_KEYS)
const SS_IDENTITY_KEY_PAIR = 'ghostr_pq_identity_key_pair';
const SS_SIGNED_PRE_KEY = 'ghostr_pq_signed_pre_key';
const SS_ONE_TIME_PRE_KEYS = 'ghostr_pq_one_time_pre_keys';
const SS_NEXT_PRE_KEY_ID = 'ghostr_pq_next_pre_key_id';
const SS_PQ_SIGNED_KEY = 'ghostr_pq_pq_signed_key';
const SS_NEXT_PQ_KEY_ID = 'ghostr_pq_next_pq_key_id';
const SS_OLD_SIGNED_PRE_KEYS = 'ghostr_pq_old_signed_pre_keys';
const SS_OLD_PQ_SIGNED_KEYS = 'ghostr_pq_old_pq_signed_keys';
const SS_SESSIONS_INDEX = 'ghostr_pq_sessions_index';
const SS_SESSION_PREFIX = 'ghostr_pq_session_';
const SS_MY_PROFILE = 'ghostr_pq_my_profile';

// User secret (storage.ts)
const USER_SECRET_KEY = 'whisper_user_secret_v1';

// Global anonymous sender token (storage.ts).
// Distinct from per-conversation senderTokens (those live inside StoredConversation
// and are migrated via dump.conversationList). The global one is used as a fallback
// by isMyMessage() to identify "my own" messages in legacy entries.
const SENDER_TOKEN_KEY = 'whisper_sender_token';

// Profile (storage.ts)
const OPAQUE_DISPLAY_NAME_KEY = 'g_pd_v1';
const OPAQUE_AVATAR_KEY = 'g_pa_v1';

// 1-to-1 messages (api1to1.ts)
const MSG_1TO1_PREFIX = 'ghostr_1to1_messages_';
const LASTPOLL_1TO1_PREFIX = 'ghostr_1to1_lastpoll_';
const PROCESSED_1TO1_PREFIX = 'ghostr_1to1_processed_';
const STATUS_1TO1_PREFIX = 'ghostr_1to1_status_';
const UNREAD_1TO1_PREFIX = 'ghostr_1to1_unread_';
const REACTIONS_PREFIX = '@ghostr_reactions_';

// Mute prefixes (muteService.ts + api1to1.ts)
const MUTE_PREFIX = '@ghostr_muted_';
const PEER_MUTE_PREFIX = '@ghostr_peer_mute_';

// Key transparency pin (keyTransparency.ts)
const KEY_PIN_PREFIX = 'ghostr_key_pin_';

// Pending invites (pendingInvites.ts) — pre-generated QR codes that haven't
// been accepted yet. CRITICAL to migrate: each pending invite is bound to
// specific signedPreKeyId / pqSignedKeyId / oneTimePreKeyId from the moment
// of generation. Without these, when the contact eventually scans the QR,
// finalizeSession() on the new device would fail to find the matching keys.
const PENDING_INVITES_KEY = 'ghostr_pending_invites';
const PENDING_INVITES_COUNTER_KEY = 'ghostr_pending_invite_counter';

// KT own-registration cache (keyTransparencyMerkle.ts). Optional — the server
// is the source of truth and returns alreadyRegistered=true on re-register.
// We migrate it to avoid one extra network round-trip on first launch.
const KT_MY_REGISTRATION_KEY = 'ghostr_kt_my_registration';

// Onboarding flag (App.tsx)
const ONBOARDING_COMPLETED_KEY = '@ghostr_onboarding_completed';

// ============================================
// DUMP SCHEMA
// ============================================

export const DUMP_SCHEMA = 'ghostr-migration-v1';

export interface MigrationDump {
  $schema: typeof DUMP_SCHEMA;
  exportedAt: number;
  appVersion: string;

  /** Master identity (Ed25519 + X25519) — the cryptographic root */
  identity: {
    raw: string; // JSON of {publicKey, privateKey, dhPublicKey, dhPrivateKey}
  };

  /** User secret used for identity commitments */
  userSecret: string; // base64

  /** PQ PreKey bundle state */
  prekeys: {
    signedPreKey: string | null;        // JSON
    pqSignedKey: string | null;         // decrypted JSON or null
    oneTimePreKeys: string | null;      // decrypted JSON of all OTPKs
    nextPreKeyId: number;
    nextPQKeyId: number;
    oldSignedPreKeys: string | null;    // JSON
    oldPQSignedKeys: string | null;     // JSON
  };

  /** Active Triple Ratchet sessions */
  sessions: Array<{
    sessionId: string;
    serialized: string; // decrypted session JSON
  }>;

  /** Profile (display name, avatar) */
  profile: {
    sessionServiceProfile: string | null; // JSON of UserProfile
    displayName: string | null;           // raw, from g_pd_v1
    avatar: string | null;                // base64 from g_pa_v1
  };

  /** Per-conversation message history (decrypted) */
  conversations: Array<{
    sessionId: string;
    messages: string | null;       // JSON array
    lastPoll: string | null;       // string
    processed: string | null;      // JSON array
    status: string | null;         // JSON map
    unread: string | null;         // string number
    reactions: string | null;      // JSON map
  }>;

  /** UI conversation list (storage.ts getConversations).
   *  Without this, the new device has crypto sessions but no UI metadata,
   *  i.e. no entries in ConversationListScreen. */
  conversationList?: string; // JSON array of StoredConversation

  /** Mute preferences (per-session, both directions). */
  mutes?: Array<{
    sessionId: string;
    muted: string | null;     // 'true'/'false' from MUTE_PREFIX
    peerMuted: string | null; // 'true'/'false' from PEER_MUTE_PREFIX
  }>;

  /** Key-transparency pinned-key entries (per contact). Restoring these
   *  preserves "verified contact" status across device migration. */
  keyPins?: Array<{
    contactId: string;
    data: string; // raw JSON
  }>;

  /** Global anonymous sender token (SecureStore). Used by isMyMessage() as a
   *  fallback when a message was sent before per-conversation tokens existed.
   *  Without this, legacy "my" messages would be misattributed after migration. */
  senderToken?: string;

  /** Pending QR invites (pre-generated, awaiting acceptance by the contact).
   *  CRITICAL for users who created invites that haven't been scanned yet —
   *  each invite is bound to specific PreKey IDs and the new device must keep
   *  that binding so finalizeSession can match the keys when the contact scans. */
  pendingInvites?: {
    /** Decrypted JSON of the invites map */
    data: string | null;
    /** Decrypted counter value (number as string) */
    counter: string | null;
  };

  /** KT registration cache (informational — the server can re-issue this).
   *  Migrating it avoids one network round-trip at first launch on new device. */
  ktRegistration?: string | null;
}

// ============================================
// READ HELPERS — handle the "encrypted-or-not" cases
// ============================================

/**
 * Read an AsyncStorage key, decrypt with localCrypto if encrypted.
 * Returns null if the key doesn't exist or decryption fails.
 *
 * IMPORTANT: caller must be in unlocked state (encryption key in memory).
 * Accepts either a PIN-derived key OR a hardware-backed device key — both
 * suffice to decrypt enc1: payloads (see hasAnyEncryptionKey for rationale).
 */
async function readDecrypted(key: string): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw == null) return null;
    if (raw.startsWith('enc1:')) {
      if (!hasAnyEncryptionKey()) {
        __DEV__ && console.warn(`[migrationService] readDecrypted: encrypted data but no key for ${key}`);
        return null;
      }
      try {
        return decryptIfNeeded(raw);
      } catch {
        __DEV__ && console.warn(`[migrationService] decrypt failed for ${key}`);
        return null;
      }
    }
    return raw;
  } catch (e) {
    __DEV__ && console.warn(`[migrationService] readDecrypted error for ${key}:`, e);
    return null;
  }
}

/**
 * Write a value to AsyncStorage, encrypting with localCrypto if encryption
 * is active. Used during IMPORT.
 */
async function writeEncrypted(key: string, value: string): Promise<void> {
  const stored = encryptIfEnabled(value);
  await AsyncStorage.setItem(key, stored);
}

// ============================================
// EXPORT — collect all data into a MigrationDump
// ============================================

/**
 * Read every piece of state that the new device will need.
 * Caller MUST be in unlocked state (so localCrypto can decrypt).
 */
export async function collectExportData(appVersion: string): Promise<MigrationDump> {
  const dump: MigrationDump = {
    $schema: DUMP_SCHEMA,
    exportedAt: Date.now(),
    appVersion,
    identity: { raw: '' },
    userSecret: '',
    prekeys: {
      signedPreKey: null,
      pqSignedKey: null,
      oneTimePreKeys: null,
      nextPreKeyId: 1,
      nextPQKeyId: 1,
      oldSignedPreKeys: null,
      oldPQSignedKeys: null,
    },
    sessions: [],
    profile: {
      sessionServiceProfile: null,
      displayName: null,
      avatar: null,
    },
    conversations: [],
    conversationList: undefined,
    mutes: [],
    keyPins: [],
    senderToken: undefined,
    pendingInvites: undefined,
    ktRegistration: undefined,
  };

  // ── 1. Identity (SecureStore — always plaintext within Keychain) ────
  const identityRaw = await SecureStore.getItemAsync(SS_IDENTITY_KEY_PAIR);
  if (!identityRaw) {
    throw new Error('No identity key pair on this device — cannot export');
  }
  dump.identity.raw = identityRaw;

  // ── 2. User secret ────────────────────────────────────────────────────
  const secret = await SecureStore.getItemAsync(USER_SECRET_KEY);
  if (secret) dump.userSecret = secret;

  // ── 3. SignedPreKey (SecureStore) ────────────────────────────────────
  const spk = await SecureStore.getItemAsync(SS_SIGNED_PRE_KEY);
  if (spk) dump.prekeys.signedPreKey = spk;

  // ── 4. PQSignedKey (AsyncStorage encrypted) ──────────────────────────
  dump.prekeys.pqSignedKey = await readDecrypted(SS_PQ_SIGNED_KEY);

  // ── 5. OneTimePreKeys (AsyncStorage encrypted) ───────────────────────
  dump.prekeys.oneTimePreKeys = await readDecrypted(SS_ONE_TIME_PRE_KEYS);

  // ── 6. Counters ──────────────────────────────────────────────────────
  const nextPreKeyId = await AsyncStorage.getItem(SS_NEXT_PRE_KEY_ID);
  if (nextPreKeyId) dump.prekeys.nextPreKeyId = parseInt(nextPreKeyId, 10) || 1;
  const nextPQKeyId = await AsyncStorage.getItem(SS_NEXT_PQ_KEY_ID);
  if (nextPQKeyId) dump.prekeys.nextPQKeyId = parseInt(nextPQKeyId, 10) || 1;

  // ── 7. Old keys (for async messages — 60-day retention) ──────────────
  dump.prekeys.oldSignedPreKeys = await AsyncStorage.getItem(SS_OLD_SIGNED_PRE_KEYS);
  dump.prekeys.oldPQSignedKeys = await AsyncStorage.getItem(SS_OLD_PQ_SIGNED_KEYS);

  // ── 8. Sessions index + each session ─────────────────────────────────
  const sessionsIndexRaw = await readDecrypted(SS_SESSIONS_INDEX);
  if (sessionsIndexRaw) {
    let sessionIds: string[] = [];
    try {
      sessionIds = JSON.parse(sessionsIndexRaw);
    } catch {
      __DEV__ && console.warn('[migrationService] sessions index not JSON');
    }

    for (const sid of sessionIds) {
      const sessionData = await readDecrypted(SS_SESSION_PREFIX + sid);
      if (sessionData) {
        dump.sessions.push({ sessionId: sid, serialized: sessionData });
      }
    }
  }

  // ── 9. Profile ───────────────────────────────────────────────────────
  dump.profile.sessionServiceProfile = await readDecrypted(SS_MY_PROFILE);
  dump.profile.displayName = await readDecrypted(OPAQUE_DISPLAY_NAME_KEY);
  dump.profile.avatar = await readDecrypted(OPAQUE_AVATAR_KEY);

  // ── 10. Per-conversation messages, status, etc. ──────────────────────
  for (const { sessionId } of dump.sessions) {
    dump.conversations.push({
      sessionId,
      messages:  await readDecrypted(MSG_1TO1_PREFIX + sessionId),
      lastPoll:  await readDecrypted(LASTPOLL_1TO1_PREFIX + sessionId),
      processed: await readDecrypted(PROCESSED_1TO1_PREFIX + sessionId),
      status:    await readDecrypted(STATUS_1TO1_PREFIX + sessionId),
      unread:    await readDecrypted(UNREAD_1TO1_PREFIX + sessionId),
      reactions: await readDecrypted(REACTIONS_PREFIX + sessionId),
    });
  }

  // ── 11. UI conversation list (storage.ts) ────────────────────────────
  // This is the SecureStore-encrypted list that drives ConversationListScreen.
  // Without it, the new device sees no conversations even though sessions
  // were imported.
  try {
    const list = await getConversations();
    dump.conversationList = JSON.stringify(list);
  } catch (e) {
    __DEV__ && console.warn('[migrationService] getConversations failed (non-fatal):', e);
  }

  // ── 12. Mute prefs (per session, both directions) ────────────────────
  // Read for every known session id (keyed off the sessions index).
  for (const { sessionId } of dump.sessions) {
    const muted = await readDecrypted(MUTE_PREFIX + sessionId);
    const peerMuted = await readDecrypted(PEER_MUTE_PREFIX + sessionId);
    if (muted != null || peerMuted != null) {
      dump.mutes!.push({ sessionId, muted, peerMuted });
    }
  }

  // ── 13. Key-transparency pins (verified contacts) ────────────────────
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const pinKeys = allKeys.filter(k => k.startsWith(KEY_PIN_PREFIX));
    for (const k of pinKeys) {
      const data = await AsyncStorage.getItem(k);
      if (data != null) {
        dump.keyPins!.push({
          contactId: k.slice(KEY_PIN_PREFIX.length),
          data,
        });
      }
    }
  } catch (e) {
    __DEV__ && console.warn('[migrationService] keyPins read failed (non-fatal):', e);
  }

  // ── 14. Global anonymous sender token (SecureStore) ──────────────────
  try {
    const senderTokenRaw = await SecureStore.getItemAsync(SENDER_TOKEN_KEY);
    if (senderTokenRaw) dump.senderToken = senderTokenRaw;
  } catch (e) {
    __DEV__ && console.warn('[migrationService] senderToken read failed (non-fatal):', e);
  }

  // ── 15. Pending QR invites (AsyncStorage encrypted) ──────────────────
  // Both the invites map AND the counter must travel together — counter is
  // referenced by labels in the invites map (Invite #1, #2, ...).
  try {
    const invitesData = await readDecrypted(PENDING_INVITES_KEY);
    const invitesCounter = await readDecrypted(PENDING_INVITES_COUNTER_KEY);
    if (invitesData != null || invitesCounter != null) {
      dump.pendingInvites = {
        data: invitesData,
        counter: invitesCounter,
      };
    }
  } catch (e) {
    __DEV__ && console.warn('[migrationService] pendingInvites read failed (non-fatal):', e);
  }

  // ── 16. KT registration cache (AsyncStorage plaintext) ───────────────
  try {
    const ktReg = await AsyncStorage.getItem(KT_MY_REGISTRATION_KEY);
    if (ktReg != null) dump.ktRegistration = ktReg;
  } catch (e) {
    __DEV__ && console.warn('[migrationService] ktRegistration read failed (non-fatal):', e);
  }

  return dump;
}

/**
 * Top-level: collect + encrypt, returning the file bytes ready to be saved.
 * This is the entry point for the Export UI.
 */
export async function createMigrationFile(
  password: string,
  appVersion: string,
  onProgress?: ProgressFn
): Promise<BuildResult> {
  // 1. Mark exporting (so a crash during this phase is recoverable).
  await markExporting();

  try {
    onProgress?.(0.02, 'collect');
    const dump = await collectExportData(appVersion);

    // 2. Encrypt. buildEncryptedDump handles 0.02..1.0 of the progress range.
    const result = await buildEncryptedDump(dump, password, appVersion, p =>
      onProgress?.(0.02 + 0.96 * p, 'encrypt')
    );

    onProgress?.(1, 'done');
    return result;
  } catch (e) {
    // Roll back marker so the device can be used normally if export fails
    await clearMarker().catch(() => {});
    throw e;
  }
}

// ============================================
// IMPORT — apply a MigrationDump to a fresh device
// ============================================

function isMigrationDump(obj: unknown): obj is MigrationDump {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as any).$schema === DUMP_SCHEMA &&
    typeof (obj as any).identity === 'object' &&
    typeof (obj as any).identity.raw === 'string'
  );
}

/**
 * Parse a migration file with the user's password and validate the schema.
 * Throws DumpDecryptError on bad password / tampered / corrupt content.
 */
export async function decryptAndValidateMigrationFile(
  fileBytes: Uint8Array,
  password: string,
  onProgress?: ProgressFn
): Promise<MigrationDump> {
  const parsed = await parseAndDecryptDump(fileBytes, password, onProgress);
  if (!isMigrationDump(parsed.data)) {
    throw new DumpDecryptError(
      'corrupt_content',
      'File does not contain a valid migration dump'
    );
  }
  return parsed.data;
}

/**
 * Apply a decrypted MigrationDump to the local device.
 *
 * STEPS:
 *   1. nuclearReset() — wipe ALL existing local state.
 *   2. initHardwareEncryptionAll() — re-bootstrap device-level keys.
 *      ⚠️ FAIL-CLOSED: if this fails, we throw and DO NOT write anything.
 *      Previous behaviour was to write data unencrypted, which violates
 *      the threat model (sessions and message history would land in plaintext
 *      on disk until the next unlock). Better to fail the import loudly so
 *      the user retries — they can also reboot and try again.
 *   3. Write identity, prekeys, profile, sessions, conversations, etc.
 *   4. Set the onboarding flag and clear any leftover migration marker.
 *
 * The caller is then responsible for triggering an app reload.
 */
export async function applyMigrationDump(
  dump: MigrationDump,
  onProgress?: ProgressFn
): Promise<void> {
  __DEV__ && console.log('[migrationService] applyMigrationDump START');

  // ── 1. Nuke existing local state ─────────────────────────────────────
  onProgress?.(0.02, 'wipe');
  await nuclearReset();

  // ── 1a. Reset module caches that may be stale post-nuclearReset ──────
  //
  // `_lockConfiguredCache` (sessionService) memoizes whether a PIN was ever
  // configured by looking at SecureStore's `whisper_lock_data_v6`. nuclearReset
  // deletes that key but does NOT touch the in-memory cache. If the cache was
  // true (user had a PIN before clicking "Restore"), every plaintext data we
  // hypothetically encounter later would be treated as tampered and removed.
  //
  // In the import flow we only write enc1: data so this is mostly defensive,
  // but the cost is zero and the failure mode (silent session deletion) is
  // catastrophic enough to warrant the line.
  try {
    resetLockConfiguredCache();
  } catch (e) {
    __DEV__ && console.warn('[migrationService] resetLockConfiguredCache failed:', e);
  }

  // ── 1bis. Re-bootstrap device-level encryption ────────────────────────
  // CRITICAL: nuclearReset() destroyed the hardware key. Without re-creating
  // it NOW, the writeEncrypted() calls below would fall back to plaintext.
  //
  // FAIL-CLOSED: if init fails (rare — keystore unavailable, jailbreak…),
  // we abort the import. Continuing would leave Triple Ratchet sessions
  // unencrypted on disk.
  onProgress?.(0.05, 'init_keys');
  const hwOk = await initHardwareEncryptionAll();
  if (!hwOk) {
    throw new Error(
      'Hardware encryption initialization failed. Import aborted to avoid ' +
      'writing data in plaintext. Reboot the device and retry.'
    );
  }

  // ── 1ter. Promote hardwareKey → persistent DEVICE_ENCRYPTION_KEY ─────
  //
  // ════════════════════════════════════════════════════════════════════════
  // CORRECTION CRITIQUE — bug "tout disparaît après reboot" (mai 2026)
  // ════════════════════════════════════════════════════════════════════════
  // Sans cette étape, après l'import on a en RAM :
  //   - hardwareKey   = K  (set par initHardwareEncryption)
  //   - encryptionKey = null
  //   - SecureStore: HARDWARE_KEY_STORE = K, MAIS PAS DEVICE_ENCRYPTION_KEY
  //
  // Conséquences sans cette correction :
  //
  // 1) Pendant la même session (juste après l'import, avant cold boot) :
  //    `isEncryptionEnabled()` retourne false (regarde encryptionKey, pas
  //    hardwareKey). Les call sites avec `if (!isEncryptionEnabled()) return
  //    null` dans secureGet/pendingInvites/etc. retournent null sur toutes
  //    les entrées enc1: fraîchement écrites → messages invisibles, envoi
  //    impossible. (Ce symptôme est aussi corrigé en aval par le passage à
  //    hasAnyEncryptionKey, mais cette étape l'évite à la source.)
  //
  // 2) Au prochain cold boot :
  //    `sessionService.ensureDeviceLevelEncryption` cherche DEVICE_ENCRYPTION_KEY
  //    en SecureStore, ne le trouve pas, et délègue à `tryRecoverFromPreFixBug`.
  //    Cette recovery sample 5 entrées AsyncStorage et exige qu'elles déchiffrent
  //    toutes avec hardwareKey. Si UNE SEULE échoue (entrée écrite par un autre
  //    service entre l'import et le boot, donnée corrompue, etc.), la recovery
  //    abandonne et `ensureDeviceLevelEncryption` génère une NOUVELLE deviceKey.
  //    À partir de là, toutes les données enc1:<chiffrées-avec-K> sont illisibles.
  //    loadSession parse JSON sur du bruit → throws → sessions chargées vides
  //    → l'app génère une nouvelle identité → "tout a disparu" pour l'utilisateur.
  //
  // La promotion proactive remplace ce chemin de récupération fragile par un
  // chemin nominal déterministe : K est immédiatement persisté sous
  // DEVICE_ENCRYPTION_KEY, et encryptionKey = K activé en RAM. Au prochain
  // boot, ensureDeviceLevelEncryption trouve DEVICE_ENCRYPTION_KEY = K, charge,
  // et tout fonctionne.
  //
  // FAIL-CLOSED : si la promotion échoue (SecureStore inaccessible, readback
  // verification fail), on AVORTE l'import. Mieux vaut demander à l'utilisateur
  // de réessayer que d'écrire des données qui seront orphelines au prochain
  // boot. Le fichier .ghostrbk est toujours là, donc rien n'est perdu.
  // ════════════════════════════════════════════════════════════════════════
  const promoted = await promoteHardwareKeyToDeviceKey();
  if (!promoted) {
    // Format aligned with the "Hardware encryption initialization failed"
    // message so MigrationImportScreen's catch (which does a string match)
    // surfaces the same user-friendly errorHardwareKeyInit message. Same
    // user remediation: reboot and retry.
    throw new Error(
      'Hardware encryption initialization failed: device key persistence ' +
      'verification did not succeed. Import aborted to avoid writing data ' +
      'that would be orphaned at next boot. Reboot the device and retry; ' +
      'if the problem persists, the device keystore may be damaged.'
    );
  }

  // ── 2. Identity (SecureStore) ────────────────────────────────────────
  onProgress?.(0.10, 'identity');
  await SecureStore.setItemAsync(SS_IDENTITY_KEY_PAIR, dump.identity.raw);

  // ── 3. User secret ───────────────────────────────────────────────────
  if (dump.userSecret) {
    await SecureStore.setItemAsync(USER_SECRET_KEY, dump.userSecret);
  }

  // ── 4. SignedPreKey (SecureStore) ────────────────────────────────────
  if (dump.prekeys.signedPreKey) {
    await SecureStore.setItemAsync(SS_SIGNED_PRE_KEY, dump.prekeys.signedPreKey);
  }

  // ── 5. AsyncStorage entries — write encrypted-if-enabled ─────────────
  onProgress?.(0.30, 'prekeys');
  if (dump.prekeys.pqSignedKey) {
    await writeEncrypted(SS_PQ_SIGNED_KEY, dump.prekeys.pqSignedKey);
  }
  if (dump.prekeys.oneTimePreKeys) {
    await writeEncrypted(SS_ONE_TIME_PRE_KEYS, dump.prekeys.oneTimePreKeys);
  }
  await AsyncStorage.setItem(SS_NEXT_PRE_KEY_ID, dump.prekeys.nextPreKeyId.toString());
  await AsyncStorage.setItem(SS_NEXT_PQ_KEY_ID, dump.prekeys.nextPQKeyId.toString());
  if (dump.prekeys.oldSignedPreKeys) {
    await AsyncStorage.setItem(SS_OLD_SIGNED_PRE_KEYS, dump.prekeys.oldSignedPreKeys);
  }
  if (dump.prekeys.oldPQSignedKeys) {
    await AsyncStorage.setItem(SS_OLD_PQ_SIGNED_KEYS, dump.prekeys.oldPQSignedKeys);
  }

  // ── 6. Sessions ──────────────────────────────────────────────────────
  onProgress?.(0.50, 'sessions');
  const sessionIds: string[] = [];
  for (const s of dump.sessions) {
    await writeEncrypted(SS_SESSION_PREFIX + s.sessionId, s.serialized);
    sessionIds.push(s.sessionId);
  }
  await writeEncrypted(SS_SESSIONS_INDEX, JSON.stringify(sessionIds));

  // ── 6bis. Cleanup des monotonic counters anti-replay ─────────────────
  //
  // ════════════════════════════════════════════════════════════════════════
  // CORRECTION CRITIQUE — bug "envoi cassé après import" (mai 2026)
  // ════════════════════════════════════════════════════════════════════════
  // Chaque session a un compteur d'envoi monotone stocké dans SecureStore
  // sous `ghostr_monotonic_send_v1_<sessionId>` (cf. monotonicCounter.ts).
  // Il sert à détecter un rollback du state Triple Ratchet et à FORCER un
  // DH ratchet de sécurité si messageNumberSend devient inférieur au
  // compteur stocké (protection nonce reuse).
  //
  // Lors d'un import, le state Triple Ratchet est restauré à l'instant
  // capturé dans le dump (messageNumberSend = N). Mais sur le device qui
  // importe, un compteur résiduel peut exister :
  //   - Soit parce que l'utilisateur a fait un import précédent puis envoyé
  //     des messages (storedCounter = M avec M > N)
  //   - Soit parce que `nuclearReset()` n'a pas réussi à lire l'index des
  //     sessions pour identifier les counters à supprimer (cas du bug
  //     `isEncryptionEnabled` en mode no-PIN, désormais corrigé en amont
  //     mais on garde la défense en profondeur)
  //
  // Conséquence si le counter résiduel n'est pas effacé :
  //   1. Premier envoi post-import : messageNumberSend = N < storedCounter = M
  //   2. verifySendCounter() → mustForceDHRatchet = true
  //   3. Triple Ratchet force un DH step imprévu côté Léo
  //   4. Le message est envoyé avec un nouveau DH public key
  //   5. Côté Bob (qui n'a pas importé), son state Triple Ratchet est
  //      ailleurs → le DH step ne s'insère pas dans sa chain → AEAD auth fail
  //   6. Symptôme observé : "Je ne reçois pas le message sur l'autre téléphone"
  //
  // SOLUTION : effacer explicitement le counter pour chaque sessionId
  // restauré. Au prochain envoi, verifySendCounter() lira null → storedCounter=0
  // → pas de rollback détecté → pas de forced DH ratchet → le message s'insère
  // dans la chain prévue → Bob déchiffre.
  //
  // SÉCURITÉ : effacer les counters supprime la protection anti-replay UNE
  // FOIS, juste après l'import. C'est volontaire et acceptable : le dump
  // étant une snapshot ponctuelle authentifiée par l'utilisateur (mot de
  // passe Argon2id), un attaquant qui aurait accès au dump aurait aussi
  // accès aux clés d'identité et pourrait forger n'importe quoi. La
  // protection anti-replay reprendra naturellement dès le premier envoi
  // post-import (updateSendCounter() écrira un nouveau counter).
  // ════════════════════════════════════════════════════════════════════════
  for (const s of dump.sessions) {
    try {
      await deleteSendCounter(s.sessionId);
    } catch (e) {
      // Best-effort. Une erreur ici ne bloque pas l'import — si le counter
      // n'est pas effacé, le premier envoi forcera un DH ratchet, ce qui
      // est le comportement legacy (cassé pour la communication mais sûr
      // côté nonces). Pas idéal, mais pas pire que l'état pre-fix.
      __DEV__ && console.warn(
        `[migrationService] deleteSendCounter failed for ${s.sessionId}:`,
        e
      );
    }
  }
  __DEV__ && console.log(
    `[migrationService] 🧹 Cleared ${dump.sessions.length} monotonic counter(s) ` +
    'to avoid spurious forced DH ratchets at first send post-import'
  );
  // ── 7. Profile ───────────────────────────────────────────────────────
  onProgress?.(0.70, 'profile');
  if (dump.profile.sessionServiceProfile) {
    // ⚠️  IMPORTANT: SS_MY_PROFILE is the ONLY sessionService AsyncStorage
    // key that is stored in PLAINTEXT, not via localCrypto's enc1: layer.
    // sessionService.loadProfile() reads it with a direct AsyncStorage.getItem
    // followed by JSON.parse — it does NOT call decryptIfNeeded. So if we
    // write the profile encrypted here, the next boot's loadProfile() throws
    // "JSON Parse error: Unexpected character: e" (the 'e' of 'enc1:').
    //
    // The profile contains only displayName + avatarBase64; sensitive avatar
    // bytes are independently protected by the opaque storage layer
    // (g_pd_v1/g_pa_v1) which IS encrypted. So plaintext here is fine.
    await AsyncStorage.setItem(SS_MY_PROFILE, dump.profile.sessionServiceProfile);
  }
  if (dump.profile.displayName) {
    await writeEncrypted(OPAQUE_DISPLAY_NAME_KEY, dump.profile.displayName);
  }
  if (dump.profile.avatar) {
    await writeEncrypted(OPAQUE_AVATAR_KEY, dump.profile.avatar);
  }

  // ── 8. Conversations (per-session message data) ──────────────────────
  onProgress?.(0.85, 'conversations');
  for (const c of dump.conversations) {
    if (c.messages)  await writeEncrypted(MSG_1TO1_PREFIX + c.sessionId, c.messages);
    if (c.lastPoll)  await writeEncrypted(LASTPOLL_1TO1_PREFIX + c.sessionId, c.lastPoll);
    if (c.processed) await writeEncrypted(PROCESSED_1TO1_PREFIX + c.sessionId, c.processed);
    if (c.status)    await writeEncrypted(STATUS_1TO1_PREFIX + c.sessionId, c.status);
    if (c.unread)    await writeEncrypted(UNREAD_1TO1_PREFIX + c.sessionId, c.unread);
    if (c.reactions) await writeEncrypted(REACTIONS_PREFIX + c.sessionId, c.reactions);
  }

  // ── 9. UI conversation list (storage layer) ──────────────────────────
  // Use saveConversations() so it's encrypted with the new device's hw key.
  if (dump.conversationList) {
    try {
      const list = JSON.parse(dump.conversationList);
      if (Array.isArray(list)) {
        await saveConversations(list);
      }
    } catch (e) {
      __DEV__ && console.warn('[migrationService] conversationList restore failed (non-fatal):', e);
    }
  }

  // ── 10. Mute preferences ─────────────────────────────────────────────
  if (Array.isArray(dump.mutes)) {
    for (const m of dump.mutes) {
      if (m.muted != null)     await writeEncrypted(MUTE_PREFIX + m.sessionId, m.muted);
      if (m.peerMuted != null) await writeEncrypted(PEER_MUTE_PREFIX + m.sessionId, m.peerMuted);
    }
  }

  // ── 11. Key-transparency pins (verified contacts) ────────────────────
  if (Array.isArray(dump.keyPins)) {
    for (const p of dump.keyPins) {
      try {
        await AsyncStorage.setItem(KEY_PIN_PREFIX + p.contactId, p.data);
      } catch (e) {
        __DEV__ && console.warn('[migrationService] keyPin restore failed for', p.contactId, e);
      }
    }
  }

  // ── 11b. Global anonymous sender token (SecureStore) ─────────────────
  if (dump.senderToken) {
    try {
      await SecureStore.setItemAsync(SENDER_TOKEN_KEY, dump.senderToken);
    } catch (e) {
      __DEV__ && console.warn('[migrationService] senderToken restore failed:', e);
      // Non-fatal: getSenderToken() will lazily generate a new one on demand.
      // The cost is misattribution of legacy messages (rare path).
    }
  }

  // ── 11c. Pending QR invites ──────────────────────────────────────────
  if (dump.pendingInvites) {
    try {
      if (dump.pendingInvites.data != null) {
        await writeEncrypted(PENDING_INVITES_KEY, dump.pendingInvites.data);
      }
      if (dump.pendingInvites.counter != null) {
        await writeEncrypted(PENDING_INVITES_COUNTER_KEY, dump.pendingInvites.counter);
      }
    } catch (e) {
      __DEV__ && console.warn('[migrationService] pendingInvites restore failed:', e);
    }
  }

  // ── 11d. KT registration cache ───────────────────────────────────────
  if (dump.ktRegistration != null) {
    try {
      await AsyncStorage.setItem(KT_MY_REGISTRATION_KEY, dump.ktRegistration);
    } catch (e) {
      __DEV__ && console.warn('[migrationService] ktRegistration restore failed:', e);
    }
  }

  // ── 12. Mark onboarding as done so the user lands in the main app ────
  onProgress?.(0.95, 'finalize');
  await AsyncStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');

  // ── 13. Clear any migration marker (this device is the new "active") ─
  await clearMarker();

  onProgress?.(1, 'done');
  __DEV__ && console.log('[migrationService] applyMigrationDump COMPLETE');
}

// ============================================
// WIPE — destroy this device after a successful export
// ============================================

// Single-flight guard: prevents two concurrent wipes from racing on the same
// device. This matters because (1) MigrationLockdownScreen calls resumePendingWipe
// on mount, and (2) any defensive caller could also invoke wipeAfterExport.
// Without this guard, two parallel nuclearReset / AsyncStorage.clear / SecureStore
// delete batches would interleave unpredictably. With it, the second caller
// simply awaits the in-flight promise and gets the same outcome.
let _wipePromise: Promise<void> | null = null;

/**
 * Atomic "this device is now retired" operation. Replaces the old
 * markFrozen() + manual lockdown screen + manual wipe button flow.
 *
 * Idempotent + crash-safe + concurrency-safe by design:
 *   1. markWiping() persists the intent (with the file path so we know
 *      what to delete from cache).
 *   2. nuclearReset() clears AsyncStorage, SecureStore (incl. the marker —
 *      see secureStoreKeys list in storage.ts), hardware keys, sessions,
 *      messages, and media files (documentDirectory/ghostr_media/).
 *   3. The cached .ghostrbk file is deleted (the user already saved it
 *      externally; leaving it in cacheDirectory would be sloppy).
 *   4. clearMarker() removes any leftover marker state.
 *
 * If steps 2–4 are interrupted (app killed mid-wipe), the next boot finds
 * 'wiping' on disk and the recovery screen calls this function again.
 *
 * @param dumpHash  Optional SHA-256 hex of the dump (informational).
 * @param appVersion Optional app version (informational).
 * @param filePath  Cache path of the .ghostrbk file. Will be deleted as
 *                  part of the wipe.
 * @param fileSize  Optional file size for the marker.
 */
export async function wipeAfterExport(
  dumpHash?: string,
  appVersion?: string,
  filePath?: string,
  fileSize?: number,
): Promise<void> {
  // De-duplicate concurrent callers (e.g. MigrationExport's defensive fallback
  // racing with MigrationLockdownScreen's resume).
  if (_wipePromise) {
    __DEV__ && console.log('[migrationService] wipeAfterExport: joining in-flight wipe');
    return _wipePromise;
  }

  _wipePromise = (async () => {
    __DEV__ && console.log('[migrationService] wipeAfterExport START');

    // 1. Persist the "wiping" intent BEFORE doing any destructive work.
    //    From this moment on, secureRpc rejects every call (relayTransport
    //    guard reads isMigrationFrozen() which now returns true).
    try {
      await markWiping(dumpHash, appVersion, filePath, fileSize);
    } catch (e) {
      __DEV__ && console.error('[migrationService] markWiping error during wipe:', e);
      // Continue — the wipe itself is still valuable even if we couldn't
      // persist the intent (e.g. SecureStore exhausted).
    }

    // 2. Wipe everything. nuclearReset is best-effort: each delete is
    //    independent, and it's safe to call again on a partially-wiped device.
    try {
      await nuclearReset();
    } catch (e) {
      __DEV__ && console.error('[migrationService] nuclearReset error during wipe:', e);
      // We continue to the file delete + clearMarker — leftover state is
      // either deleted by the next call, or is harmless on a fresh app start.
    }

    // 3. Delete the cached dump file. The user has already saved it externally,
    //    and a residual 1–10 MB encrypted file in cacheDirectory is sloppy.
    const pathToDelete = filePath ?? getMigrationMarkerSync()?.filePath;
    if (pathToDelete) {
      try {
        const info = await FileSystem.getInfoAsync(pathToDelete);
        if (info.exists) {
          await FileSystem.deleteAsync(pathToDelete, { idempotent: true });
        }
      } catch (e) {
        __DEV__ && console.warn('[migrationService] cache file delete failed (non-fatal):', e);
      }
    }

    // 4. Clear the marker. SecureStore's MIGRATION_MARKER_KEY is normally
    //    deleted by nuclearReset (it's in the secureStoreKeys list now), but
    //    this guarantees the in-memory cache + hint key are also reset, and
    //    listeners are notified so React re-renders out of the recovery screen.
    await clearMarker();

    __DEV__ && console.log('[migrationService] wipeAfterExport COMPLETE');
  })();

  try {
    await _wipePromise;
  } finally {
    // Release the guard so a future export-on-the-now-clean-device could,
    // theoretically, run another wipe. In practice the device is fresh and
    // there's nothing to wipe, but we don't want a permanent latch.
    _wipePromise = null;
  }
}

/**
 * Crash recovery entry point. Called by the recovery screen on cold start
 * when the marker is found in 'wiping' (or legacy 'frozen') state. Resumes
 * the wipe with whatever info the marker has; safe to call multiple times.
 */
export async function resumePendingWipe(): Promise<void> {
  const m = getMigrationMarkerSync();
  await wipeAfterExport(
    m?.dumpHash,
    m?.exportAppVersion,
    m?.filePath,
    m?.fileSize,
  );
}

// ============================================
// EXPORTS FOR TESTS / DEBUG
// ============================================

export const _internal = {
  collectExportData,
  applyMigrationDump,
  isMigrationDump,
  STORAGE_KEYS: {
    SS_IDENTITY_KEY_PAIR,
    SS_SIGNED_PRE_KEY,
    SS_ONE_TIME_PRE_KEYS,
    SS_NEXT_PRE_KEY_ID,
    SS_PQ_SIGNED_KEY,
    SS_NEXT_PQ_KEY_ID,
    SS_OLD_SIGNED_PRE_KEYS,
    SS_OLD_PQ_SIGNED_KEYS,
    SS_SESSIONS_INDEX,
    SS_SESSION_PREFIX,
    SS_MY_PROFILE,
    USER_SECRET_KEY,
    OPAQUE_DISPLAY_NAME_KEY,
    OPAQUE_AVATAR_KEY,
    MSG_1TO1_PREFIX,
    MUTE_PREFIX,
    PEER_MUTE_PREFIX,
    KEY_PIN_PREFIX,
    SENDER_TOKEN_KEY,
    PENDING_INVITES_KEY,
    PENDING_INVITES_COUNTER_KEY,
    KT_MY_REGISTRATION_KEY,
    ONBOARDING_COMPLETED_KEY,
  },
};

export { DumpDecryptError } from './secureBackup';
