import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';

import { Secret } from '@opsiforce/external-service-sdk';

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
