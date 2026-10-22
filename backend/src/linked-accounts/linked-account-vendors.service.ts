import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, isNotNull, or } from 'drizzle-orm';
import { db } from '../../db';
import { linkedAccounts } from '../../db/schema';
import type { JsonObject, JsonValue } from '../common/json';
import type { DbExecutor } from '../common/locks';
import { SecretSealer } from '../sealing/secret-sealer';
import { ChatGptAdapter } from './chatgpt/chatgpt-adapter';
import type { VendorAdapter, VendorCredential, VendorId } from './vendor-adapter';

const NOT_REVOKED_MESSAGE = 'The sign-in could not be revoked; try again';

type SealedField = 'credential' | 'pendingSignIn';

function storedEnvelope(sealed: string): JsonValue {
  try {
    return JSON.parse(sealed) as JsonValue;
  } catch {
    return sealed;
  }
}

function placeOf(modelProviderId: string, field: SealedField): string {
  return `linked_accounts|${modelProviderId}|${field}`;
}

@Injectable()
export class LinkedAccountVendorsService {
  private readonly logger = new Logger(LinkedAccountVendorsService.name);
  private readonly adapters: Record<VendorId, VendorAdapter>;

  constructor(
    configService: ConfigService,
    private readonly sealer: SecretSealer
  ) {
    this.adapters = {
      chatgpt: new ChatGptAdapter(
        configService.getOrThrow<string>('linkedAccountChatGptIssuer'),
        configService.getOrThrow<string>('linkedAccountChatGptUsageUrl')
      ),
    };
  }

  async revokeStoredSignIn(tx: DbExecutor, modelProviderId: string): Promise<void> {
    const [row] = await tx
      .select({ vendor: linkedAccounts.vendor, credential: linkedAccounts.credential })
      .from(linkedAccounts)
      .where(eq(linkedAccounts.modelProviderId, modelProviderId))
      .for('update');
    if (row?.credential) {
      await this.revokeWithVendor(this.adapterOf(row.vendor), this.openCredential(modelProviderId, row.credential));
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

  sealCredential(modelProviderId: string, credential: VendorCredential): string {
    return JSON.stringify(this.sealer.seal({ ...credential }, placeOf(modelProviderId, 'credential')));
  }

  openCredential(modelProviderId: string, sealed: string): VendorCredential {
    const value = this.open(modelProviderId, 'credential', sealed) as {
      accessToken?: unknown;
      refreshToken?: unknown;
    };
    return {
      accessToken: typeof value.accessToken === 'string' ? value.accessToken : '',
      refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : null,
    };
  }

  sealPendingSignIn(modelProviderId: string, pending: JsonObject): string {
    return JSON.stringify(this.sealer.seal(pending, placeOf(modelProviderId, 'pendingSignIn')));
  }

  openPendingSignIn(modelProviderId: string, sealed: string): JsonValue {
    return this.open(modelProviderId, 'pendingSignIn', sealed);
  }

  async resealUnplacedSignIns(): Promise<void> {
    const rows = await db
      .select({ modelProviderId: linkedAccounts.modelProviderId })
      .from(linkedAccounts)
      .where(or(isNotNull(linkedAccounts.credential), isNotNull(linkedAccounts.pendingSignIn)));
    for (const { modelProviderId } of rows) await this.resealUnplacedSignIn(modelProviderId);
  }

  private async resealUnplacedSignIn(modelProviderId: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ credential: linkedAccounts.credential, pendingSignIn: linkedAccounts.pendingSignIn })
        .from(linkedAccounts)
        .where(eq(linkedAccounts.modelProviderId, modelProviderId))
        .for('update');
      if (!row) return;
      const credential = this.resealed(modelProviderId, 'credential', row.credential);
      const pendingSignIn = this.resealed(modelProviderId, 'pendingSignIn', row.pendingSignIn);
      if (credential === null && pendingSignIn === null) return;
      await tx
        .update(linkedAccounts)
        .set({ ...(credential === null ? {} : { credential }), ...(pendingSignIn === null ? {} : { pendingSignIn }) })
        .where(eq(linkedAccounts.modelProviderId, modelProviderId));
      this.logger.log(`The sign-in of Linked account ${modelProviderId} is re-sealed to its place`);
    });
  }

  private resealed(modelProviderId: string, field: SealedField, sealed: string | null): string | null {
    if (!sealed) return null;
    try {
      const bound = this.sealer.resealUnplaced(storedEnvelope(sealed), placeOf(modelProviderId, field));
      return bound ? JSON.stringify(bound) : null;
    } catch {
      return null;
    }
  }

  private open(modelProviderId: string, field: SealedField, sealed: string): JsonValue {
    return this.sealer.open(storedEnvelope(sealed), placeOf(modelProviderId, field));
  }
}
