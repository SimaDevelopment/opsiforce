import type { AgentProfile, AgentProfileSkill } from '~/api/agents';

export interface RepinnedSkill {
  skill: AgentProfileSkill;
  fromVersion: number;
  toVersion: number;
}

export interface ProfileDiff {
  promptChanged: boolean;
  modelChanged: boolean;
  added: AgentProfileSkill[];
  removed: AgentProfileSkill[];
  repinned: RepinnedSkill[];
  skillsChanged: boolean;
  empty: boolean;
}

/** `skills: null` is how the API says an environment holds no profile at all (issue 31). */
export function isPublished(profile: AgentProfile | undefined): profile is AgentProfile {
  return !!profile && profile.skills !== null;
}

export function profileDiff(development: AgentProfile, target: AgentProfile | undefined): ProfileDiff {
  const from = new Map((target?.skills ?? []).map((skill) => [skill.skillId, skill]));
  const to = new Map((development.skills ?? []).map((skill) => [skill.skillId, skill]));

  const added = [...to.values()].filter((skill) => !from.has(skill.skillId));
  const removed = [...from.values()].filter((skill) => !to.has(skill.skillId));
  const repinned = [...to.values()]
    .map((skill) => {
      const before = from.get(skill.skillId);
      return before && before.pinnedVersion !== skill.pinnedVersion
        ? { skill, fromVersion: before.pinnedVersion, toVersion: skill.pinnedVersion }
        : null;
    })
    .filter((entry): entry is RepinnedSkill => entry !== null);

  const promptChanged = (development.promptBody ?? '') !== (target?.promptBody ?? '');
  const modelChanged = development.model !== (target?.model ?? null) || development.variant !== (target?.variant ?? null);
  const skillsChanged = added.length + removed.length + repinned.length > 0;

  return {
    promptChanged,
    modelChanged,
    added,
    removed,
    repinned,
    skillsChanged,
    empty: !promptChanged && !modelChanged && !skillsChanged,
  };
}

/** The Publishing strip's one line per target. */
export function driftText(development: AgentProfile | undefined, target: AgentProfile | undefined): string {
  if (!isPublished(target)) return 'Not published yet';
  if (!isPublished(development)) return 'Development holds no definition';
  const diff = profileDiff(development, target);
  if (diff.empty) return 'Same as Development';
  const parts = [diff.promptChanged && 'prompt', diff.modelChanged && 'model', diff.skillsChanged && 'skills'].filter(
    (part): part is string => typeof part === 'string'
  );
  return `Development differs: ${parts.join(', ')}`;
}
