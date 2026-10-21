/**
 * Zero-dependency secret hashing for WD-016 scoped credentials
 * (node:crypto only; no plaintext retention anywhere).
 *
 * Storage format: `salt$digest` where salt is 16 random bytes (hex) and
 * digest is SHA-256(salt || secret) (hex). Verification hashes the presented
 * secret with the STORED salt and compares digests with
 * crypto.timingSafeEqual - the comparison is constant-time and both sides are
 * 64 hex characters by construction, so length never leaks.
 *
 * Secret format: `uwdat_` + 32 base62 characters generated from
 * crypto.randomBytes with rejection sampling (no modulo bias). The prefix
 * makes accidental logging recognizable in CI secret scanning.
 *
 * FR-064 / "Identity and application permissions": secrets do not appear in
 * logs or share URLs; the hash at rest is the only retained form.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Public prefix of every issued secret (also the thing scanners look for). */
export const SECRET_PREFIX = 'uwdat_';

/** Entropy payload length after the prefix (base62 characters). */
export const SECRET_LENGTH = 32;

const BASE62_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// 248 = 62 * 4: bytes below this bound map onto the alphabet without bias.
const BASE62_REJECTION_LIMIT = 248;

/** Salt length in bytes (hex-encoded in the stored string). */
export const SALT_BYTES = 16;

/**
 * Generate a fresh secret: `uwdat_` + 32 unbiased base62 characters
 * (~190 bits of entropy) from crypto.randomBytes.
 */
export function generateSecret(): string {
  let secret = '';
  while (secret.length < SECRET_LENGTH) {
    const bytes = randomBytes(SECRET_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= BASE62_REJECTION_LIMIT) continue; // rejection sampling
      secret += BASE62_ALPHABET[byte % 62]!;
      if (secret.length === SECRET_LENGTH) break;
    }
  }
  return SECRET_PREFIX + secret;
}

/** Structural check of a presented credential (cheap, pre-hash). */
export function isSecretFormat(candidate: string): boolean {
  return typeof candidate === 'string' && new RegExp(`^${SECRET_PREFIX}[0-9A-Za-z]{${SECRET_LENGTH}}$`).test(candidate);
}

function digest(salt: Buffer, secret: string): string {
  return createHash('sha256').update(salt).update(secret, 'utf8').digest('hex');
}

/**
 * Hash a secret for storage. A fresh random salt is drawn per token; the
 * return value `salt$digest` is the ONLY thing a store may keep. The
 * plaintext argument never leaves the caller's frame because of it.
 */
export function hashSecret(secret: string, salt: Buffer = randomBytes(SALT_BYTES)): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('hashSecret: secret must be a non-empty string');
  }
  return `${salt.toString('hex')}$${digest(salt, secret)}`;
}

/** Constant-time equality of two same-length hex strings. */
export function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Verify a presented secret against a stored `salt$digest`. Constant-time:
 * the candidate is salted with the STORED salt, hashed, and compared with
 * timingSafeEqual; no early exit can signal how far the match went.
 */
export function verifySecret(presented: string, stored: string): boolean {
  if (typeof presented !== 'string' || typeof stored !== 'string') return false;
  const separator = stored.indexOf('$');
  if (separator <= 0) return false;
  const saltHex = stored.slice(0, separator);
  const expected = stored.slice(separator + 1);
  if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(expected)) return false;
  const candidate = digest(Buffer.from(saltHex, 'hex'), presented);
  return constantTimeHexEquals(candidate, expected);
}
