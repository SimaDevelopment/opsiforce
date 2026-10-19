import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { podWebhookUrl } from '../../src/external-services/configuration/webhook-url';
import { PodService } from '../../src/pod/pod.service';
import type { FakePodService } from '../support/infra-fakes';
import { createProject, createTenant } from '../support/project-fixtures';
import { waitFor } from '../support/wait-for';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { createCustomService, ensureExternalServiceBuilder } from './support/custom-services';
import { tenantAdmin } from './support/fixtures';

const PUBLIC_URL = 'https://opsiforce.example.com';

describe("a service copy's pod is told its Webhook address", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    harness = await createExternalServicesTestApp({ env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL } });
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
  });

  it("starts a new service's builder chat with Development's address", async () => {
    const pods = app.get<FakePodService>(PodService);
    const service = await createCustomService(app, await tenantAdmin(app), 'Boards', 'webhook-boards');

    await waitFor(() =>
      pods.callsTo('createAssignedPod').some((call) => call.args.environmentId === service.builderChatId)
    );

    const started = pods.callsTo('createAssignedPod').find((call) => call.args.environmentId === service.builderChatId);
    expect(started?.args.serviceWebhookUrl).toBe(
      `${PUBLIC_URL}/api/external-services/webhooks/${service.id}/development`
    );
  });

  it("gives every other environment of the builder chat the service's own address", async () => {
    const service = await createCustomService(app, await tenantAdmin(app), 'Cards', 'webhook-cards');

    expect(await podWebhookUrl(app.get(ConfigService), { projectId: service.builderChatId, isDefault: false })).toBe(
      `${PUBLIC_URL}/api/external-services/webhooks/${service.id}`
    );
  });

  it('gives a Project that serves no External Service none', async () => {
    const projectId = await createProject(app, await createTenant(app));

    expect(await podWebhookUrl(app.get(ConfigService), { projectId, isDefault: true })).toBeUndefined();
  });
});
