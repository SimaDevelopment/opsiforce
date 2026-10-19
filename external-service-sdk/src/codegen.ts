import type { Field } from './fields.ts';
import { placedFieldsOf, type ValueField } from './form-levels.ts';

export const typesFileName = 'service.types.ts';

export function singleQuoted(text: string): string {
  return `'${JSON.stringify(text).slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`;
}

export function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : singleQuoted(name);
}

export function literal(value: unknown): string {
  if (typeof value === 'string') return singleQuoted(value);
  return JSON.stringify(value) ?? 'undefined';
}

export function union(types: string[]): string {
  const distinct = [...new Set(types)];
  if (distinct.length === 0) return 'never';
  return distinct.join(' | ');
}

function indent(text: string, depth: number): string {
  return text.replaceAll('\n', `\n${'  '.repeat(depth)}`);
}

export function objectType(members: string[]): string {
  if (members.length === 0) return 'Record<string, never>';
  return `{\n  ${members.map((member) => indent(member, 1)).join('\n  ')}\n}`;
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

export function formType(fields: readonly Field[] | undefined, listItem: boolean): string {
  const members = listItem ? ['id: string;'] : [];
  for (const { field, conditions } of placedFieldsOf(fields ?? [])) {
    if (field.type === 'info' || field.type === 'button') continue;
    const present = 'required' in field && field.required === true && conditions.length === 0;
    members.push(`${propertyName(field.key)}${present ? '' : '?'}: ${fieldValueType(field)};`);
  }
  return objectType(members);
}

export function nameUnion(names: string[]): string {
  return union(names.map(literal));
}
