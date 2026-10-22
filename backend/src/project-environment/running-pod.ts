import { ProjectStatus } from '../project/project.types';

export function hasRunningPod(env: { disabled: boolean; status: string }): boolean {
  return !env.disabled && env.status === ProjectStatus.Active;
}
