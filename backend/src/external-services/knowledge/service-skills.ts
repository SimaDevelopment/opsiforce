import { Injectable } from '@nestjs/common';
import {
  serviceSkillName,
  ServiceSkillSource,
  type ServiceSkill,
  type ServiceSkillAudience,
} from '../../delivery/service-skill-source';
import { builtInProfileFor } from '../../store/agent-profile.repository';
import { hashSkillTree, type SkillTree } from '../../store/gate';
import { SkillRepository } from '../../store/skill.repository';
import { manifestDescription } from '../../store/skill-tree';
import { ProjectConfigurationStore } from '../configuration/project-configuration.store';
import { ServiceAvailability } from '../configuration/service-availability';
import { servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { latestMarkedSkills, profileIdAt, servicesCarriedBy } from './service-skill.repository';
import { serviceSkillDocument } from './service-skill-document';

export function serviceSkillTree(service: RegisteredService): SkillTree {
  return [{ path: 'SKILL.md', content: Buffer.from(serviceSkillDocument(service), 'utf8'), executable: false }];
}

function behaviourProfileId(audience: ServiceSkillAudience): Promise<string | undefined> {
  return audience.agentOrigin === 'built_in'
    ? builtInProfileFor(audience.agentId, audience.tenantId).then((profile) => profile.id)
    : profileIdAt(audience.agentId, audience.environmentId);
}

@Injectable()
export class ServiceSkills extends ServiceSkillSource {
  constructor(
    private readonly availability: ServiceAvailability,
    private readonly registry: ServiceRegistry,
    private readonly projectConfigurationStore: ProjectConfigurationStore,
    private readonly skills: SkillRepository
  ) {
    super();
  }

  async skillsFor(audience: ServiceSkillAudience): Promise<ServiceSkill[]> {
    const profileId = await behaviourProfileId(audience);
    const carried = profileId ? await servicesCarriedBy(profileId) : [];
    const configured = await this.projectConfigurationStore.configuredServiceIds(audience.projectEnvironmentId);
    const wanted = new Set([...carried, ...configured]);
    const available = wanted.size === 0 ? new Set<string>() : await this.availableServiceIds(audience.tenantId);
    const marked = await latestMarkedSkills([...wanted].filter((id) => available.has(id)));
    const skills: ServiceSkill[] = marked.map((skill) => ({
      name: skill.name,
      externalServiceId: skill.externalServiceId,
      skillVersionId: skill.skillVersionId,
      contentHash: skill.contentHash,
      description: skill.description,
      tree: () => this.skills.readTree(skill.skillVersionId),
    }));
    const tested = await this.testedDevelopment(audience.projectEnvironmentId, audience.tenantId);
    if (!tested || !configured.includes(tested.id)) return skills;
    const testedSkill = draftSkillOf(tested);
    return [...skills.filter((skill) => skill.name !== testedSkill.name), testedSkill];
  }

  async availableServiceIds(tenantId: string): Promise<ReadonlySet<string>> {
    return new Set((await this.availability.availableToTenant(tenantId)).map((service) => service.id));
  }

  async servicesCarriedByAgentOf(audience: ServiceSkillAudience | undefined): Promise<Set<string>> {
    const profileId = audience ? await behaviourProfileId(audience) : undefined;
    return new Set(profileId ? await servicesCarriedBy(profileId) : []);
  }

  private async testedDevelopment(projectEnvironmentId: string, tenantId: string): Promise<RegisteredService | null> {
    const tested = await this.registry.testedBy(projectEnvironmentId, tenantId);
    if (!tested) return null;
    const development = await servableOrNone(this.registry.development(tested.id));
    return development?.home?.disabled ? null : development;
  }
}

function draftSkillOf(service: RegisteredService): ServiceSkill {
  const tree = serviceSkillTree(service);
  return {
    name: serviceSkillName(service.slug),
    externalServiceId: service.id,
    skillVersionId: null,
    contentHash: hashSkillTree(tree),
    description: manifestDescription(tree),
    tree: () => Promise.resolve(tree),
  };
}
