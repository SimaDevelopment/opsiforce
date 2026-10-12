import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JsonValue } from '../common/json';
import { asEncryptedResourceValue, type EncryptedResourceValue } from '../common/secret-crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_VARIABLE = 'EXTERNAL_SERVICES_ENCRYPTION_KEY';
const KEY_HINT = 'generate one with: openssl rand -hex 32';

export type SealedSecret = EncryptedResourceValue;

export class SecretUnreadableError extends Error {
  readonly code = 'secret-unreadable';

  constructor(readonly place: string) {
    super(`The sealed secret for ${place} cannot be opened there`);
  }
}

export function encryptionKeyFrom(configured: string): Buffer {
  const hex = configured.trim();
  if (!hex) throw new Error(`${KEY_VARIABLE} is not set; ${KEY_HINT}`);
  const key = Buffer.from(hex, 'hex');
  if (key.byteLength !== KEY_BYTES || key.toString('hex') !== hex.toLowerCase()) {
    throw new Error(`${KEY_VARIABLE} must be ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes); ${KEY_HINT}`);
  }
  return key;
}

@Injectable()
export class SecretSealer {
  private readonly logger = new Logger(SecretSealer.name);
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    this.key = encryptionKeyFrom(configService.get<string>('externalServicesEncryptionKey', ''));
  }

  seal(value: JsonValue, place: string): SealedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(place, 'utf8'));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return {
      alg: ALGORITHM,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  }

  open(sealed: JsonValue, place: string): JsonValue {
    try {
      return this.decrypt(asEncryptedResourceValue(sealed), place);
    } catch (err) {
      this.logger.warn(`A sealed secret could not be opened for ${place}: ${(err as Error).message}`);
      throw new SecretUnreadableError(place);
    }
  }

  // TODO: remove in the release after External Services v2 ships: only WhatsappUpgrade reads unplaced v1 secrets
  openUnplaced(sealed: JsonValue, describedAs: string): JsonValue {
    try {
      return this.decrypt(asEncryptedResourceValue(sealed), null);
    } catch (err) {
      this.logger.warn(`An unplaced sealed value could not be opened for ${describedAs}: ${(err as Error).message}`);
      throw new SecretUnreadableError(describedAs);
    }
  }

  resealUnplaced(sealed: JsonValue, place: string): SealedSecret | null {
    if (this.opensAt(sealed, place)) return null;
    try {
      return this.seal(this.decrypt(asEncryptedResourceValue(sealed), null), place);
    } catch (err) {
      this.logger.warn(`A sealed secret could not be re-sealed for ${place}: ${(err as Error).message}`);
      throw new SecretUnreadableError(place);
    }
  }

  private opensAt(sealed: JsonValue, place: string): boolean {
    try {
      this.decrypt(asEncryptedResourceValue(sealed), place);
      return true;
    } catch {
      return false;
    }
  }

  private decrypt(envelope: SealedSecret, place: string | null): JsonValue {
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(envelope.iv, 'base64'));
    if (place !== null) decipher.setAAD(Buffer.from(place, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as JsonValue;
  }
}
