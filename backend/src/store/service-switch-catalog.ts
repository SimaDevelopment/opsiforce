import type { Field, ServiceManifest } from '@opsiforce/external-service-sdk';
import { formValuesSchema, serviceSettingsFormOf, valueFieldsOf } from '@opsiforce/external-service-sdk/platform';
import type { AgentServiceSettings } from '../../db/schema';

export type ServiceSwitches = Pick<ServiceManifest, 'projectForm'>;

export interface SwitchableService {
  id: string;
  slug: string;
  displayName: string;
  manifest: ServiceSwitches;
}

export abstract class ServiceSwitchCatalog {
  abstract availableService(tenantId: string, externalServiceId: string): Promise<SwitchableService | null>;
}

export interface KeptServiceSettings {
  settings: AgentServiceSettings | null;
  dropped: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serviceSettingsFieldKeys(manifest: ServiceSwitches): string[] {
  return valueFieldsOf(serviceSettingsFormOf(manifest.projectForm ?? [])).map((field) => field.key);
}

export function settableFieldValues(manifest: ServiceSwitches, settings: AgentServiceSettings): AgentServiceSettings {
  const settable = new Set(serviceSettingsFieldKeys(manifest));
  return Object.fromEntries(Object.entries(settings).filter(([key]) => settable.has(key)));
}

function optional(form: readonly Field[]): Field[] {
  return form.map((field) => {
    if (field.type === 'section') return { ...field, fields: optional(field.fields) as typeof field.fields };
    return 'required' in field ? { ...field, required: false } : field;
  });
}

export function fieldValueSettingProblems(manifest: ServiceSwitches, values: Record<string, unknown>): string[] {
  const settable = serviceSettingsFieldKeys(manifest);
  const unknown = Object.keys(values).filter((key) => !settable.includes(key));
  if (unknown.length > 0) {
    return [`values names what isn't a setting of this service (unknown or picked per Project): ${unknown.join(', ')}`];
  }
  const parsed = formValuesSchema(optional(serviceSettingsFormOf(manifest.projectForm ?? []))).safeParse(values);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => `values.${issue.path.map(String).join('.')}: ${issue.message}`);
}

export function keptServiceSettings(manifest: ServiceSwitches, settings: AgentServiceSettings): KeptServiceSettings {
  const settable = new Set(serviceSettingsFieldKeys(manifest));
  return {
    settings: settableFieldValues(manifest, settings),
    dropped: Object.keys(settings).filter((key) => !settable.has(key)),
  };
}

export function settingsWithinGrants(
  manifest: ServiceSwitches,
  settings: AgentServiceSettings,
  grants: { canConfigureProjects: boolean }
): KeptServiceSettings {
  if (grants.canConfigureProjects) return { settings, dropped: [] };
  return { settings: null, dropped: Object.keys(settings) };
}

export function isAgentServiceSettings(value: unknown): value is AgentServiceSettings {
  return isPlainObject(value);
}
