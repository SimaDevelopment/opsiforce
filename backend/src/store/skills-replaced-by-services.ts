import { serviceSkillName } from '../delivery/service-skill-source';

// TODO: remove in the release after External Services v2 ships: the v1 skills the pin swap and Agent Import replace, a no-op once every deployment has booted it
export interface SkillReplacement {
  retired: string;
  serviceSlug: string;
  replacement: string;
}

const SERVICE_SLUG_REPLACING: Record<string, string> = {
  whatsapp: 'whatsapp',
  'incoming-email': 'incoming-email',
};

export const SKILLS_REPLACED_BY_SERVICES: SkillReplacement[] = Object.entries(SERVICE_SLUG_REPLACING).map(
  ([retired, serviceSlug]) => ({ retired, serviceSlug, replacement: serviceSkillName(serviceSlug) })
);

export function replacementOf(skillName: string): SkillReplacement | undefined {
  return SKILLS_REPLACED_BY_SERVICES.find((swap) => swap.retired === skillName);
}
