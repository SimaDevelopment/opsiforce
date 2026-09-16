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

it('records the pod IP on the environment once the pod reports ready', async () => {
  const tenant = await harness.tenants.getOrCreateTenant(`globex-${Date.now()}`);
  const project = await harness.projects.create({ title: 'Startup' }, tenant.id);
  const podName = harness.fakes.pods.assignedPodName(project.id);

  await waitFor(() => harness.fakes.pods.callsTo('waitForReady').length > 0);
  harness.fakes.pods.markPodReady(podName, '10.244.0.7');

  await waitFor(async () => {
    const environment = await harness.projectEnvironments.findByIdOrNull(project.id);
    return environment?.status === ProjectStatus.Active;
  });

  const environment = await harness.projectEnvironments.findByIdOrNull(project.id);
  expect(environment?.podIp).toBe('10.244.0.7');
});
