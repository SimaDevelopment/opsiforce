import { eq, isNull, or } from 'drizzle-orm';
import { db } from '../../db';
import { resourcePresets, tenantResourcePresetOverrides, tenantSettings } from '../../db/schema';
import type { DbExecutor } from '../common/locks';
import {
  RESOURCE_BOUNDS,
  customPodSettings,
  InvalidPodClassSelection,
  JOB_POD_RESOURCES,
  resourcesOf,
  type PodClassBounds,
  type PodClassSelection,
  type PodResources,
  type PodSettings,
} from './pod-classes';

export interface CatalogPreset {
  id: string;
  name: string;
  tenantId: string | null;
  resources: PodResources;
  platformResources: PodResources;
  overridden: boolean;
}

/** The presets one Organization sees, with its own numbers applied, and its default; no Organization means the platform's. */
export interface PresetCatalog {
  presets: CatalogPreset[];
  defaultPresetId: string | null;
  platformDefaultPresetId: string | null;
  ownDefault: boolean;
}

export async function readPresetCatalog(tenantId: string | null, executor: DbExecutor = db): Promise<PresetCatalog> {
  const rows = await executor
    .select()
    .from(resourcePresets)
    .where(
      tenantId
        ? or(isNull(resourcePresets.tenantId), eq(resourcePresets.tenantId, tenantId))
        : isNull(resourcePresets.tenantId)
    );
  const overrides = tenantId
    ? await executor
        .select()
        .from(tenantResourcePresetOverrides)
        .where(eq(tenantResourcePresetOverrides.tenantId, tenantId))
    : [];
  const ownDefaultId = tenantId ? await readOwnDefaultPresetId(tenantId, executor) : null;
  const overrideByPreset = new Map(overrides.map((row) => [row.presetId, resourcesOf(row)]));

  const presets = rows
    .map((row): CatalogPreset => {
      const override = row.tenantId === null ? overrideByPreset.get(row.id) : undefined;
      return {
        id: row.id,
        name: row.name,
        tenantId: row.tenantId,
        resources: override ?? resourcesOf(row),
        platformResources: resourcesOf(row),
        overridden: override !== undefined,
      };
    })
    .toSorted(bySize);
  const platformDefaultPresetId = rows.find((row) => row.isDefault)?.id ?? null;
  const visibleOwnDefault = presets.some((preset) => preset.id === ownDefaultId) ? ownDefaultId : null;
  return {
    presets,
    defaultPresetId: visibleOwnDefault ?? platformDefaultPresetId,
    platformDefaultPresetId,
    ownDefault: visibleOwnDefault !== null,
  };
}

async function readOwnDefaultPresetId(tenantId: string, executor: DbExecutor): Promise<string | null> {
  const [row] = await executor
    .select({ presetId: tenantSettings.defaultResourcePresetId })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  return row?.presetId ?? null;
}

function bySize(a: CatalogPreset, b: CatalogPreset): number {
  return (
    a.resources.cpuMillicores - b.resources.cpuMillicores ||
    a.resources.memoryRequestMib - b.resources.memoryRequestMib ||
    a.resources.memoryLimitMib - b.resources.memoryLimitMib ||
    a.name.localeCompare(b.name)
  );
}

export function presetPodSettings(preset: CatalogPreset): PodSettings {
  return { presetId: preset.id, presetName: preset.name, ...preset.resources };
}

export function defaultPodSettings(catalog: PresetCatalog): PodSettings {
  const preset = catalog.presets.find((entry) => entry.id === catalog.defaultPresetId);
  return preset ? presetPodSettings(preset) : { presetId: null, presetName: null, ...JOB_POD_RESOURCES };
}

/** A stored choice seen by one Organization: its preset's current numbers, the stored numbers for Custom, the default for an unknown preset. */
export function podSettingsOn(stored: PodSettings | undefined, catalog: PresetCatalog): PodSettings {
  if (!stored) return defaultPodSettings(catalog);
  if (stored.presetId === null) return { ...resourcesOf(stored), presetId: null, presetName: null };
  const preset = catalog.presets.find((entry) => entry.id === stored.presetId);
  return preset ? presetPodSettings(preset) : defaultPodSettings(catalog);
}

export function podSettingsForSelection(selection: PodClassSelection, catalog: PresetCatalog): PodSettings {
  if (selection.presetId === null) return customPodSettings(selection);
  const preset = catalog.presets.find((entry) => entry.id === selection.presetId);
  if (!preset) throw new InvalidPodClassSelection(`Unknown preset ${String(selection.presetId)}`);
  return presetPodSettings(preset);
}

/**
 * Resources carried in an export, read by the importing Organization: a preset of the same name gives its numbers,
 * anything else is Custom at the carried numbers. Older bundles name the preset in `podClass`.
 */
export function podSettingsFromBundle(carried: unknown, catalog: PresetCatalog): PodSettings | null {
  if (typeof carried !== 'object' || carried === null) return null;
  const resources = carried as Partial<PodResources> & { presetName?: unknown; podClass?: unknown };
  const name =
    typeof resources.presetName === 'string'
      ? resources.presetName
      : typeof resources.podClass === 'string' && resources.podClass !== 'custom'
        ? resources.podClass
        : null;
  const preset = name ? catalog.presets.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) : undefined;
  if (preset) return presetPodSettings(preset);
  if (
    typeof resources.cpuMillicores !== 'number' ||
    typeof resources.memoryRequestMib !== 'number' ||
    typeof resources.memoryLimitMib !== 'number'
  ) {
    return null;
  }
  return customPodSettings({ presetId: null, ...resourcesOf(resources as PodResources) });
}

export interface PodClassCatalog {
  presets: { id: string; name: string; resources: PodResources; organization: boolean }[];
  defaultPresetId: string | null;
  customBounds: PodClassBounds;
}

export function podClassCatalog(catalog: PresetCatalog): PodClassCatalog {
  return {
    presets: catalog.presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      resources: preset.resources,
      organization: preset.tenantId !== null,
    })),
    defaultPresetId: catalog.defaultPresetId,
    customBounds: RESOURCE_BOUNDS,
  };
}
