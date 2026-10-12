import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CallLogCleanupProcessor } from '../../src/external-services/calls/call-log-cleanup.processor';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { backdateCall, callIdsOf, stageCalls, usageRowsOf } from './support/call-log';
import { forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  callOperation,
  configurePlatformService,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  type GateCallerFixture,
} from './support/gate';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

describe('Call log retention', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let caller: GateCallerFixture;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ env: { EXTERNAL_SERVICE_CALL_LOG_RETENTION_DAYS: '7' } });
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    const [mailbox] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM));
    caller = await gateCaller(app);
    await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, { mailbox, accountsMode: 'all' });
  });

  function runDailyCleanup(): Promise<void> {
    return new CallLogCleanupProcessor(app.get(ConfigService)).process({} as Job);
  }

  it('deletes Calls past the retention in batches and keeps newer ones', async () => {
    const expired = await stageCalls(
      Array.from({ length: 2345 }, (_, index) => ({
        projectEnvironmentId: caller.projectEnvironmentId,
        createdAt: daysAgo(8 + (index % 20)),
      }))
    );
    const kept = await stageCalls([
      { projectEnvironmentId: caller.projectEnvironmentId, createdAt: daysAgo(6) },
      { projectEnvironmentId: caller.projectEnvironmentId, createdAt: daysAgo(0) },
    ]);

    await runDailyCleanup();

    expect(await callIdsOf(expired)).toEqual([]);
    expect((await callIdsOf(kept)).toSorted()).toEqual(kept.toSorted());
  });

  it('leaves Usage intact when the Calls it counted are gone', async () => {
    const res = await callOperation(app, {
      key: caller.key,
      slug: FIXTURE_SERVICE,
      operation: 'delete_account',
      input: { accountId: 'acc_1' },
    });
    expect(res.statusCode).toBe(403);
    const callId = res.json<{ callId: string }>().callId;
    const before = await usageRowsOf(caller.projectEnvironmentId);
    await backdateCall(callId, daysAgo(30));

    await runDailyCleanup();

    expect(await callIdsOf([callId])).toEqual([]);
    expect(before).toEqual([expect.objectContaining({ calls: 1, refused: 1 })]);
    expect(await usageRowsOf(caller.projectEnvironmentId)).toEqual(before);
  });
});
