import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeServiceFromOpenApi } from '@opsiforce/external-service-sdk/openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';

const committedFolder = join(shippedBuiltInServicesDir(), 'public-api');
const generatedFiles = ['service.json', 'openapi-routes.json', 'service.types.ts'];

describe('the committed public-api service folder', () => {
  let harness: ExternalServicesTestApp;
  let folder: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    folder = mkdtempSync(join(tmpdir(), 'public-api-'));
    copyFileSync(join(committedFolder, 'service.json'), join(folder, 'service.json'));
  });

  afterAll(async () => {
    rmSync(folder, { recursive: true, force: true });
    await harness.close();
  });

  it('is what external-service-cli generate --from-openapi writes from /api/v1/openapi.json (rerun with -u)', async () => {
    const document = (await harness.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();

    const result = await writeServiceFromOpenApi(folder, document, { origin: 'built_in' });

    expect(result, result.ok ? '' : result.output).toMatchObject({ ok: true });
    for (const file of generatedFiles) {
      await expect(readFileSync(join(folder, file), 'utf8')).toMatchFileSnapshot(join(committedFolder, file));
    }
  });
});
