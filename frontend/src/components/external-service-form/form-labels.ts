import { valueFieldsOf, type Field } from '@opsiforce/external-service-sdk/forms';
import { createStore, produce } from 'solid-js/store';
import { ApiError } from '~/api/client';
import type { FieldOption } from './form-context';
import { isPlainValues, type FormValues } from './form-values';

export type ValueLabels = Record<string, Record<string, string>>;

function callSourcedSelections(fields: readonly Field[], values: FormValues, selections: Map<string, Set<string>>) {
  for (const field of valueFieldsOf(fields)) {
    const value = values[field.key];
    if (field.type === 'list') {
      if (Array.isArray(value)) {
        for (const item of value) if (isPlainValues(item)) callSourcedSelections(field.item, item, selections);
      }
      continue;
    }
    if (!('options' in field) || Array.isArray(field.options) || !('call' in field.options)) continue;
    const picked = selections.get(field.key) ?? new Set<string>();
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry === 'string' && entry !== '') picked.add(entry);
    }
    selections.set(field.key, picked);
  }
}

export interface LabelBook {
  storedLabel: (fieldKey: string, value: string) => string | undefined;
  seenOptions: (fieldKey: string, options: readonly FieldOption[]) => void;
  labelsFor: (values: FormValues) => ValueLabels;
}

export function createLabelBook(form: readonly Field[], stored: ValueLabels): LabelBook {
  const [seen, setSeen] = createStore<ValueLabels>({});
  const labelOf = (fieldKey: string, value: string) => seen[fieldKey]?.[value] ?? stored[fieldKey]?.[value];
  return {
    storedLabel: labelOf,
    seenOptions: (fieldKey, options) =>
      setSeen(
        produce((book) => {
          const labels = (book[fieldKey] ??= {});
          for (const option of options) labels[option.value] = option.label;
        })
      ),
    labelsFor: (values) => {
      const selections = new Map<string, Set<string>>();
      callSourcedSelections(form, values, selections);
      const labels: ValueLabels = {};
      for (const [fieldKey, picked] of selections) {
        const known = [...picked].flatMap((value) => {
          const label = labelOf(fieldKey, value);
          return label === undefined ? [] : [[value, label] as const];
        });
        if (known.length > 0) labels[fieldKey] = Object.fromEntries(known);
      }
      return labels;
    },
  };
}

export function formCallFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.details?.detail;
    if (typeof detail === 'string' && detail !== '') return detail;
    if (error.status === 502 && error.code === 'timeout') return 'The service did not answer in time.';
  }
  return "The service couldn't be asked right now.";
}
