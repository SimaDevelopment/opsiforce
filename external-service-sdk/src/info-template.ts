import type { Field } from './fields.ts';
import { eachKeyedField } from './form-levels.ts';

const templateVariablePattern = /\{\{\s*([^{}\s]+)\s*\}\}/g;

export function templateVariablesOf(template: string): string[] {
  return [...template.matchAll(templateVariablePattern)].map((match) => match[1] ?? '');
}

export function infoTemplateVariablesOf(form: readonly Field[] | undefined): string[] {
  const variables = new Set<string>();
  eachKeyedField(form, (field) => {
    if (field.type === 'info' && field.template !== undefined) {
      for (const variable of templateVariablesOf(field.template)) variables.add(variable);
    }
  });
  return [...variables];
}

export function renderInfoTemplate(template: string, valueOf: (variable: string) => string): string {
  let blank = false;
  const rendered = template.replace(templateVariablePattern, (_, variable: string) => {
    const value = valueOf(variable);
    if (value === '') blank = true;
    return value;
  });
  return blank ? '' : rendered;
}
