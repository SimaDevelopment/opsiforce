import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';

let harness: DomainTestHarness;

beforeAll(async () => {
  harness = await createDomainTestingModule();
});

afterAll(async () => {
  await harness.close();
});

const customerIdp = {
  clientId: 'customer-app',
  clientSecret: 'customer-secret',
  discoveryUrl: 'https://idp.example-org.test/.well-known/openid-configuration',
};

describe('Deleting a Project removes its App Auth', () => {
  it('leaves no gate on Development or a published environment of a manual App', async () => {
    const tenant = await harness.tenants.getOrCreateTenant(`remove-auth-${randomUUID()}`);
    const project = await harness.projects.create({ title: 'Protected' }, tenant.id);
    await harness.projects.updateAuth(project.id, project.id, { mode: 'manual', config: customerIdp }, tenant.id);
    const published = { id: randomUUID() };
    await harness.projectEnvironments.create({
      id: published.id,
      projectId: project.id,
      environmentId: null,
      isDefault: false,
      directory: `projects/${published.id}`,
      platformVersion: '0.1.0',
      authMode: 'manual',
    });
    await harness.projects.inheritAuth({ id: project.id }, await harness.projectEnvironments.findById(published.id));

    await harness.projects.remove(project.id, tenant.id);

    expect(harness.fakes.projectAuth.gateOf(project.id)).toBeUndefined();
    expect(harness.fakes.projectAuth.gateOf(published.id)).toBeUndefined();
  });
});
