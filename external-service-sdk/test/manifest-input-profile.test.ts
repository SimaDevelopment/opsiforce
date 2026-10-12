import { test } from 'node:test';

import { assertAccepted, assertRefused } from './support/check.ts';
import { trelloManifest, type JsonObject } from './support/fixtures.ts';

function withNameSchema(schema: JsonObject): JsonObject {
  const manifest = trelloManifest();
  manifest.$defs.CreateCard.properties.name = schema;
  return manifest;
}

const namePath = '$defs.CreateCard.properties.name';

test('pattern and patternProperties are refused', () => {
  assertRefused(
    withNameSchema({ type: 'string', pattern: '^(a+)+$' }),
    namePath,
    /pattern is not allowed in input schemas/
  );
  assertRefused(
    withNameSchema({ type: 'object', patternProperties: { '^x': { type: 'string' } } }),
    namePath,
    /patternProperties is not allowed/
  );
});

test('$id is refused', () => {
  assertRefused(withNameSchema({ type: 'string', $id: 'https://evil.test/name' }), namePath, /\$id is not allowed/);
});

test('a $ref outside the manifest $defs is refused', () => {
  for (const $ref of ['https://evil.test/schema.json', 'other.json#/X', '#/definitions/X', '#/schemas/X']) {
    assertRefused(withNameSchema({ $ref }), `${namePath}.$ref`, /\$ref must point to #\/\$defs\/<name>/);
  }
});

test('a $ref to a missing $defs entry is refused', () => {
  const manifest = trelloManifest();
  manifest.operations.list_cards.input = { $ref: '#/$defs/ListBoards' };

  assertRefused(manifest, 'operations.list_cards.input.$ref', /#\/\$defs\/ListBoards does not exist in \$defs/);
});

test('$defs that refer to each other in a cycle are refused', () => {
  const manifest = trelloManifest();
  manifest.$defs.Node = { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } };

  assertRefused(manifest, '$defs.Node', /cycle: Node → Node/);
});

test('every schema has a type or a $ref', () => {
  assertRefused(withNameSchema({ minLength: 1 }), `${namePath}.type`, /every input schema needs a type/);
  assertRefused(
    withNameSchema({ $ref: '#/$defs/ListCards', maxLength: 3 }),
    namePath,
    /\$ref takes only a description beside it/
  );
});

test('keywords outside the profile are refused', () => {
  for (const [keyword, value] of [
    ['not', { type: 'string' }],
    ['if', { type: 'string' }],
    ['allOf', [{ type: 'string' }]],
    ['unevaluatedProperties', false],
    ['dependentRequired', {}],
  ] as const) {
    assertRefused(
      withNameSchema({ type: 'string', [keyword]: value }),
      namePath,
      new RegExp(`${keyword}.* is not allowed`)
    );
  }
  assertRefused(withNameSchema({ type: 'string', nullable: true }), namePath, /nullable is not allowed here/);
  assertRefused(withNameSchema({ type: 'string', format: 'credit-card' }), `${namePath}.format`, /Invalid option/);
});

test('Ajv strict mode refuses a required property that is not declared', () => {
  const manifest = trelloManifest();
  manifest.$defs.CreateCard.required.push('position');

  assertRefused(manifest, 'operations.create_card.input', /strict mode: required property "position" is not defined/);
});

test('schemas nested deeper than 8 levels are refused', () => {
  let schema: JsonObject = { type: 'string' };
  for (let level = 0; level < 8; level += 1) schema = { type: 'object', properties: { next: schema } };
  assertRefused(withNameSchema(schema), '$defs.CreateCard', /nests 10 levels deep; the limit is 8/);
});

test('nesting counts through $ref', () => {
  const manifest = trelloManifest();
  let schema: JsonObject = { $ref: '#/$defs/CreateCard' };
  for (let level = 0; level < 7; level += 1) schema = { type: 'array', items: schema };
  manifest.operations.create_card.input = { type: 'object', properties: { deep: schema } };

  assertRefused(manifest, 'operations.create_card.input', /nests 11 levels deep; the limit is 8/);
});

test('a schema over 64 KB is refused', () => {
  const values = Array.from({ length: 400 }, (_, index) => `${'v'.repeat(170)}${index}`);
  assertRefused(
    withNameSchema({ type: 'string', enum: values }),
    '$defs.CreateCard',
    /this schema is \d+ bytes; the limit is 65536/
  );
});

test('enums over 500 values and objects over 200 properties are refused', () => {
  const values = Array.from({ length: 501 }, (_, index) => `v${index}`);
  assertRefused(withNameSchema({ type: 'string', enum: values }), `${namePath}.enum`, /<=500/);

  const properties = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`p${index}`, { type: 'string' }]));
  assertRefused(withNameSchema({ type: 'object', properties }), `${namePath}.properties`, /at most 200 properties/);
});

test('a manifest over 256 KB is refused', () => {
  const manifest = trelloManifest();
  for (let index = 0; index < 70; index += 1) {
    manifest.$defs[`Padding${index}`] = { type: 'string', description: 'x'.repeat(1990) };
    manifest.$defs[`Filler${index}`] = { type: 'string', description: 'y'.repeat(1990), title: 'z'.repeat(200) };
  }
  manifest.operations.list_cards.description = 'x'.repeat(500);

  assertRefused(manifest, '', /service\.json is \d+ bytes; the limit is 262144/);
});

test('the safe profile accepts nullable unions, formats, defaults and alternatives', () => {
  assertAccepted(
    withNameSchema({
      type: ['string', 'null'],
      anyOf: [{ type: 'string', format: 'email', maxLength: 254 }, { type: 'string', format: 'uri' }, { type: 'null' }],
    })
  );
  assertAccepted(withNameSchema({ type: 'string', format: 'date-time', default: '2026-10-08T10:00:00Z' }));
});
