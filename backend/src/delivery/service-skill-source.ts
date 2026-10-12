import type { SkillTree } from '../store/gate';
import type { DeliveredSkill } from './delivery.repository';

export const SERVICE_SKILL_PREFIX = 'service-';

export function serviceSkillName(slug: string): string {
  return `${SERVICE_SKILL_PREFIX}${slug}`;
}

export function isDeliveredServiceSkill(delivered: Pick<DeliveredSkill, 'skillName'>): boolean {
  return delivered.skillName.startsWith(SERVICE_SKILL_PREFIX);
}

export interface ServiceSkill {
  name: string;
  externalServiceId: string;
  skillVersionId: string | null;
  contentHash: string;
  description: string | null;
  tree: () => Promise<SkillTree>;
}

export interface ServiceSkillAudience {
  projectEnvironmentId: string;
  agentId: string;
  agentName: string;
  agentOrigin: string;
  tenantId: string;
  environmentId: string;
}

export abstract class ServiceSkillSource {
  abstract skillsFor(audience: ServiceSkillAudience): Promise<ServiceSkill[]>;
}
