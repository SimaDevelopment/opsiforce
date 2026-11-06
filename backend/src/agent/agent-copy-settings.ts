import { podSettingsFromRequest } from '../pod/pod-class-request';
import type { PodSettings } from '../pod/pod-classes';
import { defaultPodSettings, type PresetCatalog } from '../pod/resource-presets';
import { validWarmPoolSize } from './agent-pod-settings';

export interface AgentProjectSettings {
  resources: PodSettings;
  /** The Agent has no Resources of its own and follows its Organization's default preset. */
  followsDefault?: boolean;
  warmPoolSize: number;
}

export interface AgentProjectSettingsChoice {
  resources?: unknown;
  warmPoolSize?: unknown;
}

export function defaultAgentProjectSettings(catalog: PresetCatalog): AgentProjectSettings {
  return { resources: defaultPodSettings(catalog), followsDefault: true, warmPoolSize: 0 };
}

export function settingsForCopy(
  carried: AgentProjectSettings,
  choice: AgentProjectSettingsChoice,
  catalog: PresetCatalog
): AgentProjectSettings {
  const resources =
    choice.resources === undefined
      ? { resources: carried.resources, followsDefault: carried.followsDefault }
      : { resources: podSettingsFromRequest(choice.resources, catalog), followsDefault: false };
  return {
    ...resources,
    warmPoolSize: choice.warmPoolSize === undefined ? carried.warmPoolSize : validWarmPoolSize(choice.warmPoolSize),
  };
}
