import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { externalServiceConfigs } from '../../db/schema';
import { PLATFORM_OWNER } from '../../src/external-services/configuration/configuration-values';
import { GeneratedValueSource, type GenerateSpec } from '../../src/external-services/configuration/generated-values';
import { ServiceConfigurationStore } from '../../src/external-services/configuration/service-configuration.store';
import { ServiceRegistry } from '../../src/external-services/registry/service-registry';
import { ProjectConfigurationCarry } from '../../src/external-services/configuration/project-configuration-carry';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { productionCaller, storeProjectConfiguration } from './support/gate';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  platformOperator,
  type PersonFixture,
} from './support/fixtures';
import {
  channelsOf,
  generatingBuiltInsDir,
  KEYS_SERVICE,
  configuringProject,
  platformServiceUrl,
  READY_KEYS,
  readProjectService,
  saveProjectService,
  saveServiceConfiguration,
  fixtureKeysEvolved,
  type Revealed,
} from './support/generating';
import type { EvolvedBuiltIns } from './support/evolved-built-ins';
import { Perms } from '../../src/permission/permission.constants';
import { seedLiveAgent } from '../support/agent-fixtures';
import { addMember, createProject, createTenant } from '../support/project-fixtures';

const BASE64URL_16_BYTES = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

describe('lists and generated values in a Service configuration', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let operator: PersonFixture;
  let serviceId: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ builtInsDir: generatingBuiltInsDir });
    app = harness.app;
    operator = await platformOperator(app);
    serviceId = await builtInServiceId(KEYS_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(KEYS_SERVICE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function scriptGenerated(alphabet: string, values: string[]): void {
    const source = app.get(GeneratedValueSource);
    const original = source.next.bind(source);
    vi.spyOn(source, 'next').mockImplementation((spec: GenerateSpec) =>
      'alphabet' in spec && spec.alphabet === alphabet && values.length > 0
        ? (values.shift() as string)
        : original(spec)
    );
  }

  it('gives each new list item a platform id and fills its generated fields, revealing generated secrets once', async () => {
    const res = await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);

    expect(res.statusCode, res.body).toBe(200);
    const view = res.json();
    const [support, sales] = channelsOf(view);
    expect(support).toMatchObject({ label: 'Support', token: { stored: true }, webhookSecret: { stored: true } });
    expect(support?.id).toMatch(/^li_[0-9a-f]{16}$/);
    expect(sales?.id).toMatch(/^li_[0-9a-f]{16}$/);
    expect(support?.id).not.toBe(sales?.id);
    expect(support?.inboxKey).toMatch(/^\d{8}$/);
    expect(view.serviceConfiguration.values.signingSecret).toEqual({ stored: true });

    const revealed = view.revealed as Revealed[];
    expect(revealed.map((entry) => entry.path).toSorted()).toEqual(
      [`channels.${support?.id}.webhookSecret`, `channels.${sales?.id}.webhookSecret`, 'signingSecret'].toSorted()
    );
    expect(revealed.find((entry) => entry.path === 'signingSecret')?.value).toMatch(BASE64URL_32_BYTES);
    expect(revealed.find((entry) => entry.path.startsWith(`channels.${support?.id}`))?.value).toMatch(
      BASE64URL_16_BYTES
    );

    const reread = await app.inject({ method: 'GET', url: platformServiceUrl(serviceId), headers: operator.headers });
    expect(reread.json().revealed).toBeUndefined();
    for (const entry of revealed) expect(reread.body).not.toContain(entry.value);
  });

  it('regenerates a unique generated value that collides with one already taken', async () => {
    scriptGenerated('digits', ['11111111', '11111111', '22222222']);

    const res = await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);

    expect(res.statusCode, res.body).toBe(200);
    expect(channelsOf(res.json()).map((channel) => channel.inboxKey)).toEqual(['11111111', '22222222']);
  });

  it('keeps unique generated values apart across Project configurations and refuses a typed value as taken', async () => {
    await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    const first = await configuringProject(app);
    const second = await configuringProject(app);
    const taken = `taken${crypto.randomUUID().replaceAll('-', '').slice(0, 11)}`;
    const fresh = `fresh${crypto.randomUUID().replaceAll('-', '').slice(0, 11)}`;
    scriptGenerated('lowercaseAlphanumeric', [taken, taken, fresh]);

    const firstSave = await saveProjectService(app, first, serviceId, {});
    const secondSave = await saveProjectService(app, second, serviceId, {});

    expect(firstSave.statusCode, firstSave.body).toBe(200);
    expect(firstSave.json().projectConfiguration.values.localPart).toBe(taken);
    expect(secondSave.statusCode, secondSave.body).toBe(200);
    expect(secondSave.json().projectConfiguration.values.localPart).toBe(fresh);

    const typed = await saveProjectService(app, second, serviceId, { localPart: taken });
    expect(typed.statusCode).toBe(400);
    expect(typed.json()).toMatchObject({
      type: 'urn:opsiforce:error:invalid-configuration',
      errors: [{ pointer: '/localPart', message: 'is taken' }],
    });
    expect((await readProjectService(app, second, serviceId)).json().projectConfiguration.values.localPart).toBe(fresh);
  });

  it('keeps saving a configuration whose own stored unique value another configuration claimed first', async () => {
    await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    const first = await configuringProject(app);
    const second = await configuringProject(app);
    const shared = `shared${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    scriptGenerated('lowercaseAlphanumeric', [shared]);
    expect((await saveProjectService(app, first, serviceId, {})).statusCode).toBe(200);
    await storeProjectConfiguration(KEYS_SERVICE, second.projectEnvironmentId, { localPart: shared });

    const res = await saveProjectService(app, second, serviceId, { watched: [] });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().projectConfiguration.values.localPart).toBe(shared);
  });

  it('lets only one of two concurrent saves take the same typed unique value', async () => {
    await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    const first = await configuringProject(app);
    const second = await configuringProject(app);
    const wanted = `both${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

    const saves = await Promise.all(
      [first, second].map((project) => saveProjectService(app, project, serviceId, { localPart: wanted }))
    );

    expect(saves.map((save) => save.statusCode).toSorted()).toEqual([200, 400]);
    expect(saves.find((save) => save.statusCode === 400)?.json()).toMatchObject({
      type: 'urn:opsiforce:error:invalid-configuration',
      errors: [{ pointer: '/localPart', message: 'is taken' }],
    });
  });

  it("copies a Service configuration to Development without its unique values, which stay the target's own", async () => {
    const saved = await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    const production = channelsOf(saved.json());
    const store = app.get(ServiceConfigurationStore);
    const service = app.get(ServiceRegistry).bySlug(KEYS_SERVICE);
    if (!service) throw new Error(`${KEYS_SERVICE} is not registered`);

    const copied = await store.copy(service, PLATFORM_OWNER, { tenantId: null, environment: 'development' });

    const development = (copied?.current.values.channels ?? []) as { label: string; inboxKey: string }[];
    expect(development.map((channel) => channel.label)).toEqual(production.map((channel) => channel.label));
    for (const channel of development) {
      expect(channel.inboxKey).toMatch(/^\d{8}$/);
      expect(production.map((held) => held.inboxKey)).not.toContain(channel.inboxKey);
    }
    await db.delete(externalServiceConfigs).where(eq(externalServiceConfigs.environment, 'development'));
  });

  it('fills a Project form generated value on the first save and keeps it on the next', async () => {
    await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    const project = await configuringProject(app);

    const first = await saveProjectService(app, project, serviceId, {});
    expect(first.statusCode, first.body).toBe(200);
    const localPart = first.json().projectConfiguration.values.localPart as string;
    expect(localPart).toMatch(/^[a-z0-9]{16}$/);

    const again = await saveProjectService(app, project, serviceId, { localPart });
    expect(again.json().projectConfiguration.values.localPart).toBe(localPart);
  });

  it('refuses more list items than the list allows', async () => {
    const res = await saveServiceConfiguration(app, operator, serviceId, {
      ...READY_KEYS,
      channels: ['a', 'b', 'c', 'd'].map((label) => ({ label, token: `${label}-token` })),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toEqual([expect.objectContaining({ pointer: '/channels' })]);
  });

  it("lets a Publish carry keep the target's own unique generated value instead of copying Development's", async () => {
    await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    const development = await configuringProject(app);
    const production = { ...(await productionCaller(app, development)), configurer: development.configurer };
    const developed = await saveProjectService(app, development, serviceId, {});
    const developmentAddress = developed.json().projectConfiguration.values.localPart as string;
    const carry = () =>
      app.get(ProjectConfigurationCarry).carry(development.projectEnvironmentId, production.projectEnvironmentId);

    const [line] = await carry();
    expect(line).toMatchObject({ outcome: 'carried' });
    const productionAddress = (await readProjectService(app, production, serviceId)).json().projectConfiguration.values
      .localPart as string;
    expect(productionAddress).toMatch(/^[a-z0-9]{16}$/);
    expect(productionAddress).not.toBe(developmentAddress);

    await saveProjectService(app, development, serviceId, {});
    await carry();
    expect((await readProjectService(app, production, serviceId)).json().projectConfiguration.values.localPart).toBe(
      productionAddress
    );
    expect((await readProjectService(app, development, serviceId)).json().projectConfiguration.values.localPart).toBe(
      developmentAddress
    );
  });
});

describe('a Project that enables a service that generates Project form values', () => {
  let evolved: EvolvedBuiltIns;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    evolved = await fixtureKeysEvolved((manifest) => {
      delete manifest.events;
    });
    harness = await createExternalServicesTestApp({ builtInsDir: evolved.dir });
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
    await evolved.remove();
  });

  it('fills the generated values when the first save creates its configuration', async () => {
    const serviceId = await builtInServiceId(KEYS_SERVICE);
    await forgetPlatformServiceConfiguration(KEYS_SERVICE);
    await saveServiceConfiguration(app, await platformOperator(app), serviceId, READY_KEYS);
    const tenant = await createTenant(app);
    const editor = await addMember(app, tenant, [Perms.manageAgents, Perms.configureProjectExternalServices]);
    const agentId = (await seedLiveAgent(tenant.tenantId, editor.userId, { visibility: 'private' })).id;
    const projectId = await createProject(app, tenant, { agentId, createdBy: editor.userId });

    const enabled = await app.inject({
      method: 'PUT',
      url: `/api/external-services/projects/${projectId}/environments/${projectId}/services/${serviceId}/configuration`,
      headers: editor.headers,
      payload: { values: {} },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: `/api/external-services/projects/${projectId}/environments/${projectId}/services/${serviceId}`,
      headers: editor.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().projectConfiguration).toMatchObject({
      saved: true,
      values: { localPart: expect.stringMatching(/^[a-z0-9]{16}$/) },
    });
  });
});
