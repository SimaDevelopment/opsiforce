import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agentProfileSkills, skills } from '../../db/schema';
import { AgentTemplateStore } from '../agent-template/agent-template.store';
import { parseFrontmatter, splitLines } from '../store/gate/frontmatter';
import { builtInProfileFor, developmentEnvironmentId } from '../store/agent-profile.repository';
import { agentConfigRoot, packageSkillNames } from '../store/skill-tree';
import { SkillRepository } from '../store/skill.repository';
import { defaultProfileModel, readMergedAgentRegistry } from './agent-config';
import { AgentRepository } from './agent.repository';
import type { AgentRow } from './agent.types';
import type { AgentBundle, AgentBundleProfile, AgentBundleSkillReference, AgentBundleTemplate } from './agent-bundle';

@Injectable()
export class AgentBundleReader {
  constructor(
    private readonly repository: AgentRepository,
    private readonly templates: AgentTemplateStore,
    private readonly skills: SkillRepository
  ) {}

  async read(agent: AgentRow, tenantId: string): Promise<AgentBundle> {
    return agent.origin === 'built_in' ? this.readBuiltIn(agent, tenantId) : this.readCustom(agent, tenantId);
  }

  private async readCustom(agent: AgentRow, tenantId: string): Promise<AgentBundle> {
    const developmentId = await developmentEnvironmentId(tenantId);
    const profile = await this.repository.profileAt(agent.id, developmentId);
    if (!profile) throw new NotFoundException(`Agent ${agent.id} has no Development profile`);

    const template = await this.templates.linkedVersion(agent.id, developmentId);
    return {
      identity: {
        displayName: agent.displayName,
        description: agent.description,
        platformApi: (await this.repository.settings(agent.id)).platformApi,
      },
      profile: {
        promptBody: profile.promptBody ?? '',
        model: profile.model ?? defaultProfileModel().model,
        variant: profile.variant,
      },
      skills: await pinnedSkills(profile.id),
      template: template ? { hash: template.hash, sourceDir: template.directory } : null,
    };
  }

  private async readBuiltIn(agent: AgentRow, tenantId: string): Promise<AgentBundle> {
    const parked = await builtInProfileFor(agent.id, tenantId);
    const shipped = await this.skills.builtInLatestVersions([...packageSkillNames(agent.name)]);
    const byName = new Map([...shipped, ...(await pinnedSkills(parked.id))].map((skill) => [skill.name, skill]));
    const entry = readMergedAgentRegistry().agents[agent.name];

    return {
      identity: {
        displayName: agent.displayName,
        description: agent.description,
        platformApi: entry?.platformApi === true,
      },
      profile: { promptBody: readPromptBody(agent.name), ...registryModel(agent.name) },
      skills: [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
      template: await this.packageTemplate(agent.name),
    };
  }

  private async packageTemplate(packageName: string): Promise<AgentBundleTemplate | null> {
    const sourceDir = packageFile(packageName, 'template');
    if (!sourceDir) return null;
    const hash = await this.templates.hashSource(sourceDir);
    return hash ? { hash, sourceDir } : null;
  }
}

function packageFile(packageName: string, entry: string): string | null {
  const root = agentConfigRoot();
  const candidates = [join(root, 'private', 'agents', packageName, entry), join(root, 'agents', packageName, entry)];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function readPromptBody(packageName: string): string {
  const file = packageFile(packageName, 'agent.md');
  if (!file) return '';
  const text = readFileSync(file, 'utf8');
  const { bodyStartLine } = parseFrontmatter(text);
  return splitLines(text)
    .slice(bodyStartLine - 1)
    .join('\n')
    .trim();
}

function registryModel(packageName: string): Pick<AgentBundleProfile, 'model' | 'variant'> {
  const entry = readMergedAgentRegistry().agents[packageName];
  if (entry?.model) return { model: entry.model, variant: entry.variant || null };
  return defaultProfileModel();
}

async function pinnedSkills(profileId: string): Promise<AgentBundleSkillReference[]> {
  return db
    .select({
      name: skills.name,
      skillId: agentProfileSkills.skillId,
      skillVersionId: agentProfileSkills.skillVersionId,
    })
    .from(agentProfileSkills)
    .innerJoin(skills, eq(skills.id, agentProfileSkills.skillId))
    .where(eq(agentProfileSkills.profileId, profileId));
}
