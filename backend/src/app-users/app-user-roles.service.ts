import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, count, eq } from 'drizzle-orm';
import { db } from '../../db';
import { appUserRoleMembers, appUserRoles } from '../../db/schema';
import { isPostgresError, PG_UNIQUE_VIOLATION } from '../common/postgres-errors';
import {
  APP_USER_ROLE_NAME_PATTERN,
  MAX_APP_USER_ROLES,
  type AppUserRoleDto,
  type AppUserRoleResponse,
} from './app-users.types';

const NAME_UNIQUE = 'app_user_roles_project_id_name_unique';

function roleName(name: unknown): string {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!APP_USER_ROLE_NAME_PATTERN.test(normalized)) {
    throw new BadRequestException(
      'A role name is 1 to 40 lowercase letters, digits, - or _, starting with a letter or digit'
    );
  }
  return normalized;
}

function roleDescription(description: unknown): string | null {
  if (description === undefined || description === null) return null;
  if (typeof description !== 'string') throw new BadRequestException('description must be a string');
  const trimmed = description.trim();
  if (trimmed.length > 300) throw new BadRequestException('description must be at most 300 characters');
  return trimmed || null;
}

@Injectable()
export class AppUserRolesService {
  async list(projectId: string): Promise<AppUserRoleResponse[]> {
    const rows = await db
      .select({
        id: appUserRoles.id,
        name: appUserRoles.name,
        description: appUserRoles.description,
        members: count(appUserRoleMembers.appUserId),
      })
      .from(appUserRoles)
      .leftJoin(appUserRoleMembers, eq(appUserRoleMembers.roleId, appUserRoles.id))
      .where(eq(appUserRoles.projectId, projectId))
      .groupBy(appUserRoles.id)
      .orderBy(asc(appUserRoles.name));
    return rows;
  }

  async create(projectId: string, dto: AppUserRoleDto): Promise<AppUserRoleResponse> {
    const values = {
      id: randomUUID(),
      projectId,
      name: roleName(dto?.name),
      description: roleDescription(dto.description),
    };
    const [{ total }] = await db
      .select({ total: count() })
      .from(appUserRoles)
      .where(eq(appUserRoles.projectId, projectId));
    if (total >= MAX_APP_USER_ROLES) {
      throw new BadRequestException(`A Project can have at most ${MAX_APP_USER_ROLES} roles`);
    }
    const [row] = await this.uniqueName(() => db.insert(appUserRoles).values(values).returning());
    return { id: row.id, name: row.name, description: row.description, members: 0 };
  }

  async update(projectId: string, roleId: string, dto: AppUserRoleDto): Promise<AppUserRoleResponse> {
    await this.find(projectId, roleId);
    const changes: Partial<typeof appUserRoles.$inferInsert> = {};
    if (dto?.name !== undefined) changes.name = roleName(dto.name);
    if (dto?.description !== undefined) changes.description = roleDescription(dto.description);
    if (Object.keys(changes).length > 0) {
      await this.uniqueName(() => db.update(appUserRoles).set(changes).where(eq(appUserRoles.id, roleId)));
    }
    const role = (await this.list(projectId)).find((r) => r.id === roleId);
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);
    return role;
  }

  async remove(projectId: string, roleId: string): Promise<void> {
    await this.find(projectId, roleId);
    await db.delete(appUserRoles).where(eq(appUserRoles.id, roleId));
  }

  private async find(projectId: string, roleId: string) {
    const [row] = await db
      .select()
      .from(appUserRoles)
      .where(and(eq(appUserRoles.id, roleId), eq(appUserRoles.projectId, projectId)));
    if (!row) throw new NotFoundException(`Role ${roleId} not found`);
    return row;
  }

  private async uniqueName<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isPostgresError(err, PG_UNIQUE_VIOLATION, NAME_UNIQUE)) {
        throw new ConflictException('This Project already has a role with this name');
      }
      throw err;
    }
  }
}
