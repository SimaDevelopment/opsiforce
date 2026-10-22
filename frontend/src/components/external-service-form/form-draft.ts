import { createMemo, createSignal } from 'solid-js';
import { createStore, produce, unwrap } from 'solid-js/store';
import type { Field } from '@opsiforce/external-service-sdk/forms';
import {
  errorKeyOf,
  errorKeyOfPointer,
  isPlainValues,
  validateFormValues,
  type FieldPath,
  type FormValues,
} from './form-values';

export interface ServerIssue {
  pointer: string;
  message: string;
}

export interface FormDraft {
  values: FormValues;
  setAt: (path: FieldPath, value: unknown) => void;
  errorAt: (path: FieldPath) => string | undefined;
  isValid: () => boolean;
  isDirty: () => boolean;
  showAllErrors: () => void;
  showServerIssues: (issues: readonly ServerIssue[]) => void;
}

function cloneValues(values: FormValues): FormValues {
  return structuredClone(unwrap(values));
}

function readableIssue(message: string): string {
  if (/^(is|must|lists) /.test(message)) return `This ${message}.`;
  return `${message.charAt(0).toUpperCase()}${message.slice(1)}${message.endsWith('.') ? '' : '.'}`;
}

function setValueAt(target: FormValues, path: FieldPath, value: unknown): void {
  let scope: unknown = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const step = path[index];
    if (Array.isArray(scope) && typeof step === 'number') scope = scope[step];
    else if (isPlainValues(scope)) {
      const key = String(step);
      if (scope[key] === undefined) scope[key] = typeof path[index + 1] === 'number' ? [] : {};
      scope = scope[key];
    }
  }
  const last = path[path.length - 1];
  if (last === undefined) return;
  if (Array.isArray(scope) && typeof last === 'number') scope[last] = value;
  else if (isPlainValues(scope)) {
    if (value === undefined) delete scope[String(last)];
    else scope[String(last)] = value;
  }
}

export function createFormDraft(
  form: readonly Field[],
  initial: FormValues,
  missing: readonly string[] = []
): FormDraft {
  const [values, setValues] = createStore<FormValues>(cloneValues(initial));
  const baseline = JSON.stringify(initial);
  const [touched, setTouched] = createSignal<ReadonlySet<string>>(new Set());
  const needed: ReadonlySet<string> = new Set(missing);
  const [allShown, setAllShown] = createSignal(false);
  const [serverIssues, setServerIssues] = createSignal<ReadonlyMap<string, string>>(new Map());

  const errors = createMemo(() => validateFormValues(form, JSON.parse(JSON.stringify(values)) as FormValues));

  const errorAt = (path: FieldPath) => {
    const key = errorKeyOf(values, path);
    const server = serverIssues().get(key);
    if (server) return readableIssue(server);
    const issue = errors().get(key);
    if (!issue) return undefined;
    return allShown() || touched().has(key) || needed.has(key) ? readableIssue(issue) : undefined;
  };

  return {
    values,
    setAt: (path, value) => {
      const key = errorKeyOf(values, path);
      setValues(produce((draft) => setValueAt(draft, path, value)));
      setTouched((previous) => new Set(previous).add(key));
      if (serverIssues().has(key)) {
        setServerIssues((previous) => {
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      }
    },
    errorAt,
    isValid: () => errors().size === 0,
    isDirty: () => JSON.stringify(values) !== baseline,
    showAllErrors: () => setAllShown(true),
    showServerIssues: (issues) =>
      setServerIssues(new Map(issues.map((issue) => [errorKeyOfPointer(values, issue.pointer), issue.message]))),
  };
}
