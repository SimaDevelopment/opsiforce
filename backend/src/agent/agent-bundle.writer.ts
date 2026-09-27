import { BadRequestException, Injectable } from '@nestjs/common';
import { db } from '../../db';
import type { DbExecutor } from '../common/locks';
import { agentProfileSkills, agentProfiles, agentSettings, agents } from '../../db/schema';
import { templateChanged } from '../agent-template/agent-template.errors';
import { AgentTemplateStore } from '../agent-template/agent-template.store';
import { developmentEnvironmentId, productionEnvironmentId } from '../store/agent-profile.repository';
import { nameUnavailable } from '../store/store-errors';
import { SkillRepository } from '../store/skill.repository';
import { readMergedAgentRegistry } from './agent-config';
import { AgentRepository } from './agent.repository';
import { PLATFORM_SKILL_NAME, type AgentCaller } from './agent.types';
import type { AgentBundle, SkillPin } from './agent-bundle';

const SLUG_MAX_LENGTH = 60;
const AGENT_NAME_UNIQUE = 'agents_tenant_id_name_unique';

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

export interface NewAgent {
  displayName: string;
  bundle: AgentBundle;
  pins: SkillPin[];
  /** Skill writes that commit with the Agent's rows, answering the pins they minted. */
  writeSkills?: (tx: DbExecutor) => Promise<SkillPin[]>;
}

@Injectable()
export class AgentBundleWriter {
  constructor(
    private readonly repository: AgentRepository,
    private readonly templates: AgentTemplateStore,
    private readonly skills: SkillRepository
  ) {}

  /** The slug a new Agent named `displayName` would get, refusing a reserved or taken one. */
  async availableName(tenantId: string, rawDisplayName: string): Promise<{ displayName: string; name: string }> {
    const displayName = rawDisplayName.trim();
    if (!displayName) throw new BadRequestException({ code: 'bad_request', message: 'displayName is required' });

    const name = slugifyAgentName(displayName);
    if (!name) throw new BadRequestException({ code: 'bad_request', message: 'displayName has no letters or digits' });
    if (name in readMergedAgentRegistry().agents) throw nameUnavailable(name);
    if (await this.repository.nameTaken(tenantId, name)) throw nameUnavailable(name);
    return { displayName, name };
  }

  async write(caller: AgentCaller, draft: NewAgent): Promise<string> {
    const { displayName, name } = await this.availableName(caller.tenantId, draft.displayName);
    const developmentId = await developmentEnvironmentId(caller.tenantId);
    const productionId = await productionEnvironmentId(caller.tenantId);
    const [platform = null] = await this.skills.builtInLatestVersions([PLATFORM_SKILL_NAME]);
    const agentId = crypto.randomUUID();
    const { identity, profile, template } = draft.bundle;

    try {
      if (template) {
        const written = await this.templates.writeUnlocked(agentId, developmentId, template.sourceDir);
        if (written.hash !== template.hash) throw templateChanged();
      }

      await db.transaction(async (tx) => {
        const mintedPins = draft.writeSkills ? await draft.writeSkills(tx) : [];
        await tx.insert(agents).values({
          id: agentId,
          tenantId: caller.tenantId,
          name,
          displayName,
          description: identity.description?.trim() || null,
          origin: 'custom',
          visibility: 'private',
          createdBy: caller.userId,
          poolSize: 0,
        });
        await tx
          .insert(agentSettings)
          .values({ agentId, defaultEnvironmentId: productionId, platformApi: identity.platformApi });

        const profileId = crypto.randomUUID();
        await tx.insert(agentProfiles).values({
          id: profileId,
          agentId,
          environmentId: developmentId,
          promptBody: profile.promptBody,
          model: profile.model,
          variant: profile.variant,
        });
        const carried = [...draft.pins, ...mintedPins];
        const carriesPlatform = platform !== null && carried.some((pin) => pin.skillId === platform.skillId);
        const pins = platform && !carriesPlatform ? [platform, ...carried] : carried;
        if (pins.length > 0) {
          await tx
            .insert(agentProfileSkills)
            .values(pins.map((pin) => ({ profileId, skillId: pin.skillId, skillVersionId: pin.skillVersionId })))
            .onConflictDoNothing({ target: [agentProfileSkills.profileId, agentProfileSkills.skillId] });
        }
      });
    } catch (error) {
      await this.templates.removeAgent(agentId);
      if (isAgentNameTaken(error)) throw nameUnavailable(name);
      throw error;
    }
    return agentId;
  }
}

interface PostgresErrorFields {
  code?: string;
  constraint_name?: string;
}

function isAgentNameTaken(error: unknown): boolean {
  const direct = error as PostgresErrorFields & { cause?: unknown };
  const pg = direct?.code ? direct : ((direct?.cause as PostgresErrorFields | undefined) ?? {});
  return pg.code === '23505' && pg.constraint_name === AGENT_NAME_UNIQUE;
}
