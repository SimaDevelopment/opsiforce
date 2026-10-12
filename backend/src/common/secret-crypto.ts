import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';
import type { JsonValue } from './json';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export type EncryptedResourceValue = {
  alg: typeof ALGORITHM;
  iv: string;
  tag: string;
  data: string;
};

// TODO: remove in the release after External Services v2 ships: v1 envelopes; only tests build them (the WhatsApp importer tests and test/linked-accounts/sealing.test.ts), so rewrite those fixtures when the importers go
export function encryptResourceValue(key: Buffer, value: JsonValue): EncryptedResourceValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);

  return {
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

// TODO: remove in the release after External Services v2 ships: see encryptResourceValue
export function decryptResourceValue(key: Buffer, envelope: EncryptedResourceValue): JsonValue {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as JsonValue;
}

export function asEncryptedResourceValue(value: JsonValue): EncryptedResourceValue {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.alg === ALGORITHM &&
    typeof value.iv === 'string' &&
    typeof value.tag === 'string' &&
    typeof value.data === 'string'
  ) {
    return { alg: ALGORITHM, iv: value.iv, tag: value.tag, data: value.data };
  }
  throw new Error('Stored resource value is not an encrypted envelope');
}

export function timingSafeStringEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  if (expectedBytes.byteLength !== actualBytes.byteLength) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}
