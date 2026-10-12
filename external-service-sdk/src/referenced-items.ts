import type { Field } from './fields.ts';
import { isPlainObject, serviceConfigurationSourceOf, valueFieldsOf, type FormValues } from './form-levels.ts';

type ReferencedItems = Map<string, Set<string>>;

function collectReferences(form: readonly Field[], values: FormValues, references: ReferencedItems): void {
  for (const field of valueFieldsOf(form)) {
    const value = values[field.key];
    if (field.type === 'list' && Array.isArray(value)) {
      for (const item of value) {
        if (isPlainObject(item)) collectReferences(field.item, item, references);
      }
      continue;
    }
    const list = serviceConfigurationSourceOf(field)?.serviceConfiguration;
    if (list === undefined) continue;
    const ids = references.get(list) ?? new Set<string>();
    for (const id of Array.isArray(value) ? value : [value]) {
      if (typeof id === 'string') ids.add(id);
    }
    references.set(list, ids);
  }
}

export function trimmedToReferencedItems(
  projectForm: readonly Field[] | undefined,
  serviceConfiguration: FormValues,
  ...projectConfigurations: FormValues[]
): FormValues {
  const references: ReferencedItems = new Map();
  for (const projectConfiguration of projectConfigurations) {
    collectReferences(projectForm ?? [], projectConfiguration, references);
  }
  const trimmed: FormValues = { ...serviceConfiguration };
  for (const [list, ids] of references) {
    const items = trimmed[list];
    if (Array.isArray(items)) {
      trimmed[list] = items.filter((item) => isPlainObject(item) && typeof item.id === 'string' && ids.has(item.id));
    }
  }
  return trimmed;
}
