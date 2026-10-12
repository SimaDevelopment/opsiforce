import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Perms } from '../../src/permission/permission.constants';
import { addMember, createProject, createTenant, type MemberFixture } from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { microsecondTimestamps, stageCalls } from './support/call-log';
import { createCustomService, ensureExternalServiceBuilder } from './support/custom-services';
import { builtInServiceId, forgetPlatformServiceConfiguration } from './support/fixtures';
import { productionEnvironmentOf } from './support/published-services';
import {
  callOperation,
  configurePlatformService,
  gateCaller,
  mailboxIds,
  productionCaller,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  type GateCallerFixture,
} from './support/gate';

interface ListedCall {
  callId: string;
  createdAt: string;
  kind: string;
  via: string | null;
  operation: string | null;
  outcome: 'allowed' | 'refused' | 'failed';
  status: number;
  code: string | null;
  bounds: { bound: string; value: unknown; label?: string }[] | null;
  serviceId: string | null;
  slug: string;
  tenantId: string | null;
  tenantName: string | null;
  projectId: string | null;
  projectTitle: string | null;
  projectEnvironmentId: string | null;
  environmentName: string | null;
  servedBy: string | null;
}

interface CallPage {
  calls: ListedCall[];
  retentionDays: number;
  newer: string | null;
  older: string | null;
}

function unique(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

describe('Call log readers', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let serviceId: string;
  let mailbox: string;
  let caller: GateCallerFixture;
  let member: MemberFixture;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    serviceId = await builtInServiceId(FIXTURE_SERVICE);
    await ensureExternalServiceBuilder();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    [mailbox] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM)) as [string];
    caller = await gateCaller(app);
    await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, { mailbox, accountsMode: 'all' });
    member = await addMember(app, caller.tenant, [Perms.usePublicApi]);
  });

  function read(url: string, person: { headers: Record<string, string> }) {
    return app.inject({ method: 'GET', url: `/api/external-services/${url}`, headers: person.headers });
  }

  async function page(url: string, person: { headers: Record<string, string> }): Promise<CallPage> {
    const res = await read(url, person);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<CallPage>();
  }

  function environmentCalls(environment = caller, query = ''): string {
    return `projects/${environment.projectId}/environments/${environment.projectEnvironmentId}/services/${serviceId}/calls${query}`;
  }

  function call(environment: GateCallerFixture, operation: string, input: unknown) {
    return callOperation(app, { key: environment.key, slug: FIXTURE_SERVICE, operation, input });
  }

  function stageFor(environment: GateCallerFixture, rows: Parameters<typeof stageCalls>[0]) {
    return stageCalls(
      rows.map((row) => ({
        externalServiceId: serviceId,
        tenantId: environment.tenant.tenantId,
        projectId: environment.projectId,
        projectTitle: environment.projectTitle,
        projectEnvironmentId: environment.projectEnvironmentId,
        ...row,
      }))
    );
  }

  describe('Calls for this environment, for anyone who can open the Project', () => {
    it('lists the environment’s Calls to the service newest first, metadata only', async () => {
      const production = await productionCaller(app, caller);
      await saveProjectConfiguration(app, FIXTURE_SERVICE, production.projectEnvironmentId, { mailbox });
      const allowed = await call(caller, 'get_account', { accountId: 'acc_1' });
      const refused = await call(caller, 'delete_account', { accountId: 'acc_1' });
      await call(production, 'get_account', { accountId: 'acc_9' });

      const { calls, newer, older } = await page(environmentCalls(), member);

      expect(calls.map(({ operation, outcome, status }) => [operation, outcome, status])).toEqual([
        ['delete_account', 'refused', 403],
        ['get_account', 'allowed', 200],
      ]);
      expect(calls[0]).toMatchObject({
        callId: refused.json().callId,
        kind: 'operation',
        via: 'agent',
        code: 'operation-off',
        serviceId,
        slug: FIXTURE_SERVICE,
        tenantId: caller.tenant.tenantId,
        projectId: caller.projectId,
        projectTitle: caller.projectTitle,
        projectEnvironmentId: caller.projectEnvironmentId,
        environmentName: 'Development',
      });
      expect(JSON.stringify(calls)).not.toContain('"input"');
      expect(allowed.statusCode).toBe(200);
      expect([newer, older]).toEqual([null, null]);
      expect((await page(environmentCalls(), member)).retentionDays).toBe(30);
    });

    it('names the environment that served each Call, and none for a built-in', async () => {
      const [servedByProduction, servedInProcess] = await stageFor(caller, [
        { operation: 'list_cards', serviceEnvironmentId: await productionEnvironmentOf(caller.tenant.tenantId) },
        { operation: 'get_account' },
      ]);

      const { calls } = await page(environmentCalls(), member);

      expect(calls.find((row) => row.callId === servedByProduction)?.servedBy).toBe('Production');
      expect(calls.find((row) => row.callId === servedInProcess)?.servedBy).toBeNull();
    });

    it('pages 25 at a time, Older then Newer, without losing rows that share a millisecond', async () => {
      const timestamps = microsecondTimestamps(31);
      const staged = await stageFor(
        caller,
        timestamps.map((createdAt, index) => ({ createdAt, operation: `op_${String(index).padStart(2, '0')}` }))
      );
      const newestFirst = staged.toReversed();

      const first = await page(environmentCalls(), member);
      expect(first.calls.map((row) => row.callId)).toEqual(newestFirst.slice(0, 25));
      expect(first.newer).toBeNull();
      expect(first.older).toEqual(expect.any(String));

      const second = await page(environmentCalls(caller, `?older=${first.older}`), member);
      expect(second.calls.map((row) => row.callId)).toEqual(newestFirst.slice(25));
      expect(second.older).toBeNull();
      expect(second.newer).toEqual(expect.any(String));

      const back = await page(environmentCalls(caller, `?newer=${second.newer}`), member);
      expect(back.calls.map((row) => row.callId)).toEqual(newestFirst.slice(0, 25));
      expect(back.newer).toBeNull();
      expect(back.older).toEqual(expect.any(String));
    });

    it('searches by Operation or bound value and filters Allowed / Refused / Failed', async () => {
      const [createCard, refusedBoard, failedMove, plain] = await stageFor(caller, [
        {
          operation: 'create_card',
          bounds: [{ bound: 'board', pointer: '/boardId', value: 'b_1', label: 'Launch plan' }],
        },
        {
          operation: 'list_cards',
          decision: 'refused',
          status: 403,
          code: 'out-of-bounds',
          bounds: [{ bound: 'board', pointer: '/boardId', value: 'b_9', label: 'Events 2026' }],
        },
        { operation: 'move_card', status: 502, code: 'service-failed' },
        { operation: 'list_cards' },
      ]);
      const ids = async (query: string) =>
        (await page(environmentCalls(caller, query), member)).calls.map((row) => row.callId).toSorted();

      expect(await ids('?q=create')).toEqual([createCard]);
      expect(await ids('?q=launch')).toEqual([createCard]);
      expect(await ids('?q=b_9')).toEqual([refusedBoard]);
      expect(await ids('?q=list_cards')).toEqual([refusedBoard, plain].toSorted());
      expect(await ids('?outcome=refused')).toEqual([refusedBoard]);
      expect(await ids('?outcome=failed')).toEqual([failedMove]);
      expect(await ids('?outcome=allowed')).toEqual([createCard, plain].toSorted());
      expect(await ids('?q=list&outcome=allowed')).toEqual([plain]);
      expect(await ids('?q=%25')).toEqual([]);
    });

    it('refuses an unknown outcome or a forged cursor', async () => {
      expect((await read(environmentCalls(caller, '?outcome=maybe'), member)).statusCode).toBe(400);
      expect((await read(environmentCalls(caller, '?older=bm90LWEtY3Vyc29y'), member)).statusCode).toBe(400);
      expect((await read(environmentCalls(caller, '?older=a&newer=b'), member)).statusCode).toBe(400);
    });

    it('answers 404 to someone who cannot open the Project', async () => {
      const outsider = await addMember(app, await createTenant(app), [Perms.viewExternalServicesUsage]);

      expect((await read(environmentCalls(), outsider)).statusCode).toBe(404);
    });
  });

  describe('Admin → Usage, for can_view_external_services_usage', () => {
    it('lists every Call of the Organization, from every Project, and nothing of another', async () => {
      const viewer = await addMember(app, caller.tenant, [Perms.viewExternalServicesUsage]);
      const otherProjectId = await createProject(app, caller.tenant, { title: unique('other-project') });
      const [mine] = await stageFor(caller, [{ operation: 'get_account' }]);
      const [otherProject] = await stageCalls([
        {
          externalServiceId: serviceId,
          tenantId: caller.tenant.tenantId,
          projectId: otherProjectId,
          operation: 'get_account',
        },
      ]);
      const elsewhere = await gateCaller(app);
      await stageFor(elsewhere, [{ operation: 'get_account' }]);

      const { calls } = await page('admin/calls', viewer);

      expect(calls.map((row) => row.callId).toSorted()).toEqual([mine, otherProject].toSorted());
    });

    it('is refused without the permission', async () => {
      expect((await read('admin/calls', member)).statusCode).toBe(403);
    });

    it('shows calls / refused / failed / events by month', async () => {
      const viewer = await addMember(app, caller.tenant, [Perms.viewExternalServicesUsage]);
      await call(caller, 'get_account', { accountId: 'acc_1' });
      await call(caller, 'delete_account', { accountId: 'acc_1' });

      const res = await read('admin/usage', viewer);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        month: new Date().toISOString().slice(0, 7),
        services: [
          {
            service: FIXTURE_SERVICE,
            displayName: 'Fixture CRM',
            calls: 2,
            refused: 1,
            failed: 0,
            events: 0,
            projects: [
              {
                projectId: caller.projectId,
                calls: 2,
                environments: [{ projectEnvironmentId: caller.projectEnvironmentId, calls: 2, refused: 1 }],
              },
            ],
          },
        ],
      });
    });
  });

  describe('a built-in’s Calls tab, for the platform operator', () => {
    it('shows Calls across Organizations, including inbound rows with no Organization', async () => {
      const operator = await addMember(app, await createTenant(app), [Perms.managePlatformExternalServices]);
      const operation = unique('op');
      const elsewhere = await gateCaller(app);
      const [mine] = await stageFor(caller, [{ operation }]);
      const [theirs] = await stageFor(elsewhere, [{ operation }]);
      const [inbound] = await stageCalls([
        { externalServiceId: serviceId, kind: 'inbound', operation, tenantId: null, projectId: null },
      ]);

      const { calls } = await page(`platform/services/${serviceId}/calls?q=${operation}`, operator);

      expect(calls.map((row) => row.callId).toSorted()).toEqual([mine, theirs, inbound].toSorted());
      expect(calls.find((row) => row.callId === inbound)).toMatchObject({
        kind: 'inbound',
        tenantId: null,
        tenantName: null,
        projectId: null,
      });
      expect(calls.find((row) => row.callId === theirs)?.tenantName).toEqual(expect.any(String));
    });

    it('is refused to an Organization admin', async () => {
      const admin = await addMember(app, caller.tenant, [Perms.manageTenantExternalServices]);

      expect((await read(`platform/services/${serviceId}/calls`, admin)).statusCode).toBe(403);
    });
  });

  describe('a custom service’s Calls tab, for its Organization admin', () => {
    async function customServiceOf(admin: MemberFixture) {
      return createCustomService(
        app,
        { ...admin, tenant: caller.tenant },
        'Trello',
        unique('trello').replace('_', '-')
      );
    }

    it('shows every Call to the service from any Project of the Organization', async () => {
      const admin = await addMember(app, caller.tenant, [Perms.manageTenantExternalServices]);
      const custom = await customServiceOf(admin);
      const otherProjectId = await createProject(app, caller.tenant, { title: unique('other-project') });
      const ids = await stageCalls([
        {
          externalServiceId: custom.id,
          slug: custom.slug,
          tenantId: caller.tenant.tenantId,
          projectId: caller.projectId,
        },
        {
          externalServiceId: custom.id,
          slug: custom.slug,
          tenantId: caller.tenant.tenantId,
          projectId: otherProjectId,
        },
      ]);

      const { calls } = await page(`services/${custom.id}/calls`, admin);

      expect(calls.map((row) => row.callId).toSorted()).toEqual(ids.toSorted());
    });

    it('answers 404 for another Organization’s service or a built-in, and 403 without the permission', async () => {
      const admin = await addMember(app, caller.tenant, [Perms.manageTenantExternalServices]);
      const custom = await customServiceOf(admin);
      const stranger = await addMember(app, await createTenant(app), [Perms.manageTenantExternalServices]);

      expect((await read(`services/${custom.id}/calls`, stranger)).statusCode).toBe(404);
      expect((await read(`services/${serviceId}/calls`, admin)).statusCode).toBe(404);
      expect((await read(`services/${custom.id}/calls`, member)).statusCode).toBe(403);
    });
  });
});
