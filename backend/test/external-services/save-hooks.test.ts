import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ServiceError } from '@opsiforce/external-service-sdk';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServiceCalls, externalServiceUsage } from '../../db/schema';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { Perms } from '../../src/permission/permission.constants';
import { addMember } from '../support/project-fixtures';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  tenantAdmin,
  platformOperator,
  type PersonFixture,
} from './support/fixtures';
import { dispatchToFakePod, type ServicePodFixture } from './support/gate';
import {
  channelsOf,
  configuringProject,
  discardProjectServiceHook,
  discardServiceConfigurationHook,
  forgetRecordedHooks,
  generatingBuiltInsDir,
  KEYS_SERVICE,
  platformServiceUrl,
  READY_KEYS,
  RECEIVING,
  readProjectService,
  retryProjectServiceHook,
  retryServiceConfigurationHook,
  rotateProjectService,
  rotateServiceConfiguration,
  saveProjectService,
  saveServiceConfiguration,
  recordedHook,
  type Revealed,
} from './support/generating';

const keysManifest = JSON.parse(
  readFileSync(join(generatingBuiltInsDir, KEYS_SERVICE, 'service.json'), 'utf8')
) as Record<string, unknown>;

async function hookCallsOf(serviceId: string, hook: string) {
  return db
    .select()
    .from(externalServiceCalls)
    .where(and(eq(externalServiceCalls.externalServiceId, serviceId), eq(externalServiceCalls.operation, hook)));
}

describe('after-save hooks, Rotate, Retry and Discard', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let operator: PersonFixture;
  let serviceId: string;
  let servicePod: ServicePodFixture | undefined;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ builtInsDir: generatingBuiltInsDir });
    app = harness.app;
    operator = await platformOperator(app);
    serviceId = await builtInServiceId(KEYS_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(KEYS_SERVICE);
    forgetRecordedHooks();
    await db.delete(externalServiceCalls).where(eq(externalServiceCalls.externalServiceId, serviceId));
  });

  afterEach(async () => {
    await servicePod?.stop();
    servicePod = undefined;
  });

  it('runs onServiceConfigurationSaved after the save with opened secrets and logs a hook Call', async () => {
    const first = await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().hookFailure).toBeNull();
    const revealed = first.json().revealed as Revealed[];
    const channels = channelsOf(first.json());

    expect(recordedHook('hooks/service')).toEqual({
      previous: null,
      current: ['Support', 'Sales'],
      webhookSecrets: channels.map(
        (channel) => revealed.find((entry) => entry.path === `channels.${channel.id}.webhookSecret`)?.value
      ),
    });

    await saveServiceConfiguration(app, operator, serviceId, {
      apiToken: '',
      channels: [{ id: channels[0]?.id, label: 'Support', token: '' }],
    });
    expect(recordedHook('hooks/service')).toMatchObject({
      previous: ['Support', 'Sales'],
      current: ['Support'],
    });

    const calls = await hookCallsOf(serviceId, 'onServiceConfigurationSaved');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ kind: 'hook', via: null, decision: 'allowed', status: 204, code: null });
    const usage = await db.select().from(externalServiceUsage).where(eq(externalServiceUsage.service, KEYS_SERVICE));
    expect(usage).toEqual([]);
  });

  it('keeps the saved values when the hook fails and answers "Saved, but" with what failed', async () => {
    const res = await saveServiceConfiguration(app, operator, serviceId, {
      ...READY_KEYS,
      apiToken: 'refused-upstream',
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      available: true,
      serviceConfiguration: { values: { apiToken: { stored: true } } },
      hookFailure: { code: 'upstream-refused', detail: 'The provider refused the webhook.' },
    });
    const reread = await app.inject({ method: 'GET', url: platformServiceUrl(serviceId), headers: operator.headers });
    expect(reread.json().hookFailure).toMatchObject({ code: 'upstream-refused' });
    const [call] = await hookCallsOf(serviceId, 'onServiceConfigurationSaved');
    expect(call).toMatchObject({ id: res.json().hookFailure.callId, status: 502, code: 'upstream-refused' });
  });

  it('re-runs a failed hook on Retry with the configuration the service last acknowledged', async () => {
    servicePod = await dispatchToFakePod(app, KEYS_SERVICE, { manifest: keysManifest });
    servicePod.pod.scriptHook('onServiceConfigurationSaved', () => {
      throw new ServiceError({ status: 502, code: 'upstream-unavailable', detail: 'Try later.' });
    });

    const failed = await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    expect(failed.json().hookFailure).toMatchObject({ code: 'upstream-unavailable' });
    const support = channelsOf(failed.json())[0];
    const second = await saveServiceConfiguration(app, operator, serviceId, {
      apiToken: '',
      channels: [{ id: support?.id, label: 'Support desk', token: '' }],
    });
    expect(second.json().hookFailure).toMatchObject({ code: 'upstream-unavailable' });

    servicePod.pod.scriptHook('onServiceConfigurationSaved', () => undefined);
    const retried = await retryServiceConfigurationHook(app, operator, serviceId);

    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().hookFailure).toBeNull();
    const hooks = servicePod.pod.receivedHooks;
    expect(hooks).toHaveLength(3);
    expect(hooks[1]?.previous).toBeNull();
    expect(hooks[2]).toMatchObject({
      hook: 'onServiceConfigurationSaved',
      previous: null,
      current: { apiToken: READY_KEYS.apiToken, channels: [{ label: 'Support desk', token: 'support-channel-token' }] },
    });
    const reread = await app.inject({ method: 'GET', url: platformServiceUrl(serviceId), headers: operator.headers });
    expect(reread.json().hookFailure).toBeNull();
  });

  it('rotates a generated secret on request, reveals the new value once and fires the hook', async () => {
    const saved = await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    const support = channelsOf(saved.json())[0];
    const before = (saved.json().revealed as Revealed[]).find((entry) =>
      entry.path.startsWith(`channels.${support?.id}`)
    );

    const rotated = await rotateServiceConfiguration(app, operator, serviceId, {
      field: 'webhookSecret',
      item: support?.id,
    });

    expect(rotated.statusCode, rotated.body).toBe(200);
    const revealed = rotated.json().revealed as Revealed[];
    expect(revealed).toHaveLength(1);
    expect(revealed[0]?.path).toBe(`channels.${support?.id}.webhookSecret`);
    expect(revealed[0]?.value).not.toBe(before?.value);
    expect(channelsOf(rotated.json()).map((channel) => channel.id)).toEqual(
      channelsOf(saved.json()).map((channel) => channel.id)
    );
    expect((recordedHook('hooks/service') as { webhookSecrets: string[] }).webhookSecrets[0]).toBe(revealed[0]?.value);
    expect(await hookCallsOf(serviceId, 'onServiceConfigurationSaved')).toHaveLength(2);
  });

  it('refuses to rotate a field the form does not generate', async () => {
    await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);

    const res = await rotateServiceConfiguration(app, operator, serviceId, { field: 'apiToken' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: 'urn:opsiforce:error:invalid-configuration',
      errors: [{ pointer: '/field', message: 'is not a generated field of this form' }],
    });
  });

  it('forgets a failed hook on Discard without calling the service again', async () => {
    const failed = await saveServiceConfiguration(app, operator, serviceId, {
      ...READY_KEYS,
      apiToken: 'refused-upstream',
    });
    expect(failed.json().hookFailure).toMatchObject({ code: 'upstream-refused' });

    const discarded = await discardServiceConfigurationHook(app, operator, serviceId);

    expect(discarded.statusCode, discarded.body).toBe(200);
    expect(discarded.json()).toMatchObject({
      serviceConfiguration: { values: { apiToken: { stored: true } } },
      hookFailure: null,
    });
    const reread = await app.inject({ method: 'GET', url: platformServiceUrl(serviceId), headers: operator.headers });
    expect(reread.json().hookFailure).toBeNull();
    expect(await hookCallsOf(serviceId, 'onServiceConfigurationSaved')).toHaveLength(1);
  });

  it('keeps Rotate, Retry and Discard of a Service configuration to platform operators', async () => {
    await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    const admin = await tenantAdmin(app);

    expect((await rotateServiceConfiguration(app, admin, serviceId, { field: 'signingSecret' })).statusCode).toBe(403);
    expect((await retryServiceConfigurationHook(app, admin, serviceId)).statusCode).toBe(403);
    expect((await discardServiceConfigurationHook(app, admin, serviceId)).statusCode).toBe(403);
  });

  describe('Project configurations', () => {
    beforeEach(async () => {
      await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    });

    it('runs onProjectConfigurationSaved with Receive and only the list items the configuration references', async () => {
      const project = await configuringProject(app);
      const read = await readProjectService(app, project, serviceId);
      const [support] = read.json().serviceConfigurationOptions[0].options as { value: string }[];

      const saved = await saveProjectService(app, project, serviceId, { ...RECEIVING, channel: support?.value });

      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().hookFailure).toBeNull();
      const localPart = saved.json().projectConfiguration.values.localPart as string;
      expect(recordedHook(`hooks/project/${project.projectEnvironmentId}`)).toEqual({
        previous: null,
        current: localPart,
        previousChannel: null,
        currentChannel: support?.value,
        receive: { 'message.received': true },
        channels: ['Support'],
      });
      const call = (await hookCallsOf(serviceId, 'onProjectConfigurationSaved')).find(
        (row) => row.projectEnvironmentId === project.projectEnvironmentId
      );
      expect(call).toMatchObject({
        kind: 'hook',
        status: 204,
        tenantId: project.tenant.tenantId,
        projectId: project.projectId,
        userId: project.configurer.userId,
      });
    });

    it('shows a failed Project hook as "Saved, but" until Retry succeeds', async () => {
      servicePod = await dispatchToFakePod(app, KEYS_SERVICE, { manifest: keysManifest });
      servicePod.pod.scriptHook('onProjectConfigurationSaved', () => {
        throw new ServiceError({ status: 409, code: 'address-in-use', detail: 'The provider already routes it.' });
      });
      const project = await configuringProject(app);

      const saved = await saveProjectService(app, project, serviceId, RECEIVING);
      expect(saved.statusCode).toBe(200);
      expect(saved.json().hookFailure).toMatchObject({ code: 'address-in-use' });
      expect((await readProjectService(app, project, serviceId)).json().hookFailure).toMatchObject({
        code: 'address-in-use',
      });

      servicePod.pod.scriptHook('onProjectConfigurationSaved', () => undefined);
      const retried = await retryProjectServiceHook(app, project, serviceId);
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().hookFailure).toBeNull();
      const [, retry] = servicePod.pod.receivedHooks;
      expect(retry).toMatchObject({
        hook: 'onProjectConfigurationSaved',
        previous: null,
        current: { receive: { 'message.received': true } },
        caller: { environmentId: project.projectEnvironmentId, via: 'form' },
      });
    });

    it('forgets a failed Project hook on Discard without calling the service again', async () => {
      servicePod = await dispatchToFakePod(app, KEYS_SERVICE, { manifest: keysManifest });
      servicePod.pod.scriptHook('onProjectConfigurationSaved', () => {
        throw new ServiceError({ status: 409, code: 'address-in-use', detail: 'The provider already routes it.' });
      });
      const project = await configuringProject(app);
      const saved = await saveProjectService(app, project, serviceId, RECEIVING);
      expect(saved.json().hookFailure).toMatchObject({ code: 'address-in-use' });

      const discarded = await discardProjectServiceHook(app, project, serviceId);

      expect(discarded.statusCode, discarded.body).toBe(200);
      expect(discarded.json().hookFailure).toBeNull();
      expect((await readProjectService(app, project, serviceId)).json().hookFailure).toBeNull();
      expect(servicePod.pod.receivedHooks).toHaveLength(1);
    });

    it('keeps Rotate, Retry and Discard of a Project configuration to its configurers', async () => {
      const project = await configuringProject(app);
      await saveProjectService(app, project, serviceId, RECEIVING);
      const member = { ...project, configurer: await addMember(app, project.tenant, [Perms.usePublicApi]) };

      expect((await rotateProjectService(app, member, serviceId, { field: 'localPart' })).statusCode).toBe(403);
      expect((await retryProjectServiceHook(app, member, serviceId)).statusCode).toBe(403);
      expect((await discardProjectServiceHook(app, member, serviceId)).statusCode).toBe(403);
    });

    it('rotates a generated Project form value and fires the hook with the old and new values', async () => {
      const project = await configuringProject(app);
      const saved = await saveProjectService(app, project, serviceId, RECEIVING);
      const before = saved.json().projectConfiguration.values.localPart as string;

      const rotated = await rotateProjectService(app, project, serviceId, { field: 'localPart' });

      expect(rotated.statusCode, rotated.body).toBe(200);
      const after = rotated.json().projectConfiguration.values.localPart as string;
      expect(after).toMatch(/^[a-z0-9]{16}$/);
      expect(after).not.toBe(before);
      expect(rotated.json().revealed).toEqual([]);
      expect(recordedHook(`hooks/project/${project.projectEnvironmentId}`)).toMatchObject({
        previous: before,
        current: after,
      });
    });
  });
});
