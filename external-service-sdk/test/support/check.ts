import assert from 'node:assert/strict';

import { checkServiceManifest, type ManifestProblem } from '@opsiforce/external-service-sdk';

export function errorsOf(manifest: unknown): ManifestProblem[] {
  return checkServiceManifest(manifest).problems.filter((problem) => problem.severity === 'error');
}

export function assertRefused(manifest: unknown, path: string, message: RegExp): void {
  const errors = errorsOf(manifest);
  assert.ok(
    errors.some((error) => error.path === path && message.test(error.message)),
    `expected an error at ${path} matching ${message}, got ${JSON.stringify(errors, null, 2)}`
  );
}

export function assertAccepted(manifest: unknown): void {
  assert.deepEqual(errorsOf(manifest), []);
}
