import type { Field, ServiceManifest } from '@opsiforce/external-service-sdk';
import {
  formValuesSchema,
  isTargetField,
  isWellFormedLabels,
  labelsKey,
  serviceSettingsFormOf,
  valueFieldsOf,
  wellFormedLabelsRule,
  type ValueLabels,
} from '@opsiforce/external-service-sdk/platform';
import type { AgentServiceSettings } from '../../db/schema';

export type SettableManifest = Pick<ServiceManifest, 'projectForm' | 'connectedByDefault'>;

export interface SettableService {
  id: string;
  slug: string;
  displayName: string;
  manifest: SettableManifest;
}

export interface ServiceConfigurationOption {
  value: string;
  label: string;
}

export interface ServiceConfigurationOptions {
  list: string;
  labelKey: string;
  options: ServiceConfigurationOption[];
}

export interface ProjectlessOptionsAnswer {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export abstract class ServiceSettingsCatalog {
  abstract availableServices(tenantId: string): Promise<SettableService[]>;
  abstract availableService(tenantId: string, externalServiceId: string): Promise<SettableService | null>;
  abstract tenantService(tenantId: string, externalServiceId: string): Promise<SettableService | null>;
  abstract serviceConfigurationOptions(
    tenantId: string,
    externalServiceId: string
  ): Promise<ServiceConfigurationOptions[]>;
  abstract callProjectlessOptions(
    tenantId: string,
    externalServiceId: string,
    name: string,
    body: unknown,
    askedBy: string
  ): Promise<ProjectlessOptionsAnswer>;
}

export interface KeptServiceSettings {
  settings: AgentServiceSettings | null;
  dropped: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function settingsFormOf(manifest: SettableManifest): Field[] {
  return serviceSettingsFormOf(manifest.projectForm ?? []);
}

export function serviceSettingsFieldKeys(manifest: SettableManifest): string[] {
  return valueFieldsOf(settingsFormOf(manifest)).map((field) => field.key);
}

export function settableFieldValues(manifest: SettableManifest, settings: AgentServiceSettings): AgentServiceSettings {
  const settable = new Set(serviceSettingsFieldKeys(manifest));
  return Object.fromEntries(Object.entries(settings).filter(([key]) => settable.has(key)));
}

export function settingLabels(manifest: SettableManifest, settings: AgentServiceSettings): ValueLabels {
  const labels = settings[labelsKey];
  if (!isWellFormedLabels(labels)) return {};
  const settable = new Set(valueFieldKeysWithin(settingsFormOf(manifest)));
  return Object.fromEntries(Object.entries(labels).filter(([key]) => settable.has(key)));
}

function valueFieldKeysWithin(form: readonly Field[]): string[] {
  return valueFieldsOf(form).flatMap((field) =>
    [field.key].concat(field.type === 'list' ? valueFieldKeysWithin(field.item) : [])
  );
}

function withLabels(manifest: SettableManifest, values: AgentServiceSettings, from: AgentServiceSettings) {
  const labels = settingLabels(manifest, from);
  return Object.keys(labels).length > 0 ? { ...values, [labelsKey]: labels } : values;
}

export function portableServiceSettings(
  manifest: SettableManifest,
  settings: AgentServiceSettings
): AgentServiceSettings | null {
  const portable = new Set(
    valueFieldsOf(settingsFormOf(manifest))
      .filter((field) => !isTargetField(field))
      .map((field) => field.key)
  );
  const kept = Object.fromEntries(Object.entries(settings).filter(([key]) => portable.has(key)));
  return Object.keys(kept).length > 0 ? kept : null;
}

function optional(form: readonly Field[]): Field[] {
  return form.map((field) => {
    if (field.type === 'section') return { ...field, fields: optional(field.fields) as typeof field.fields };
    return 'required' in field ? { ...field, required: false } : field;
  });
}

export function fieldValueSettingProblems(manifest: SettableManifest, values: Record<string, unknown>): string[] {
  const { [labelsKey]: labels, ...fieldValues } = values;
  if (labels !== undefined && !isWellFormedLabels(labels)) return [`values.${labelsKey} ${wellFormedLabelsRule}`];
  const settable = serviceSettingsFieldKeys(manifest);
  const unknown = Object.keys(fieldValues).filter((key) => !settable.includes(key));
  if (unknown.length > 0) {
    return [
      `values names what isn't a setting of this service (unknown, or a secret or generated value each Project gets its own): ${unknown.join(', ')}`,
    ];
  }
  const parsed = formValuesSchema(optional(settingsFormOf(manifest))).safeParse(fieldValues);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => `values.${issue.path.map(String).join('.')}: ${issue.message}`);
}

export function keptServiceSettings(manifest: SettableManifest, settings: AgentServiceSettings): KeptServiceSettings {
  const settable = new Set(serviceSettingsFieldKeys(manifest));
  return {
    settings: withLabels(manifest, settableFieldValues(manifest, settings), settings),
    dropped: Object.keys(settings).filter((key) => key !== labelsKey && !settable.has(key)),
  };
}

export function settingsWithinGrants(
  manifest: SettableManifest,
  settings: AgentServiceSettings,
  grants: { canConfigureProjects: boolean }
): KeptServiceSettings {
  if (grants.canConfigureProjects) return { settings, dropped: [] };
  return { settings: null, dropped: Object.keys(settings) };
}

export function isAgentServiceSettings(value: unknown): value is AgentServiceSettings {
  return isPlainObject(value);
}
