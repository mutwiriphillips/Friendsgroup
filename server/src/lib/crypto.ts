import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from './http.js';

const PLAIN = 'plain:';
const NOKEY_HASH = 'nk:';

/** True once FIELD_ENCRYPTION_KEY is set. Until then National IDs are stored unencrypted (marked "plain:") and can be encrypted later with `npm run rekey`. */
export const hasFieldKey = () => !!config.fieldKey;

function getKey(): Buffer {
  return Buffer.from(config.fieldKey, 'hex');
}

/** AES-256-GCM. Output format: base64(iv).base64(tag).base64(ciphertext). Without a key the value is stored as `plain:<value>` for now. */
export function encryptField(plain: string): string {
  if (!hasFieldKey()) return PLAIN + plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

export function decryptField(payload: string): string {
  if (payload.startsWith(PLAIN)) return payload.slice(PLAIN.length);
  if (!hasFieldKey()) throw new HttpError(503, 'This value is encrypted. Set FIELD_ENCRYPTION_KEY to read it.');
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !enc) throw new Error('Malformed encrypted field');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

const norm = (v: string) => v.trim().toUpperCase();
const keyedHash = (value: string) => createHmac('sha256', getKey()).update(norm(value)).digest('hex');
const unkeyedHash = (value: string) => NOKEY_HASH + createHmac('sha256', 'friends-self-help-group-unkeyed-lookup').update(norm(value)).digest('hex');

/** Deterministic hash for unique lookups (duplicate National ID checks). Keyed when the key is set, otherwise a marked fallback. */
export function blindIndex(value: string): string {
  return hasFieldKey() ? keyedHash(value) : unkeyedHash(value);
}

/** Every hash a value could be stored under (keyed and fallback), so duplicates are caught across the switch to a key. */
export function blindIndexAll(value: string): string[] {
  return hasFieldKey() ? [keyedHash(value), unkeyedHash(value)] : [unkeyedHash(value)];
}
