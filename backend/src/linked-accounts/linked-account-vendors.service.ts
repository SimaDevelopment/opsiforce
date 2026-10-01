import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { linkedAccounts } from '../../db/schema';
import type { JsonObject, JsonValue } from '../common/json';
import type { DbExecutor } from '../common/locks';
import {
  asEncryptedResourceValue,
  decryptResourceValue,
  encryptResourceValue,
  parseEncryptionKey,
} from '../common/secret-crypto';
import { ChatGptAdapter } from './chatgpt/chatgpt-adapter';
import type { VendorAdapter, VendorCredential, VendorId } from './vendor-adapter';

const NO_ENCRYPTION_MESSAGE = 'Linked accounts need EXTERNAL_SERVICES_ENCRYPTION_KEY on this platform';
const NOT_REVOKED_MESSAGE = 'The sign-in could not be revoked; try again';

@Injectable()
export class LinkedAccountVendorsService {
  private readonly logger = new Logger(LinkedAccountVendorsService.name);
  private readonly adapters: Record<VendorId, VendorAdapter>;
  private readonly encryptionKeyHex: string;

  constructor(configService: ConfigService) {
    this.adapters = {
      chatgpt: new ChatGptAdapter(
        configService.getOrThrow<string>('linkedAccountChatGptIssuer'),
        configService.getOrThrow<string>('linkedAccountChatGptUsageUrl')
      ),
    };
    this.encryptionKeyHex = configService.get<string>('externalServicesEncryptionKey', '').trim();
  }

  async revokeStoredSignIn(tx: DbExecutor, modelProviderId: string): Promise<void> {
    const [row] = await tx
      .select({ vendor: linkedAccounts.vendor, credential: linkedAccounts.credential })
      .from(linkedAccounts)
      .where(eq(linkedAccounts.modelProviderId, modelProviderId))
      .for('update');
    if (row?.credential) {
      await this.revokeWithVendor(
        this.adapterOf(row.vendor),
        this.unsealCredential(this.encryptionKey(), row.credential)
      );
    }
  }

  async revokeWithVendor(adapter: VendorAdapter, credential: VendorCredential): Promise<void> {
    try {
      await adapter.revoke(credential);
    } catch (err) {
      this.logger.warn(`The ${adapter.vendor} sign-in was not revoked: ${(err as Error).message}`);
      throw new BadGatewayException(NOT_REVOKED_MESSAGE);
    }
  }

  adapterOf(vendor: string): VendorAdapter {
    if (!Object.hasOwn(this.adapters, vendor)) throw new Error(`No Vendor adapter for ${vendor}`);
    return this.adapters[vendor as VendorId];
  }

  hasEncryptionKey(): boolean {
    return this.encryptionKeyHex !== '';
  }

  encryptionKey(): Buffer {
    if (!this.encryptionKeyHex) throw new ServiceUnavailableException(NO_ENCRYPTION_MESSAGE);
    return parseEncryptionKey(this.encryptionKeyHex);
  }

  seal(key: Buffer, value: JsonObject): string {
    return JSON.stringify(encryptResourceValue(key, value));
  }

  unseal(key: Buffer, sealed: string): JsonValue {
    return decryptResourceValue(key, asEncryptedResourceValue(JSON.parse(sealed) as JsonValue));
  }

  unsealCredential(key: Buffer, sealed: string): VendorCredential {
    const value = this.unseal(key, sealed) as { accessToken?: unknown; refreshToken?: unknown };
    return {
      accessToken: typeof value.accessToken === 'string' ? value.accessToken : '',
      refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : null,
    };
  }
}
