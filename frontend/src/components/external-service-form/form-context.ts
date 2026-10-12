import { serviceConfigurationSourceOf, type Field } from '@opsiforce/external-service-sdk/forms';
import type { FormDraft } from './form-draft';
import type { FormValues } from './form-values';

export interface FieldOption {
  value: string;
  label: string;
  description?: string;
}

export type FormCallRoute = 'options' | 'info' | 'buttons';

export interface FormCallRequest {
  query?: string;
  item?: string;
}

export type MessageLevel = 'info' | 'success' | 'warning' | 'error';

export interface InfoResult {
  text: string;
  level?: MessageLevel;
}

export type ButtonResult =
  | { message: string; level?: MessageLevel }
  | { image: { mimeType: string; base64: string }; caption?: string }
  | { link: string; label?: string };

export interface RotateTarget {
  field: string;
  item?: string;
}

export type ServiceCaller = (route: FormCallRoute, name: string, request: FormCallRequest) => Promise<unknown>;

export interface FormContext {
  draft: FormDraft;
  readOnly: () => boolean;
  templateValues: () => FormValues;
  serviceConfigurationOptions: (listKey: string, labelKey: string) => FieldOption[];
  storedLabel: (fieldKey: string, value: string) => string | undefined;
  callService?: ServiceCaller;
  seenOptions?: (fieldKey: string, options: readonly FieldOption[]) => void;
  revealed?: () => ReadonlyMap<string, string>;
  rotate?: (target: RotateTarget) => Promise<void>;
  pendingGeneratedText?: () => string;
}

export function fixedOptionsOf(
  field: Extract<Field, { type: 'select' | 'multiselect' | 'radio' }>,
  ctx: FormContext
): FieldOption[] | null {
  const listed = field.options;
  if (Array.isArray(listed)) return listed;
  const source = serviceConfigurationSourceOf(field);
  return source ? ctx.serviceConfigurationOptions(source.serviceConfiguration, source.labelKey) : null;
}
