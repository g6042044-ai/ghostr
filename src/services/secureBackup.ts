// src/services/secureBackup.ts
// Encrypted dump format for device migration
//
// SECURITY ARCHITECTURE — defence in depth, KEK/DEK pattern:
//
//   user_password
//        │
//        │  Argon2id (m=64MiB, t=3, p=1) — same params as appLock.ts
//        │  salt: 32 bytes, fresh per backup
//        ▼
//   backup_KEK (32 bytes)
//        │
//        │  HKDF-SHA256(KEK, info=…)
//        │
//        ├──▶ wrapKey  (32B) — wraps the random DEK
//        └──▶ authKey  (32B) — HMAC of the header (binds KDF params)
//
//   DEK (Data Encryption Key) = 32B random per export
//
//   plaintext_blob = JSON of identity + prekeys + sessions + messages + …
//   ciphertext     = nacl.secretbox(plaintext_blob, content_nonce, DEK)
//   wrappedDEK     = nacl.secretbox(DEK, wrap_nonce, wrapKey)
//   headerMac      = HMAC-SHA256(authKey, canonical_JSON(header))
//
//   FILE = magic || version || headerLen(BE32) || header || headerMac || ciphertext
//
// KEY PROPERTIES:
//   1. Without the password, the DEK is unrecoverable (Argon2id 64MiB makes
//      brute force ~$10^9 per try at scale; password strength dominates).
//   2. Header tampering (e.g. lowering Argon2id memory to make brute force
//      easier) is detected by the headerMac BEFORE any decryption attempt.
//   3. KEK and DEK are zeroized after use.
//   4. Wrong password is detected at headerMac verification (constant-time,
//      no plaintext leak via partial decryption attempts).
//
// FORMAT VERSION = 1. Future versions can add fields to the header JSON
//   without breaking parsing, since headerLen is explicit.

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';
import {
  deriveKey,
  deriveKeyWithParams,
  ArgonUnavailableError,
} from './kdf';

declare const __DEV__: boolean;

// ============================================
// FORMAT CONSTANTS
// ============================================

/** "GHSTRBKF" — identifies a Ghostr migration file at the byte level. */
const MAGIC = new Uint8Array([0x47, 0x48, 0x53, 0x54, 0x52, 0x42, 0x4b, 0x46]);
const FORMAT_VERSION = 1;

/** Maximum header size — defends against DoS via gigantic header claims. */
const MAX_HEADER_SIZE = 64 * 1024; // 64 KB is way more than enough

/** Maximum total file size we accept on import — defends against memory bombs. */
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB cap

const NONCE_SIZE = nacl.secretbox.nonceLength; // 24
const KEY_SIZE = nacl.secretbox.keyLength;     // 32
const HMAC_SIZE = 32;                          // SHA-256

// ============================================
// TYPES
// ============================================

export interface DumpHeader {
  /** Format version of this header schema */
  version: number;
  /** KDF parameters JSON (compatible with kdf.ts deriveKeyWithParams) */
  kdfParams: string;
  /** Base64 nonce used to wrap the DEK with wrapKey (24B) */
  wrapNonce: string;
  /** Base64 wrapped DEK = nacl.secretbox(DEK, wrapNonce, wrapKey). Includes 16B Poly1305. */
  wrappedDek: string;
  /** Base64 nonce used to encrypt the content with the DEK (24B) */
  contentNonce: string;
  /** Unix ms when the file was created */
  createdAt: number;
  /** App version that produced this file (informational) */
  appVersion?: string;
  /** Optional: format hint for content (currently always 'json') */
  contentFormat: 'json';
}

export interface BuildResult {
  /** Final file bytes */
  bytes: Uint8Array;
  /** SHA-256 hex of `bytes` — bound to the marker on the originating device */
  hash: string;
  /** Size in bytes (convenience) */
  size: number;
}

export type ProgressFn = (progress: number, label?: string) => void;

// ============================================
// HKDF (RFC 5869) via @noble/hashes
// ============================================
//
// We use @noble's audited HKDF instead of rolling our own. The KEK is already
// uniformly random (from Argon2id), so we use a zero salt — HKDF-Extract on a
// uniform input is essentially a no-op but enforces RFC 5869 layout cleanly.
//
// Two info strings ensure wrapKey and authKey are cryptographically independent
// (domain separation): even if one is somehow compromised, the other isn't.

/**
 * Derive (wrapKey, authKey) from the Argon2id KEK.
 * Each is 32 bytes; HKDF-SHA256 with distinct info strings ensures independence.
 */
function deriveSubkeys(kek: Uint8Array): { wrapKey: Uint8Array; authKey: Uint8Array } {
  // Zero-length salt is the recommended default when the IKM is already uniform.
  const wrapKey = hkdf(sha256, kek, undefined, 'ghostr:backup:wrap:v1', 32);
  const authKey = hkdf(sha256, kek, undefined, 'ghostr:backup:auth:v1', 32);
  return { wrapKey, authKey };
}

// ============================================
// CANONICAL JSON
// ============================================
//
// Why: HMAC must be computed over a deterministic byte sequence.
// JSON.stringify is not deterministic (object key order is implementation-
// defined for non-numeric keys). We sort keys alphabetically.

function canonicalJson(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  return '{' + parts.join(',') + '}';
}

// ============================================
// HMAC HELPERS
// ============================================

function computeHeaderMac(authKey: Uint8Array, headerJson: string): Uint8Array {
  const headerBytes = decodeUTF8(headerJson);
  return hmac(sha256, authKey, headerBytes);
}

/** Constant-time compare (timing-safe) */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ============================================
// BUILD (EXPORT) — encrypt a dump
// ============================================

/**
 * Encrypt a JSON-serializable plaintext object into a migration file.
 *
 * @param plaintextObject The dump to encrypt (will be JSON.stringify'd)
 * @param password User-chosen backup password (separate from app PIN)
 * @param appVersion Informational app version string (e.g. "3.0.0")
 * @param onProgress Optional progress callback (0..1, with label)
 *
 * @returns { bytes, hash, size } — bytes is the file content, hash is SHA-256 hex
 *
 * @throws ArgonUnavailableError if Argon2id native module is missing in production
 */
export async function buildEncryptedDump(
  plaintextObject: unknown,
  password: string,
  appVersion: string | undefined,
  onProgress?: ProgressFn
): Promise<BuildResult> {
  if (!password || password.length < 8) {
    throw new Error('Backup password too short (min 8 chars)');
  }

  onProgress?.(0.05, 'serializing');

  // 1. Serialize the plaintext. We do not compress — gzip would help for
  //    text-heavy histories but adds a dependency and complicates streaming.
  //    The dump is encrypted before any disk I/O, so size is the only cost.
  const plaintextJson = JSON.stringify(plaintextObject);
  const plaintextBytes = decodeUTF8(plaintextJson);

  // 2. Derive the KEK from the password.
  onProgress?.(0.10, 'kdf');
  const kdfResult = await deriveKey(password, undefined, p => {
    // Argon2id progress is mostly opaque (single native call); we map it
    // into the 0.10 → 0.85 portion of the global progress bar.
    onProgress?.(0.10 + 0.75 * p, 'kdf');
  });
  const kek = kdfResult.key;

  try {
    // 3. Derive (wrapKey, authKey) from KEK via HKDF.
    onProgress?.(0.86, 'derive_subkeys');
    const { wrapKey, authKey } = deriveSubkeys(kek);

    try {
      // 4. Generate fresh DEK (32B random) and wrap it with wrapKey.
      const dek = nacl.randomBytes(KEY_SIZE);
      const wrapNonce = nacl.randomBytes(NONCE_SIZE);
      const wrappedDek = nacl.secretbox(dek, wrapNonce, wrapKey);
      // wrappedDek is 32 + 16 = 48 bytes (Poly1305 tag prepended by NaCl).

      try {
        // 5. Encrypt the plaintext with the DEK.
        onProgress?.(0.90, 'encrypt');
        const contentNonce = nacl.randomBytes(NONCE_SIZE);
        const ciphertext = nacl.secretbox(plaintextBytes, contentNonce, dek);

        // 6. Build the header JSON.
        const header: DumpHeader = {
          version: FORMAT_VERSION,
          kdfParams: kdfResult.params,
          wrapNonce: encodeBase64(wrapNonce),
          wrappedDek: encodeBase64(wrappedDek),
          contentNonce: encodeBase64(contentNonce),
          createdAt: Date.now(),
          appVersion,
          contentFormat: 'json',
        };
        const headerJson = canonicalJson(header);
        const headerBytes = decodeUTF8(headerJson);

        if (headerBytes.length > MAX_HEADER_SIZE) {
          throw new Error('Header unexpectedly large');
        }

        // 7. Compute headerMac over the canonical header JSON.
        const headerMac = computeHeaderMac(authKey, headerJson);

        // 8. Assemble the final file:
        //    magic(8) || version(1) || headerLen(4 BE) || header || headerMac(32) || ciphertext
        const headerLen = headerBytes.length;
        const totalLen =
          MAGIC.length +
          1 +
          4 +
          headerLen +
          HMAC_SIZE +
          ciphertext.length;

        const out = new Uint8Array(totalLen);
        let offset = 0;

        out.set(MAGIC, offset); offset += MAGIC.length;
        out[offset++] = FORMAT_VERSION;
        // 4-byte big-endian length
        out[offset++] = (headerLen >>> 24) & 0xff;
        out[offset++] = (headerLen >>> 16) & 0xff;
        out[offset++] = (headerLen >>> 8) & 0xff;
        out[offset++] = headerLen & 0xff;
        out.set(headerBytes, offset); offset += headerLen;
        out.set(headerMac, offset); offset += HMAC_SIZE;
        out.set(ciphertext, offset);

        onProgress?.(0.98, 'finalizing');

        // 9. Compute file hash for the marker on the originating device.
        const hash = sha256(out);
        const hashHex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');

        // 10. Zeroize plaintext.
        plaintextBytes.fill(0);

        onProgress?.(1, 'done');

        return {
          bytes: out,
          hash: hashHex,
          size: out.length,
        };
      } finally {
        dek.fill(0);
      }
    } finally {
      wrapKey.fill(0);
      authKey.fill(0);
    }
  } finally {
    kek.fill(0);
  }
}

// ============================================
// PARSE (IMPORT) — decrypt a dump
// ============================================

export class DumpDecryptError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = 'DumpDecryptError';
    Object.setPrototypeOf(this, DumpDecryptError.prototype);
  }
}

export interface ParsedDump {
  /** Decoded plaintext object (JSON-parsed) */
  data: unknown;
  /** Header info (for UI display: createdAt, appVersion) */
  header: DumpHeader;
}

/**
 * Read and decrypt a migration file.
 *
 * Phases:
 *   1. Parse magic + version + headerLen
 *   2. Parse header JSON
 *   3. Run Argon2id with the header's KDF params (slow — 200-1500ms)
 *   4. Verify headerMac (rejects wrong password OR tampered header)
 *   5. Unwrap DEK
 *   6. Decrypt content (Poly1305 verifies again)
 *   7. JSON.parse and return
 *
 * Why HMAC AND Poly1305: belt-and-suspenders. HMAC catches header tampering
 * before we even use the DEK (defense against KDF-parameter downgrade). Poly1305
 * catches content tampering. Either failure throws a typed error.
 *
 * @throws DumpDecryptError with `reason ∈ { 'invalid_format', 'wrong_password',
 *         'tampered', 'corrupt_content', 'unsupported_version' }`
 * @throws ArgonUnavailableError on prod build without Argon2id
 */
export async function parseAndDecryptDump(
  fileBytes: Uint8Array,
  password: string,
  onProgress?: ProgressFn
): Promise<ParsedDump> {
  // ── 1. Parse magic + version + headerLen ──────────────────────────
  if (fileBytes.length > MAX_FILE_SIZE) {
    throw new DumpDecryptError('invalid_format', 'File too large');
  }

  const minSize = MAGIC.length + 1 + 4 + 1 + HMAC_SIZE + 16; // tag at minimum
  if (fileBytes.length < minSize) {
    throw new DumpDecryptError('invalid_format', 'File too short');
  }

  for (let i = 0; i < MAGIC.length; i++) {
    if (fileBytes[i] !== MAGIC[i]) {
      throw new DumpDecryptError('invalid_format', 'Not a Ghostr migration file');
    }
  }
  let offset = MAGIC.length;

  const version = fileBytes[offset++];
  if (version !== FORMAT_VERSION) {
    throw new DumpDecryptError(
      'unsupported_version',
      `Unsupported format version ${version}, this app supports ${FORMAT_VERSION}`
    );
  }

  const headerLen =
    ((fileBytes[offset] << 24) |
      (fileBytes[offset + 1] << 16) |
      (fileBytes[offset + 2] << 8) |
      fileBytes[offset + 3]) >>> 0;  // unsigned
  offset += 4;

  if (headerLen <= 0 || headerLen > MAX_HEADER_SIZE) {
    throw new DumpDecryptError('invalid_format', 'Invalid header length');
  }

  // We need at least: header + MAC + ciphertext-with-tag (≥16B) past `offset`.
  // Strict >: file is truncated and we can't even read the MAC.
  // == : MAC is there but no ciphertext at all → invalid (need ≥ Poly1305 tag).
  if (offset + headerLen + HMAC_SIZE + 16 > fileBytes.length) {
    throw new DumpDecryptError('invalid_format', 'File truncated');
  }

  // ── 2. Parse header JSON ─────────────────────────────────────────────
  const headerBytes = fileBytes.slice(offset, offset + headerLen);
  offset += headerLen;

  let header: DumpHeader;
  try {
    const headerJson = encodeUTF8(headerBytes);
    header = JSON.parse(headerJson);
  } catch {
    throw new DumpDecryptError('invalid_format', 'Header is not valid JSON');
  }

  if (!header.kdfParams || !header.wrapNonce || !header.wrappedDek || !header.contentNonce) {
    throw new DumpDecryptError('invalid_format', 'Header missing required fields');
  }

  // Extract MAC and ciphertext
  const fileMac = fileBytes.slice(offset, offset + HMAC_SIZE);
  offset += HMAC_SIZE;
  const ciphertext = fileBytes.slice(offset);

  if (ciphertext.length < 16) {
    throw new DumpDecryptError('invalid_format', 'Ciphertext too short');
  }

  // ── 3. Derive KEK from password using header's KDF params ────────────
  onProgress?.(0.05, 'kdf');
  let kek: Uint8Array;
  try {
    kek = await deriveKeyWithParams(password, header.kdfParams, p => {
      onProgress?.(0.05 + 0.80 * p, 'kdf');
    });
  } catch (e) {
    if (e instanceof ArgonUnavailableError) {
      throw e; // bubble up — handled by UI
    }
    throw new DumpDecryptError('invalid_format', 'KDF parameters invalid');
  }

  try {
    onProgress?.(0.86, 'derive_subkeys');
    const { wrapKey, authKey } = deriveSubkeys(kek);

    try {
      // ── 4. Verify headerMac (rejects wrong password OR tampered header) ──
      onProgress?.(0.88, 'verify');
      // Recompute over the EXACT bytes we read (canonical form is what
      // was MAC'd at build time).
      const headerJson = encodeUTF8(headerBytes);
      const expectedMac = computeHeaderMac(authKey, headerJson);

      if (!constantTimeEqual(expectedMac, fileMac)) {
        // Could be wrong password OR tampered file. From the UI's POV both
        // mean "user can't decrypt this". We tag as 'wrong_password' since
        // tampering is rare in practice; the user-visible message is generic.
        throw new DumpDecryptError(
          'wrong_password',
          'Wrong password or file has been tampered'
        );
      }

      // ── 5. Unwrap DEK ────────────────────────────────────────────────
      const wrapNonce = decodeBase64(header.wrapNonce);
      const wrappedDek = decodeBase64(header.wrappedDek);

      if (wrapNonce.length !== NONCE_SIZE) {
        throw new DumpDecryptError('invalid_format', 'wrapNonce size invalid');
      }

      const dek = nacl.secretbox.open(wrappedDek, wrapNonce, wrapKey);
      if (!dek) {
        // This SHOULD NOT happen if HMAC verification passed (HMAC binds
        // the wrappedDek and KDF params). If it does, something is severely
        // wrong — treat as tampered.
        throw new DumpDecryptError('tampered', 'DEK unwrap failed despite valid HMAC');
      }
      if (dek.length !== KEY_SIZE) {
        throw new DumpDecryptError('tampered', 'Unwrapped DEK has wrong size');
      }

      try {
        // ── 6. Decrypt content ────────────────────────────────────────
        onProgress?.(0.92, 'decrypt');
        const contentNonce = decodeBase64(header.contentNonce);
        if (contentNonce.length !== NONCE_SIZE) {
          throw new DumpDecryptError('invalid_format', 'contentNonce size invalid');
        }

        const plaintext = nacl.secretbox.open(ciphertext, contentNonce, dek);
        if (!plaintext) {
          throw new DumpDecryptError('corrupt_content', 'Content decryption failed');
        }

        // ── 7. JSON.parse ────────────────────────────────────────────
        onProgress?.(0.97, 'parsing');
        let data: unknown;
        try {
          data = JSON.parse(encodeUTF8(plaintext));
        } catch {
          plaintext.fill(0);
          throw new DumpDecryptError('corrupt_content', 'Decrypted content is not valid JSON');
        }
        plaintext.fill(0);

        onProgress?.(1, 'done');

        return { data, header };
      } finally {
        dek.fill(0);
      }
    } finally {
      wrapKey.fill(0);
      authKey.fill(0);
    }
  } finally {
    kek.fill(0);
  }
}

// ============================================
// LIGHT INSPECTION (no decryption)
// ============================================

/**
 * Peek at the header WITHOUT verifying the password — gives the UI enough
 * info to show "this file was created on YYYY-MM-DD by app version X".
 *
 * IMPORTANT: do not display anything from this header as if it were
 * authenticated. The headerMac is verified only inside parseAndDecryptDump.
 */
export function peekDumpHeader(fileBytes: Uint8Array): DumpHeader {
  if (fileBytes.length < MAGIC.length + 1 + 4) {
    throw new DumpDecryptError('invalid_format', 'File too short');
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (fileBytes[i] !== MAGIC[i]) {
      throw new DumpDecryptError('invalid_format', 'Not a Ghostr migration file');
    }
  }
  let offset = MAGIC.length;
  const version = fileBytes[offset++];
  if (version !== FORMAT_VERSION) {
    throw new DumpDecryptError('unsupported_version', `Unsupported version ${version}`);
  }
  const headerLen =
    ((fileBytes[offset] << 24) |
      (fileBytes[offset + 1] << 16) |
      (fileBytes[offset + 2] << 8) |
      fileBytes[offset + 3]) >>> 0;  // unsigned
  offset += 4;
  if (headerLen <= 0 || headerLen > MAX_HEADER_SIZE) {
    throw new DumpDecryptError('invalid_format', 'Invalid header length');
  }
  if (offset + headerLen > fileBytes.length) {
    throw new DumpDecryptError('invalid_format', 'File truncated');
  }
  const headerBytes = fileBytes.slice(offset, offset + headerLen);
  try {
    return JSON.parse(encodeUTF8(headerBytes));
  } catch {
    throw new DumpDecryptError('invalid_format', 'Header is not valid JSON');
  }
}

// ============================================
// EXPORTS FOR TESTS / DEBUG
// ============================================

export const _internal = {
  MAGIC,
  FORMAT_VERSION,
  MAX_HEADER_SIZE,
  MAX_FILE_SIZE,
  deriveSubkeys,
  canonicalJson,
  computeHeaderMac,
  constantTimeEqual,
};
