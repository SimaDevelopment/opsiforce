import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../../db';
import { environments, projectEnvironments } from '../../db/schema';
import { environmentInUse } from '../agent/agent-errors';
import { AgentRepository } from '../agent/agent.repository';
import {
  CreateEnvironmentDto,
  DEVELOPMENT_ENVIRONMENT_NAME,
  DEVELOPMENT_ENVIRONMENT_SHORT_NAME,
  DEVELOPMENT_ENVIRONMENT_SLUG,
  EnvironmentResponse,
  EnvironmentRow,
  PRODUCTION_ENVIRONMENT_NAME,
  PRODUCTION_ENVIRONMENT_SHORT_NAME,
  PRODUCTION_ENVIRONMENT_SLUG,
  UpdateEnvironmentDto,
} from './environment.types';

const RESERVED_ENVIRONMENT_NAMES = [DEVELOPMENT_ENVIRONMENT_NAME, PRODUCTION_ENVIRONMENT_NAME];

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 60;
const DESCRIPTION_MAX_LENGTH = 500;
const SLUG_MAX_LENGTH = 26;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SHORT_NAME_PATTERN = /^[A-Za-z0-9]{2,5}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const DEVELOPMENT_ENVIRONMENT_COLOR = '#3B82F6';
const PRODUCTION_ENVIRONMENT_COLOR = '#22C55E';

const DEFAULT_ENVIRONMENT_COLORS = [
  '#F97316',
  '#A855F7',
  '#EC4899',
  '#14B8A6',
  '#EAB308',
  '#EF4444',
  '#6366F1',
  '#06B6D4',
];

export function slugifyEnvironmentName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}

@Injectable()
export class EnvironmentService {
  constructor(private readonly agents: AgentRepository) {}

  async listForTenant(tenantId: string): Promise<EnvironmentResponse[]> {
    const rows = await db.select().from(environments).where(eq(environments.tenantId, tenantId));
    return rows
      .toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
      .map(toResponse);
  }

  async getDefaultForTenant(tenantId: string): Promise<EnvironmentRow | null> {
    const [row] = await db
      .select()
      .from(environments)
      .where(and(eq(environments.tenantId, tenantId), eq(environments.isDefault, true)));
    return row ?? null;
  }

  async ensureDefaultForTenant(tenantId: string): Promise<EnvironmentRow> {
    await this.ensureProductionForTenant(tenantId);

    const existing = await this.getDefaultForTenant(tenantId);
    if (existing) return existing;

    const [created] = await db
      .insert(environments)
      .values({
        id: crypto.randomUUID(),
        tenantId,
        name: DEVELOPMENT_ENVIRONMENT_NAME,
        slug: DEVELOPMENT_ENVIRONMENT_SLUG,
        shortName: DEVELOPMENT_ENVIRONMENT_SHORT_NAME,
        description: 'Default working environment',
        color: DEVELOPMENT_ENVIRONMENT_COLOR,
        isDefault: true,
        isProtected: true,
      })
      .onConflictDoNothing()
      .returning();

    if (created) return created;

    const fallback = await this.getDefaultForTenant(tenantId);
    if (!fallback) throw new Error(`Failed to ensure Development environment for tenant ${tenantId}`);
    return fallback;
  }

  private async ensureProductionForTenant(tenantId: string): Promise<void> {
    const rows = await db
      .select({ name: environments.name })
      .from(environments)
      .where(eq(environments.tenantId, tenantId));
    if (rows.some((r) => r.name.toLowerCase() === PRODUCTION_ENVIRONMENT_NAME.toLowerCase())) return;

    await db
      .insert(environments)
      .values({
        id: crypto.randomUUID(),
        tenantId,
        name: PRODUCTION_ENVIRONMENT_NAME,
        slug: PRODUCTION_ENVIRONMENT_SLUG,
        shortName: PRODUCTION_ENVIRONMENT_SHORT_NAME,
        description: 'Live environment for published apps',
        color: PRODUCTION_ENVIRONMENT_COLOR,
        isDefault: false,
        isProtected: true,
      })
      .onConflictDoNothing();
  }

  async findForTenant(tenantId: string, id: string): Promise<EnvironmentRow> {
    const [row] = await db
      .select()
      .from(environments)
      .where(and(eq(environments.id, id), eq(environments.tenantId, tenantId)));
    if (!row) throw new NotFoundException(`Environment ${id} not found`);
    return row;
  }

  async create(tenantId: string, dto: CreateEnvironmentDto): Promise<EnvironmentResponse> {
    const name = this.validateName(dto.name);
    const slug = dto.slug !== undefined ? this.validateSlug(dto.slug) : slugifyEnvironmentName(name);
    const shortName = this.validateShortName(dto.shortName);
    const description = this.validateDescription(dto.description);

    this.assertNameNotReserved(name);

    if (!slug) {
      throw new BadRequestException("'slug' is required when the name has no latin letters or digits");
    }

    await this.assertNameAvailable(tenantId, name, null);
    await this.assertSlugAvailable(tenantId, slug);

    const color = dto.color !== undefined ? this.validateColor(dto.color) : await this.nextDefaultColor(tenantId);

    const [created] = await db
      .insert(environments)
      .values({ id: crypto.randomUUID(), tenantId, name, slug, shortName, description, color, isDefault: false })
      .returning();
    return toResponse(created);
  }

  async update(tenantId: string, id: string, dto: UpdateEnvironmentDto): Promise<EnvironmentResponse> {
    const current = await this.findForTenant(tenantId, id);
    if (current.isProtected && (dto.name !== undefined || dto.description !== undefined)) {
      throw new BadRequestException(`The ${current.name} environment is protected and cannot be modified`);
    }

    const patch: Partial<EnvironmentRow> = {};
    if (dto.name !== undefined) {
      const name = this.validateName(dto.name);
      this.assertNameNotReserved(name);
      await this.assertNameAvailable(tenantId, name, id);
      patch.name = name;
    }
    if (dto.description !== undefined) patch.description = this.validateDescription(dto.description);
    if (dto.shortName !== undefined) patch.shortName = this.validateShortName(dto.shortName);
    if (dto.color !== undefined) patch.color = this.validateColor(dto.color);

    if (Object.keys(patch).length === 0) return toResponse(current);

    const [updated] = await db
      .update(environments)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(environments.id, id), eq(environments.tenantId, tenantId)))
      .returning();
    return toResponse(updated);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const current = await this.findForTenant(tenantId, id);
    if (current.isProtected) {
      throw new BadRequestException(`The ${current.name} environment is protected and cannot be deleted`);
    }

    const [instance] = await db
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.environmentId, id))
      .limit(1);
    if (instance) {
      throw new BadRequestException(
        'This environment still has published project instances. Delete those project environments first.'
      );
    }

    const referencing = await this.agents.agentsReferencing(id);
    if (referencing.length > 0) throw environmentInUse(referencing);

    await db.delete(environments).where(and(eq(environments.id, id), eq(environments.tenantId, tenantId)));
  }

  private assertNameNotReserved(name: string): void {
    const reserved = RESERVED_ENVIRONMENT_NAMES.find((r) => r.toLowerCase() === name.toLowerCase());
    if (reserved) throw new BadRequestException(`'${reserved}' is a reserved environment name`);
  }

  private async assertNameAvailable(tenantId: string, name: string, excludeId: string | null): Promise<void> {
    const rows = await db
      .select({ id: environments.id, name: environments.name })
      .from(environments)
      .where(eq(environments.tenantId, tenantId));
    const clash = rows.find((r) => r.name.toLowerCase() === name.toLowerCase() && r.id !== excludeId);
    if (clash) throw new BadRequestException(`An environment named '${name}' already exists`);
  }

  private async assertSlugAvailable(tenantId: string, slug: string): Promise<void> {
    const [clash] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(and(eq(environments.tenantId, tenantId), eq(environments.slug, slug)))
      .limit(1);
    if (clash) throw new BadRequestException(`An environment with URL slug '${slug}' already exists`);
  }

  private validateSlug(value: unknown): string {
    if (typeof value !== 'string') throw new BadRequestException("'slug' must be a string");
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > SLUG_MAX_LENGTH) {
      throw new BadRequestException(`'slug' must be 1-${SLUG_MAX_LENGTH} characters`);
    }
    if (!SLUG_PATTERN.test(trimmed)) {
      throw new BadRequestException(
        "'slug' may only contain lowercase letters, digits, and dashes, and cannot start or end with a dash"
      );
    }
    return trimmed;
  }

  private validateShortName(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new BadRequestException("'shortName' must be a string or null");
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (!SHORT_NAME_PATTERN.test(trimmed)) {
      throw new BadRequestException("'shortName' must be 2-5 letters or digits");
    }
    return trimmed;
  }

  private validateColor(value: unknown): string {
    if (typeof value !== 'string') throw new BadRequestException("'color' must be a string");
    const trimmed = value.trim();
    if (!COLOR_PATTERN.test(trimmed)) {
      throw new BadRequestException("'color' must be a hex color in the form #RRGGBB");
    }
    return trimmed;
  }

  private async nextDefaultColor(tenantId: string): Promise<string> {
    const rows = await db
      .select({ color: environments.color })
      .from(environments)
      .where(and(eq(environments.tenantId, tenantId), eq(environments.isProtected, false)));
    const used = new Set(rows.map((row) => row.color));
    const unused = DEFAULT_ENVIRONMENT_COLORS.find((color) => !used.has(color));
    return unused ?? DEFAULT_ENVIRONMENT_COLORS[rows.length % DEFAULT_ENVIRONMENT_COLORS.length];
  }

  private validateName(value: unknown): string {
    if (typeof value !== 'string') throw new BadRequestException("'name' must be a string");
    const trimmed = value.trim();
    if (trimmed.length < NAME_MIN_LENGTH || trimmed.length > NAME_MAX_LENGTH) {
      throw new BadRequestException(`'name' must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} characters`);
    }
    return trimmed;
  }

  private validateDescription(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new BadRequestException("'description' must be a string or null");
    const trimmed = value.trim();
    if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
      throw new BadRequestException(`'description' must be at most ${DESCRIPTION_MAX_LENGTH} characters`);
    }
    return trimmed.length === 0 ? null : trimmed;
  }
}

function toResponse(row: EnvironmentRow): EnvironmentResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    shortName: row.shortName,
    description: row.description,
    color: row.color,
    isDefault: row.isDefault,
    isProtected: row.isProtected,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
