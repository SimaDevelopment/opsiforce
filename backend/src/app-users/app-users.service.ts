import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { appUserRoleMembers, appUserRoles, appUsers } from '../../db/schema';
import { isPostgresError, PG_UNIQUE_VIOLATION } from '../common/postgres-errors';
import { hashPassword, verifyAgainstNobody, verifyPassword } from './app-user-passwords';
import {
  APP_USER_LOCK_MINUTES,
  APP_USER_PASSWORD_MIN_LENGTH,
  type AppUserIdentity,
  type AppUserResponse,
  type CreateAppUserDto,
  type SignInResult,
  type UpdateAppUserDto,
} from './app-users.types';

const EMAIL_UNIQUE = 'app_users_project_id_email_unique';
const MAX_FAILED_SIGN_INS = 5;
const LOCK_MS = APP_USER_LOCK_MINUTES * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AppUserRow = typeof appUsers.$inferSelect;
type Executor = Pick<typeof db, 'select' | 'insert' | 'delete'>;

function toResponse(row: AppUserRow, roles: string[]): AppUserResponse {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    roles,
    status: row.disabledAt !== null ? 'disabled' : row.passwordHash === null ? 'invited' : 'active',
    lockedUntil: row.lockedUntil && row.lockedUntil > new Date() ? row.lockedUntil : null,
    lastSignInAt: row.lastSignInAt,
    createdAt: row.createdAt,
  };
}

export function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') throw new BadRequestException('email is required');
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new BadRequestException('email must be a valid email address');
  }
  return normalized;
}

function normalizeName(name: unknown): string | null {
  if (name === undefined || name === null) return null;
  if (typeof name !== 'string') throw new BadRequestException('name must be a string');
  const trimmed = name.trim();
  if (trimmed.length > 200) throw new BadRequestException('name must be at most 200 characters');
  return trimmed || null;
}

export function validPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < APP_USER_PASSWORD_MIN_LENGTH || password.length > 256) {
    throw new BadRequestException(`password must be ${APP_USER_PASSWORD_MIN_LENGTH} to 256 characters`);
  }
  return password;
}

function roleNames(roles: unknown): string[] {
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string')) {
    throw new BadRequestException('roles must be a list of role names');
  }
  return [...new Set(roles as string[])];
}

async function rolesByUser(executor: Executor, userIds: string[]): Promise<Map<string, string[]>> {
  const roles = new Map<string, string[]>(userIds.map((id) => [id, []]));
  if (userIds.length === 0) return roles;
  const rows = await executor
    .select({ appUserId: appUserRoleMembers.appUserId, name: appUserRoles.name })
    .from(appUserRoleMembers)
    .innerJoin(appUserRoles, eq(appUserRoles.id, appUserRoleMembers.roleId))
    .where(inArray(appUserRoleMembers.appUserId, userIds))
    .orderBy(asc(appUserRoles.name));
  for (const row of rows) roles.get(row.appUserId)?.push(row.name);
  return roles;
}

async function assignRoles(executor: Executor, projectId: string, userId: string, names: string[]): Promise<void> {
  const found =
    names.length === 0
      ? []
      : await executor
          .select({ id: appUserRoles.id, name: appUserRoles.name })
          .from(appUserRoles)
          .where(and(eq(appUserRoles.projectId, projectId), inArray(appUserRoles.name, names)));
  const missing = names.filter((name) => !found.some((role) => role.name === name));
  if (missing.length > 0) throw new BadRequestException(`Unknown roles: ${missing.join(', ')}`);
  await executor.delete(appUserRoleMembers).where(eq(appUserRoleMembers.appUserId, userId));
  if (found.length > 0) {
    await executor.insert(appUserRoleMembers).values(found.map((role) => ({ appUserId: userId, roleId: role.id })));
  }
}

@Injectable()
export class AppUsersService {
  async list(projectId: string): Promise<AppUserResponse[]> {
    const rows = await db.select().from(appUsers).where(eq(appUsers.projectId, projectId)).orderBy(asc(appUsers.email));
    const roles = await rolesByUser(
      db,
      rows.map((row) => row.id)
    );
    return rows.map((row) => toResponse(row, roles.get(row.id) ?? []));
  }

  async get(projectId: string, userId: string): Promise<AppUserResponse> {
    const row = await this.findRow(projectId, userId);
    const roles = await rolesByUser(db, [row.id]);
    return toResponse(row, roles.get(row.id) ?? []);
  }

  async create(projectId: string, dto: CreateAppUserDto): Promise<AppUserResponse> {
    const values = {
      id: randomUUID(),
      projectId,
      email: normalizeEmail(dto?.email),
      name: normalizeName(dto.name),
      passwordHash: dto.password === undefined ? null : await hashPassword(validPassword(dto.password)),
      tokensValidAfter: new Date(),
    };
    const roles = dto.roles === undefined ? [] : roleNames(dto.roles);
    const row = await this.uniqueEmail(() =>
      db.transaction(async (tx) => {
        const [inserted] = await tx.insert(appUsers).values(values).returning();
        await assignRoles(tx, projectId, inserted.id, roles);
        return inserted;
      })
    );
    return this.get(projectId, row.id);
  }

  async update(projectId: string, userId: string, dto: UpdateAppUserDto): Promise<AppUserResponse> {
    const current = await this.findRow(projectId, userId);
    const now = new Date();
    const changes: Partial<typeof appUsers.$inferInsert> = { updatedAt: now };
    if (dto.email !== undefined) changes.email = normalizeEmail(dto.email);
    if (dto.name !== undefined) changes.name = normalizeName(dto.name);
    if (dto.password !== undefined) Object.assign(changes, await this.passwordChange(dto.password, now));
    if (dto.disabled !== undefined) {
      if (typeof dto.disabled !== 'boolean') throw new BadRequestException('disabled must be a boolean');
      if (dto.disabled && current.disabledAt === null) {
        changes.disabledAt = now;
        changes.tokensValidAfter = now;
      }
      if (!dto.disabled) changes.disabledAt = null;
    }
    const roles = dto.roles === undefined ? undefined : roleNames(dto.roles);
    await this.uniqueEmail(() =>
      db.transaction(async (tx) => {
        await tx.update(appUsers).set(changes).where(eq(appUsers.id, current.id));
        if (roles !== undefined) await assignRoles(tx, projectId, current.id, roles);
      })
    );
    return this.get(projectId, current.id);
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await db
      .update(appUsers)
      .set({ ...(await this.passwordChange(password, new Date())), updatedAt: new Date() })
      .where(eq(appUsers.id, userId));
  }

  async remove(projectId: string, userId: string): Promise<void> {
    const current = await this.findRow(projectId, userId);
    await db.delete(appUsers).where(eq(appUsers.id, current.id));
  }

  async findByEmail(projectId: string, email: string): Promise<AppUserRow | null> {
    let normalized: string;
    try {
      normalized = normalizeEmail(email);
    } catch {
      return null;
    }
    const [row] = await db
      .select()
      .from(appUsers)
      .where(and(eq(appUsers.projectId, projectId), eq(appUsers.email, normalized)));
    return row ?? null;
  }

  async signIn(projectId: string, email: string, password: string): Promise<SignInResult> {
    const row = await this.findByEmail(projectId, email);
    if (!row || row.passwordHash === null) {
      await verifyAgainstNobody(password);
      return { outcome: 'wrong-credentials' };
    }
    const now = new Date();
    const [attempt] = await db
      .update(appUsers)
      .set({ failedSignIns: sql`${appUsers.failedSignIns} + 1` })
      .where(and(eq(appUsers.id, row.id), or(isNull(appUsers.lockedUntil), lte(appUsers.lockedUntil, now))))
      .returning({ count: appUsers.failedSignIns });
    if (!attempt) return { outcome: 'locked' };
    if (attempt.count > MAX_FAILED_SIGN_INS) return this.lock(row.id, now);

    if (!(await verifyPassword(password, row.passwordHash))) {
      return attempt.count === MAX_FAILED_SIGN_INS ? this.lock(row.id, now) : { outcome: 'wrong-credentials' };
    }
    await db
      .update(appUsers)
      .set(row.disabledAt ? { failedSignIns: 0 } : { failedSignIns: 0, lockedUntil: null, lastSignInAt: now })
      .where(eq(appUsers.id, row.id));
    if (row.disabledAt) return { outcome: 'disabled' };
    return { outcome: 'signed-in', user: await this.identity(row) };
  }

  async activeUser(projectId: string, userId: string, issuedAtMs: number): Promise<AppUserIdentity | null> {
    const [row] = await db
      .select()
      .from(appUsers)
      .where(and(eq(appUsers.id, userId), eq(appUsers.projectId, projectId), isNull(appUsers.disabledAt)));
    if (!row || issuedAtMs < row.tokensValidAfter.getTime()) return null;
    return this.identity(row);
  }

  private async identity(row: AppUserRow): Promise<AppUserIdentity> {
    const roles = await rolesByUser(db, [row.id]);
    return { id: row.id, projectId: row.projectId, email: row.email, name: row.name, roles: roles.get(row.id) ?? [] };
  }

  private async passwordChange(password: unknown, now: Date): Promise<Partial<typeof appUsers.$inferInsert>> {
    return {
      passwordHash: await hashPassword(validPassword(password)),
      tokensValidAfter: now,
      failedSignIns: 0,
      lockedUntil: null,
    };
  }

  private async lock(userId: string, now: Date): Promise<SignInResult> {
    await db
      .update(appUsers)
      .set({ failedSignIns: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) })
      .where(eq(appUsers.id, userId));
    return { outcome: 'locked' };
  }

  private async findRow(projectId: string, userId: string): Promise<AppUserRow> {
    const [row] = await db
      .select()
      .from(appUsers)
      .where(and(eq(appUsers.id, userId), eq(appUsers.projectId, projectId)));
    if (!row) throw new NotFoundException(`App User ${userId} not found`);
    return row;
  }

  private async uniqueEmail<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isPostgresError(err, PG_UNIQUE_VIOLATION, EMAIL_UNIQUE)) {
        throw new ConflictException('An App User with this email already exists in this Project');
      }
      throw err;
    }
  }
}
