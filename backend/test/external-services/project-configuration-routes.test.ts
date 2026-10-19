import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agentProfileSkills, skills } from '../../db/schema';
import { SKILL_DELIVERY_QUEUE } from '../../src/delivery/delivery.types';
import { Perms } from '../../src/permission/permission.constants';
import { builtInProfileFor } from '../../src/store/agent-profile.repository';
import type { FakeQueue } from '../support/infra-fakes';
import {
  addMember,
  createProject,
  createTenant,
  privateWorkspaceIdOf,
  type MemberFixture,
} from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  configurePlatformService,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  storedProjectConfiguration,
  storeProjectConfiguration,
  type GateCallerFixture,
} from './support/gate';

describe('the Project configuration routes behind the chat bar', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let caller: GateCallerFixture;
  let member: MemberFixture;
  let configurer: MemberFixture;
  let serviceId: string;
  let supportMailbox: string;
  let salesMailbox: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    serviceId = await builtInServiceId(FIXTURE_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    [supportMailbox, salesMailbox] = mailboxIds(
      await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM)
    ) as [string, string];
    caller = await gateCaller(app);
    member = await addMember(app, caller.tenant, [Perms.usePublicApi]);
    configurer = await addMember(app, caller.tenant, [Perms.configureProjectExternalServices]);
  });

  function servicesUrl(projectId = caller.projectId, projectEnvironmentId = caller.projectEnvironmentId): string {
    return `/api/external-services/projects/${projectId}/environments/${projectEnvironmentId}/services`;
  }

  async function carryServiceSkill(agentId: string): Promise<void> {
    const profile = await builtInProfileFor(agentId, caller.tenant.tenantId);
    const [skill] = await db.select().from(skills).where(eq(skills.externalServiceId, serviceId));
    if (!skill?.latestVersionId) throw new Error(`${FIXTURE_SERVICE} has no Service skill`);
    await db
      .insert(agentProfileSkills)
      .values({ profileId: profile.id, skillId: skill.id, skillVersionId: skill.latestVersionId });
  }

  function readAs(person: MemberFixture, url = `${servicesUrl()}/${serviceId}`) {
    return app.inject({ method: 'GET', url, headers: person.headers });
  }

  function saveAs(person: MemberFixture, values: Record<string, unknown>) {
    return app.inject({
      method: 'PUT',
      url: `${servicesUrl()}/${serviceId}/configuration`,
      headers: person.headers,
      payload: { values },
    });
  }

  it('shows any Project member the configuration read-only, with only its form values', async () => {
    const res = await readAs(member);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: serviceId,
      slug: FIXTURE_SERVICE,
      origin: 'built_in',
      displayName: 'Fixture CRM',
      projectConfiguration: { saved: false, missing: ['mailbox'] },
    });
    expect(res.json().projectConfiguration).not.toHaveProperty('operations');
    expect(res.json().projectConfiguration).not.toHaveProperty('receive');
    expect(res.json().manifest.projectForm).toBeDefined();
    expect(res.json().manifest.serviceForm).toBeUndefined();
  });

  it('offers the Service configuration list items by label without their secrets', async () => {
    const res = await readAs(member);

    expect(res.json().serviceConfigurationOptions).toEqual([
      {
        list: 'mailboxes',
        labelKey: 'label',
        options: [
          { value: supportMailbox, label: 'Support' },
          { value: salesMailbox, label: 'Sales' },
        ],
      },
    ]);
    expect(res.body).not.toContain('support-token');
    expect(res.body).not.toContain('crm-key-1');
  });

  it('lets only a holder of can_configure_project_external_services save', async () => {
    const refused = await saveAs(member, { mailbox: supportMailbox });
    expect(refused.statusCode).toBe(403);
    expect(await storedProjectConfiguration(FIXTURE_SERVICE, caller.projectEnvironmentId)).toBeNull();

    const saved = await saveAs(configurer, {
      mailbox: supportMailbox,
      _labels: { accountIds: { acc_1: 'Acme' } },
      accountIds: ['acc_1'],
    });

    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().projectConfiguration).toMatchObject({
      saved: true,
      missing: [],
      values: { mailbox: supportMailbox, accountIds: ['acc_1'] },
      labels: { accountIds: { acc_1: 'Acme' } },
    });
    expect((await readAs(member)).json().projectConfiguration.values.mailbox).toBe(supportMailbox);
  });

  it('answers values that do not fit the Project form with the invalid-configuration problem', async () => {
    const res = await saveAs(configurer, { mailbox: supportMailbox, pipeline: 'marketing' });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      code: 'invalid-configuration',
      errors: [expect.objectContaining({ pointer: '/pipeline' })],
    });
  });

  it('reports a stored value that no longer fits as missing', async () => {
    await storeProjectConfiguration(FIXTURE_SERVICE, caller.projectEnvironmentId, { mailbox: 42 });

    expect((await readAs(member)).json().projectConfiguration).toMatchObject({ saved: true, missing: ['mailbox'] });
  });

  it('lists the Available services with each configuration state for the bar', async () => {
    await saveAs(configurer, { mailbox: supportMailbox });

    const res = await readAs(member, servicesUrl());

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().services).toEqual([
      expect.objectContaining({
        id: serviceId,
        slug: FIXTURE_SERVICE,
        displayName: 'Fixture CRM',
        origin: 'built_in',
        configuration: { saved: true, missing: [] },
      }),
    ]);
  });

  it('lists every Available service as available while neither the Agent carries it nor a configuration exists', async () => {
    const res = await readAs(member, servicesUrl());

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().services).toEqual([
      expect.objectContaining({
        id: serviceId,
        state: 'available',
        configuration: expect.objectContaining({ saved: false }),
      }),
    ]);
    expect((await readAs(member)).json()).toMatchObject({ state: 'available' });
  });

  it('lists a service whose Service skill the Agent carries as needing configuration', async () => {
    const agentId = (await readAs(member, servicesUrl())).json().agentId as string;
    await carryServiceSkill(agentId);

    const res = await readAs(member, servicesUrl());

    expect(res.json().services).toEqual([expect.objectContaining({ id: serviceId, state: 'needs-configuration' })]);
    expect((await readAs(member)).json()).toMatchObject({ state: 'needs-configuration' });
  });

  it('enables a service on the first save, which delivers its Service skill to this environment', async () => {
    const queue = app.get<FakeQueue>(getQueueToken(SKILL_DELIVERY_QUEUE));
    const before = queue.callsTo('add').length;

    const saved = await saveAs(configurer, { mailbox: supportMailbox });

    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ state: 'enabled' });
    expect(
      queue
        .callsTo('add')
        .slice(before)
        .map((call) => (call.args as { data: { projectEnvironmentId: string } }).data.projectEnvironmentId)
    ).toContain(caller.projectEnvironmentId);
    expect((await readAs(member, servicesUrl())).json().services).toEqual([
      expect.objectContaining({ id: serviceId, state: 'enabled' }),
    ]);
  });

  it('lists nothing while the service is not Available, and hides its configuration', async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);

    expect((await readAs(member, servicesUrl())).json().services).toEqual([]);
    expect((await readAs(member)).statusCode).toBe(404);
  });

  it('answers 404 to someone who cannot open the Project', async () => {
    const otherTenant = await createTenant(app);
    const outsider = await addMember(app, otherTenant, [Perms.configureProjectExternalServices]);

    expect((await readAs(outsider)).statusCode).toBe(404);
    expect((await readAs(outsider, servicesUrl())).statusCode).toBe(404);
    expect((await saveAs(outsider, { mailbox: supportMailbox })).statusCode).toBe(404);
  });

  it("answers 404 to a member of the Organization for a Project in someone else's private workspace", async () => {
    const owner = await addMember(app, caller.tenant, [Perms.configureProjectExternalServices]);
    const privateProjectId = await createProject(app, caller.tenant, {
      workspaceId: await privateWorkspaceIdOf(app, caller.tenant, owner),
    });
    const url = `${servicesUrl(privateProjectId, privateProjectId)}/${serviceId}`;

    expect((await readAs(owner, url)).statusCode).toBe(200);
    expect((await readAs(configurer, url)).statusCode).toBe(404);
  });

  it('answers 404 for an environment of another Project', async () => {
    const otherProjectId = await createProject(app, caller.tenant);

    const res = await readAs(member, `${servicesUrl(caller.projectId, otherProjectId)}/${serviceId}`);

    expect(res.statusCode).toBe(404);
  });
});
