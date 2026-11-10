import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppUsersService } from '../../src/app-users/app-users.service';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';

let harness: DomainTestHarness;

beforeAll(async () => {
  harness = await createDomainTestingModule();
});

afterAll(async () => {
  await harness.close();
});

async function appUsersProject() {
  const tenant = await harness.tenants.getOrCreateTenant(`app-users-seeding-${randomUUID()}`);
  const project = await harness.projects.create({ title: 'Equipment Monitor' }, tenant.id);
  await harness.projects.updateAuth(
    project.id,
    project.id,
    { mode: 'app_users', bypassAuthPaths: ['/health'] },
    tenant.id
  );
  return { tenantId: tenant.id, projectId: project.id };
}

describe('App Users outside Development', () => {
  it('a published environment gets its own client and keeps the paths that skip sign-in', async () => {
    const { projectId } = await appUsersProject();
    const publishedId = randomUUID();
    await harness.projectEnvironments.create({
      id: publishedId,
      projectId,
      environmentId: null,
      isDefault: false,
      directory: `projects/${publishedId}`,
      platformVersion: '0.1.0',
      authMode: 'public',
    });
    const published = await harness.projectEnvironments.findById(publishedId);

    await harness.projects.inheritAuth({ id: projectId }, published);

    expect(harness.fakes.projectAuth.callsTo('applyAppUsers').at(-1)?.args).toEqual({
      environmentId: publishedId,
      shortId: published.shortId,
      bypassAuthPaths: ['/health'],
    });
    expect((await harness.projectEnvironments.findById(publishedId)).authMode).toBe('app_users');
  });

  it('a Duplicate keeps the mode but none of the source’s accounts', async () => {
    const { tenantId, projectId } = await appUsersProject();
    const appUsers = new AppUsersService();
    await appUsers.create(projectId, { email: 'ada@example-org.test', password: 'correct horse battery' });

    const copy = await harness.projects.duplicate(projectId, tenantId, undefined, null);

    expect((await harness.projectEnvironments.findById(copy.id)).authMode).toBe('app_users');
    expect(harness.fakes.projectAuth.gateOf(copy.id)).toEqual({ mode: 'app_users', bypassAuthPaths: ['/health'] });
    expect(await appUsers.list(copy.id)).toEqual([]);
  });

  it('a source switched to App Users mid-Publish waits, so the published mode matches its gate', async () => {
    const tenant = await harness.tenants.getOrCreateTenant(`app-users-seeding-${randomUUID()}`);
    const project = await harness.projects.create({ title: 'Equipment Monitor' }, tenant.id);
    const manual = {
      clientId: 'dev-client',
      clientSecret: 'dev-secret',
      discoveryUrl: 'https://issuer.example-org.test',
    };
    await harness.projects.updateAuth(project.id, project.id, { mode: 'manual', config: manual }, tenant.id);
    const publishedId = randomUUID();
    await harness.projectEnvironments.create({
      id: publishedId,
      projectId: project.id,
      environmentId: null,
      isDefault: false,
      directory: `projects/${publishedId}`,
      platformVersion: '0.1.0',
      authMode: 'public',
    });
    const published = await harness.projectEnvironments.findById(publishedId);
    const hold = harness.fakes.projectAuth.holdNextApplyFor(publishedId);

    const seeding = harness.projects.inheritAuth({ id: project.id }, published);
    await hold.reached;
    let switched = false;
    const switching = harness.projects
      .updateAuth(project.id, project.id, { mode: 'app_users' }, tenant.id)
      .then(() => (switched = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(switched).toBe(false);

    hold.release();
    await seeding;
    await switching;

    expect((await harness.projectEnvironments.findById(publishedId)).authMode).toBe('manual');
    expect(harness.fakes.projectAuth.gateOf(publishedId)).toMatchObject({ mode: 'manual' });
    expect((await harness.projectEnvironments.findById(project.id)).authMode).toBe('app_users');
  });
});
