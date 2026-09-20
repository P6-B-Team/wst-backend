import crypto from 'node:crypto';
import { logWarn } from './logger.js';

/**
 * Certificate verification tokens are stored hashed so a database reader cannot forge a valid
 * verification URL. That alone meant the raw token existed for exactly one HTTP response and a
 * student could never get their QR code again.
 *
 * The token is therefore also kept encrypted with AES-256-GCM under a key that lives outside the
 * database (CERT_TOKEN_KEY). The hash remains the lookup column for public verification; the
 * ciphertext only lets an authorised caller re-render the QR. Losing the key costs re-rendering,
 * never verification.
 */
let cachedKey: Buffer | undefined;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const configured = process.env.CERT_TOKEN_KEY;
  if (configured && configured.length >= 32) {
    cachedKey = crypto.createHash('sha256').update(configured).digest();
    return cachedKey;
  }
  if (process.env.NODE_ENV === 'production')
    throw new Error('CERT_TOKEN_KEY must be set to at least 32 characters in production');
  // Development and test fall back to a key derived from the signing secret so that a token
  // encrypted by the seed script can still be decrypted by the API process. It is derived, not
  // random, precisely because a random per-process key silently breaks QR re-rendering.
  const derivable = process.env.JWT_ACCESS_SECRET;
  if (derivable) {
    cachedKey = crypto.createHash('sha256').update(`cert-token:${derivable}`).digest();
    return cachedKey;
  }
  if (process.env.NODE_ENV !== 'test')
    logWarn('cert_token_key_missing_using_ephemeral', {
      note: 'Development only. Existing certificate QR codes cannot be re-rendered after a restart.',
    });
  cachedKey = crypto.randomBytes(32);
  return cachedKey;
}

export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptToken(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const [iv, tag, data] = String(payload).split('.');
  if (!iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const sha256Hex = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
