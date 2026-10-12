import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DispatchRequest } from '@opsiforce/external-service-sdk/server';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ServiceDispatcher } from '../../src/external-services/gate/service-dispatcher';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration, platformOperator } from './support/fixtures';
import {
  callOperation,
  configurePlatformService,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
} from './support/gate';
import {
  configuringProject,
  generatingBuiltInsDir,
  KEYS_SERVICE,
  READY_KEYS,
  RECEIVING,
  readProjectService,
  saveProjectService,
  saveServiceConfiguration,
} from './support/generating';
import { Perms } from '../../src/permission/permission.constants';
import { addMember } from '../support/project-fixtures';

const wireFolder = resolve(__dirname, '../../../external-service-sdk/test/compat/wire');

const VOLATILE_IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|li_[0-9a-f]{16}/g;

const GENERATED_KEYS = new Set(['signingSecret', 'webhookSecret', 'inboxKey', 'localPart']);

type Dispatch = MockInstance<ServiceDispatcher['dispatch']>;

function normalized(value: unknown, ids: Map<string, string>, key = ''): unknown {
  if (GENERATED_KEYS.has(key) && typeof value === 'string') return `<generated ${key}>`;
  if (typeof value === 'string') {
    return value.replaceAll(VOLATILE_IDS, (id) => {
      const stand = String(ids.size + 1).padStart(12, '0');
      if (!ids.has(id)) ids.set(id, id.startsWith('li_') ? `li_0000${stand}` : `00000000-0000-4000-8000-${stand}`);
      return ids.get(id) as string;
    });
  }
  if (Array.isArray(value)) return value.map((entry) => normalized(entry, ids));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, normalized(entry, ids, name)]));
  }
  return value;
}

function golden(dispatch: Dispatch, route: DispatchRequest['route']): string {
  const [service, request] = dispatch.mock.calls.findLast(([, sent]) => sent.route === route) ?? [];
  if (!service || !request) throw new Error(`The Gate dispatched no ${route} request`);
  const { name, body } = request;
  const captured = { service: service.slug, route, ...(name === undefined ? {} : { name }), body };
  return `${JSON.stringify(normalized(captured, new Map()), null, 2)}\n`;
}

describe('the wire requests the Gate sends, one golden per /_service route', () => {
  describe('Operations and form calls of a configured service', () => {
    let harness: ExternalServicesTestApp;
    let app: NestFastifyApplication;
    let dispatch: Dispatch;

    beforeAll(async () => {
      harness = await createExternalServicesTestApp();
      app = harness.app;
      dispatch = vi.spyOn(app.get(ServiceDispatcher), 'dispatch');
      await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    });

    afterAll(async () => {
      await harness.close();
    });

    it('operations, options, info and buttons', async () => {
      const [support] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM)) as [string];
      const caller = await gateCaller(app);
      await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
        mailbox: support,
        accountsMode: 'all',
      });
      const configurer = await addMember(app, caller.tenant, [Perms.configureProjectExternalServices]);
      const serviceId = await builtInServiceId(FIXTURE_SERVICE);
      const formCall = (route: string, name: string, payload: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url: `/api/external-services/projects/${caller.projectId}/environments/${caller.projectEnvironmentId}/services/${serviceId}/${route}/${name}`,
          headers: configurer.headers,
          payload,
        });

      const operation = await callOperation(app, {
        key: caller.key,
        slug: FIXTURE_SERVICE,
        operation: 'get_account',
        input: { accountId: 'acc_1' },
      });
      const options = await formCall('options', 'listAccounts', { values: { mailbox: support }, query: 'glo' });
      const info = await formCall('info', 'accountsSummary', { values: { mailbox: support, accountIds: ['acc_1'] } });
      const button = await formCall('buttons', 'sendInvite', { values: { mailbox: support } });

      expect([operation, options, info, button].map((res) => res.statusCode)).toEqual([200, 200, 200, 200]);
      for (const route of ['operations', 'options', 'info', 'buttons'] as const) {
        await expect(golden(dispatch, route)).toMatchFileSnapshot(`${wireFolder}/${route}.json`);
      }
    });
  });

  describe('save hooks and inbound of a service that has them', () => {
    let harness: ExternalServicesTestApp;
    let app: NestFastifyApplication;
    let dispatch: Dispatch;

    beforeAll(async () => {
      harness = await createExternalServicesTestApp({ builtInsDir: generatingBuiltInsDir });
      app = harness.app;
      dispatch = vi.spyOn(app.get(ServiceDispatcher), 'dispatch');
      await forgetPlatformServiceConfiguration(KEYS_SERVICE);
    });

    afterAll(async () => {
      await harness.close();
    });

    it('hooks and inbound', async () => {
      const serviceId = await builtInServiceId(KEYS_SERVICE);
      const saved = await saveServiceConfiguration(app, await platformOperator(app), serviceId, READY_KEYS);
      const project = await configuringProject(app);
      const read = await readProjectService(app, project, serviceId);
      const [support] = read.json().serviceConfigurationOptions[0].options as { value: string }[];
      const projectSaved = await saveProjectService(app, project, serviceId, { ...RECEIVING, channel: support?.value });
      const webhook = await app.inject({
        method: 'POST',
        url: `/api/external-services/webhooks/${KEYS_SERVICE}`,
        headers: { 'content-type': 'application/json', 'x-provider-signature': 'sig-1' },
        payload: JSON.stringify({ messages: [{ id: 'm-1', text: 'Hello' }] }),
      });

      expect([saved, projectSaved, webhook].map((res) => res.statusCode)).toEqual([200, 200, 200]);
      await expect(golden(dispatch, 'hooks')).toMatchFileSnapshot(`${wireFolder}/hooks.json`);
      await expect(golden(dispatch, 'inbound')).toMatchFileSnapshot(`${wireFolder}/inbound.json`);
    });
  });
});
