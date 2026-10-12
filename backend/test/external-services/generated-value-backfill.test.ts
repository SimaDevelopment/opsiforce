import { describe, expect, it } from 'vitest';
import { createExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration, platformOperator } from './support/fixtures';
import {
  channelsOf,
  configuringProject,
  fixtureKeysEvolved,
  generatingBuiltInsDir,
  KEYS_SERVICE,
  platformServiceUrl,
  READY_KEYS,
  RECEIVING,
  readProjectService,
  saveProjectService,
  saveServiceConfiguration,
} from './support/generating';

type FieldJson = Record<string, unknown> & { key?: string; item?: FieldJson[] };

function withoutGenerate(fields: FieldJson[]): void {
  for (const field of fields) {
    delete field.generate;
    if (field.item) withoutGenerate(field.item);
  }
}

describe('a Built-in manifest that newly declares generated fields', () => {
  it('fills the empty generated fields of stored configurations when the backend boots', async () => {
    const evolved = await fixtureKeysEvolved((manifest) => {
      withoutGenerate(manifest.serviceForm as FieldJson[]);
      withoutGenerate(manifest.projectForm as FieldJson[]);
    });
    const before = await createExternalServicesTestApp({ builtInsDir: evolved.dir });
    const operator = await platformOperator(before.app);
    const serviceId = await builtInServiceId(KEYS_SERVICE);
    await forgetPlatformServiceConfiguration(KEYS_SERVICE);
    const saved = await saveServiceConfiguration(before.app, operator, serviceId, READY_KEYS);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(channelsOf(saved.json())[0]?.inboxKey).toBeUndefined();
    const project = await configuringProject(before.app);
    const configured = await saveProjectService(before.app, project, serviceId, {
      ...RECEIVING,
      operations: { send_message: true },
    });
    expect(configured.json().projectConfiguration.values.localPart).toBeUndefined();
    await before.close();

    const after = await createExternalServicesTestApp({ builtInsDir: generatingBuiltInsDir });
    try {
      const view = await after.app.inject({
        method: 'GET',
        url: platformServiceUrl(serviceId),
        headers: operator.headers,
      });
      expect(view.json().serviceConfiguration.values.signingSecret).toEqual({ stored: true });
      expect(channelsOf(view.json()).map((channel) => channel.inboxKey)).toEqual([
        expect.stringMatching(/^\d{8}$/),
        expect.stringMatching(/^\d{8}$/),
      ]);
      const reopened = (await readProjectService(after.app, project, serviceId)).json().projectConfiguration;
      expect(reopened.values.localPart).toMatch(/^[a-z0-9]{16}$/);
      expect(reopened.operations).toEqual({ send_message: true });
      expect(reopened.receive).toEqual({ 'message.received': true });
    } finally {
      await after.close();
      await evolved.remove();
    }
  });
});
