import { operationDefaults, type Operation, type ServiceManifest } from './manifest.ts';
import type { ServiceRoute } from './runtime.ts';

export const formCallTimeoutSeconds = 10;

export interface OperationLimits {
  inputBytes: number;
  timeoutSeconds: number;
}

export function operationLimitsOf(operation: Operation | undefined): OperationLimits {
  return {
    inputBytes: operation?.limits?.inputBytes ?? operationDefaults.inputBytes,
    timeoutSeconds: operation?.limits?.timeoutSeconds ?? operationDefaults.timeoutSeconds,
  };
}

export function handlerTimeoutSeconds(manifest: ServiceManifest, route: ServiceRoute, name?: string): number {
  if (route === 'operations') return operationLimitsOf(manifest.operations?.[name ?? '']).timeoutSeconds;
  if (route === 'inbound') return operationDefaults.timeoutSeconds;
  return formCallTimeoutSeconds;
}
