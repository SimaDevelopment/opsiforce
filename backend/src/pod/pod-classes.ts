export type PodPreset = 'small' | 'medium' | 'large';

export type PodClass = PodPreset | 'custom';

export interface PodResources {
  cpuMillicores: number;
  memoryRequestMib: number;
  memoryLimitMib: number;
}

export type PodSettings = PodResources & { podClass: PodClass };

export interface PodClassBounds {
  min: PodResources;
  max: PodResources;
}

export const POD_CLASS_DEFAULT: PodClass = 'small';

const PRESETS: Record<PodPreset, PodResources> = {
  small: { cpuMillicores: 100, memoryRequestMib: 2048, memoryLimitMib: 4096 },
  medium: { cpuMillicores: 1000, memoryRequestMib: 4096, memoryLimitMib: 8192 },
  large: { cpuMillicores: 2000, memoryRequestMib: 8192, memoryLimitMib: 16384 },
};

export const CUSTOM_BOUNDS: PodClassBounds = {
  min: { cpuMillicores: 250, memoryRequestMib: 1024, memoryLimitMib: 2048 },
  max: { cpuMillicores: 4000, memoryRequestMib: 16384, memoryLimitMib: 24576 },
};

export function isPreset(podClass: PodClass): podClass is PodPreset {
  return podClass === 'small' || podClass === 'medium' || podClass === 'large';
}

export function resolvePreset(preset: PodPreset): PodResources {
  return PRESETS[preset];
}

/** Preset projects follow the current catalog; custom projects retain saved values. */
export function resolveStoredPodResources(settings?: PodSettings): PodResources {
  if (!settings) return resolvePreset('small');
  return isPreset(settings.podClass) ? resolvePreset(settings.podClass) : settings;
}

export interface PodClassSelection {
  podClass: PodClass;
  cpuMillicores?: number;
  memoryRequestMib?: number;
  memoryLimitMib?: number;
}

export class InvalidPodClassSelection extends Error {}

export function resolvePodClassSelection(selection: PodClassSelection): PodResources {
  if (selection.podClass === 'custom') {
    if (
      typeof selection.cpuMillicores !== 'number' ||
      typeof selection.memoryRequestMib !== 'number' ||
      typeof selection.memoryLimitMib !== 'number'
    ) {
      throw new InvalidPodClassSelection(
        'Custom pod class requires numeric cpuMillicores, memoryRequestMib, and memoryLimitMib'
      );
    }
    return clampCustom({
      cpuMillicores: selection.cpuMillicores,
      memoryRequestMib: selection.memoryRequestMib,
      memoryLimitMib: selection.memoryLimitMib,
    });
  }
  if (!isPreset(selection.podClass)) {
    throw new InvalidPodClassSelection(`Unknown pod class: ${String(selection.podClass)}`);
  }
  return resolvePreset(selection.podClass);
}

export function isDefaultPodSettings(settings: PodSettings): boolean {
  return settings.podClass === POD_CLASS_DEFAULT;
}

export function resolvePodSettings(stored?: PodSettings): PodSettings {
  return { podClass: stored?.podClass ?? POD_CLASS_DEFAULT, ...resolveStoredPodResources(stored) };
}

export function podSettingsForSelection(selection: PodClassSelection): PodSettings {
  return { podClass: selection.podClass, ...resolvePodClassSelection(selection) };
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
    CUSTOM_BOUNDS.min.cpuMillicores,
    CUSTOM_BOUNDS.max.cpuMillicores
  );
  const memoryRequestMib = clampValue(
    input.memoryRequestMib,
    CUSTOM_BOUNDS.min.memoryRequestMib,
    CUSTOM_BOUNDS.max.memoryRequestMib
  );
  const memoryLimitMib = clampValue(
    input.memoryLimitMib,
    CUSTOM_BOUNDS.min.memoryLimitMib,
    CUSTOM_BOUNDS.max.memoryLimitMib
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

export interface PodClassPreset {
  podClass: PodPreset;
  resources: PodResources;
}

export interface PodClassCatalog {
  presets: PodClassPreset[];
  customBounds: PodClassBounds;
}

export function buildPodClassCatalog(): PodClassCatalog {
  return {
    presets: [
      { podClass: 'small', resources: resolvePreset('small') },
      { podClass: 'medium', resources: resolvePreset('medium') },
      { podClass: 'large', resources: resolvePreset('large') },
    ],
    customBounds: CUSTOM_BOUNDS,
  };
}
