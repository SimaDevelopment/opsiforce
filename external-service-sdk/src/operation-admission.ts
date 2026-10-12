import { createBoundsChecker, type LabelledBoundSite } from './bounds.ts';
import { isPlainObject } from './form-levels.ts';
import { operationLimitsOf } from './handler-limits.ts';
import { compileManifestValidators, type ManifestValidators } from './input-validators.ts';
import type { ServiceManifest } from './manifest.ts';
import { problem, type ProblemDetails } from './problems.ts';

export interface InputProblem {
  pointer: string;
  detail: string;
  rule: string;
}

export interface OperationCall {
  operation: string;
  input: unknown;
  inputBytes?: number;
  projectConfiguration: unknown;
  serviceConfiguration?: unknown;
}

export type OperationAdmission =
  | { admitted: true; input: unknown; touched: LabelledBoundSite[] }
  | { admitted: false; problem: ProblemDetails; touched?: LabelledBoundSite[] };

export interface OperationAdmissionGate {
  admit(call: OperationCall): OperationAdmission;
}

const encoder = new TextEncoder();

export function defaultOperationSwitches(manifest: ServiceManifest): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(manifest.operations ?? {}).map(([name, operation]) => [name, operation.kind === 'read'])
  );
}

export function operationSwitchedOn(projectConfiguration: unknown, operation: string): boolean {
  if (!isPlainObject(projectConfiguration)) return false;
  const switches = projectConfiguration.operations;
  return isPlainObject(switches) && switches[operation] === true;
}

export function inputBytesOf(input: unknown): number {
  return encoder.encode(JSON.stringify(input ?? {})).byteLength;
}

function refused(body: ProblemDetails): OperationAdmission {
  return { admitted: false, problem: body };
}

export function createOperationAdmission(
  manifest: ServiceManifest,
  validators: ManifestValidators = compileManifestValidators(manifest)
): OperationAdmissionGate {
  return {
    admit(call) {
      const { operation: name } = call;
      const operation = Object.hasOwn(manifest.operations ?? {}, name) ? manifest.operations?.[name] : undefined;
      const validate = validators.operations[name];
      if (!operation || !validate) {
        return refused(
          problem({
            status: 404,
            code: 'unknown-operation',
            detail: `This service has no Operation "${name}".`,
            operation: name,
          })
        );
      }

      if (!operationSwitchedOn(call.projectConfiguration, name)) {
        return refused(
          problem({
            status: 403,
            code: 'operation-off',
            detail: `The Operation "${name}" is switched off in this Project's configuration.`,
            operation: name,
          })
        );
      }

      const limit = operationLimitsOf(operation).inputBytes;
      const bytes = call.inputBytes ?? inputBytesOf(call.input);
      if (bytes > limit) {
        return refused(
          problem({
            status: 413,
            code: 'input-too-large',
            detail: `The input is ${bytes} bytes; "${name}" takes at most ${limit}.`,
            operation: name,
            limit,
          })
        );
      }

      const input = structuredClone(call.input ?? {});
      if (!validate(input)) {
        const errors: InputProblem[] = (validate.errors ?? []).map((error) => ({
          pointer: error.instancePath,
          detail: error.message ?? 'is invalid',
          rule: error.keyword,
        }));
        const first = errors[0];
        return refused(
          problem({
            status: 400,
            code: 'invalid-input',
            detail: first
              ? `The input does not fit "${name}": ${first.pointer === '' ? 'input' : first.pointer} ${first.detail}.`
              : `The input does not fit "${name}".`,
            operation: name,
            errors,
          })
        );
      }

      const bounds = createBoundsChecker({
        manifest,
        projectConfiguration: call.projectConfiguration,
        serviceConfiguration: call.serviceConfiguration,
        operation: name,
      });
      const outOfBounds = bounds.check({ operation: name }, input);
      const touched = bounds.touched({ operation: name }, input);
      if (outOfBounds) return { admitted: false, problem: outOfBounds, touched };

      return { admitted: true, input, touched };
    },
  };
}
