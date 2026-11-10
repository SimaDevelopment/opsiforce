import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db } from '../../db';
import { appUserLinks, appUsers, projectApps, projects } from '../../db/schema';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import { PublicUrlService } from '../project-environment/public-url.service';
import { AppUserMailer } from './app-user-mailer';
import { appUsersAddresses } from './app-users-client';
import { AppUsersService, validPassword } from './app-users.service';
import type { AppUserLinkPurpose, AppUserLinkResponse } from './app-users.types';

const LINK_TTL_MS: Record<AppUserLinkPurpose, number> = {
  invite: 7 * 24 * 60 * 60 * 1000,
  reset: 24 * 60 * 60 * 1000,
};
const SELF_SERVICE_RESET_TTL_MS = 60 * 60 * 1000;
const SELF_SERVICE_RESET_COOLDOWN_MS = 60 * 1000;

interface CreatedLink {
  token: string;
  link: { url: string; expiresAt: Date };
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface OpenLink {
  purpose: AppUserLinkPurpose;
  email: string;
  appName: string;
  returnUrl: string | null;
}

export type RedeemResult = { outcome: 'done'; link: OpenLink } | { outcome: 'invalid' };

@Injectable()
export class AppUserLinksService {
  private readonly issuer: string;

  constructor(
    configService: ConfigService,
    private readonly users: AppUsersService,
    private readonly environments: ProjectEnvironmentService,
    private readonly publicUrls: PublicUrlService,
    private readonly mailer: AppUserMailer
  ) {
    this.issuer = appUsersAddresses(configService)?.issuer ?? '';
  }

  async createForOwner(
    projectId: string,
    userId: string,
    purpose: unknown,
    environmentId: unknown,
    send: unknown
  ): Promise<AppUserLinkResponse> {
    if (purpose !== 'invite' && purpose !== 'reset') throw new BadRequestException('purpose must be invite or reset');
    if (send !== undefined && typeof send !== 'boolean') throw new BadRequestException('send must be a boolean');
    if (send && !this.mailer.enabled) throw new BadRequestException('Email is not set up on this Opsiforce');
    const user = await this.users.get(projectId, userId);
    if (user.status === 'disabled') throw new BadRequestException('Enable this App User before sending them a link');
    const app = await this.appOf(projectId, environmentId);
    const { token, link } = await this.create(userId, purpose, app, LINK_TTL_MS[purpose]);
    if (!send) return { ...link, emailed: false };
    try {
      await this.email(token, link);
    } catch (err) {
      return { ...link, emailed: false, emailError: (err as Error).message };
    }
    return { ...link, emailed: true };
  }

  async sendSelfServiceReset(userId: string, environmentId: string, returnUrl: string): Promise<void> {
    const created = await this.create(
      userId,
      'reset',
      { environmentId, url: returnUrl },
      SELF_SERVICE_RESET_TTL_MS,
      new Date(Date.now() - SELF_SERVICE_RESET_COOLDOWN_MS)
    );
    if (created) await this.email(created.token, created.link);
  }

  async open(token: string): Promise<OpenLink | null> {
    const [row] = await db
      .select({
        purpose: appUserLinks.purpose,
        email: appUsers.email,
        returnUrl: appUserLinks.returnUrl,
        appName: projectApps.name,
        projectTitle: projects.title,
      })
      .from(appUserLinks)
      .innerJoin(appUsers, eq(appUsers.id, appUserLinks.appUserId))
      .innerJoin(projects, eq(projects.id, appUsers.projectId))
      .leftJoin(projectApps, eq(projectApps.projectEnvironmentId, appUserLinks.projectEnvironmentId))
      .where(
        and(
          eq(appUserLinks.tokenHash, hashToken(token)),
          gt(appUserLinks.expiresAt, new Date()),
          isNull(appUsers.disabledAt)
        )
      );
    if (!row) return null;
    return {
      purpose: row.purpose,
      email: row.email,
      returnUrl: row.returnUrl,
      appName: row.appName ?? row.projectTitle ?? 'this App',
    };
  }

  async redeem(token: string, password: string): Promise<RedeemResult> {
    const chosen = validPassword(password);
    const link = await this.open(token);
    if (!link) return { outcome: 'invalid' };
    const claimed = await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(appUserLinks)
        .where(and(eq(appUserLinks.tokenHash, hashToken(token)), gt(appUserLinks.expiresAt, new Date())))
        .returning({ appUserId: appUserLinks.appUserId });
      if (!row) return null;
      await tx.delete(appUserLinks).where(eq(appUserLinks.appUserId, row.appUserId));
      return row.appUserId;
    });
    if (!claimed) return { outcome: 'invalid' };
    await this.users.setPassword(claimed, chosen);
    return { outcome: 'done', link };
  }

  private async email(token: string, link: { url: string; expiresAt: Date }): Promise<void> {
    const opened = await this.open(token);
    if (!opened) throw new Error('The link is no longer valid');
    await this.mailer.sendLink(opened.email, { ...link, purpose: opened.purpose, appName: opened.appName });
  }

  private create(
    userId: string,
    purpose: AppUserLinkPurpose,
    app: { environmentId: string; url: string | null } | null,
    ttlMs: number
  ): Promise<CreatedLink>;
  private create(
    userId: string,
    purpose: AppUserLinkPurpose,
    app: { environmentId: string; url: string | null } | null,
    ttlMs: number,
    replaceOnlyIfCreatedBefore: Date
  ): Promise<CreatedLink | null>;
  private async create(
    userId: string,
    purpose: AppUserLinkPurpose,
    app: { environmentId: string; url: string | null } | null,
    ttlMs: number,
    replaceOnlyIfCreatedBefore?: Date
  ): Promise<CreatedLink | null> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs);
    const projectEnvironmentId = app?.environmentId ?? null;
    const returnUrl = app?.url ?? null;
    await db.delete(appUserLinks).where(lt(appUserLinks.expiresAt, new Date()));
    const written = await db
      .insert(appUserLinks)
      .values({ tokenHash: hashToken(token), appUserId: userId, purpose, projectEnvironmentId, returnUrl, expiresAt })
      .onConflictDoUpdate({
        target: [appUserLinks.appUserId, appUserLinks.purpose],
        set: { tokenHash: hashToken(token), projectEnvironmentId, returnUrl, expiresAt, createdAt: new Date() },
        ...(replaceOnlyIfCreatedBefore ? { setWhere: lt(appUserLinks.createdAt, replaceOnlyIfCreatedBefore) } : {}),
      })
      .returning({ tokenHash: appUserLinks.tokenHash });
    if (written.length === 0) return null;
    const url = new URL(`${this.issuer}/set-password`);
    url.searchParams.set('token', token);
    return { token, link: { url: url.toString(), expiresAt } };
  }

  private async appOf(
    projectId: string,
    environmentId: unknown
  ): Promise<{ environmentId: string; url: string | null } | null> {
    if (environmentId === undefined || environmentId === null) return null;
    if (typeof environmentId !== 'string') throw new BadRequestException('environmentId must be a string');
    const env = await this.environments.findByIdOrNull(environmentId);
    if (!env || env.projectId !== projectId) throw new NotFoundException(`Environment ${environmentId} not found`);
    return { environmentId: env.id, url: this.publicUrls.publicUrlLiveOrNot(env) };
  }
}
