import type { Field } from './fields.ts';
import { placedFieldsOf, type ValueField } from './form-levels.ts';
import type { InputSchema } from './input-schema.ts';
import { computeManifestHash } from './manifest-hash.ts';
import type { ServiceManifest } from './manifest.ts';
import { declaredHandlerNames } from './runtime.ts';

export const typesFileName = 'service.types.ts';

const reservedTypeNames = new Set(['Manifest', 'ServiceConfiguration', 'ProjectConfiguration', 'Secret']);

function singleQuoted(text: string): string {
  return `'${JSON.stringify(text).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`;
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : singleQuoted(name);
}

function literal(value: unknown): string {
  if (typeof value === 'string') return singleQuoted(value);
  return JSON.stringify(value) ?? 'undefined';
}

function union(types: string[]): string {
  const distinct = [...new Set(types)];
  if (distinct.length === 0) return 'never';
  return distinct.join(' | ');
}

function indent(text: string, depth: number): string {
  return text.replaceAll('\n', `\n${'  '.repeat(depth)}`);
}

function objectType(members: string[]): string {
  if (members.length === 0) return 'Record<string, never>';
  return `{\n  ${members.map((member) => indent(member, 1)).join('\n  ')}\n}`;
}

function defTypeNames(defs: Record<string, InputSchema>): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set(reservedTypeNames);
  for (const name of Object.keys(defs)) {
    const base = name.charAt(0).toUpperCase() + name.slice(1);
    let candidate = reservedTypeNames.has(base) ? `${base}Input` : base;
    for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base}${suffix}`;
    taken.add(candidate);
    names.set(name, candidate);
  }
  return names;
}

function schemaType(schema: InputSchema, defNames: Map<string, string>, filledByDefaults: boolean): string {
  if (schema.$ref !== undefined) return defNames.get(schema.$ref.slice('#/$defs/'.length)) ?? 'unknown';
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum) return union(schema.enum.map(literal));
  const alternatives = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  if (alternatives.length > 0) {
    return union(alternatives.map((alternative) => schemaType(alternative, defNames, filledByDefaults)));
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length === 0) return 'unknown';
  return union(
    types.map((type) => {
      switch (type) {
        case 'string':
          return 'string';
        case 'number':
        case 'integer':
          return 'number';
        case 'boolean':
          return 'boolean';
        case 'null':
          return 'null';
        case 'array': {
          const item = schema.items ? schemaType(schema.items, defNames, filledByDefaults) : 'unknown';
          return /^[A-Za-z0-9_]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
        }
        case 'object':
          return objectSchemaType(schema, defNames, filledByDefaults);
      }
    })
  );
}

function objectSchemaType(schema: InputSchema, defNames: Map<string, string>, filledByDefaults: boolean): string {
  const required = new Set(schema.required ?? []);
  const members = Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const present = required.has(name) || (filledByDefaults && property.default !== undefined);
    return `${propertyName(name)}${present ? '' : '?'}: ${schemaType(property, defNames, filledByDefaults)};`;
  });
  if (schema.additionalProperties === true || typeof schema.additionalProperties === 'object') {
    members.push('[key: string]: unknown;');
  }
  if (members.length === 0) return 'Record<string, unknown>';
  return objectType(members);
}

function optionLiterals(field: Extract<ValueField, { type: 'radio' | 'select' | 'multiselect' }>): string {
  return Array.isArray(field.options) ? union(field.options.map((option) => literal(option.value))) : 'string';
}

function fieldValueType(field: ValueField): string {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return 'string';
    case 'number':
      return 'number';
    case 'toggle':
      return 'boolean';
    case 'radio':
    case 'select':
      return optionLiterals(field);
    case 'multiselect': {
      const item = optionLiterals(field);
      return item === 'string' ? 'string[]' : `Array<${item}>`;
    }
    case 'secret':
      return 'Secret';
    case 'keyValue':
      return 'Record<string, string>';
    case 'list':
      return `Array<${formType(field.item, true)}>`;
  }
}

function formType(fields: readonly Field[] | undefined, listItem: boolean): string {
  const members = listItem ? ['id: string;'] : [];
  for (const { field, conditions } of placedFieldsOf(fields ?? [])) {
    if (field.type === 'info' || field.type === 'button') continue;
    const present = 'required' in field && field.required === true && conditions.length === 0;
    members.push(`${propertyName(field.key)}${present ? '' : '?'}: ${fieldValueType(field)};`);
  }
  return objectType(members);
}

function nameUnion(names: string[]): string {
  return union(names.map(literal));
}

export function generateServiceTypes(manifestJson: unknown, manifest: ServiceManifest): string {
  const defs = manifest.$defs ?? {};
  const defNames = defTypeNames(defs);
  const handlers = declaredHandlerNames(manifest);
  const usesSecret = JSON.stringify([manifest.serviceForm, manifest.projectForm]).includes('"type":"secret"');

  const operations = Object.entries(manifest.operations ?? {}).map(
    ([name, operation]) => `${propertyName(name)}: ${schemaType(operation.input, defNames, true)};`
  );
  const events = Object.entries(manifest.events ?? {}).map(
    ([type, event]) => `${propertyName(type)}: ${schemaType(event.data, defNames, false)};`
  );

  const lines = [
    '// Generated by `external-service-cli types` from service.json. Do not edit; run it again after changing service.json.',
    ...(usesSecret ? ["import type { Secret } from '@opsiforce/external-service-sdk';", ''] : []),
    `export const manifestHash = ${literal(computeManifestHash(manifestJson))};`,
    '',
    ...[...defNames].flatMap(([name, typeName]) => {
      const schema = defs[name];
      return schema ? [`export type ${typeName} = ${schemaType(schema, defNames, true)};`, ''] : [];
    }),
    `export type ServiceConfiguration = ${formType(manifest.serviceForm, false)};`,
    '',
    `export type ProjectConfiguration = ${formType(manifest.projectForm, false)};`,
    '',
    `export type Manifest = ${objectType([
      'manifestHash: typeof manifestHash;',
      `operations: ${operations.length === 0 ? 'Record<never, never>' : objectType(operations)};`,
      `events: ${events.length === 0 ? 'Record<never, never>' : objectType(events)};`,
      `options: ${nameUnion(handlers.options)};`,
      `info: ${nameUnion(handlers.info)};`,
      `buttons: ${nameUnion(handlers.buttons)};`,
      `bounds: ${nameUnion(Object.keys(manifest.bounds ?? {}))};`,
      `inbound: ${handlers.inbound};`,
      'serviceConfiguration: ServiceConfiguration;',
      'projectConfiguration: ProjectConfiguration;',
    ])};`,
    '',
  ];
  return lines.join('\n');
}
