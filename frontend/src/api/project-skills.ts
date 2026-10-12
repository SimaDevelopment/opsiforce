import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';
import type { ProjectEnvironmentRef } from './project-external-services';

export type EnvironmentSkillKind = 'store' | 'package' | 'service' | 'platform';

export type EnvironmentSkillState = 'on' | 'switched-off' | 'switching-on' | 'retrying' | 'always-on';

export interface EnvironmentSkill {
  name: string;
  kind: EnvironmentSkillKind;
  description: string | null;
  state: EnvironmentSkillState;
  service: string | null;
  carried: boolean;
}

export interface EnvironmentSkills {
  agentName: string;
  skills: EnvironmentSkill[];
}

const SETTLING_POLL_MS = 3000;
const RETRYING_POLL_MS = 30_000;

function skillsPath(ref: ProjectEnvironmentRef): string {
  return `/projects/${ref.projectId}/environments/${ref.projectEnvironmentId}/skills`;
}

export const projectSkillKeys = {
  list: (ref: ProjectEnvironmentRef) => ['project-skills', ref.projectId, ref.projectEnvironmentId] as const,
};

function pollInterval(data: EnvironmentSkills | undefined): number | false {
  const states = new Set(data?.skills.map((skill) => skill.state));
  if (states.has('switching-on')) return SETTLING_POLL_MS;
  if (states.has('retrying')) return RETRYING_POLL_MS;
  return false;
}

export function useProjectSkills(ref: () => ProjectEnvironmentRef) {
  return createAppQuery(() => ({
    queryKey: projectSkillKeys.list(ref()),
    queryFn: () => api.get<EnvironmentSkills>(skillsPath(ref())),
    reconcile: 'name',
    refetchInterval: (query) => pollInterval(query.state.data),
  }));
}

export function useSwitchSkill(ref: () => ProjectEnvironmentRef) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (change: { name: string; on: boolean }) =>
      api.put<EnvironmentSkills>(`${skillsPath(ref())}/${encodeURIComponent(change.name)}`, { on: change.on }),
    onSuccess: (skills: EnvironmentSkills) => qc.setQueryData(projectSkillKeys.list(ref()), skills),
  }));
}

export function isOn(skill: EnvironmentSkill): boolean {
  return skill.state !== 'switched-off';
}
