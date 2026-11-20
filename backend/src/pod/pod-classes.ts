export interface PodResources {
  cpuMillicores: number;
  memoryRequestMib: number;
  memoryLimitMib: number;
}

/** A pod's size: the preset it was chosen from, or none for Custom, and the numbers it runs at. */
export interface PodSettings extends PodResources {
  presetId: string | null;
  presetName: string | null;
}

export interface PodClassBounds {
  min: PodResources;
  max: PodResources;
}

export const JOB_POD_RESOURCES: PodResources = { cpuMillicores: 100, memoryRequestMib: 2048, memoryLimitMib: 4096 };

const MIN_RESOURCES: PodResources = { cpuMillicores: 50, memoryRequestMib: 512, memoryLimitMib: 512 };

const DEFAULT_MAX_RESOURCES: PodResources = { cpuMillicores: 4000, memoryRequestMib: 16384, memoryLimitMib: 24576 };

const MAX_RESOURCE_ENV: Record<keyof PodResources, string> = {
  cpuMillicores: 'AGENT_MAX_CPU_MILLICORES',
  memoryRequestMib: 'AGENT_MAX_MEMORY_REQUEST_MIB',
  memoryLimitMib: 'AGENT_MAX_MEMORY_LIMIT_MIB',
};

function maxResource(env: NodeJS.ProcessEnv, key: keyof PodResources): number {
  const raw = env[MAX_RESOURCE_ENV[key]]?.trim();
  if (!raw) return DEFAULT_MAX_RESOURCES[key];
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_RESOURCES[key]) {
    throw new Error(`${MAX_RESOURCE_ENV[key]} must be a whole number of at least ${MIN_RESOURCES[key]}, got "${raw}"`);
  }
  return value;
}

export function resourceBoundsFrom(env: NodeJS.ProcessEnv): PodClassBounds {
  const max: PodResources = {
    cpuMillicores: maxResource(env, 'cpuMillicores'),
    memoryRequestMib: maxResource(env, 'memoryRequestMib'),
    memoryLimitMib: maxResource(env, 'memoryLimitMib'),
  };
  if (max.memoryLimitMib < max.memoryRequestMib) {
    throw new Error(
      `${MAX_RESOURCE_ENV.memoryLimitMib} (${max.memoryLimitMib}) must be at least ${MAX_RESOURCE_ENV.memoryRequestMib} (${max.memoryRequestMib})`
    );
  }
  return { min: MIN_RESOURCES, max };
}

export const RESOURCE_BOUNDS: PodClassBounds = resourceBoundsFrom(process.env);

export const PRESET_NAME_MAX_LENGTH = 40;

export interface PodClassSelection {
  presetId: string | null;
  cpuMillicores?: number;
  memoryRequestMib?: number;
  memoryLimitMib?: number;
}

export class InvalidPodClassSelection extends Error {}

export function resourcesOf(row: PodResources): PodResources {
  return {
    cpuMillicores: row.cpuMillicores,
    memoryRequestMib: row.memoryRequestMib,
    memoryLimitMib: row.memoryLimitMib,
  };
}

export function customPodSettings(selection: PodClassSelection): PodSettings {
  if (
    typeof selection.cpuMillicores !== 'number' ||
    typeof selection.memoryRequestMib !== 'number' ||
    typeof selection.memoryLimitMib !== 'number'
  ) {
    throw new InvalidPodClassSelection(
      'Custom Resources need numeric cpuMillicores, memoryRequestMib and memoryLimitMib'
    );
  }
  return {
    presetId: null,
    presetName: null,
    ...clampCustom({
      cpuMillicores: selection.cpuMillicores,
      memoryRequestMib: selection.memoryRequestMib,
      memoryLimitMib: selection.memoryLimitMib,
    }),
  };
}

export function sameResources(a: PodResources, b: PodResources): boolean {
  return (
    a.cpuMillicores === b.cpuMillicores &&
    a.memoryRequestMib === b.memoryRequestMib &&
    a.memoryLimitMib === b.memoryLimitMib
  );
}

function clampValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

export function clampCustom(input: PodResources): PodResources {
  const cpuMillicores = clampValue(
    input.cpuMillicores,
    RESOURCE_BOUNDS.min.cpuMillicores,
    RESOURCE_BOUNDS.max.cpuMillicores
  );
  const memoryRequestMib = clampValue(
    input.memoryRequestMib,
    RESOURCE_BOUNDS.min.memoryRequestMib,
    RESOURCE_BOUNDS.max.memoryRequestMib
  );
  const memoryLimitMib = clampValue(
    input.memoryLimitMib,
    RESOURCE_BOUNDS.min.memoryLimitMib,
    RESOURCE_BOUNDS.max.memoryLimitMib
  );
  return {
    cpuMillicores,
    memoryRequestMib,
    memoryLimitMib: Math.max(memoryLimitMib, memoryRequestMib),
  };
}

export interface K8sResourceRequirements {
  requests: { cpu: string; memory: string };
  limits: { memory: string };
}

export function toK8sResources(resources: PodResources): K8sResourceRequirements {
  return {
    requests: { cpu: `${resources.cpuMillicores}m`, memory: `${resources.memoryRequestMib}Mi` },
    limits: { memory: `${resources.memoryLimitMib}Mi` },
  };
}

const RESOURCE_KEYS = ['cpuMillicores', 'memoryRequestMib', 'memoryLimitMib'] as const;

export function validPresetResources(input: unknown): PodResources {
  const candidate = (input ?? {}) as Partial<Record<(typeof RESOURCE_KEYS)[number], unknown>>;
  for (const key of RESOURCE_KEYS) {
    const value = candidate[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new InvalidPodClassSelection(`${key} must be a whole number`);
    }
    if (value < RESOURCE_BOUNDS.min[key] || value > RESOURCE_BOUNDS.max[key]) {
      throw new InvalidPodClassSelection(
        `${key} must be from ${RESOURCE_BOUNDS.min[key]} to ${RESOURCE_BOUNDS.max[key]}`
      );
    }
  }
  const resources = resourcesOf(candidate as PodResources);
  if (resources.memoryLimitMib < resources.memoryRequestMib) {
    throw new InvalidPodClassSelection('memoryLimitMib must be at least memoryRequestMib');
  }
  return resources;
}

export function validPresetName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim() : '';
  if (name.length === 0) throw new InvalidPodClassSelection('A preset needs a name');
  if (name.length > PRESET_NAME_MAX_LENGTH) {
    throw new InvalidPodClassSelection(`A preset name is at most ${PRESET_NAME_MAX_LENGTH} characters`);
  }
  if (name.toLowerCase() === 'custom') throw new InvalidPodClassSelection('Custom is reserved');
  return name;
}
