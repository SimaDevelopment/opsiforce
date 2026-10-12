import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ServiceError } from '@opsiforce/external-service-sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeServicePod, type FakeServicePod } from './support/fake-service-pod';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import type { Revealed } from './support/generating';
import {
  BOARDS_MANIFEST,
  freePort,
  publishCustomService,
  READY_BOARDS,
  saveCustomServiceConfiguration,
  type PublishedService,
} from './support/published-services';

const GENERATING_BOARDS = {
  ...BOARDS_MANIFEST,
  serviceForm: [
    ...BOARDS_MANIFEST.serviceForm,
    { key: 'signingSecret', type: 'secret', label: 'Signing secret', generate: { bytes: 16 } },
  ],
};

describe("a Custom External Service's tenant-owned Service configuration", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let pod: FakeServicePod;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'custom-hooks-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { STORAGE_MOUNT_PATH: storageRoot },
      servicePodPort: podPort,
      serviceStartHoldMs: 2_000,
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
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards', manifest: GENERATING_BOARDS });
    pod = await startFakeServicePod({ manifest: GENERATING_BOARDS, gatewayKey: service.key, port: podPort });
  });

  afterEach(async () => {
    await pod.close();
  });

  function configurationUrl(suffix = ''): string {
    return `${TENANT_SERVICES}/${service.id}/configuration${suffix}`;
  }

  it('reveals the generated secret once and hands it to the service pod in onServiceConfigurationSaved', async () => {
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);

    expect(saved.statusCode, saved.body).toBe(200);
    const [revealed] = saved.json().revealed as Revealed[];
    expect(revealed?.path).toBe('signingSecret');
    expect(saved.json().hookFailure).toBeNull();
    expect(pod.receivedHooks).toEqual([
      expect.objectContaining({
        hook: 'onServiceConfigurationSaved',
        previous: null,
        current: { ...READY_BOARDS, signingSecret: revealed?.value },
      }),
    ]);
  });

  it('rotates the generated secret and tells the service the old and new values', async () => {
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);
    const before = (saved.json().revealed as Revealed[])[0]?.value;

    const rotated = await app.inject({
      method: 'POST',
      url: configurationUrl('/rotate'),
      headers: admin.headers,
      payload: { field: 'signingSecret' },
    });

    expect(rotated.statusCode, rotated.body).toBe(200);
    const after = (rotated.json().revealed as Revealed[])[0]?.value;
    expect(after).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(after).not.toBe(before);
    expect(pod.receivedHooks[1]).toMatchObject({
      previous: { signingSecret: before },
      current: { signingSecret: after },
    });
  });

  it('keeps the save when the hook fails and re-runs it on Retry', async () => {
    pod.scriptHook('onServiceConfigurationSaved', () => {
      throw new ServiceError({ status: 502, code: 'upstream-unavailable', detail: 'The board tool is down.' });
    });

    const saved = await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().hookFailure).toMatchObject({ code: 'upstream-unavailable' });
    const shown = await app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${service.id}`,
      headers: admin.headers,
    });
    expect(shown.json().hookFailure).toMatchObject({ code: 'upstream-unavailable' });

    pod.scriptHook('onServiceConfigurationSaved', () => undefined);
    const retried = await app.inject({ method: 'POST', url: configurationUrl('/hook/retry'), headers: admin.headers });

    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().hookFailure).toBeNull();
    expect(pod.receivedHooks).toHaveLength(2);
  });
});
