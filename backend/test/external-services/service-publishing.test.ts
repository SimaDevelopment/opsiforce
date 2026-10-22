import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  computeManifestHash,
  createFileServiceRecords,
  recordsFileInWorkspace,
} from '@opsiforce/external-service-sdk/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import {
  createCustomService,
  ensureExternalServiceBuilder,
  TENANT_SERVICES,
  type CreatedCustomService,
} from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { BOARDS_MANIFEST, productionEnvironmentOf } from './support/published-services';
import { runningDevelopment, type BuilderDevelopment } from './support/test-lane';
import { committedWorkspace, publishReview, writeTestReport } from './support/service-publishing';

const SHIPPED_SDK_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '../../../external-service-sdk/package.json'), 'utf8')) as { version: string }
).version;

const MOVING_MANIFEST = {
  ...BOARDS_MANIFEST,
  events: {
    ...BOARDS_MANIFEST.events,
    'card.moved': { title: 'Card moved', description: 'A card moved to another list.' },
  },
};

function recordedRequest(requestId: string, outcome: 'proxied' | 'not allowed') {
  return {
    requestId,
    time: new Date().toISOString(),
    callerKind: 'call' as const,
    projectId: null,
    projectEnvironmentId: null,
    environment: null,
    method: 'GET',
    path: '/boards/b1/cards',
    route: 'List cards',
    outcome,
    reason: null,
    status: outcome === 'proxied' ? 200 : 403,
    bytesIn: 0,
    bytesOut: 2,
    durationMs: 3,
    notes: {},
  };
}

describe('the Publish dialog of a Custom External Service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let admin: PersonFixture;
  let service: CreatedCustomService;
  let development: BuilderDevelopment;
  let production: string;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'service-publishing-'));
    harness = await createExternalServicesTestApp({ env: { STORAGE_MOUNT_PATH: storageRoot } });
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    admin = await tenantAdmin(app);
    service = await createCustomService(app, admin, 'Boards', `boards-${crypto.randomUUID().slice(0, 6)}`);
    development = await runningDevelopment(app, storageRoot, service.builderChatId, MOVING_MANIFEST);
    production = await productionEnvironmentOf(admin.tenant.tenantId);
  });

  it("shows the check report of Development's files: its Event types and no problems", async () => {
    const res = await publishReview(app, admin, service.id, production);

    expect(res.statusCode, res.body).toBe(200);
    const review = res.json();
    expect(review.target).toMatchObject({ environmentId: production, name: 'Production', firstPublish: true });
    expect(review.check).toEqual({
      ok: true,
      problems: [],
      events: [
        { type: 'card.created', title: 'Card created' },
        { type: 'card.moved', title: 'Card moved' },
      ],
    });
    expect(review.builtOnSdk1).toBe(false);
  });

  it('says when the builder wrote no test report', async () => {
    const review = (await publishReview(app, admin, service.id, production)).json();

    expect(review.testReport).toEqual({ state: 'missing' });
  });

  it('reads the test report: what was tested at which commit, what was not, the real upstream, files changed since', async () => {
    const workspace = join(storageRoot, development.directory);
    const commit = await committedWorkspace(workspace);
    const answered = 'req-answered';
    const refused = 'req-refused';
    const records = createFileServiceRecords({ file: join(workspace, recordsFileInWorkspace) });
    records.call(recordedRequest(answered, 'proxied'));
    records.call(recordedRequest(refused, 'not allowed'));
    records.close();
    await writeTestReport(workspace, {
      commit,
      manifestHash: computeManifestHash(MOVING_MANIFEST),
      lines: [
        {
          expectation: 'listing cards shows the Roadmap board',
          result: 'pass',
          source: 'live-call',
          callIds: [answered],
        },
        {
          expectation: 'another board is refused',
          result: 'pass',
          source: 'live-call',
          callIds: [refused, 'no-such-call'],
        },
        { expectation: 'moving a card handles a 429', result: 'pass', source: 'unit-test', callIds: [] },
        {
          expectation: 'moving a card moves it',
          result: 'not-checked',
          source: 'live-call',
          callIds: [],
          reason: 'no write target was named',
        },
      ],
    });
    await writeFile(join(workspace, 'app', 'service.ts'), 'export default {};\n');

    const review = (await publishReview(app, admin, service.id, production)).json();

    expect(review.testReport).toMatchObject({
      state: 'present',
      commit,
      headCommit: commit,
      changedSince: expect.arrayContaining(['app/service.ts']),
      manifestMatches: true,
      counts: { pass: 3, fail: 0, notChecked: 1 },
      upstreamCalled: true,
      unknownCallIds: ['no-such-call'],
    });
    expect(review.testReport.lines[3]).toMatchObject({ result: 'not-checked', reason: 'no write target was named' });
  });

  it('says the real upstream was never called when no live call was answered, and flags a stale manifest', async () => {
    const workspace = join(storageRoot, development.directory);
    const commit = await committedWorkspace(workspace);
    await writeTestReport(workspace, {
      commit,
      manifestHash: computeManifestHash(BOARDS_MANIFEST),
      lines: [{ expectation: 'listing cards answers', result: 'pass', source: 'unit-test', callIds: [] }],
    });

    const review = (await publishReview(app, admin, service.id, production)).json();

    expect(review.testReport).toMatchObject({
      state: 'present',
      upstreamCalled: false,
      manifestMatches: false,
      changedSince: [],
    });
  });

  it('shows a malformed test report as unreadable instead of trusting it', async () => {
    const workspace = join(storageRoot, development.directory);
    await writeTestReport(workspace, { commit: 'abc', lines: [] });

    const review = (await publishReview(app, admin, service.id, production)).json();

    expect(review.testReport.state).toBe('unreadable');
    expect(review.testReport.problems).toEqual(expect.arrayContaining([expect.stringContaining('commit')]));
  });

  it('shows an unpublished service as a Draft read from Development, with its SDK against the newest one', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${service.id}`,
      headers: admin.headers,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: service.id,
      origin: 'custom',
      published: false,
      displayName: 'Fixture Boards',
      builderChatId: service.builderChatId,
      defaultEnvironment: null,
      sdk: { vendored: SHIPPED_SDK_VERSION, latest: SHIPPED_SDK_VERSION, status: 'current' },
    });
    expect(Object.keys(res.json().manifest.events)).toEqual(['card.created', 'card.moved']);
  });

  it('shows a service built on SDK 1 with its warning, and Publish refuses it', async () => {
    await runningDevelopment(app, storageRoot, service.builderChatId, {
      sdk: 1,
      displayName: 'Old Boards',
      description: 'Built before SDK 2.',
      operations: { list_cards: { kind: 'read', description: 'List cards.', input: { type: 'object' } } },
    });

    const review = (await publishReview(app, admin, service.id, production)).json();
    const published = await app.inject({
      method: 'POST',
      url: `${TENANT_SERVICES}/${service.id}/publish`,
      headers: admin.headers,
      payload: { environmentId: production },
    });

    expect(review.builtOnSdk1).toBe(true);
    expect(published.statusCode, published.body).toBe(409);
    expect(published.json()).toMatchObject({
      type: 'urn:opsiforce:error:built-on-sdk-1',
      detail: 'Built on SDK 1: rebuild it on SDK 2 or delete it',
    });
  });

  it('loads the page of a service built on SDK 1 saying so, and deletes it', async () => {
    await runningDevelopment(app, storageRoot, service.builderChatId, {
      ...BOARDS_MANIFEST,
      sdk: 1,
      operations: { list_cards: { kind: 'read', description: 'List cards.', input: { type: 'object' } } },
    });

    const page = await app.inject({ method: 'GET', url: `${TENANT_SERVICES}/${service.id}`, headers: admin.headers });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `${TENANT_SERVICES}/${service.id}?confirmSlug=${service.slug}`,
      headers: admin.headers,
    });

    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toMatchObject({ id: service.id, builtOnSdk1: true, manifest: null, displayName: 'Boards' });
    expect(deleted.statusCode, deleted.body).toBe(204);
  });
});
