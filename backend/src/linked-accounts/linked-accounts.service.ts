import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { linkedAccounts, modelProviders } from '../../db/schema';
import { readModelCatalog } from '../agent/agent-models';
import type { JsonObject } from '../common/json';
import { lockPlatformModelProviders, type DbExecutor } from '../common/locks';
import { timingSafeStringEqual } from '../common/secret-crypto';
import { BASE_FORMATS } from '../model-provider/base-formats';
import { ModelProviderConnectionsService } from '../model-provider/model-provider-connections.service';
import { ModelProviderKeyModelsService } from '../model-provider/model-provider-key-models.service';
import { ModelProvidersService } from '../model-provider/model-provider.service';
import { STARTING_WEIGHT } from '../model-provider/model-provider.types';
import { customBifrostProviderName } from '../model-provider/provider-names';
import type { TenantContext } from '../tenant/tenant.decorator';
import type {
  LinkedAccountCredentialView,
  LinkedAccountUsageView,
  LinkedAccountView,
  SignInView,
  StartedSignInView,
} from './linked-account.types';
import {
  CALLER_SECRET_PREFIX,
  callerSecretHashOf,
  newCallerSecret,
  platformLinkedAccountVendors,
} from './linked-account-rows';
import { LinkedAccountVendorsService } from './linked-account-vendors.service';
import { platformLinkedAccountVendorOf } from './platform-linked-accounts';
import {
  VendorRateLimitedError,
  VendorSignInUnavailableError,
  type AccessTokenCheck,
  type SignInPoll,
  type VendorAdapter,
  type VendorCredential,
  type VendorId,
  type VendorUsage,
} from './vendor-adapter';
import { VENDOR_BASE_FORMAT, isVendorId } from './vendors';

const SIGN_IN_LIFETIME_MS = 15 * 60 * 1000;
const MIN_POLL_GAP_MS = 5_000;
const RATE_LIMITED_WAIT_MS = 30_000;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

const UNKNOWN_CALLER_MESSAGE = 'Unknown Linked-account caller';
const NOT_CONNECTED_MESSAGE = 'This Linked account is not signed in';
const NOT_A_PLATFORM_LINKED_ACCOUNT_MESSAGE = 'This Built-in model provider does not sign in a Linked account';
const SIGN_IN_ENDED_MESSAGE = 'This Linked account needs to be signed in again';
const NOT_REFRESHED_MESSAGE = 'The Linked account could not be refreshed';
const PASTED_TOKEN_EXPIRED_REASON = 'The pasted access token has expired';
const NO_USAGE_MESSAGE = 'OpenAI did not return this account’s usage; try again';

interface PendingSignIn {
  handle: JsonObject;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  nextPollAt: number;
  pollIntervalMs: number;
}

type LinkedAccountRow = typeof linkedAccounts.$inferSelect;

type Renewal =
  | { outcome: 'serving'; credential: VendorCredential; accountId: string | null }
  | { outcome: 'ended'; reason: string };

interface ServedCredential {
  adapter: VendorAdapter;
  credential: VendorCredential;
  accountId: string | null;
}

interface OwnedLinkedAccount {
  ownerId: string;
  bifrostProvider: string;
  vendor: VendorId;
}

function pendingView(pending: PendingSignIn): SignInView {
  return {
    state: 'pending',
    userCode: pending.userCode,
    verificationUrl: pending.verificationUrl,
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
}

@Injectable()
export class LinkedAccountsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LinkedAccountsService.name);
  private readonly proxyServiceToken: string;

  constructor(
    configService: ConfigService,
    private readonly connections: ModelProviderConnectionsService,
    private readonly modelProvidersService: ModelProvidersService,
    private readonly keyModels: ModelProviderKeyModelsService,
    private readonly vendors: LinkedAccountVendorsService
  ) {
    this.proxyServiceToken = configService.get<string>('linkedAccountProxyServiceToken', '');
  }

  onApplicationBootstrap(): void {
    void this.repointConnectedAccounts().then(() => this.keyModels.reconcileKeyModels(readModelCatalog()));
  }

  async repointConnectedAccounts(): Promise<void> {
    if (!this.connections.isBifrostConfigured()) return;
    try {
      const connected = await db
        .select({ ownerId: modelProviders.id, bifrostProvider: modelProviders.bifrostProvider })
        .from(linkedAccounts)
        .innerJoin(modelProviders, eq(modelProviders.id, linkedAccounts.modelProviderId))
        .where(isNotNull(linkedAccounts.credential));
      for (const account of connected) await this.repointIfLost(account.ownerId, account.bifrostProvider);
    } catch (err) {
      this.logger.warn(
        `Connected Linked accounts were not checked against Bifrost; retried at next boot: ${(err as Error).message}`
      );
    }
  }

  private async repointIfLost(ownerId: string, bifrostProvider: string): Promise<void> {
    if (await this.connections.servesThroughLinkedAccountProxy(bifrostProvider)) return;
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(linkedAccounts)
        .where(eq(linkedAccounts.modelProviderId, ownerId))
        .for('update');
      if (!row?.credential) return;
      const callerSecretHash = await this.pointAtProxy(row, bifrostProvider);
      await tx.update(linkedAccounts).set({ callerSecretHash }).where(eq(linkedAccounts.modelProviderId, ownerId));
      await this.modelProvidersService.rewriteChatKeysOfTenantsUsing(tx, bifrostProvider);
      this.logger.log(
        `The Linked account of ${bifrostProvider} had lost its sign-in in Bifrost and is repointed at the Linked-account proxy`
      );
    });
  }

  isProxyServiceToken(token: string | undefined): boolean {
    return this.proxyServiceToken !== '' && token !== undefined && timingSafeStringEqual(this.proxyServiceToken, token);
  }

  async startPlatformSignIn(name: string): Promise<StartedSignInView> {
    const vendor = await this.platformVendorOf(name);
    return this.startSignIn(vendor, (tx) => this.ensurePlatformRow(tx, name));
  }

  async platformStatus(name: string): Promise<LinkedAccountView> {
    const vendor = await this.platformVendorOf(name);
    const ownerId = await this.platformRowId(db, name);
    if (!ownerId) return this.viewOf(vendor, null, null);
    return this.pollSignInStatus(ownerId, name, vendor);
  }

  async platformUsage(name: string): Promise<LinkedAccountUsageView> {
    await this.platformVendorOf(name);
    return this.usageOf(await this.platformRowId(db, name));
  }

  async pastePlatformAccessToken(name: string, accessToken: unknown): Promise<LinkedAccountView> {
    const vendor = await this.platformVendorOf(name);
    return this.pasteAccessToken(vendor, name, (tx) => this.ensurePlatformRow(tx, name), accessToken);
  }

  async disconnectPlatform(name: string): Promise<LinkedAccountView> {
    const vendor = await this.platformVendorOf(name);
    const ownerId = await this.platformRowId(db, name);
    if (!ownerId) return this.viewOf(vendor, null, null);
    return this.disconnect(ownerId, name, vendor);
  }

  async startTenantSignIn(tenant: TenantContext, name: string): Promise<StartedSignInView> {
    const account = await this.tenantAccount(tenant, name);
    return this.startSignIn(account.vendor, async () => account.ownerId);
  }

  async tenantStatus(tenant: TenantContext, name: string): Promise<LinkedAccountView> {
    const account = await this.tenantAccount(tenant, name);
    return this.pollSignInStatus(account.ownerId, account.bifrostProvider, account.vendor);
  }

  async tenantUsage(tenant: TenantContext, name: string): Promise<LinkedAccountUsageView> {
    return this.usageOf((await this.tenantAccount(tenant, name)).ownerId);
  }

  async pasteTenantAccessToken(tenant: TenantContext, name: string, accessToken: unknown): Promise<LinkedAccountView> {
    const account = await this.tenantAccount(tenant, name);
    return this.pasteAccessToken(account.vendor, account.bifrostProvider, async () => account.ownerId, accessToken);
  }

  async disconnectTenant(tenant: TenantContext, name: string): Promise<LinkedAccountView> {
    const account = await this.tenantAccount(tenant, name);
    return this.disconnect(account.ownerId, account.bifrostProvider, account.vendor);
  }

  private async pasteAccessToken(
    vendor: VendorId,
    bifrostProvider: string,
    ownerIdIn: (tx: DbExecutor) => Promise<string>,
    pasted: unknown
  ): Promise<LinkedAccountView> {
    this.connections.assertBifrostConfigured();
    const key = this.vendors.encryptionKey();
    const adapter = this.vendors.adapterOf(vendor);
    const accessToken = typeof pasted === 'string' ? pasted.trim() : '';
    const refusal = adapter.pastedTokenRefusal(accessToken);
    if (refusal) throw new BadRequestException(refusal);
    const check = await this.checkWithVendor(adapter, accessToken);
    if (check.outcome === 'failed') {
      if (check.permanent) throw new UnprocessableEntityException(check.reason);
      throw new BadGatewayException(check.reason);
    }

    return db.transaction(async (tx) => {
      const ownerId = await ownerIdIn(tx);
      await tx
        .insert(linkedAccounts)
        .values({ modelProviderId: ownerId, vendor, callerSecretHash: callerSecretHashOf(newCallerSecret()) })
        .onConflictDoNothing({ target: linkedAccounts.modelProviderId });
      const [row] = await tx
        .select()
        .from(linkedAccounts)
        .where(eq(linkedAccounts.modelProviderId, ownerId))
        .for('update');
      if (!row) throw new Error(`The Linked account of ${bifrostProvider} was not stored`);
      const connected = await this.connect(tx, key, row, bifrostProvider, { accessToken, refreshToken: null });
      return this.viewOf(vendor, connected, null);
    });
  }

  private async disconnect(ownerId: string, bifrostProvider: string, vendor: VendorId): Promise<LinkedAccountView> {
    this.connections.assertBifrostConfigured();
    const key = this.vendors.encryptionKey();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(linkedAccounts)
        .where(eq(linkedAccounts.modelProviderId, ownerId))
        .for('update');
      if (!row) return this.viewOf(vendor, null, null);
      if (row.credential) {
        await this.vendors.revokeWithVendor(
          this.vendors.adapterOf(row.vendor),
          this.vendors.unsealCredential(key, row.credential)
        );
      }
      const disconnected: LinkedAccountRow = { ...row, credential: null, statusReason: null, pendingSignIn: null };
      await tx
        .update(linkedAccounts)
        .set({ credential: null, statusReason: null, pendingSignIn: null })
        .where(eq(linkedAccounts.modelProviderId, ownerId));
      if (row.credential) {
        await this.modelProvidersService.rewriteChatKeysOfTenantsUsing(tx, bifrostProvider);
        this.logger.log(`The Linked account of ${bifrostProvider} is disconnected`);
      }
      return this.viewOf(vendor, disconnected, null);
    });
  }

  private async startSignIn(
    vendor: VendorId,
    ownerIdIn: (tx: DbExecutor) => Promise<string>
  ): Promise<StartedSignInView> {
    this.connections.assertBifrostConfigured();
    const key = this.vendors.encryptionKey();
    const started = await this.startWithVendor(this.vendors.adapterOf(vendor));
    const now = Date.now();
    const pending: PendingSignIn = {
      handle: started.handle,
      userCode: started.userCode,
      verificationUrl: started.verificationUrl,
      expiresAt: now + SIGN_IN_LIFETIME_MS,
      nextPollAt: now,
      pollIntervalMs: Math.max(started.pollIntervalMs, MIN_POLL_GAP_MS),
    };
    const sealedPending = this.vendors.seal(key, pending as unknown as JsonObject);

    await db.transaction(async (tx) => {
      const ownerId = await ownerIdIn(tx);
      await tx
        .insert(linkedAccounts)
        .values({
          modelProviderId: ownerId,
          vendor,
          pendingSignIn: sealedPending,
          callerSecretHash: callerSecretHashOf(newCallerSecret()),
        })
        .onConflictDoUpdate({ target: linkedAccounts.modelProviderId, set: { pendingSignIn: sealedPending } });
    });

    return {
      userCode: pending.userCode,
      verificationUrl: pending.verificationUrl,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  async credentialFor(callerSecret: unknown, forceRefresh: boolean): Promise<LinkedAccountCredentialView> {
    if (typeof callerSecret !== 'string' || !callerSecret.startsWith(CALLER_SECRET_PREFIX)) {
      throw new UnauthorizedException(UNKNOWN_CALLER_MESSAGE);
    }
    const hash = callerSecretHashOf(callerSecret);
    const key = this.vendors.encryptionKey();

    const served = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(linkedAccounts)
        .where(eq(linkedAccounts.callerSecretHash, hash))
        .for('update');
      if (!row || !timingSafeStringEqual(row.callerSecretHash, hash)) {
        throw new UnauthorizedException(UNKNOWN_CALLER_MESSAGE);
      }
      return this.servedCredential(tx, key, row, forceRefresh);
    });
    if (!served) throw new ConflictException(SIGN_IN_ENDED_MESSAGE);
    return {
      vendor: served.adapter.vendor,
      accessToken: served.credential.accessToken,
      accountId: served.accountId,
      expiresAt: served.adapter.describe(served.credential).expiresAt?.toISOString() ?? null,
    };
  }

  private async usageOf(ownerId: string | null): Promise<LinkedAccountUsageView> {
    const key = this.vendors.encryptionKey();
    const served = await db.transaction(async (tx) => {
      const [row] = ownerId
        ? await tx.select().from(linkedAccounts).where(eq(linkedAccounts.modelProviderId, ownerId)).for('update')
        : [];
      if (!row) throw new ConflictException(NOT_CONNECTED_MESSAGE);
      return this.servedCredential(tx, key, row, false);
    });
    if (!served) throw new ConflictException(SIGN_IN_ENDED_MESSAGE);
    let usage: VendorUsage;
    try {
      usage = await served.adapter.usage(served.credential.accessToken, served.accountId);
    } catch (err) {
      this.logger.warn(`The ${served.adapter.vendor} usage did not answer: ${(err as Error).message}`);
      throw new BadGatewayException(NO_USAGE_MESSAGE);
    }
    return {
      plan: usage.plan,
      windows: usage.windows.map((window) => ({
        windowMinutes: window.windowMinutes,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt?.toISOString() ?? null,
      })),
    };
  }

  private async servedCredential(
    tx: DbExecutor,
    key: Buffer,
    row: LinkedAccountRow,
    forceRefresh: boolean
  ): Promise<ServedCredential | null> {
    if (!row.credential) throw new ConflictException(NOT_CONNECTED_MESSAGE);
    const adapter = this.vendors.adapterOf(row.vendor);
    const current = this.vendors.unsealCredential(key, row.credential);
    const renewal = await this.renewed(adapter, current, forceRefresh);
    if (renewal.outcome === 'ended') {
      await this.endSignIn(tx, row, renewal.reason);
      return null;
    }
    if (renewal.credential !== current) {
      await tx
        .update(linkedAccounts)
        .set({ credential: this.vendors.seal(key, { ...renewal.credential }) })
        .where(eq(linkedAccounts.modelProviderId, row.modelProviderId));
    }
    return { adapter, credential: renewal.credential, accountId: renewal.accountId };
  }

  private async renewed(adapter: VendorAdapter, credential: VendorCredential, forceRefresh: boolean): Promise<Renewal> {
    const described = adapter.describe(credential);
    const msLeft = described.expiresAt === null ? null : described.expiresAt.getTime() - Date.now();

    if (!credential.refreshToken) {
      if (msLeft !== null && msLeft <= 0) return { outcome: 'ended', reason: PASTED_TOKEN_EXPIRED_REASON };
      const check = await this.checkWithVendor(adapter, credential.accessToken);
      if (check.outcome === 'accepted') {
        return { outcome: 'serving', credential, accountId: check.accountId ?? described.accountId };
      }
      if (check.permanent) return { outcome: 'ended', reason: check.reason };
      throw new BadGatewayException(NOT_REFRESHED_MESSAGE);
    }

    if (!forceRefresh && (msLeft === null || msLeft > REFRESH_WINDOW_MS)) {
      return { outcome: 'serving', credential, accountId: described.accountId };
    }
    const result = await this.refreshWithVendor(adapter, credential);
    if (result.outcome === 'refreshed') {
      return {
        outcome: 'serving',
        credential: result.credential,
        accountId: adapter.describe(result.credential).accountId,
      };
    }
    if (result.permanent) return { outcome: 'ended', reason: result.reason };
    this.logger.warn(`The ${adapter.vendor} token refresh failed: ${result.reason}`);
    throw new BadGatewayException(NOT_REFRESHED_MESSAGE);
  }

  private async endSignIn(tx: DbExecutor, row: LinkedAccountRow, reason: string): Promise<void> {
    await tx
      .update(linkedAccounts)
      .set({ credential: null, statusReason: reason })
      .where(eq(linkedAccounts.modelProviderId, row.modelProviderId));
    const [owner] = await tx
      .select({ bifrostProvider: modelProviders.bifrostProvider })
      .from(modelProviders)
      .where(eq(modelProviders.id, row.modelProviderId));
    if (owner) await this.modelProvidersService.rewriteChatKeysOfTenantsUsing(tx, owner.bifrostProvider);
    this.logger.warn(
      `The Linked account of ${owner?.bifrostProvider ?? row.modelProviderId} needs signing in again: ${reason}`
    );
  }

  private async pollSignInStatus(
    ownerId: string,
    bifrostProvider: string,
    vendor: VendorId
  ): Promise<LinkedAccountView> {
    const key = this.vendors.encryptionKey();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(linkedAccounts)
        .where(eq(linkedAccounts.modelProviderId, ownerId))
        .for('update');
      if (!row) return this.viewOf(vendor, null, null);
      if (!row.pendingSignIn) return this.viewOf(vendor, row, null);

      const pending = this.vendors.unseal(key, row.pendingSignIn) as unknown as PendingSignIn;
      const now = Date.now();
      if (now >= pending.expiresAt) {
        await this.setPending(tx, row, null);
        return this.viewOf(vendor, { ...row, pendingSignIn: null }, { state: 'expired' });
      }
      if (now < pending.nextPollAt) return this.viewOf(vendor, row, pendingView(pending));

      const poll = await this.pollVendor(this.vendors.adapterOf(row.vendor), pending);
      if (poll.outcome === 'completed') {
        const connected = await this.connect(tx, key, row, bifrostProvider, poll.credential);
        return this.viewOf(vendor, connected, null);
      }
      if (poll.outcome === 'failed') {
        await this.setPending(tx, row, null);
        return this.viewOf(vendor, { ...row, pendingSignIn: null }, { state: 'failed', message: poll.message });
      }
      const wait = poll.outcome === 'rate-limited' ? RATE_LIMITED_WAIT_MS : pending.pollIntervalMs;
      const next = { ...pending, nextPollAt: now + wait };
      await this.setPending(tx, row, this.vendors.seal(key, next as unknown as JsonObject));
      return this.viewOf(vendor, row, pendingView(next));
    });
  }

  private async connect(
    tx: DbExecutor,
    key: Buffer,
    row: LinkedAccountRow,
    bifrostProvider: string,
    credential: VendorCredential
  ): Promise<LinkedAccountRow> {
    const callerSecretHash = row.credential ? row.callerSecretHash : await this.pointAtProxy(row, bifrostProvider);
    const connected: LinkedAccountRow = {
      ...row,
      credential: this.vendors.seal(key, { ...credential }),
      statusReason: null,
      pendingSignIn: null,
      callerSecretHash,
    };
    await tx
      .update(linkedAccounts)
      .set({
        credential: connected.credential,
        statusReason: null,
        pendingSignIn: null,
        callerSecretHash: connected.callerSecretHash,
      })
      .where(eq(linkedAccounts.modelProviderId, row.modelProviderId));
    await this.modelProvidersService.rewriteChatKeysOfTenantsUsing(tx, bifrostProvider);
    this.logger.log(`The Linked account of ${bifrostProvider} is signed in and served by the Linked-account proxy`);
    return connected;
  }

  private async pointAtProxy(row: LinkedAccountRow, bifrostProvider: string): Promise<string> {
    const callerSecret = newCallerSecret();
    const format = BASE_FORMATS[VENDOR_BASE_FORMAT[this.vendors.adapterOf(row.vendor).vendor]];
    await this.connections.pointAtLinkedAccountProxy(
      this.connections.linkedAccountSpec(bifrostProvider, format),
      callerSecret
    );
    return callerSecretHashOf(callerSecret);
  }

  private async pollVendor(adapter: VendorAdapter, pending: PendingSignIn): Promise<SignInPoll> {
    try {
      return await adapter.pollSignIn(pending.handle);
    } catch (err) {
      this.logger.warn(`The ${adapter.vendor} sign-in check did not answer: ${(err as Error).message}`);
      return { outcome: 'pending' };
    }
  }

  private async startWithVendor(adapter: VendorAdapter) {
    try {
      return await adapter.startSignIn();
    } catch (err) {
      if (err instanceof VendorRateLimitedError) {
        throw new HttpException(`${err.message}; try again in a minute`, HttpStatus.TOO_MANY_REQUESTS);
      }
      if (err instanceof VendorSignInUnavailableError) throw new BadRequestException(err.message);
      this.logger.warn(`The ${adapter.vendor} sign-in did not start: ${(err as Error).message}`);
      throw new BadGatewayException('The sign-in could not be started; try again');
    }
  }

  private async refreshWithVendor(adapter: VendorAdapter, credential: VendorCredential) {
    try {
      return await adapter.refresh(credential);
    } catch (err) {
      this.logger.warn(`The ${adapter.vendor} token refresh did not answer: ${(err as Error).message}`);
      throw new BadGatewayException(NOT_REFRESHED_MESSAGE);
    }
  }

  private async checkWithVendor(adapter: VendorAdapter, accessToken: string): Promise<AccessTokenCheck> {
    try {
      return await adapter.whoami(accessToken);
    } catch (err) {
      this.logger.warn(`The ${adapter.vendor} access-token check did not answer: ${(err as Error).message}`);
      return { outcome: 'failed', permanent: false, reason: 'The access token could not be checked; try again' };
    }
  }

  private viewOf(vendor: VendorId, row: LinkedAccountRow | null, signIn: SignInView | null): LinkedAccountView {
    const signedInAs =
      row?.credential && this.vendors.hasEncryptionKey()
        ? this.vendors
            .adapterOf(vendor)
            .describe(this.vendors.unsealCredential(this.vendors.encryptionKey(), row.credential)).signedInAs
        : null;
    return {
      vendor,
      state: row?.credential ? 'connected' : row?.statusReason ? 'needs-sign-in' : 'awaiting-sign-in',
      signedInAs,
      reason: row?.credential ? null : (row?.statusReason ?? null),
      signIn,
    };
  }

  private async setPending(tx: DbExecutor, row: LinkedAccountRow, pendingSignIn: string | null): Promise<void> {
    await tx
      .update(linkedAccounts)
      .set({ pendingSignIn })
      .where(eq(linkedAccounts.modelProviderId, row.modelProviderId));
  }

  private async ensurePlatformRow(tx: DbExecutor, name: string): Promise<string> {
    await lockPlatformModelProviders(tx);
    const existing = await this.platformRowId(tx, name);
    if (existing) return existing;
    const [created] = await tx
      .insert(modelProviders)
      .values({ tenantId: null, bifrostProvider: name, enabled: true, weight: STARTING_WEIGHT })
      .returning({ id: modelProviders.id });
    if (!created) throw new Error(`The platform row of ${name} was not created`);
    await this.modelProvidersService.rewriteChatKeysOfTenantsUsing(tx, name);
    return created.id;
  }

  private async platformRowId(executor: DbExecutor, name: string): Promise<string | null> {
    const [row] = await executor
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(and(isNull(modelProviders.tenantId), eq(modelProviders.bifrostProvider, name)));
    return row?.id ?? null;
  }

  private async platformVendorOf(name: string): Promise<VendorId> {
    const vendor = platformLinkedAccountVendorOf(name) ?? (await platformLinkedAccountVendors(db, name)).get(name);
    if (!vendor) throw new BadRequestException(NOT_A_PLATFORM_LINKED_ACCOUNT_MESSAGE);
    return vendor;
  }

  private async tenantAccount(tenant: TenantContext, name: string): Promise<OwnedLinkedAccount> {
    const bifrostProvider = customBifrostProviderName(tenant.tenantName, name);
    const [row] = await db
      .select({ ownerId: modelProviders.id, vendor: linkedAccounts.vendor })
      .from(linkedAccounts)
      .innerJoin(modelProviders, eq(modelProviders.id, linkedAccounts.modelProviderId))
      .where(and(eq(modelProviders.tenantId, tenant.tenantId), eq(modelProviders.bifrostProvider, bifrostProvider)));
    if (!row || !isVendorId(row.vendor)) {
      throw new NotFoundException(`${name} is not a Linked account of this organization`);
    }
    return { ownerId: row.ownerId, bifrostProvider, vendor: row.vendor };
  }
}
