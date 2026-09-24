import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { MissingPermissionException } from '../permission/missing-permission.exception';
import { Perms } from '../permission/permission.constants';
import { and, asc, eq, isNull, not, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  agentProfileSkills,
  agentProfiles,
  agentSettings,
  agents,
  environments,
  skills,
} from '../../db/schema';
import { CUSTOM_AGENT_PACKAGE } from '../delivery/delivery.types';
import { SkillDeliveryRepository } from '../delivery/skill-delivery.repository';
import { packageSkillNames } from '../store/skill-tree';
import { developmentEnvironmentId } from '../store/agent-profile.repository';
import {
  CATALOG_LIST_FILTERS,
  catalogFilterWhere,
  catalogSearchWhere,
  type CatalogColumns,
  type CatalogListFilter,
} from '../store/catalog-filters';
import { nameUnavailable, notDisableable, visibilityIncoherent } from '../store/store-errors';
import { agentDeclaresPlatformApi, readMergedAgentRegistry, registryDefaultModel } from './agent-config';
import { agentInUse, lastBuiltInAgent, notPublishable } from './agent-errors';
import { isChatKind, type ProjectKind } from '../project/project.types';
import { assertModelSelection } from './agent-models';
import { AgentProfileService, assertAgentCarriesNoPrivateSkill } from './agent-profile.service';
import { AgentRepository } from './agent.repository';
import {
  agentDisabledIn,
  assertAgentVisibleToUser,
  BUILDER_AGENT_SLUG,
  canDisableAgent,
  canEditAgent,
  liveAgentsWhere,
  startableBuiltInAgentsWhere,
  visibleAgentsWhere,
} from './agent-visibility';
import {
  DEFAULT_AGENT_NAME,
  PLATFORM_SKILL_NAME,
  type AgentCaller,
  type AgentDeliveryEnvironment,
  type AgentDeliveryResponse,
  type AgentDetail,
  type AgentIdentity,
  type AgentProfileResponse,
  type AgentProfileSkillResponse,
  type AgentResponse,
  type AgentRow,
  type AgentSummary,
  type CreateAgentDto,
  type DuplicateAgentDto,
  type PublishAgentDto,
  type PublishAgentResponse,
  type SetAgentSkillDto,
  type SetAgentVisibilityDto,
  type UpdateAgentDto,
  type UpdateAgentProfileDto,
  type UpdateAgentSettingsDto,
} from './agent.types';

const SLUG_MAX_LENGTH = 60;

const AGENT_CATALOG_COLUMNS: CatalogColumns = {
  tenantId: agents.tenantId,
  name: agents.name,
  displayName: agents.displayName,
  description: agents.description,
  origin: agents.origin,
  visibility: agents.visibility,
  createdBy: agents.createdBy,
};

export function slugifyAgentName(displayName: string): string {
  return displayName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}

@Injectable()
export class AgentService {
  constructor(
    private readonly repository: AgentRepository,
    private readonly profiles: AgentProfileService,
    private readonly skillDeliveries: SkillDeliveryRepository
  ) {}

  async findAll(caller: AgentCaller): Promise<AgentResponse[]> {
    const rows = await this.repository.list(caller.tenantId, liveAgentsWhere(caller.tenantId, caller.userId));
    return rows.map(toResponse);
  }

  async listStore(caller: AgentCaller, rawFilter?: string, query?: string): Promise<AgentSummary[]> {
    const filter = parseFilter(rawFilter);
    if (filter === 'disabled' && !caller.canManageAgents) throw new MissingPermissionException(Perms.manageAgents);

    const rows = await this.repository.list(
      caller.tenantId,
      and(
        visibleAgentsWhere(caller.tenantId, caller.userId, { includeDisabled: true }),
        catalogFilterWhere(AGENT_CATALOG_COLUMNS, filter, {
          userId: caller.userId,
          disabled: agentDisabledIn(caller.tenantId),
        }),
        catalogSearchWhere(AGENT_CATALOG_COLUMNS, query)
      )
    );
    const ids = rows.map((row) => row.id);
    const [live, profileEnvironments, defaults] = await Promise.all([
      this.repository.liveIds(liveAgentsWhere(caller.tenantId, caller.userId)),
      this.repository.profileEnvironmentIds(ids, caller.tenantId),
      this.repository.defaultEnvironmentIds(ids),
    ]);

    return rows.map((row) =>
      toSummary(row, caller.userId, live.has(row.id), profileEnvironments.get(row.id) ?? [], defaults.get(row.id) ?? null)
    );
  }

  async findOne(caller: AgentCaller, agentId: string): Promise<AgentDetail> {
    const agent = await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    const live = await this.repository.liveIds(liveAgentsWhere(caller.tenantId, caller.userId));

    const profiles = await this.readProfiles(agent, caller.tenantId);
    const settings = await this.repository.settings(agent.id);
    return {
      ...toSummary(
        agent,
        caller.userId,
        live.has(agent.id),
        profiles.map((profile) => profile.environmentId),
        settings.defaultEnvironmentId
      ),
      settings,
      profiles,
      shippedSkills: agent.origin === 'built_in' ? await this.repository.shippedSkills(packageSkillNames(agent.name)) : [],
      projectCount: await this.repository.projectCount(agent.id, caller.tenantId),
    };
  }

  async create(caller: AgentCaller, dto: CreateAgentDto): Promise<AgentDetail> {
    const displayName = (dto.displayName ?? '').trim();
    if (!displayName) throw new BadRequestException({ code: 'bad_request', message: 'displayName is required' });

    const name = slugifyAgentName(displayName);
    if (!name) throw new BadRequestException({ code: 'bad_request', message: 'displayName has no letters or digits' });
    if (name in readMergedAgentRegistry().agents) throw nameUnavailable(name);
    if (await this.repository.nameTaken(caller.tenantId, name)) throw nameUnavailable(name);

    const fallback = registryDefaultModel();
    const model = dto.model?.trim() || fallback.model;
    const variant = dto.variant === undefined ? (fallback.variant ?? null) : dto.variant?.trim() || null;
    assertModelSelection(model, variant);

    const environmentId = await developmentEnvironmentId(caller.tenantId);
    const platform = await platformSkill();
    const agentId = crypto.randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(agents).values({
        id: agentId,
        tenantId: caller.tenantId,
        name,
        displayName,
        description: dto.description?.trim() || null,
        origin: 'custom',
        visibility: 'private',
        createdBy: caller.userId,
        poolSize: 0,
      });
      await tx.insert(agentSettings).values({ agentId, defaultEnvironmentId: environmentId, platformApi: false });

      const profileId = crypto.randomUUID();
      await tx.insert(agentProfiles).values({ id: profileId, agentId, environmentId, promptBody: '', model, variant });
      if (platform) {
        await tx
          .insert(agentProfileSkills)
          .values({ profileId, skillId: platform.id, skillVersionId: platform.latestVersionId });
      }
    });

    return this.findOne(caller, agentId);
  }

  async update(caller: AgentCaller, agentId: string, dto: UpdateAgentDto): Promise<AgentDetail> {
    const agent = await this.assertEditable(caller, agentId);

    const patch: Partial<typeof agents.$inferInsert> = {};
    if (dto.displayName !== undefined) {
      const displayName = dto.displayName.trim();
      if (!displayName) throw new BadRequestException({ code: 'bad_request', message: 'displayName is required' });
      patch.displayName = displayName;
    }
    if (dto.description !== undefined) patch.description = dto.description?.trim() || null;

    if (Object.keys(patch).length > 0) {
      await db
        .update(agents)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(agents.id, agent.id));
    }
    return this.findOne(caller, agentId);
  }

  async updateSettings(caller: AgentCaller, agentId: string, dto: UpdateAgentSettingsDto): Promise<AgentDetail> {
    const agent = await this.assertEditable(caller, agentId);

    const patch: Partial<typeof agentSettings.$inferInsert> = {};
    if (dto.defaultEnvironmentId !== undefined) {
      const [environment] = await db
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.id, dto.defaultEnvironmentId ?? ''), eq(environments.tenantId, caller.tenantId)))
        .limit(1);
      if (!environment) throw new NotFoundException(`Environment ${dto.defaultEnvironmentId} not found`);
      patch.defaultEnvironmentId = environment.id;
    }
    if ('platformApi' in dto) patch.platformApi = dto.platformApi === true;

    if (Object.keys(patch).length > 0) {
      await db
        .insert(agentSettings)
        .values({ agentId: agent.id, ...patch })
        .onConflictDoUpdate({ target: agentSettings.agentId, set: { ...patch, updatedAt: new Date() } });
    }
    return this.findOne(caller, agentId);
  }

  async setVisibility(caller: AgentCaller, agentId: string, dto: SetAgentVisibilityDto): Promise<AgentDetail> {
    const agent = await this.assertEditable(caller, agentId);
    if (dto.visibility !== 'public') throw visibilityIncoherent("Public agents can't be made private");

    if (agent.visibility !== 'public') {
      const profile = await this.profiles.targetProfile(agent, caller.tenantId);
      assertAgentCarriesNoPrivateSkill(
        { ...agent, visibility: 'public' },
        await this.repository.privateSkillNames(profile.id)
      );
      await db.update(agents).set({ visibility: 'public', updatedAt: new Date() }).where(eq(agents.id, agent.id));
    }
    return this.findOne(caller, agentId);
  }

  async duplicate(caller: AgentCaller, agentId: string, dto: DuplicateAgentDto): Promise<AgentDetail> {
    const source = await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    const sourceProfile = await this.profiles.targetProfile(source, caller.tenantId);
    const fallback = registryDefaultModel();

    const created = await this.create(caller, {
      displayName: dto.displayName,
      description: source.description,
      ...(source.origin === 'built_in'
        ? { model: fallback.model, variant: fallback.variant ?? null }
        : { model: sourceProfile.model ?? fallback.model, variant: sourceProfile.variant }),
    });

    const target = await this.profiles.targetProfile(
      await assertAgentVisibleToUser(caller.tenantId, caller.userId, created.id),
      caller.tenantId
    );
    await db.transaction(async (tx) => {
      if (source.origin === 'custom') {
        await tx
          .update(agentProfiles)
          .set({ promptBody: sourceProfile.promptBody ?? '', updatedAt: new Date() })
          .where(eq(agentProfiles.id, target.id));
      }
      const carried = await tx
        .select({ skillId: agentProfileSkills.skillId, skillVersionId: agentProfileSkills.skillVersionId })
        .from(agentProfileSkills)
        .where(eq(agentProfileSkills.profileId, sourceProfile.id));
      for (const row of carried) {
        await tx
          .insert(agentProfileSkills)
          .values({ profileId: target.id, skillId: row.skillId, skillVersionId: row.skillVersionId })
          .onConflictDoNothing({ target: [agentProfileSkills.profileId, agentProfileSkills.skillId] });
      }
    });

    return this.findOne(caller, created.id);
  }

  async setDisabled(caller: AgentCaller, agentId: string, disabled: boolean): Promise<AgentDetail> {
    const agent = await this.assertDisableable(caller, agentId);
    if (disabled === agent.disabled) return this.findOne(caller, agentId);
    if (!disabled) {
      await this.repository.enableIn(caller.tenantId, agent.id);
    } else if (agent.origin === 'custom') {
      await this.repository.disableIn(caller.tenantId, agent.id, caller.userId);
    } else if (!(await this.repository.disableBuiltInUnlessLast(caller.tenantId, agent.id, caller.userId))) {
      throw lastBuiltInAgent(agent.displayName ?? agent.name);
    }
    return this.findOne(caller, agentId);
  }

  async remove(
    caller: AgentCaller,
    agentId: string,
    removeProjects: (projectIds: string[]) => Promise<void>
  ): Promise<void> {
    const agent = await this.assertEditable(caller, agentId);
    if (!agent.disabled && (await this.repository.publishedBeyondDevelopment(agent.id, caller.tenantId))) {
      throw new BadRequestException({
        code: 'agent_not_disabled',
        message: `\`${agent.name}\` is published beyond Development; disable it before deleting it`,
      });
    }
    const projectCount = await this.repository.projectCount(agent.id, caller.tenantId);
    if (projectCount > 0) throw agentInUse(projectCount);

    const testProjects = await this.repository.testProjectIds(agent.id, caller.tenantId);
    await removeProjects(agent.builderChatId ? [...testProjects, agent.builderChatId] : testProjects);
    await db.delete(agents).where(eq(agents.id, agent.id));
  }

  async updateProfile(caller: AgentCaller, agentId: string, dto: UpdateAgentProfileDto): Promise<AgentDetail> {
    const agent = await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    await this.profiles.updateProfile(agent, caller, dto);
    return this.findOne(caller, agentId);
  }

  async listSkills(caller: AgentCaller, agentId: string): Promise<AgentProfileSkillResponse[]> {
    const agent = await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    return this.profiles.listSkills(agent, caller);
  }

  async setSkill(
    caller: AgentCaller,
    agentId: string,
    skillId: string,
    dto: SetAgentSkillDto
  ): Promise<AgentProfileSkillResponse[]> {
    const agent = await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    return this.profiles.setSkill(agent, caller, skillId, dto);
  }

  async removeSkill(caller: AgentCaller, agentId: string, skillId: string): Promise<AgentProfileSkillResponse[]> {
    const agent = await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    return this.profiles.removeSkill(agent, caller, skillId);
  }

  async publish(caller: AgentCaller, agentId: string, dto: PublishAgentDto): Promise<PublishAgentResponse> {
    const agent = await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    return this.profiles.publish(agent, caller, dto);
  }

  async delivery(caller: AgentCaller, agentId: string): Promise<AgentDeliveryResponse> {
    await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    const agent = await this.skillDeliveries.agent(agentId);
    if (agent?.origin !== 'built_in') return { environments: [], summary: { total: 0, converged: 0 } };

    // Builder chats and test Projects are delivered to but never listed (ADR-0064).
    const targets = (await this.skillDeliveries.fanOutTargets(agentId, caller.tenantId)).filter(
      (target) => target.projectKind === null
    );
    const states = new Map(
      (await this.skillDeliveries.statesFor(targets.map((target) => target.projectEnvironmentId))).map((state) => [
        state.projectEnvironmentId,
        state,
      ])
    );
    const rows: AgentDeliveryEnvironment[] = [];
    for (const target of targets) {
      const state = states.get(target.projectEnvironmentId);
      const row: AgentDeliveryEnvironment = {
        projectEnvironmentId: target.projectEnvironmentId,
        projectId: target.projectId,
        projectTitle: target.projectTitle,
        environmentId: target.environmentId,
        converged: state?.converged ?? true,
        pendingSkills: state?.pendingSkills ?? [],
        omittedSkills: state?.omittedSkills ?? [],
      };
      if (state?.failedAt) row.failedAt = state.failedAt;
      if (state?.error) row.error = state.error;
      rows.push(row);
    }
    return {
      environments: rows,
      summary: { total: rows.length, converged: rows.filter((row) => row.converged).length },
    };
  }

  async assertLiveForProjectCreate(
    agentId: string,
    tenantId: string,
    userId: string | null,
    kind: ProjectKind | null = null
  ): Promise<void> {
    if (isChatKind(kind) && (await this.isBuilderAgent(agentId))) return;
    const live = await this.repository.liveIds(liveAgentsWhere(tenantId, userId));
    if (!live.has(agentId)) throw new UnprocessableEntityException(`Agent ${agentId} not found`);
  }

  async findBuilderAgentId(): Promise<string | null> {
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.name, BUILDER_AGENT_SLUG), isNull(agents.tenantId)));
    return row?.id ?? null;
  }

  private async isBuilderAgent(agentId: string): Promise<boolean> {
    return (await this.findBuilderAgentId()) === agentId;
  }

  async findById(id: string): Promise<AgentResponse> {
    const [row] = await db
      .select({ id: agents.id, name: agents.name, displayName: agents.displayName, description: agents.description })
      .from(agents)
      .where(eq(agents.id, id));
    if (!row) throw new NotFoundException(`Agent ${id} not found`);
    return row;
  }

  async resolveName(id: string): Promise<string> {
    const [row] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, id));
    if (!row) throw new NotFoundException(`Agent ${id} not found`);
    return row.name;
  }

  async resolveIdentity(id: string): Promise<AgentIdentity> {
    const [row] = await db
      .select({ name: agents.name, displayName: agents.displayName, origin: agents.origin })
      .from(agents)
      .where(eq(agents.id, id));
    if (!row) throw new NotFoundException(`Agent ${id} not found`);
    return { ...row, package: row.origin === 'custom' ? CUSTOM_AGENT_PACKAGE : row.name };
  }

  async resolvePackageName(id: string): Promise<string> {
    return (await this.resolveIdentity(id)).package;
  }

  async callsPlatformApi(agentId: string): Promise<boolean> {
    const [row] = await db
      .select({ name: agents.name, origin: agents.origin, platformApi: agentSettings.platformApi })
      .from(agents)
      .leftJoin(agentSettings, eq(agentSettings.agentId, agents.id))
      .where(eq(agents.id, agentId));
    if (!row) return false;

    return row.origin === 'built_in' ? agentDeclaresPlatformApi(row.name) : row.platformApi === true;
  }

  async findIdByName(name: string, tenantId: string): Promise<string | null> {
    const rows = await db
      .select({ id: agents.id, tenantId: agents.tenantId })
      .from(agents)
      .where(
        and(
          eq(agents.name, name),
          or(isNull(agents.tenantId), eq(agents.tenantId, tenantId)),
          not(agentDisabledIn(tenantId))
        )
      );
    const builtIn = rows.find((row) => row.tenantId === null);
    return (builtIn ?? rows[0])?.id ?? null;
  }

  async getDefaultAgentId(tenantId: string): Promise<string> {
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(startableBuiltInAgentsWhere(tenantId))
      .orderBy(sql`${agents.name} = ${DEFAULT_AGENT_NAME} desc`, asc(agents.name))
      .limit(1);
    if (!row) throw new Error(`No built-in agent is enabled for tenant ${tenantId}`);
    return row.id;
  }

  private async assertDisableable(caller: AgentCaller, agentId: string): Promise<AgentRow> {
    const agent = await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    if (agent.origin === 'custom') return this.assertEditable(caller, agentId);
    if (!canDisableAgent(agent, caller.userId)) {
      throw notDisableable('The Skill & Agent Builder is always available to whoever may author');
    }
    if (!caller.canManageAgents) throw new MissingPermissionException(Perms.manageAgents);
    return agent;
  }

  private async assertEditable(caller: AgentCaller, agentId: string): Promise<AgentRow> {
    const agent = await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    if (agent.origin === 'built_in') throw notPublishable(`Agent \`${agent.name}\` is owned by the agent image`);
    if (!canEditAgent(agent, caller.userId)) {
      throw new ForbiddenException({ code: 'not_editable', message: `Agent \`${agent.name}\` cannot be edited` });
    }
    return agent;
  }

  private async readProfiles(agent: AgentRow, tenantId: string): Promise<AgentProfileResponse[]> {
    const rows = await this.repository.profiles(agent.id, tenantId);
    const skillsByProfile = await this.repository.skillsOf(rows.map((row) => row.id));

    if (agent.origin === 'built_in') {
      return rows.map((row) => ({
        environmentId: row.environmentId,
        promptBody: null,
        model: null,
        variant: null,
        updatedAt: row.updatedAt,
        skills: skillsByProfile.get(row.id) ?? [],
      }));
    }

    const byEnvironment = new Map(rows.map((row) => [row.environmentId, row]));
    return (await this.repository.environmentIds(tenantId)).map((environmentId) => {
      const row = byEnvironment.get(environmentId);
      if (!row) {
        return { environmentId, promptBody: null, model: null, variant: null, updatedAt: null, skills: null };
      }
      return {
        environmentId,
        promptBody: row.promptBody,
        model: row.model,
        variant: row.variant,
        updatedAt: row.updatedAt,
        skills: skillsByProfile.get(row.id) ?? [],
      };
    });
  }
}

async function platformSkill(): Promise<{ id: string; latestVersionId: string } | null> {
  const [row] = await db
    .select({ id: skills.id, latestVersionId: skills.latestVersionId })
    .from(skills)
    .where(and(eq(skills.name, PLATFORM_SKILL_NAME), isNull(skills.tenantId)))
    .orderBy(asc(skills.name))
    .limit(1);
  return row?.latestVersionId ? { id: row.id, latestVersionId: row.latestVersionId } : null;
}

function toResponse(row: AgentRow): AgentResponse {
  return { id: row.id, name: row.name, displayName: row.displayName, description: row.description };
}

function toSummary(
  row: AgentRow,
  userId: string,
  live: boolean,
  profileEnvironmentIds: string[],
  defaultEnvironmentId: string | null
): AgentSummary {
  return {
    ...toResponse(row),
    origin: row.origin,
    visibility: row.visibility,
    disabled: row.disabled,
    disableable: canDisableAgent(row, userId),
    createdBy: row.createdBy,
    imageOwned: row.origin === 'built_in',
    builderChatId: row.builderChatId,
    live,
    defaultEnvironmentId,
    profileEnvironmentIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseFilter(raw: string | undefined): CatalogListFilter {
  if (!raw) return 'all';
  const filter = CATALOG_LIST_FILTERS.find((candidate) => candidate === raw);
  if (!filter) throw new BadRequestException({ code: 'bad_request', message: `Unknown filter \`${raw}\`` });
  return filter;
}
