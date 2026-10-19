import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Perms } from '../../../src/permission/permission.constants';
import { addMember, type MemberFixture } from '../../support/project-fixtures';
import type { PersonFixture } from './fixtures';
import { evolvedBuiltIn, type EvolvedBuiltIns } from './evolved-built-ins';
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

export function failHooks(hooks: { service?: boolean; project?: boolean }): void {
  recordedHooks().set('fail/service', hooks.service === true);
  recordedHooks().set('fail/project', hooks.project === true);
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

export function fixtureKeysEvolved(edit: (manifest: Record<string, unknown>) => void): Promise<EvolvedBuiltIns> {
  return evolvedBuiltIn(generatingBuiltInsDir, KEYS_SERVICE, edit);
}
