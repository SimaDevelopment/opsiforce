import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILT_INS_ADAPTER_PATH } from '../../src/external-services/built-ins/built-ins-adapter';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';

describe("the built-ins adapter's routes", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ builtInsDir: shippedBuiltInServicesDir() });
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
  });

  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PROPFIND', 'REPORT', 'MKCOL', 'PURGE'])(
    'hand a %s request to the service, which checks its Caller identity',
    async (method) => {
      const res = await app.inject({
        method: method as 'GET',
        url: `${BUILT_INS_ADAPTER_PATH}/incoming-email/anything`,
      });

      expect(res.statusCode, res.body).toBe(401);
      expect(res.headers['opsiforce-outcome']).toBe('unidentified');
    }
  );

  it('hands a QUERY with its body to the service', async () => {
    const res = await fetch(`${await harness.listen()}${BUILT_INS_ADAPTER_PATH}/incoming-email/anything`, {
      method: 'QUERY',
      headers: { 'content-type': 'application/json' },
      body: '{"q":1}',
    });

    expect(res.status, await res.text()).toBe(401);
    expect(res.headers.get('opsiforce-outcome')).toBe('unidentified');
  });
});
