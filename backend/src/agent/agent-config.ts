import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AgentRegistryEntry {
  name?: string;
  description?: string;
  default?: boolean;
  port?: number;
  version?: string;
  model?: string;
  variant?: string;
  poolSize?: number;
  platformApi?: boolean;
}

export interface AgentRegistry {
  agents: Record<string, AgentRegistryEntry>;
}

export interface AgentModelSelection {
  model: string;
  variant?: string;
}

export const FALLBACK_APP_PORT = 3000;

export interface AgentRuntimeConfig {
  poolSizes: Map<string, number>;
  versions: Map<string, string>;
  modelSelections: Map<string, AgentModelSelection>;
  platformApi: Map<string, boolean>;
}

function readPublicRegistry(): AgentRegistry {
  const file = join(process.cwd(), '..', 'agent-config', 'agents.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AgentRegistry>;
    return { agents: parsed.agents ?? {} };
  } catch {
    return { agents: {} };
  }
}

function readPrivateRegistry(): AgentRegistry {
  const file = join(process.cwd(), '..', 'agent-config', 'private', 'agents.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AgentRegistry>;
    return { agents: parsed.agents ?? {} };
  } catch {
    return { agents: {} };
  }
}

export function mergeAgentRegistries(publicRegistry: AgentRegistry, privateFragment?: AgentRegistry): AgentRegistry {
  return { agents: { ...publicRegistry.agents, ...privateFragment?.agents } };
}

export function readMergedAgentRegistry(privateFragment?: AgentRegistry): AgentRegistry {
  return mergeAgentRegistries(readPublicRegistry(), privateFragment ?? readPrivateRegistry());
}

export function registryDefaultModel(registry: AgentRegistry = readMergedAgentRegistry()): AgentModelSelection {
  const entries = Object.values(registry.agents);
  const entry = entries.find((candidate) => candidate.default === true) ?? entries[0];
  return {
    model: entry?.model ?? '',
    ...(typeof entry?.variant === 'string' && entry.variant.length > 0 ? { variant: entry.variant } : {}),
  };
}

export function agentDeclaresPlatformApi(slug: string): boolean {
  return readMergedAgentRegistry().agents[slug]?.platformApi === true;
}

export function agentAppPort(slug: string): number {
  const entry = readMergedAgentRegistry().agents[slug];
  return portOf(entry);
}

export function sharedAppPort(): number {
  const ports = new Set(Object.values(readMergedAgentRegistry().agents).map(portOf));
  if (ports.size > 1) {
    throw new Error(
      `Agents declare different app ports (${[...ports].toSorted((a, b) => a - b).join(', ')}); the backend routes every environment through one port.`
    );
  }
  return ports.values().next().value ?? FALLBACK_APP_PORT;
}

function portOf(entry: AgentRegistryEntry | undefined): number {
  return typeof entry?.port === 'number' && entry.port > 0 ? entry.port : FALLBACK_APP_PORT;
}

export function readAgentConfig(): AgentRuntimeConfig {
  const poolSizes = new Map<string, number>();
  const versions = new Map<string, string>();
  const modelSelections = new Map<string, AgentModelSelection>();
  const platformApi = new Map<string, boolean>();
  for (const [slug, conf] of Object.entries(readMergedAgentRegistry().agents)) {
    const poolSize = typeof conf.poolSize === 'number' && conf.poolSize > 0 ? conf.poolSize : 0;
    poolSizes.set(slug, poolSize);
    platformApi.set(slug, conf.platformApi === true);
    if (typeof conf.version === 'string' && conf.version.length > 0) {
      versions.set(slug, conf.version);
    }
    if (typeof conf.model === 'string' && conf.model.length > 0) {
      modelSelections.set(slug, {
        model: conf.model,
        ...(typeof conf.variant === 'string' && conf.variant.length > 0 ? { variant: conf.variant } : {}),
      });
    }
  }
  return { poolSizes, versions, modelSelections, platformApi };
}
