import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  platformOperator,
  type PersonFixture,
} from './support/fixtures';
import {
  channelsOf,
  configuringProject,
  forgetRecordedHooks,
  generatingBuiltInsDir,
  KEYS_SERVICE,
  READY_KEYS,
  readProjectService,
  saveProjectService,
  saveServiceConfiguration,
  recordedHook,
  type ConfiguringProject,
} from './support/generating';

describe('deleting a list item from a Service configuration', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let operator: PersonFixture;
  let serviceId: string;
  let support: string;
  let sales: string;

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
    forgetRecordedHooks();
    const saved = await saveServiceConfiguration(app, operator, serviceId, READY_KEYS);
    [support, sales] = channelsOf(saved.json()).map((channel) => channel.id) as [string, string];
  });

  function deleteSupport() {
    return saveServiceConfiguration(app, operator, serviceId, {
      apiToken: '',
      channels: [{ id: sales, label: 'Sales', token: '' }],
    });
  }

  async function configured(values: Record<string, unknown>): Promise<ConfiguringProject> {
    const project = await configuringProject(app);
    const res = await saveProjectService(app, project, serviceId, values);
    expect(res.statusCode, res.body).toBe(200);
    return project;
  }

  it('strips every Project configuration reference to the item and shows the notice once', async () => {
    const referencing = await configured({
      channel: support,
      watched: [support, sales],
      rooms: [{ room: 'red', channel: support }],
      _labels: { channel: { [support]: 'Support' } },
    });
    const elsewhere = await configured({ channel: sales });

    const res = await deleteSupport();
    expect(res.statusCode, res.body).toBe(200);

    const opened = await readProjectService(app, referencing, serviceId);
    const configuration = opened.json().projectConfiguration;
    expect(configuration.values.channel).toBeUndefined();
    expect(configuration.values.watched).toEqual([sales]);
    expect(configuration.values.rooms).toEqual([{ id: expect.any(String), room: 'red' }]);
    expect(configuration.labels.channel).toEqual({});
    expect(opened.json().notice).toEqual({
      removed: [{ label: 'Support', fields: ['Channel', 'Watched channels', 'Rooms › Channel'] }],
    });
    expect((await readProjectService(app, referencing, serviceId)).json().notice).toBeNull();

    const untouched = await readProjectService(app, elsewhere, serviceId);
    expect(untouched.json().projectConfiguration.values.channel).toBe(sales);
    expect(untouched.json().notice).toBeNull();
  });

  it('runs the Project hook of each stripped configuration with its old and new references', async () => {
    const referencing = await configured({ channel: support });

    await deleteSupport();

    expect(recordedHook(`hooks/project/${referencing.projectEnvironmentId}`)).toMatchObject({
      previousChannel: support,
      currentChannel: null,
    });
  });

  it('leaves Project configurations alone when no item is deleted', async () => {
    const referencing = await configured({ channel: support });

    await saveServiceConfiguration(app, operator, serviceId, {
      apiToken: '',
      channels: [
        { id: support, label: 'Support renamed', token: '' },
        { id: sales, label: 'Sales', token: '' },
      ],
    });

    const opened = await readProjectService(app, referencing, serviceId);
    expect(opened.json().projectConfiguration.values.channel).toBe(support);
    expect(opened.json().notice).toBeNull();
  });
});
