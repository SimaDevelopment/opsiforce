import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { projectEnvironments, projects, users } from '../../db/schema';
import {
  AgentUpdateInProgress,
  EnvironmentSkillNotFound,
  EnvironmentSkillsService,
  PlatformSkillAlwaysOn,
  SkillNoLongerCarried,
  type EnvironmentSkill,
  type EnvironmentSkills,
} from '../delivery/environment-skills';
import { Perms } from '../permission/permission.constants';
import { hasPermission } from '../permission/permission.utils';
import { isProjectAccessible } from '../project/project-visibility';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../user/user.decorator';

@Controller('projects/:projectId/environments/:projectEnvironmentId/skills')
export class ProjectSkillsController {
  constructor(private readonly environmentSkills: EnvironmentSkillsService) {}

  @Get()
  async list(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<EnvironmentSkills> {
    await reachableUserId(tenant, user, projectId, projectEnvironmentId);
    return this.environmentSkills.list(projectEnvironmentId);
  }

  @Put(':skillName')
  async switch(
    @Param('projectId') projectId: string,
    @Param('projectEnvironmentId') projectEnvironmentId: string,
    @Param('skillName') skillName: string,
    @Body() body: { on?: unknown } | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<EnvironmentSkills> {
    if (typeof body?.on !== 'boolean') throw new BadRequestException('Send {"on": true} or {"on": false}');
    const userId = await reachableUserId(tenant, user, projectId, projectEnvironmentId);
    try {
      const skill = await this.environmentSkills.find(projectEnvironmentId, skillName);
      assertMaySwitch(user, skill);
      if (body.on) await this.environmentSkills.switchOn(projectEnvironmentId, skillName);
      else await this.environmentSkills.switchOff(projectEnvironmentId, skillName, userId);
    } catch (err) {
      throw asHttpError(err);
    }
    return this.environmentSkills.list(projectEnvironmentId);
  }
}

function assertMaySwitch(user: UserContext, skill: EnvironmentSkill): void {
  if (skill.kind === 'platform') throw new PlatformSkillAlwaysOn();
  const needed = skill.kind === 'service' ? Perms.configureProjectExternalServices : Perms.manageProjectSkills;
  if (!hasPermission(user.groups, needed)) {
    throw new ForbiddenException(`Switching ${skill.name} needs ${needed}`);
  }
}

function asHttpError(err: unknown): unknown {
  if (err instanceof EnvironmentSkillNotFound) return new NotFoundException(err.message);
  if (err instanceof PlatformSkillAlwaysOn || err instanceof SkillNoLongerCarried) {
    return new ConflictException(err.message);
  }
  if (err instanceof AgentUpdateInProgress) return new ConflictException(err.message);
  return err;
}

async function reachableUserId(
  tenant: TenantContext,
  user: UserContext,
  projectId: string,
  projectEnvironmentId: string
): Promise<string> {
  const [row] = await db
    .select({ id: projectEnvironments.id })
    .from(projectEnvironments)
    .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
    .where(
      and(
        eq(projectEnvironments.id, projectEnvironmentId),
        eq(projectEnvironments.projectId, projectId),
        eq(projects.tenantId, tenant.tenantId)
      )
    );
  const [person] = await db.select({ id: users.id }).from(users).where(eq(users.keycloakId, user.userId));
  if (!row || !person || !(await isProjectAccessible(tenant.tenantId, person.id, projectId))) {
    throw new NotFoundException(`Project ${projectId} not found`);
  }
  return person.id;
}
