import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { db } from '../../db';
import { customDomains } from '../../db/schema';
import { appCanonicalHost, type AppAddress } from '../common/app-host';
import { lockCustomDomainHostname, type DbExecutor } from '../common/locks';
import { isPostgresError, PG_UNIQUE_VIOLATION } from '../common/postgres-errors';
import { assertWithinLimit, resolveLimit } from '../limit/limits';
import { LIMITS } from '../limit/limit-registry';
import { OIDC_CALLBACK_PATH } from '../project/app-auth-route';
import type { Transaction } from '../external-services/configuration/transaction';
import {
  lockEnvironmentAuth,
  withEnvironmentAuthLock,
  type LockedEnvironmentAuth,
} from '../project/environment-auth-lock';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import { resolveAppAddress, type AppDomains } from '../proxy/app-address';
import { CustomDomainCluster } from './custom-domain-cluster';
import { hostsOf, type RoutedEnvironment } from './custom-domain-objects';
import { ROUTED_DOMAIN_STATUSES } from './main-domain';
import { checkDns } from './dns-check';
import { displayHostname, readHostname, withoutWww, wwwOf } from './hostname';
import { DnsUnreachable, PUBLIC_DNS, type PublicDns } from './public-dns';
import { zoneStartOf } from './zone-start';
import type {
  AddCustomDomainDto,
  CustomDomainView,
  CustomDomainsView,
  DnsRecord,
  UpdateCustomDomainDto,
} from './custom-domain.types';

type CustomDomainRow = typeof customDomains.$inferSelect;
type CustomDomainUpdate = PgUpdateSetSource<typeof customDomains>;
type AddressedEnvironment = AppAddress & RoutedEnvironment;

const HOSTNAME_ON_ENVIRONMENT_UNIQUE = 'custom_domains_project_environment_id_hostname_unique';
const ALREADY_ADDED = 'This App already has this domain.';
const ONLY_CONNECTED_MAIN = 'Only a connected domain can be the Main domain.';
const REDIRECTS_TO_MAIN_REQUIRED = 'redirectsToMain must be true or false.';
const DNS_UNREACHABLE = "Couldn't reach DNS. Try again in a moment.";
const STARTS_ISSUING_ON_A_PASS = new Set<CustomDomainRow['status']>(['waiting', 'failed']);
const HOLDS_THE_DOMAIN: CustomDomainRow['status'][] = ['issuing', 'connected', 'failed'];
const SETTLING: CustomDomainRow['status'][] = ['waiting', 'issuing'];
const ZONE_APEX = '@';

type DomainHostnames = Pick<CustomDomainRow, 'hostname' | 'bare'>;

function sharesAHost(one: DomainHostnames, other: DomainHostnames): boolean {
  const hosts = hostsOf(one);
  return hostsOf(other).some((host) => hosts.includes(host));
}

async function holdersOf(executor: DbExecutor, taker: CustomDomainRow): Promise<CustomDomainRow[]> {
  const holders = await executor
    .select()
    .from(customDomains)
    .where(
      and(
        ne(customDomains.projectEnvironmentId, taker.projectEnvironmentId),
        inArray(customDomains.status, HOLDS_THE_DOMAIN),
        inArray(customDomains.hostname, [taker.hostname, wwwOf(taker.hostname), withoutWww(taker.hostname)])
      )
    );
  return holders.filter((holder) => sharesAHost(holder, taker));
}

async function takeFrom(executor: DbExecutor, taken: CustomDomainRow[]): Promise<void> {
  if (taken.length === 0) return;
  await executor.delete(customDomains).where(
    inArray(
      customDomains.id,
      taken.map((domain) => domain.id)
    )
  );
  const losingMain = new Set(taken.filter((domain) => domain.isMain).map((domain) => domain.projectEnvironmentId));
  for (const environmentId of losingMain) await handOverMain(executor, environmentId);
}

function environmentsOf(domains: CustomDomainRow[]): string[] {
  return [...new Set(domains.map((domain) => domain.projectEnvironmentId))];
}

async function handOverMain(executor: DbExecutor, environmentId: string): Promise<void> {
  const oldestConnected = executor
    .select({ id: customDomains.id })
    .from(customDomains)
    .where(and(eq(customDomains.projectEnvironmentId, environmentId), eq(customDomains.status, 'connected')))
    .orderBy(asc(customDomains.createdAt), asc(customDomains.id))
    .limit(1);
  await executor
    .update(customDomains)
    .set({ isMain: true, updatedAt: new Date() })
    .where(inArray(customDomains.id, oldestConnected));
}

async function assertNewToEnvironment(
  executor: DbExecutor,
  environmentId: string,
  { hostname, bare }: { hostname: string; bare?: boolean }
): Promise<void> {
  const bareParent = withoutWww(hostname);
  const www = wwwOf(hostname);
  const taken = await executor
    .select({ hostname: customDomains.hostname, bare: customDomains.bare })
    .from(customDomains)
    .where(
      and(
        eq(customDomains.projectEnvironmentId, environmentId),
        inArray(customDomains.hostname, [hostname, bareParent, www])
      )
    );
  if (taken.some((row) => row.hostname === hostname)) throw new BadRequestException(ALREADY_ADDED);
  if (taken.some((row) => row.hostname === bareParent && row.bare)) {
    throw new BadRequestException(
      `${displayHostname(hostname)} comes with ${displayHostname(bareParent)}, which is already added.`
    );
  }
  if (bare && taken.some((row) => row.hostname === www)) {
    throw new BadRequestException(
      `${displayHostname(www)} is already added on its own. Remove it first, then add ${displayHostname(hostname)}, which brings www along.`
    );
  }
}

function hostInZone(name: string, zoneStart: string): string {
  return name === zoneStart ? ZONE_APEX : name.slice(0, -`.${zoneStart}`.length);
}

function recordsOf(
  domain: Pick<CustomDomainRow, 'hostname' | 'bare' | 'zoneStart'>,
  defaultAddress: string
): DnsRecord[] {
  const record = (type: DnsRecord['type'], name: string): DnsRecord => ({
    type,
    name,
    host: hostInZone(name, domain.zoneStart),
    value: defaultAddress,
  });
  if (!domain.bare) return [record('CNAME', domain.hostname)];
  return [record('ALIAS', domain.hostname), record('CNAME', wwwOf(domain.hostname))];
}

function signInCallbackOf(row: CustomDomainRow, env: AddressedEnvironment): string | null {
  const signsInOutside = env.authMode === 'manual' || env.authMode === 'provider';
  return signsInOutside ? `https://${row.hostname}${OIDC_CALLBACK_PATH}` : null;
}

function viewOf(row: CustomDomainRow, env: AddressedEnvironment, defaultAddress: string): CustomDomainView {
  return {
    id: row.id,
    hostname: row.hostname,
    displayHostname: displayHostname(row.hostname),
    bare: row.bare,
    status: row.status,
    isMain: row.isMain,
    redirectsToMain: row.redirectsToMain,
    dnsAnswer: row.dnsAnswer,
    failureReason: row.failureReason,
    checkedAt: row.checkedAt,
    records: recordsOf(row, defaultAddress),
    signInCallback: signInCallbackOf(row, env),
  };
}

@Injectable()
export class CustomDomainService {
  private readonly logger = new Logger(CustomDomainService.name);
  private readonly appsHostname: string;
  private readonly appDomains: AppDomains;
  private readonly refusedDomains: string[];

  constructor(
    config: ConfigService,
    @Inject(PUBLIC_DNS) private readonly dns: PublicDns,
    private readonly environments: ProjectEnvironmentService,
    private readonly cluster: CustomDomainCluster
  ) {
    this.appsHostname = config.getOrThrow<string>('appsHostname');
    this.appDomains = {
      appsHostname: this.appsHostname,
      previewAppsHostname: config.getOrThrow<string>('previewAppsHostname'),
    };
    this.refusedDomains = config.getOrThrow<string[]>('customDomainsRefused');
  }

  async list(env: AddressedEnvironment, tenantId: string): Promise<CustomDomainsView> {
    const defaultAddress = this.defaultAddressOf(env);
    const rows = await db
      .select()
      .from(customDomains)
      .where(eq(customDomains.projectEnvironmentId, env.id))
      .orderBy(asc(customDomains.createdAt), asc(customDomains.id));
    return {
      items: rows.map((row) => viewOf(row, env, defaultAddress)),
      defaultAddress,
      usage: {
        used: await LIMITS.custom_domains.count(db, tenantId),
        limit: await resolveLimit(db, tenantId, 'custom_domains'),
      },
    };
  }

  async add(
    env: AddressedEnvironment,
    tenantId: string,
    dto: AddCustomDomainDto | undefined
  ): Promise<CustomDomainView> {
    const reading = readHostname(typeof dto?.hostname === 'string' ? dto.hostname : '', this.refusedDomains);
    if (reading.refusal !== undefined) throw new BadRequestException(reading.refusal);
    const { hostname } = reading;
    await assertNewToEnvironment(db, env.id, { hostname });
    const zoneStart = await this.findZoneStart(hostname);
    const row = await this.insert(env, tenantId, hostname, zoneStart);
    return viewOf(await this.firstCheckOf(row, env), env, this.defaultAddressOf(env));
  }

  async check(env: AddressedEnvironment, domainId: string): Promise<CustomDomainView> {
    const row = await this.rowOf(db, env, domainId);
    try {
      const stepped = await this.step(row, env);
      if (ROUTED_DOMAIN_STATUSES.includes(stepped.status)) await this.cluster.routeEnvironment(env.id);
      return viewOf(stepped, env, this.defaultAddressOf(env));
    } catch (err) {
      if (err instanceof DnsUnreachable) throw new ServiceUnavailableException(DNS_UNREACHABLE);
      throw err;
    }
  }

  async refresh(env: AddressedEnvironment, tenantId: string): Promise<CustomDomainsView> {
    const settling = await db
      .select()
      .from(customDomains)
      .where(and(eq(customDomains.projectEnvironmentId, env.id), inArray(customDomains.status, SETTLING)))
      .orderBy(asc(customDomains.createdAt), asc(customDomains.id));
    for (const row of settling) {
      try {
        await this.step(row, env);
      } catch (err) {
        if (!(err instanceof DnsUnreachable)) {
          this.logger.warn(`Refreshing custom domain ${row.id} failed: ${(err as Error).message}`);
        }
      }
    }
    return this.list(env, tenantId);
  }

  private step(row: CustomDomainRow, env: AddressedEnvironment): Promise<CustomDomainRow> {
    return row.status === 'issuing' ? this.settle(row) : this.checkRow(row, env);
  }

  private async settle(row: CustomDomainRow): Promise<CustomDomainRow> {
    const progress = await this.cluster.certificateProgress(row.id);
    switch (progress.state) {
      case 'missing':
        return withEnvironmentAuthLock(row.projectEnvironmentId, (tx) => this.orderAgainIfIssuing(tx, row));
      case 'failed':
        return this.settleIssuing(db, row, { status: 'failed', failureReason: progress.reason });
      case 'ready':
        return withEnvironmentAuthLock(row.projectEnvironmentId, (tx, auth) => this.connect(tx, row, auth));
      case 'issuing':
        return row;
    }
  }

  private async orderAgainIfIssuing(tx: Transaction, row: CustomDomainRow): Promise<CustomDomainRow> {
    const [current] = await tx
      .select()
      .from(customDomains)
      .where(and(eq(customDomains.id, row.id), eq(customDomains.status, 'issuing')))
      .for('update');
    if (current) await this.cluster.orderCertificate(current);
    return current ?? row;
  }

  private async connect(
    tx: Transaction,
    row: CustomDomainRow,
    auth: LockedEnvironmentAuth | undefined
  ): Promise<CustomDomainRow> {
    if (!auth) return row;
    const isMain = !(await this.hasMainDomain(tx, row.projectEnvironmentId));
    const connected = await this.settleIssuing(tx, row, {
      status: 'connected',
      connectedAt: new Date(),
      failureReason: null,
      isMain,
    });
    if (connected.status === 'connected') await this.cluster.routeWithin(tx, row.projectEnvironmentId, auth);
    return connected;
  }

  private async hasMainDomain(executor: DbExecutor, environmentId: string): Promise<boolean> {
    const [main] = await executor
      .select({ id: customDomains.id })
      .from(customDomains)
      .where(and(eq(customDomains.projectEnvironmentId, environmentId), eq(customDomains.isMain, true)));
    return main !== undefined;
  }

  async makeMain(env: AddressedEnvironment, domainId: string): Promise<CustomDomainView> {
    const made = await withEnvironmentAuthLock(env.id, async (tx, auth) => {
      const row = await this.rowOf(tx, env, domainId);
      if (row.status !== 'connected') throw new ConflictException(ONLY_CONNECTED_MAIN);
      const now = new Date();
      await tx
        .update(customDomains)
        .set({ isMain: false, updatedAt: now })
        .where(and(eq(customDomains.projectEnvironmentId, env.id), eq(customDomains.isMain, true)));
      const [main] = await tx
        .update(customDomains)
        .set({ isMain: true, updatedAt: now })
        .where(and(eq(customDomains.id, row.id), eq(customDomains.status, 'connected')))
        .returning();
      if (!main) throw new ConflictException(ONLY_CONNECTED_MAIN);
      await this.cluster.routeWithin(tx, env.id, auth);
      return main;
    });
    return viewOf(made, env, this.defaultAddressOf(env));
  }

  async setRedirectToMain(
    env: AddressedEnvironment,
    domainId: string,
    dto: UpdateCustomDomainDto | undefined
  ): Promise<CustomDomainView> {
    const redirectsToMain = dto?.redirectsToMain;
    if (typeof redirectsToMain !== 'boolean') throw new BadRequestException(REDIRECTS_TO_MAIN_REQUIRED);
    const updated = await withEnvironmentAuthLock(env.id, async (tx, auth) => {
      const row = await this.rowOf(tx, env, domainId);
      const changed = await this.update(tx, row.id, { redirectsToMain, updatedAt: new Date() });
      await this.cluster.routeWithin(tx, env.id, auth);
      return changed;
    });
    return viewOf(updated, env, this.defaultAddressOf(env));
  }

  private async settleIssuing(
    executor: DbExecutor,
    row: CustomDomainRow,
    outcome: CustomDomainUpdate
  ): Promise<CustomDomainRow> {
    const [settled] = await executor
      .update(customDomains)
      .set({ ...outcome, updatedAt: new Date() })
      .where(and(eq(customDomains.id, row.id), eq(customDomains.status, 'issuing')))
      .returning();
    return settled ?? row;
  }

  async remove(env: AddressedEnvironment, domainId: string): Promise<void> {
    await withEnvironmentAuthLock(env.id, async (tx, auth) => {
      const row = await this.rowOf(tx, env, domainId);
      await tx.delete(customDomains).where(eq(customDomains.id, row.id));
      if (row.isMain) await handOverMain(tx, env.id);
      await this.cluster.routeWithin(tx, env.id, auth);
      await this.cluster.remove(row.id);
    });
  }

  private async rowOf(executor: DbExecutor, env: AppAddress, domainId: string): Promise<CustomDomainRow> {
    const [row] = await executor
      .select()
      .from(customDomains)
      .where(and(eq(customDomains.id, domainId), eq(customDomains.projectEnvironmentId, env.id)));
    if (!row) throw new NotFoundException(`Custom domain ${domainId} not found`);
    return row;
  }

  private async insert(
    env: AppAddress,
    tenantId: string,
    hostname: string,
    zoneStart: string
  ): Promise<CustomDomainRow> {
    const bare = zoneStart === hostname;
    try {
      return await db.transaction(async (tx) => {
        await lockCustomDomainHostname(tx, withoutWww(hostname));
        await assertNewToEnvironment(tx, env.id, { hostname, bare });
        await assertWithinLimit(tx, tenantId, 'custom_domains');
        const [inserted] = await tx
          .insert(customDomains)
          .values({ id: randomUUID(), tenantId, projectEnvironmentId: env.id, hostname, bare, zoneStart })
          .returning();
        return inserted;
      });
    } catch (err) {
      if (isPostgresError(err, PG_UNIQUE_VIOLATION, HOSTNAME_ON_ENVIRONMENT_UNIQUE)) {
        throw new BadRequestException(ALREADY_ADDED);
      }
      throw err;
    }
  }

  private async firstCheckOf(row: CustomDomainRow, env: AppAddress): Promise<CustomDomainRow> {
    try {
      return await this.checkRow(row, env);
    } catch (err) {
      if (!(err instanceof DnsUnreachable)) {
        this.logger.warn(`The first Check of custom domain ${row.id} failed: ${(err as Error).message}`);
      }
      return row;
    }
  }

  private async checkRow(row: CustomDomainRow, env: AppAddress): Promise<CustomDomainRow> {
    const { passed, answer } = await checkDns(this.dns, row, {
      defaultAddress: this.defaultAddressOf(env),
      isNamedBy: async (target) => {
        const address = await resolveAppAddress(target, this.appDomains, this.environments);
        return address?.env.id === env.id && !address.previewed;
      },
    });
    const now = new Date();
    const checked = { dnsAnswer: answer, checkedAt: now, updatedAt: now };
    const issuing = passed && STARTS_ISSUING_ON_A_PASS.has(row.status) ? await this.passOn(row, checked) : undefined;
    return issuing ?? this.update(db, row.id, checked);
  }

  private async passOn(row: CustomDomainRow, checked: CustomDomainUpdate): Promise<CustomDomainRow | undefined> {
    const environmentIds = [row.projectEnvironmentId, ...environmentsOf(await holdersOf(db, row))].sort((one, other) =>
      one.localeCompare(other)
    );
    return db.transaction(async (tx) => {
      const auths = new Map<string, LockedEnvironmentAuth | undefined>();
      for (const environmentId of environmentIds)
        auths.set(environmentId, await lockEnvironmentAuth(tx, environmentId));
      await lockCustomDomainHostname(tx, withoutWww(row.hostname));
      const [current] = await tx.select().from(customDomains).where(eq(customDomains.id, row.id)).for('update');
      if (!current || !STARTS_ISSUING_ON_A_PASS.has(current.status)) return undefined;
      const taken = await holdersOf(tx, current);
      if (environmentsOf(taken).some((environmentId) => !auths.has(environmentId))) return undefined;
      await takeFrom(tx, taken);
      for (const domain of taken) await this.cluster.remove(domain.id);
      for (const environmentId of environmentsOf(taken)) {
        await this.cluster.routeWithin(tx, environmentId, auths.get(environmentId));
      }
      const issuing = await this.update(tx, row.id, { ...checked, status: 'issuing', failureReason: null });
      await this.cluster.orderCertificate(issuing);
      await this.cluster.routeWithin(tx, issuing.projectEnvironmentId, auths.get(issuing.projectEnvironmentId));
      return issuing;
    });
  }

  private async update(executor: DbExecutor, domainId: string, set: CustomDomainUpdate): Promise<CustomDomainRow> {
    const [updated] = await executor.update(customDomains).set(set).where(eq(customDomains.id, domainId)).returning();
    if (!updated) throw new NotFoundException(`Custom domain ${domainId} not found`);
    return updated;
  }

  private async findZoneStart(hostname: string): Promise<string> {
    let zoneStart: string | null;
    try {
      zoneStart = await zoneStartOf(this.dns, hostname);
    } catch (err) {
      if (err instanceof DnsUnreachable) throw new ServiceUnavailableException(DNS_UNREACHABLE);
      throw err;
    }
    if (zoneStart === null) {
      throw new BadRequestException(
        "We can't find this domain in DNS yet. Check the spelling, or add it once its DNS is set up."
      );
    }
    return zoneStart;
  }

  private defaultAddressOf(env: AppAddress): string {
    return appCanonicalHost(env, this.appsHostname);
  }
}
