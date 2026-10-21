const MIB_PER_GIB = 1024;
const MILLICORES_PER_CORE = 1000;

export function millicoresToCores(millicores: number): number {
  return millicores / MILLICORES_PER_CORE;
}

export function mibToGib(mib: number): number {
  return mib / MIB_PER_GIB;
}

export function coresToMillicores(cores: number): number {
  return Math.round(cores * MILLICORES_PER_CORE);
}

export function gibToMib(gib: number): number {
  return Math.round(gib * MIB_PER_GIB);
}

export function trimNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, '');
}

export function formatCores(millicores: number): string {
  return `${trimNumber(millicoresToCores(millicores))} vCPU`;
}

export function formatGib(mib: number): string {
  return `${trimNumber(mibToGib(mib))} GiB`;
}

const POD_CLASS_TITLES: Record<string, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  custom: 'Custom',
};

export function podClassTitle(podClass: string): string {
  return POD_CLASS_TITLES[podClass] ?? podClass;
}

export function describePodSettings(settings: {
  podClass: string;
  cpuMillicores: number;
  memoryRequestMib: number;
  memoryLimitMib: number;
}): string {
  return `${podClassTitle(settings.podClass)} · ${formatCores(settings.cpuMillicores)} · ${formatGib(settings.memoryRequestMib)} / ${formatGib(settings.memoryLimitMib)}`;
}

export function describeReadyProjects(size: number): string {
  return size === 0 ? 'none ready' : `${size} ready`;
}
