import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';

import { Secret, type ServiceLog } from '@opsiforce/external-service-sdk';

import { echoManifest, dispatchJson, runtimeFor, wireContext } from './support/runtime.ts';

const value = 'tok_live_9f8e7d6c5b4a';

test('a Secret reveals its value only when asked', () => {
  assert.equal(new Secret(value).reveal(), value);
});

test('a Secret never shows its value in JSON, strings or inspection', () => {
  const secret = new Secret(value);
  const shown = [
    JSON.stringify({ token: secret }),
    String(secret),
    `${secret}`,
    'token=' + secret,
    inspect(secret),
    inspect({ nested: { secret } }, { depth: 5 }),
    JSON.stringify(Object.entries(secret)),
    JSON.stringify({ ...secret }),
  ];

  for (const text of shown) assert.doesNotMatch(text, /tok_live/, text);
});

test('a Secret logged through ctx.log never reaches the log', async () => {
  const lines: string[] = [];
  const manifest = {
    ...echoManifest(),
    serviceForm: [{ key: 'apiKey', type: 'secret' }],
  };
  const runtime = runtimeFor(
    manifest,
    {
      operations: {
        echo: (_input: unknown, ctx: { serviceConfiguration: { apiKey: Secret }; log: ServiceLog }) => {
          ctx.log.info('calling upstream', {
            apiKey: ctx.serviceConfiguration.apiKey,
            config: ctx.serviceConfiguration,
          });
          return { ok: true };
        },
      },
    },
    { log: (line) => lines.push(line) }
  );

  const response = await dispatchJson(runtime, 'operations', 'echo', {
    context: wireContext({ serviceConfiguration: { apiKey: value } }),
    input: {},
  });

  assert.equal(response.status, 200);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /calling upstream/);
  assert.match(lines[0] ?? '', /call_test_1/);
  assert.doesNotMatch(lines[0] ?? '', /tok_live/);
});
