import type { ManifestCheck, ManifestProblem, OperationKind } from '@opsiforce/external-service-sdk';
import { schemaInputsOf, type SchemaInput } from '@opsiforce/external-service-sdk/platform';

export interface CheckedOperation {
  name: string;
  kind: OperationKind;
  title?: string;
  inputs: SchemaInput[];
}

export interface CheckedEvent {
  type: string;
  title: string;
  inputs: SchemaInput[];
}

export interface CheckReport {
  ok: boolean;
  problems: ManifestProblem[];
  operations: CheckedOperation[];
  events: CheckedEvent[];
}

export function checkReportOf(check: ManifestCheck): CheckReport {
  const manifest = check.manifest;
  return {
    ok: check.ok,
    problems: check.problems,
    operations: Object.entries(manifest?.operations ?? {}).map(([name, operation]) => ({
      name,
      kind: operation.kind,
      ...(operation.title === undefined ? {} : { title: operation.title }),
      inputs: schemaInputsOf(operation.input, manifest?.$defs),
    })),
    events: Object.entries(manifest?.events ?? {}).map(([type, event]) => ({
      type,
      title: event.title,
      inputs: schemaInputsOf(event.data, manifest?.$defs),
    })),
  };
}
