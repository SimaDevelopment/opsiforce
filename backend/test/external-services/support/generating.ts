import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Perms } from '../../../src/permission/permission.constants';
import { addMember, type MemberFixture } from '../../support/project-fixtures';
import type { PersonFixture } from './fixtures';
import { gateCaller, type GateCallerFixture } from './gate';

export const generatingBuiltInsDir = resolve(__dirname, 'generating-built-ins');
export const KEYS_SERVICE = 'fixture-keys';

export const READY_KEYS = {
  apiToken: 'keys-api-token',
  channels: [
    { label: 'Support', token: 'support-channel-token' },
    { label: 'Sales', token: 'sales-channel-token' },
  ],
};

export interface Revealed {
  path: string;
  value: string;
}

export interface ChannelView {
  id: string;
  label: string;
  token: unknown;
  webhookSecret?: unknown;
  inboxKey?: string;
}

export function platformServiceUrl(serviceId: string): string {
  return `/api/external-services/platform/services/${serviceId}`;
}

export function saveServiceConfiguration(
  app: NestFastifyApplication,
  operator: PersonFixture,
  serviceId: string,
  values: Record<string, unknown>
) {
  return app.inject({
    method: 'PUT',
    url: `${platformServiceUrl(serviceId)}/configuration`,
    headers: operator.headers,
    payload: { values },
  });
}

export function rotateServiceConfiguration(
  app: NestFastifyApplication,
  operator: PersonFixture,
  serviceId: string,
  target: { field: string; item?: string }
) {
  return app.inject({
    method: 'POST',
    url: `${platformServiceUrl(serviceId)}/configuration/rotate`,
    headers: operator.headers,
    payload: target,
  });
}

export function retryServiceConfigurationHook(app: NestFastifyApplication, operator: PersonFixture, serviceId: string) {
  return app.inject({
    method: 'POST',
    url: `${platformServiceUrl(serviceId)}/configuration/hook/retry`,
    headers: operator.headers,
  });
}

export function discardServiceConfigurationHook(
  app: NestFastifyApplication,
  operator: PersonFixture,
  serviceId: string
) {
  return app.inject({
    method: 'POST',
    url: `${platformServiceUrl(serviceId)}/configuration/hook/discard`,
    headers: operator.headers,
  });
}

export function channelsOf(view: { serviceConfiguration: { values: Record<string, unknown> } }): ChannelView[] {
  return (view.serviceConfiguration.values.channels ?? []) as ChannelView[];
}

function recordedHooks(): Map<string, unknown> {
  return ((globalThis as Record<symbol, unknown>)[Symbol.for('opsiforce.test.fixture-keys.hooks')] ??= new Map<
    string,
    unknown
  >()) as Map<string, unknown>;
}

export function recordedHook(key: string): unknown {
  return recordedHooks().get(key);
}

export function forgetRecordedHooks(): void {
  recordedHooks().clear();
}

export interface ConfiguringProject extends GateCallerFixture {
  configurer: MemberFixture;
}

export async function configuringProject(app: NestFastifyApplication): Promise<ConfiguringProject> {
  const caller = await gateCaller(app);
  return { ...caller, configurer: await addMember(app, caller.tenant, [Perms.configureProjectExternalServices]) };
}

export function projectServiceUrl(project: GateCallerFixture, serviceId: string): string {
  return `/api/external-services/projects/${project.projectId}/environments/${project.projectEnvironmentId}/services/${serviceId}`;
}

export function readProjectService(app: NestFastifyApplication, project: ConfiguringProject, serviceId: string) {
  return app.inject({
    method: 'GET',
    url: projectServiceUrl(project, serviceId),
    headers: project.configurer.headers,
  });
}

export function saveProjectService(
  app: NestFastifyApplication,
  project: ConfiguringProject,
  serviceId: string,
  values: Record<string, unknown>
) {
  return app.inject({
    method: 'PUT',
    url: `${projectServiceUrl(project, serviceId)}/configuration`,
    headers: project.configurer.headers,
    payload: { values },
  });
}

export function rotateProjectService(
  app: NestFastifyApplication,
  project: ConfiguringProject,
  serviceId: string,
  target: { field: string; item?: string }
) {
  return app.inject({
    method: 'POST',
    url: `${projectServiceUrl(project, serviceId)}/configuration/rotate`,
    headers: project.configurer.headers,
    payload: target,
  });
}

export function retryProjectServiceHook(app: NestFastifyApplication, project: ConfiguringProject, serviceId: string) {
  return app.inject({
    method: 'POST',
    url: `${projectServiceUrl(project, serviceId)}/configuration/hook/retry`,
    headers: project.configurer.headers,
  });
}

export function discardProjectServiceHook(app: NestFastifyApplication, project: ConfiguringProject, serviceId: string) {
  return app.inject({
    method: 'POST',
    url: `${projectServiceUrl(project, serviceId)}/configuration/hook/discard`,
    headers: project.configurer.headers,
  });
}

export const RECEIVING = { receive: { 'message.received': true } };

export interface EvolvedKeys {
  dir: string;
  remove(): Promise<void>;
}

export async function fixtureKeysEvolved(edit: (manifest: Record<string, unknown>) => void): Promise<EvolvedKeys> {
  const dir = await mkdtemp(join(tmpdir(), 'evolved-keys-'));
  const folder = join(dir, KEYS_SERVICE);
  await mkdir(folder);
  const manifest = JSON.parse(
    await readFile(join(generatingBuiltInsDir, KEYS_SERVICE, 'service.json'), 'utf8')
  ) as Record<string, unknown>;
  edit(manifest);
  await writeFile(join(folder, 'service.json'), JSON.stringify(manifest, null, 2));
  await writeFile(
    join(folder, 'handlers.ts'),
    `export default {
  manifestHash: ${JSON.stringify(computeManifestHash(manifest))},
  operations: { send_message: (input) => input },
  inbound: () => ({ events: [] }),
};
`
  );
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}
