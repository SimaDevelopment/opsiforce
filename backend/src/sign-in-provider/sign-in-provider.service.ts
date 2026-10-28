import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { projectEnvironments, signInProviders } from '../../db/schema';
import type { AppAuthRouteTarget } from '../project/app-auth-route';
import { ProjectAuthService } from '../project/project-auth.service';
import { SecretSealer } from '../sealing/secret-sealer';
import { signInProviderFields } from './sign-in-provider-input';
import {
  connectionOf,
  findTenantSignInProvider,
  sealClientSecret,
  type SignInProviderRow,
} from './sign-in-provider-rows';
import type { SaveSignInProviderDto, SignInProviderOption, SignInProviderView } from './sign-in-provider.types';

const usingProviders = (providerIds: string[]) =>
  and(inArray(projectEnvironments.signInProviderId, providerIds), eq(projectEnvironments.authMode, 'provider'));

@Injectable()
export class SignInProvidersService {
  private readonly logger = new Logger(SignInProvidersService.name);

  constructor(
    private readonly sealer: SecretSealer,
    private readonly projectAuthService: ProjectAuthService
  ) {}

  async list(tenantId: string): Promise<SignInProviderView[]> {
    const rows = await db
      .select()
      .from(signInProviders)
      .where(eq(signInProviders.tenantId, tenantId))
      .orderBy(asc(signInProviders.name));
    const usage = await this.environmentCounts(rows.map((row) => row.id));
    return rows.map((row) => this.viewOf(row, usage.get(row.id) ?? 0));
  }

  async options(tenantId: string): Promise<SignInProviderOption[]> {
    return db
      .select({ id: signInProviders.id, name: signInProviders.name })
      .from(signInProviders)
      .where(eq(signInProviders.tenantId, tenantId))
      .orderBy(asc(signInProviders.name));
  }

  async create(tenantId: string, dto: SaveSignInProviderDto): Promise<SignInProviderView> {
    const fields = signInProviderFields(dto);
    const clientSecret = dto.clientSecret?.trim();
    if (!clientSecret) throw new BadRequestException('Client secret is required');
    await this.assertNameFree(tenantId, fields.name);

    const id = randomUUID();
    const [row] = await db
      .insert(signInProviders)
      .values({ id, tenantId, ...fields, clientSecret: sealClientSecret(this.sealer, id, clientSecret) })
      .returning();
    try {
      await this.projectAuthService.applySignInHost(connectionOf(this.sealer, row));
    } catch (err) {
      await db.delete(signInProviders).where(eq(signInProviders.id, id));
      throw err;
    }
    return this.viewOf(row, 0);
  }

  async update(tenantId: string, providerId: string, dto: SaveSignInProviderDto): Promise<SignInProviderView> {
    const existing = await findTenantSignInProvider(tenantId, providerId);
    const fields = signInProviderFields(dto, existing);
    if (fields.name !== existing.name) await this.assertNameFree(tenantId, fields.name);
    const clientSecret = dto.clientSecret?.trim();
    const sealedSecret = clientSecret ? sealClientSecret(this.sealer, providerId, clientSecret) : existing.clientSecret;
    const provider = connectionOf(this.sealer, { ...existing, ...fields, clientSecret: sealedSecret });
    await this.projectAuthService.applySignInHost(provider);

    const [row] = await db
      .update(signInProviders)
      .set({ ...fields, clientSecret: sealedSecret, updatedAt: new Date() })
      .where(eq(signInProviders.id, providerId))
      .returning();

    const usedBy = await this.environmentsUsing(providerId);
    let stale = 0;
    for (const env of usedBy) {
      try {
        const { config, bypassAuthPaths } = await this.projectAuthService.getConfig(env.id);
        await this.projectAuthService.applyProvider(env, provider, config?.forwardAccessToken, bypassAuthPaths);
      } catch (err) {
        stale += 1;
        this.logger.error(
          `Failed to rewrite App Auth of environment ${env.id} for sign-in provider ${providerId}`,
          err
        );
      }
    }
    if (stale > 0) {
      throw new ServiceUnavailableException(
        `Saved, but ${stale} of ${usedBy.length} app environment(s) still use the previous settings; save again to retry`
      );
    }
    return this.viewOf(row, usedBy.length);
  }

  async remove(tenantId: string, providerId: string): Promise<void> {
    await findTenantSignInProvider(tenantId, providerId);
    const used = (await this.environmentCounts([providerId])).get(providerId) ?? 0;
    if (used > 0) {
      throw new ConflictException(
        `This sign-in provider protects ${used} app environment(s); switch them to another App Auth mode first`
      );
    }
    await this.projectAuthService.removeSignInHost(providerId);
    await db.delete(signInProviders).where(eq(signInProviders.id, providerId));
  }

  private environmentsUsing(providerId: string): Promise<AppAuthRouteTarget[]> {
    return db
      .select({ id: projectEnvironments.id, shortId: projectEnvironments.shortId })
      .from(projectEnvironments)
      .where(usingProviders([providerId]));
  }

  private async environmentCounts(providerIds: string[]): Promise<Map<string, number>> {
    if (providerIds.length === 0) return new Map();
    const rows = await db
      .select({ signInProviderId: projectEnvironments.signInProviderId, environments: count() })
      .from(projectEnvironments)
      .where(usingProviders(providerIds))
      .groupBy(projectEnvironments.signInProviderId);
    return new Map(rows.flatMap((row) => (row.signInProviderId ? [[row.signInProviderId, row.environments]] : [])));
  }

  private async assertNameFree(tenantId: string, name: string): Promise<void> {
    const [clash] = await db
      .select({ id: signInProviders.id })
      .from(signInProviders)
      .where(and(eq(signInProviders.tenantId, tenantId), eq(signInProviders.name, name)));
    if (clash) throw new ConflictException(`A sign-in provider named "${name}" already exists`);
  }

  private viewOf(row: SignInProviderRow, environmentCount: number): SignInProviderView {
    return {
      id: row.id,
      name: row.name,
      discoveryUrl: row.discoveryUrl,
      clientId: row.clientId,
      scope: row.scope,
      requiredClaimName: row.requiredClaimName,
      requiredClaimValues: row.requiredClaimValues,
      groupsClaim: row.groupsClaim,
      redirectUri: this.projectAuthService.signInCallbackUrl(row.id),
      environmentCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
