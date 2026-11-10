import {
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  randomBytes,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { appUserSigningKeys } from '../../db/schema';
import { SecretSealer } from '../sealing/secret-sealer';
import type { SigningKey } from './app-user-jwt';

const sealPlace = (kid: string) => `app-user-signing-key:${kid}`;

function newRsaKey(): Promise<{ privateKey: KeyObject; publicKey: KeyObject }> {
  return new Promise((resolve, reject) => {
    generateKeyPair('rsa', { modulusLength: 2048 }, (err, publicKey, privateKey) => {
      if (err) reject(err);
      else resolve({ publicKey, privateKey });
    });
  });
}

@Injectable()
export class AppUserSigningKey {
  private loaded?: Promise<SigningKey>;

  constructor(private readonly sealer: SecretSealer) {}

  load(): Promise<SigningKey> {
    this.loaded ??= this.loadOrCreate().catch((err: unknown) => {
      this.loaded = undefined;
      throw err;
    });
    return this.loaded;
  }

  private async loadOrCreate(): Promise<SigningKey> {
    const row = (await this.row()) ?? (await this.createOnce());
    if (!row) throw new Error('The App Users signing key could not be created');
    const jwk = row.publicJwk as JsonWebKey;
    return {
      kid: row.kid,
      privateKey: createPrivateKey(String(this.sealer.open(row.sealedPrivateKey, sealPlace(row.kid)))),
      publicKey: createPublicKey({ key: jwk, format: 'jwk' }),
      jwk: { ...jwk, kid: row.kid, use: 'sig', alg: 'RS256' },
    };
  }

  private async row() {
    const [row] = await db.select().from(appUserSigningKeys).limit(1);
    return row;
  }

  private async createOnce() {
    const kid = randomBytes(8).toString('hex');
    const { privateKey, publicKey } = await newRsaKey();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const { kty, n, e } = publicKey.export({ format: 'jwk' });
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('app_user_signing_keys'))`);
      const [existing] = await tx.select({ kid: appUserSigningKeys.kid }).from(appUserSigningKeys).limit(1);
      if (existing) return;
      await tx.insert(appUserSigningKeys).values({
        kid,
        publicJwk: { kty: String(kty), n: String(n), e: String(e) },
        sealedPrivateKey: this.sealer.seal(privatePem, sealPlace(kid)),
      });
    });
    return this.row();
  }
}
