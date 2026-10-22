import { podSettingsFromRequest } from '../pod/pod-class-request';
import { resolvePodSettings, type PodSettings } from '../pod/pod-classes';
import { validWarmPoolSize } from './agent-pod-settings';

export interface AgentProjectSettings {
  resources: PodSettings;
  warmPoolSize: number;
}

export interface AgentProjectSettingsChoice {
  resources?: unknown;
  warmPoolSize?: unknown;
}

export const DEFAULT_AGENT_PROJECT_SETTINGS: AgentProjectSettings = {
  resources: resolvePodSettings(),
  warmPoolSize: 0,
};

export function settingsForCopy(
  carried: AgentProjectSettings,
  choice: AgentProjectSettingsChoice
): AgentProjectSettings {
  return {
    resources: choice.resources === undefined ? carried.resources : podSettingsFromRequest(choice.resources),
    warmPoolSize: choice.warmPoolSize === undefined ? carried.warmPoolSize : validWarmPoolSize(choice.warmPoolSize),
  };
}
