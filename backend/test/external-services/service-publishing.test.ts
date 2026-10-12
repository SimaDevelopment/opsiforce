import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import {
  createCustomService,
  ensureExternalServiceBuilder,
  TENANT_SERVICES,
  type CreatedCustomService,
} from './support/custom-services';
import { memberWithout, tenantAdmin, type PersonFixture } from './support/fixtures';
import { BOARDS_MANIFEST, productionEnvironmentOf } from './support/published-services';
import { runningDevelopment, type BuilderDevelopment } from './support/test-lane';
import { stageCalls } from './support/call-log';
import { committedWorkspace, publishReview, writeTestReport } from './support/service-publishing';

const SHIPPED_SDK_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '../../../external-service-sdk/package.json'), 'utf8')) as { version: string }
).version;

const MOVING_MANIFEST = {
  ...BOARDS_MANIFEST,
  operations: {
    ...BOARDS_MANIFEST.operations,
    move_card: {
      kind: 'write',
      description: 'Move a card to another list.',
      input: {
        type: 'object',
        required: ['cardId', 'listId'],
        properties: { cardId: { type: 'string' }, listId: { type: 'string' } },
      },
    },
  },
};

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

  it("shows the check report of Development's files: kinds, bound and unbound inputs, write-with-no-bound warnings", async () => {
    const res = await publishReview(app, admin, service.id, production);

    expect(res.statusCode, res.body).toBe(200);
    const review = res.json();
    expect(review.target).toMatchObject({ environmentId: production, name: 'Production', firstPublish: true });
    expect(review.check.ok).toBe(true);
    expect(review.check.operations).toEqual([
      { name: 'list_cards', kind: 'read', inputs: [{ pointer: '/boardId', bound: 'board' }] },
      {
        name: 'move_card',
        kind: 'write',
        inputs: [
          { pointer: '/cardId', bound: null },
          { pointer: '/listId', bound: null },
        ],
      },
    ]);
    expect(review.check.events).toEqual([
      {
        type: 'card.created',
        title: 'Card created',
        inputs: [
          { pointer: '/boardId', bound: 'board' },
          { pointer: '/name', bound: null },
        ],
      },
    ]);
    expect(review.check.problems).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: 'operations.move_card',
        message: expect.stringContaining('no bound'),
      }),
    ]);
  });

  it('says when the builder wrote no test report', async () => {
    const review = (await publishReview(app, admin, service.id, production)).json();

    expect(review.testReport).toEqual({ state: 'missing' });
  });

  it('reads the test report: what was tested at which commit, what was not, the real upstream, files changed since', async () => {
    const workspace = join(storageRoot, development.directory);
    const commit = await committedWorkspace(workspace);
    const [answered, refused] = await stageCalls([
      { externalServiceId: service.id, slug: service.slug, decision: 'allowed' },
      { externalServiceId: service.id, slug: service.slug, decision: 'refused', status: 403, code: 'out-of-bounds' },
    ]);
    await writeTestReport(workspace, {
      commit,
      manifestHash: computeManifestHash(MOVING_MANIFEST),
      lines: [
        { expectation: 'list_cards lists the Roadmap board', result: 'pass', source: 'live-call', callIds: [answered] },
        {
          expectation: 'another board is refused',
          result: 'pass',
          source: 'live-call',
          callIds: [refused, 'no-such-call'],
        },
        { expectation: 'move_card handles a 429', result: 'pass', source: 'unit-test', callIds: [] },
        {
          expectation: 'move_card moves a card',
          result: 'not-checked',
          source: 'live-call',
          callIds: [],
          reason: 'no write target was named',
        },
      ],
    });
    await writeFile(join(workspace, 'app', 'handlers.ts'), 'export default {};\n');

    const review = (await publishReview(app, admin, service.id, production)).json();

    expect(review.testReport).toMatchObject({
      state: 'present',
      commit,
      headCommit: commit,
      changedSince: ['app/handlers.ts'],
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
      lines: [{ expectation: 'list_cards answers', result: 'pass', source: 'unit-test', callIds: [] }],
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
      sdk: { vendored: '1.0.0', latest: SHIPPED_SDK_VERSION, status: 'current' },
    });
    expect(Object.keys(res.json().manifest.operations)).toEqual(['list_cards', 'move_card']);
  });

  it("serves the service's live openapi.json to signed-in managers only", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${service.id}/openapi.json`,
      headers: admin.headers,
    });
    const stranger = await memberWithout(app);
    const refused = await app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${service.id}/openapi.json`,
      headers: stranger.headers,
    });
    const anonymous = await app.inject({ method: 'GET', url: `${TENANT_SERVICES}/${service.id}/openapi.json` });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ openapi: '3.1.0' });
    expect(Object.keys(res.json().paths)).toEqual(['/list_cards', '/move_card']);
    expect(refused.statusCode).toBe(403);
    expect([401, 403]).toContain(anonymous.statusCode);
  });
});
