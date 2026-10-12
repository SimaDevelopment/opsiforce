import type { Field, OperationKind } from '@opsiforce/external-service-sdk';
import {
  renderInfoTemplate,
  serviceConfigurationSourceOf,
  visibleFieldKeys,
} from '@opsiforce/external-service-sdk/platform';
import { isListItem, isPlainValues, masked, type ConfigurationValues } from '../configuration/configuration-values';
import type { ProjectConfiguration, Switches, ValueLabels } from '../configuration/project-configuration.store';
import type { RegisteredService } from '../registry/service-registry';
import type { GateCaller } from './gate-caller';

export interface DescribedOperation {
  kind: OperationKind;
  title?: string;
  on: boolean;
}

export interface ServiceDescription {
  service: string;
  displayName: string;
  description: string;
  environment: { slug: string; name: string };
  manifestHash: string;
  complete: boolean;
  missing: string[];
  operations: Record<string, DescribedOperation>;
  receive: Switches;
  projectConfiguration: ConfigurationValues & { _labels: ValueLabels };
  info: Record<string, string>;
}

export interface DescriptionSources {
  service: RegisteredService;
  caller: GateCaller;
  projectConfiguration: ProjectConfiguration;
  serviceConfiguration: ConfigurationValues;
  webhookUrl: string | null;
}

type KeyedField = Exclude<Field, { type: 'section' }>;
type ChoiceField = Extract<Field, { type: 'select' | 'radio' | 'multiselect' }>;

function fieldsOutsideSections(form: readonly Field[]): KeyedField[] {
  return form.flatMap((field) => (field.type === 'section' ? fieldsOutsideSections(field.fields) : [field]));
}

function isChoiceField(field: KeyedField): field is ChoiceField {
  return field.type === 'select' || field.type === 'radio' || field.type === 'multiselect';
}

function chosenValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function plainText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function choiceLabel(field: ChoiceField, value: string, serviceConfiguration: ConfigurationValues): string | null {
  const { options } = field;
  if (Array.isArray(options)) return options.find((option) => option.value === value)?.label ?? null;
  const source = serviceConfigurationSourceOf(field);
  if (!source) return null;
  const items = serviceConfiguration[source.serviceConfiguration];
  const item = Array.isArray(items) ? items.find((entry) => isListItem(entry) && entry.id === value) : undefined;
  const label = isPlainValues(item) ? item[source.labelKey] : undefined;
  return typeof label === 'string' ? label : null;
}

function addChoiceLabels(
  labels: ValueLabels,
  fields: readonly KeyedField[],
  values: ConfigurationValues,
  serviceConfiguration: ConfigurationValues
): void {
  for (const field of fields) {
    if (field.type === 'list') {
      const items = Array.isArray(values[field.key]) ? (values[field.key] as unknown[]) : [];
      for (const item of items.filter(isPlainValues)) {
        addChoiceLabels(labels, fieldsOutsideSections(field.item as Field[]), item, serviceConfiguration);
      }
      continue;
    }
    if (!isChoiceField(field)) continue;
    for (const value of chosenValues(values[field.key])) {
      const label = choiceLabel(field, value, serviceConfiguration);
      if (label !== null) labels[field.key] = { ...labels[field.key], [value]: label };
    }
  }
}

function labelsOf(sources: DescriptionSources): ValueLabels {
  const labels: ValueLabels = {};
  addChoiceLabels(
    labels,
    fieldsOutsideSections(sources.service.manifest.projectForm ?? []),
    sources.projectConfiguration.values,
    sources.serviceConfiguration
  );
  for (const [field, byValue] of Object.entries(sources.projectConfiguration.labels)) {
    labels[field] = { ...labels[field], ...byValue };
  }
  return labels;
}

function renderedInfo(sources: DescriptionSources): Record<string, string> {
  const form = sources.service.manifest.projectForm ?? [];
  const values = sources.projectConfiguration.values;
  const fields = fieldsOutsideSections(form);
  const defaults = new Map(fields.map((field) => [field.key, 'default' in field ? field.default : undefined]));
  const visible = visibleFieldKeys(form, values);
  const variableValue = (variable: string): string => {
    if (variable === 'webhookUrl') return sources.webhookUrl ?? '';
    const serviceKey = /^serviceConfiguration\.(.+)$/.exec(variable)?.[1];
    if (serviceKey !== undefined) return plainText(sources.serviceConfiguration[serviceKey]);
    return plainText(values[variable] ?? defaults.get(variable));
  };
  const info: Record<string, string> = {};
  for (const field of fields) {
    if (field.type !== 'info' || field.template === undefined || !visible.has(field.key)) continue;
    info[field.key] = renderInfoTemplate(field.template, variableValue);
  }
  return info;
}

function describedOperations(sources: DescriptionSources): Record<string, DescribedOperation> {
  return Object.fromEntries(
    Object.entries(sources.service.manifest.operations ?? {}).map(([name, operation]) => [
      name,
      {
        kind: operation.kind,
        ...(operation.title === undefined ? {} : { title: operation.title }),
        on: sources.projectConfiguration.operations[name] === true,
      },
    ])
  );
}

export function describeService(sources: DescriptionSources): ServiceDescription {
  const { service, caller, projectConfiguration } = sources;
  return {
    service: service.slug,
    displayName: service.manifest.displayName,
    description: service.manifest.description,
    environment: { slug: caller.environment, name: caller.environmentName },
    manifestHash: service.manifestHash,
    complete: projectConfiguration.missing.length === 0,
    missing: projectConfiguration.missing,
    operations: describedOperations(sources),
    receive: projectConfiguration.receive,
    projectConfiguration: {
      ...masked(service.manifest.projectForm ?? [], projectConfiguration.values),
      _labels: labelsOf(sources),
    },
    info: renderedInfo(sources),
  };
}
