import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ServiceManifest } from '@opsiforce/external-service-sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { projectEnvironments } from '../../db/schema';
import { EnvironmentService } from '../../src/environment/environment.service';
import { manifestDiff } from '../../src/external-services/publishing/manifest-diff';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import { memberWithout, tenantAdmin, type PersonFixture } from './support/fixtures';
import {
  addServiceEnvironment,
  freePort,
  publishCustomService,
  writeServiceFiles,
  type PublishedService,
} from './support/published-services';
import { committedWorkspace, publishReview } from './support/service-publishing';
import { runningDevelopment, type BuilderDevelopment } from './support/test-lane';

const BOARD_OPTIONS = [
  { value: 'b1', label: 'Roadmap' },
  { value: 'b2', label: 'Operations' },
];

const PRODUCTION_MANIFEST = {
  sdk: 2,
  displayName: 'Boards',
  description: 'A pretend board tool the Organization built itself.',
  inbound: true,
  projectForm: [{ key: 'boards', type: 'multiselect', label: 'Boards', options: BOARD_OPTIONS }],
  events: {
    'card.created': { title: 'Card created', description: 'A card was added to a board.' },
    'card.deleted': { title: 'Card deleted', description: 'A card was deleted.' },
  },
} as const;

const DEVELOPMENT_MANIFEST = {
  ...PRODUCTION_MANIFEST,
  events: {
    'card.created': { title: 'Card added', description: 'A card was added to a board.' },
    'card.archived': { title: 'Card archived', description: 'A card was archived.' },
  },
};

const STAGING_MANIFEST = {
  ...PRODUCTION_MANIFEST,
  projectForm: [{ key: 'boardIds', was: 'boards', type: 'multiselect', label: 'Boards', options: BOARD_OPTIONS }],
  events: {
    ...PRODUCTION_MANIFEST.events,
    'card.deleted': { title: 'Card deleted', description: 'A card was deleted from a board.' },
  },
};

const asManifest = (manifest: unknown) => manifest as ServiceManifest;

describe('the manifest diff between two versions of a service', () => {
  it('marks added, removed, unchanged and edited Event types', () => {
    expect(manifestDiff(asManifest(PRODUCTION_MANIFEST), asManifest(DEVELOPMENT_MANIFEST))).toEqual({
      events: [
        { type: 'card.created', change: 'changed', aspects: ['title'] },
        { type: 'card.archived', change: 'added', aspects: [] },
        { type: 'card.deleted', change: 'removed', aspects: [] },
      ],
    });
    expect(manifestDiff(asManifest(PRODUCTION_MANIFEST), asManifest(STAGING_MANIFEST)).events).toEqual([
      { type: 'card.created', change: 'unchanged', aspects: [] },
      { type: 'card.deleted', change: 'changed', aspects: ['description'] },
    ]);
  });

  it('marks everything added when there is nothing to compare against', () => {
    expect(manifestDiff(null, asManifest(PRODUCTION_MANIFEST)).events.map((event) => event.change)).toEqual([
      'added',
      'added',
    ]);
  });
});

describe("a Custom External Service's manifest in each environment", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let development: BuilderDevelopment;
  let staging: string;
  let qa: string;

  const environmentManifests = (person: PersonFixture = admin) =>
    app.inject({ method: 'GET', url: `${TENANT_SERVICES}/${service.id}/manifests`, headers: person.headers });

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'environment-manifests-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { STORAGE_MOUNT_PATH: storageRoot, OPSIFORCE_PUBLIC_URL: 'https://opsiforce.example.com' },
      servicePodPort: podPort,
    });
    app = harness.app;
    await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, {
      slug: `boards-${crypto.randomUUID().slice(0, 6)}`,
      manifest: PRODUCTION_MANIFEST,
    });
    development = await runningDevelopment(app, storageRoot, service.builderChatId, DEVELOPMENT_MANIFEST);
    const environments = app.get(EnvironmentService);
    staging = (await environments.create(admin.tenant.tenantId, { name: 'Staging', slug: 'staging' })).id;
    qa = (await environments.create(admin.tenant.tenantId, { name: 'QA', slug: 'qa' })).id;
    const stagingInstance = await addServiceEnvironment(app, service.builderChatId, admin.tenant.tenantId, staging);
    await writeServiceFiles(storageRoot, stagingInstance.directory, STAGING_MANIFEST);
  });

  it('reads Development and every published environment, diffed against the Default environment', async () => {
    const res = await environmentManifests();

    expect(res.statusCode, res.body).toBe(200);
    const byName = Object.fromEntries(
      (res.json() as { name: string }[]).map((environment) => [environment.name, environment])
    );
    expect(Object.keys(byName)).toEqual(['Development', 'Production', 'QA', 'Staging']);
    expect(byName.Development).toMatchObject({
      environmentId: development.environmentId,
      status: 'development',
      serviceDefault: false,
      publishedCommitSha: null,
      manifest: { events: { 'card.archived': { title: 'Card archived' } } },
      changes: {
        events: [
          { type: 'card.created', change: 'changed', aspects: ['title'] },
          { type: 'card.archived', change: 'added' },
          { type: 'card.deleted', change: 'removed' },
        ],
      },
    });
    expect(byName.Production).toMatchObject({
      environmentId: service.environmentId,
      serviceDefault: true,
      status: 'development-differs',
      manifest: { events: { 'card.deleted': { title: 'Card deleted' } } },
      changes: null,
    });
    expect(byName.Staging).toMatchObject({
      environmentId: staging,
      serviceDefault: false,
      status: 'development-differs',
      changes: {
        events: [
          { type: 'card.created', change: 'unchanged' },
          { type: 'card.deleted', change: 'changed' },
        ],
      },
    });
    expect(byName.QA).toEqual({
      environmentId: qa,
      name: 'QA',
      status: 'unpublished',
      serviceDefault: false,
      publishedCommitSha: null,
      manifest: null,
      changes: null,
    });
  });

  it("says an environment is the same as Development until Development's app/ changes", async () => {
    const workspace = join(storageRoot, development.directory);
    const commit = await committedWorkspace(workspace);
    await db
      .update(projectEnvironments)
      .set({ deployedCommitSha: commit })
      .where(eq(projectEnvironments.id, service.projectEnvironmentId));
    const statusOfProduction = async () =>
      (await environmentManifests()).json().find((environment: { name: string }) => environment.name === 'Production')
        ?.status;

    expect(await statusOfProduction()).toBe('same-as-development');

    await writeFile(join(workspace, 'app', 'service.ts'), 'export default {};\n');

    expect(await statusOfProduction()).toBe('development-differs');
  });

  it('is refused to people who cannot manage the Organization’s External Services', async () => {
    expect((await environmentManifests(await memberWithout(app))).statusCode).toBe(403);
  });

  it("marks each Event type of the Publish dialog's check against the chosen environment", async () => {
    const toStaging = (await publishReview(app, admin, service.id, staging)).json();
    const toQa = (await publishReview(app, admin, service.id, qa)).json();

    expect(toStaging.changes).toEqual({
      events: [
        { type: 'card.created', change: 'changed', aspects: ['title'] },
        { type: 'card.archived', change: 'added', aspects: [] },
        { type: 'card.deleted', change: 'removed', aspects: [] },
      ],
    });
    expect(toQa.changes.events.map((event: { change: string }) => event.change)).toEqual(['added', 'added']);
  });
});
