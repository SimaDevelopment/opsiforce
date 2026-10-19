import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { serviceManifestJsonSchema } from '@opsiforce/external-service-sdk/platform';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { fixtureManifest, trelloManifest } from './support/fixtures.ts';

const committed = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve('@opsiforce/external-service-sdk/service.schema.json')), 'utf8')
);

test('service.schema.json matches the zod meta-schema (run `yarn schema` after changing it)', () => {
  assert.deepEqual(committed, serviceManifestJsonSchema());
});

test('editors validating with service.schema.json accept the example manifests and refuse a misspelled key', () => {
  const validate = new Ajv2020({ strict: false }).compile(committed);

  for (const name of ['trello', 'whatsapp', 'github-sdk2']) {
    assert.equal(validate(fixtureManifest(name)), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
  const misspelled = trelloManifest();
  misspelled.serviceForm[0].item[0].lable = 'Label';
  assert.equal(validate(misspelled), false);
});
