import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';
import { waitFor } from './support/wait-for';
import { ProjectStatus } from '../src/project/project.types';

let harness: DomainTestHarness;

beforeAll(async () => {
  harness = await createDomainTestingModule();
});

afterAll(async () => {
  await harness.close();
});

it('turns the environment active once its pod reports ready', async () => {
  const tenant = await harness.tenants.getOrCreateTenant(`globex-${Date.now()}`);
  const project = await harness.projects.create({ title: 'Startup' }, tenant.id);
  const podName = harness.fakes.pods.assignedPodName(project.id);

  await waitFor(() => harness.fakes.pods.callsTo('waitForReady').length > 0);
  harness.fakes.pods.markPodReady(podName);

  await waitFor(async () => {
    const environment = await harness.projectEnvironments.findByIdOrNull(project.id);
    return environment?.status === ProjectStatus.Active;
  });

  const environment = await harness.projectEnvironments.findByIdOrNull(project.id);
  expect(environment?.status).toBe(ProjectStatus.Active);
});
