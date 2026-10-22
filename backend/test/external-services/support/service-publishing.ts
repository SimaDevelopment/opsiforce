import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TENANT_SERVICES } from './custom-services';
import type { PersonFixture } from './fixtures';

export function publishReview(
  app: NestFastifyApplication,
  admin: PersonFixture,
  serviceId: string,
  environmentId: string
) {
  return app.inject({
    method: 'GET',
    url: `${TENANT_SERVICES}/${serviceId}/publish?environmentId=${environmentId}`,
    headers: admin.headers,
  });
}

export function publishService(
  app: NestFastifyApplication,
  admin: PersonFixture,
  serviceId: string,
  payload: { environmentId: string; values?: Record<string, unknown>; copyFromDevelopment?: string[] },
  headers: Record<string, string> = admin.headers
) {
  return app.inject({ method: 'POST', url: `${TENANT_SERVICES}/${serviceId}/publish`, headers, payload });
}

export function defaultEnvironmentReview(
  app: NestFastifyApplication,
  admin: PersonFixture,
  serviceId: string,
  environmentId: string
) {
  return app.inject({
    method: 'GET',
    url: `${TENANT_SERVICES}/${serviceId}/default-environment?environmentId=${environmentId}`,
    headers: admin.headers,
  });
}

export function switchDefaultEnvironment(
  app: NestFastifyApplication,
  admin: PersonFixture,
  serviceId: string,
  payload: { environmentId: string; values?: Record<string, unknown>; copyFromDevelopment?: string[] }
) {
  return app.inject({
    method: 'PUT',
    url: `${TENANT_SERVICES}/${serviceId}/default-environment`,
    headers: admin.headers,
    payload,
  });
}

export function serviceEnvironments(app: NestFastifyApplication, admin: PersonFixture, serviceId: string) {
  return app.inject({
    method: 'GET',
    url: `${TENANT_SERVICES}/${serviceId}/environments`,
    headers: admin.headers,
  });
}

const run = promisify(execFile);

function git(workspace: string, args: string[]) {
  return run('git', ['-c', 'user.email=builder@test.local', '-c', 'user.name=Builder', ...args], { cwd: workspace });
}

/** A git checkout of the builder's workspace, as the template's initial commit leaves it. */
export async function committedWorkspace(workspace: string): Promise<string> {
  await writeFile(join(workspace, '.gitignore'), '.cache/\n');
  await git(workspace, ['init', '-q']);
  await git(workspace, ['add', '-A']);
  await git(workspace, ['commit', '-q', '-m', 'service']);
  return (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
}

export async function writeTestReport(workspace: string, report: unknown): Promise<void> {
  await mkdir(join(workspace, '.cache'), { recursive: true });
  await writeFile(join(workspace, '.cache', 'service-test-report.json'), JSON.stringify(report));
}
