import { test } from 'node:test';

import { assertAccepted, assertRefused } from './support/check.ts';
import { trelloManifest, type JsonObject } from './support/fixtures.ts';

function withServiceFields(...fields: JsonObject[]): JsonObject {
  const manifest = trelloManifest();
  manifest.serviceForm.push(...fields);
  return manifest;
}

function withProjectFields(...fields: JsonObject[]): JsonObject {
  const manifest = trelloManifest();
  manifest.projectForm.push(...fields);
  return manifest;
}

const at = (index: number, rest = '') => `serviceForm[${index}]${rest}`;
const added = 2;

test('every field type of the v1 catalog is accepted', () => {
  assertAccepted(
    withServiceFields(
      { key: 'host', type: 'text', validate: { format: 'url', allowHttp: true }, placeholder: 'https://…' },
      { key: 'notes', type: 'textarea', validate: { maxLength: 2000 } },
      { key: 'retries', type: 'number', min: 0, max: 5, integer: true, default: 3 },
      { key: 'verbose', type: 'toggle', default: false },
      {
        key: 'region',
        type: 'radio',
        options: [
          { value: 'eu', label: 'Europe' },
          { value: 'us', label: 'US' },
        ],
      },
      { key: 'plan', type: 'select', options: { call: 'listPlans', searchable: true } },
      { key: 'scopes', type: 'multiselect', options: [{ value: 'read', label: 'Read' }], maxItems: 500 },
      { key: 'privateKey', type: 'secret', multiline: true },
      { key: 'headers', type: 'keyValue', default: { 'x-team': 'ops' } },
      {
        type: 'section',
        title: 'Advanced',
        collapsed: true,
        visibleWhen: { field: 'verbose', truthy: true },
        fields: [{ key: 'timeout', type: 'number', min: 1 }],
      },
      { key: 'status', type: 'info', call: 'connectionStatus' },
      { key: 'rotate', type: 'button', label: 'Rotate', call: 'rotate', confirm: 'Rotate the token?' }
    )
  );
});

test('a field of an unknown type is refused, including the types left out of v1', () => {
  for (const type of ['oauth', 'file', 'json', 'date', 'time', 'datetime', 'timezone', 'password']) {
    assertRefused(
      withServiceFields({ key: 'x', type }),
      at(added, '.type'),
      /a form takes a field of type text, textarea/
    );
  }
});

const malformedFields: [string, JsonObject, string, RegExp][] = [
  ['text with a regex validate', { key: 'x', type: 'text', validate: { regex: '^a+$' } }, '.validate', /regex/],
  [
    'text with an unknown format',
    { key: 'x', type: 'text', validate: { format: 'iban' } },
    '.validate.format',
    /Invalid option/,
  ],
  [
    'text with allowHttp but no url format',
    { key: 'x', type: 'text', validate: { allowHttp: true } },
    '.validate.allowHttp',
    /only to format "url"/,
  ],
  ['textarea with a non-string default', { key: 'x', type: 'textarea', default: 3 }, '.default', /expected string/],
  ['number with min above max', { key: 'x', type: 'number', min: 5, max: 1 }, '.min', /greater than max/],
  ['number with a string default', { key: 'x', type: 'number', default: '3' }, '.default', /expected number/],
  [
    'toggle marked required',
    { key: 'x', type: 'toggle', required: true },
    '',
    /not a property of this field type: required/,
  ],
  ['radio without options', { key: 'x', type: 'radio' }, '.options', /Invalid input/],
  [
    'select with duplicate option values',
    {
      key: 'x',
      type: 'select',
      options: [
        { value: 'a', label: 'A' },
        { value: 'a', label: 'B' },
      ],
    },
    '.options[1].value',
    /listed twice/,
  ],
  [
    'select with a default outside its options',
    { key: 'x', type: 'select', options: [{ value: 'a', label: 'A' }], default: 'b' },
    '.default',
    /not one of the options/,
  ],
  [
    'multiselect over 500 items',
    { key: 'x', type: 'multiselect', options: [{ value: 'a', label: 'A' }], maxItems: 501 },
    '.maxItems',
    /<=500/,
  ],
  [
    'secret with a default',
    { key: 'x', type: 'secret', default: 'hunter2' },
    '',
    /not a property of this field type: default/,
  ],
  ['secret with a weak generate', { key: 'x', type: 'secret', generate: { bytes: 8 } }, '.generate.bytes', />=16/],
  [
    'secret with a unique generate',
    { key: 'x', type: 'secret', generate: { bytes: 32, unique: true } },
    '.generate',
    /unique applies only to a text field/,
  ],
  [
    'secret with a unique generated alphabet',
    { key: 'x', type: 'secret', generate: { length: 16, alphabet: 'hex', unique: true } },
    '.generate',
    /unique applies only to a text field/,
  ],
  [
    'text with an unknown generate alphabet',
    { key: 'x', type: 'text', generate: { length: 16, alphabet: 'emoji' } },
    '.generate.alphabet',
    /Invalid option/,
  ],
  [
    'text generated and defaulted',
    { key: 'x', type: 'text', generate: { bytes: 32 }, default: 'abc' },
    '.default',
    /generated field cannot also have a default/,
  ],
  ['list without items', { key: 'x', type: 'list', item: [] }, '.item', />=1/],
  [
    'list inside a list item',
    { key: 'x', type: 'list', item: [{ key: 'y', type: 'list', item: [{ key: 'z', type: 'text' }] }] },
    '.item[0].type',
    /a list item \(one level, no list inside\)/,
  ],
  [
    'list item field named id',
    { key: 'x', type: 'list', item: [{ key: 'id', type: 'text' }] },
    '.item[0].key',
    /reserved: the platform assigns each list item its id/,
  ],
  [
    'keyValue with a nested value',
    { key: 'x', type: 'keyValue', default: { a: { b: 1 } } },
    '.default.a',
    /expected string/,
  ],
  [
    'section inside a section',
    { type: 'section', title: 'A', fields: [{ type: 'section', title: 'B', fields: [{ key: 'x', type: 'text' }] }] },
    '.fields[0].type',
    /sections do not nest/,
  ],
  ['section without a title', { type: 'section', fields: [{ key: 'x', type: 'text' }] }, '.title', /expected string/],
  [
    'info with two sources',
    { key: 'x', type: 'info', text: 'Hello', call: 'status' },
    '',
    /exactly one of text, template or call/,
  ],
  [
    'info with an unknown template variable',
    { key: 'x', type: 'info', template: '{{secretToken}}' },
    '.template',
    /\{\{secretToken\}\} is not a field at the same level/,
  ],
  ['button without a call', { key: 'x', type: 'button', label: 'Go' }, '.call', /expected string/],
  ['field key with a dash', { key: 'api-key', type: 'text' }, '.key', /must start with a letter/],
];

for (const [name, field, rest, message] of malformedFields) {
  test(`a malformed field is refused: ${name}`, () => {
    assertRefused(withServiceFields(field), at(added, rest), message);
  });
}

test('keys are unique across a form, sections included', () => {
  const manifest = withServiceFields({ type: 'section', title: 'More', fields: [{ key: 'callback', type: 'text' }] });

  assertRefused(manifest, at(added, '.fields[0].key'), /key "callback" is used twice/);
});

test('a list item cannot use the id key the platform assigns', () => {
  assertRefused(
    withProjectFields({ key: 'repositories', type: 'list', item: [{ key: 'id', type: 'text' }] }),
    'projectForm[3].item[0].key',
    /reserved: the platform assigns each list item its id/
  );
});

test('was cannot name a field that still exists', () => {
  const manifest = trelloManifest();
  manifest.projectForm[2].was = 'workspace';

  assertRefused(manifest, 'projectForm[2].was', /still a field at this level/);
});

test('visibleWhen names a value field at the same level', () => {
  assertRefused(
    withServiceFields({ key: 'x', type: 'text', visibleWhen: { field: 'missing', truthy: true } }),
    at(added, '.visibleWhen'),
    /"missing" is not a field at the same level/
  );
  assertRefused(
    withServiceFields({ key: 'x', type: 'text', visibleWhen: { field: 'label', truthy: true } }),
    at(added, '.visibleWhen'),
    /"label" is not a field at the same level/
  );
  assertRefused(
    withServiceFields({ key: 'x', type: 'text', visibleWhen: { field: 'callback', equals: 'a' } }),
    at(added, '.visibleWhen'),
    /info field and holds no value/
  );
  assertRefused(
    withServiceFields({ key: 'x', type: 'text', visibleWhen: { field: 'workspaces', equals: 'a', truthy: true } }),
    at(added, '.visibleWhen'),
    /Unrecognized key/
  );
});

test('dependsOn names fields at the same level', () => {
  const manifest = trelloManifest();
  manifest.projectForm[2].options.dependsOn = ['board'];

  assertRefused(manifest, 'projectForm[2].options.dependsOn[0]', /"board" is not a field at the same level/);
});

test('serviceConfiguration options read a Service form list from the Project form only', () => {
  assertRefused(
    withServiceFields({ key: 'x', type: 'select', options: { serviceConfiguration: 'workspaces', labelKey: 'label' } }),
    at(added, '.options.serviceConfiguration'),
    /exist only in the Project form/
  );

  const notAList = trelloManifest();
  notAList.projectForm[0].options.serviceConfiguration = 'callback';
  assertRefused(
    notAList,
    'projectForm[0].options.serviceConfiguration',
    /"callback" is not a list field of the Service form/
  );

  const unknownLabel = trelloManifest();
  unknownLabel.projectForm[0].options.labelKey = 'name';
  assertRefused(unknownLabel, 'projectForm[0].options.labelKey', /"name" is not a field of the "workspaces" items/);
});

test('templates read same-level values, the Service configuration and the webhook URL only', () => {
  const manifest = withProjectFields({
    key: 'hint',
    type: 'info',
    template: '{{boardsMode}} on {{serviceConfiguration.domain}} at {{webhookUrl}}',
  });
  manifest.serviceForm.push({ key: 'domain', type: 'text' });
  assertAccepted(manifest);

  assertRefused(
    withServiceFields({ key: 'hint', type: 'info', template: '{{serviceConfiguration.callback}}' }),
    at(added, '.template'),
    /serviceConfiguration variables exist only in the Project form/
  );
  assertRefused(
    withProjectFields({ key: 'hint', type: 'info', template: '{{serviceConfiguration.missing}}' }),
    'projectForm[3].template',
    /\{\{serviceConfiguration\.missing\}\} is not a Service form field/
  );
});

test('a template never shows a secret or a list', () => {
  assertRefused(
    withServiceFields({ key: 'token', type: 'secret' }, { key: 'hint', type: 'info', template: 'Token: {{token}}' }),
    at(added + 1, '.template'),
    /\{\{token\}\} is a secret field; a template shows only plain single values/
  );
  assertRefused(
    withProjectFields({ key: 'hint', type: 'info', template: '{{serviceConfiguration.workspaces}}' }),
    'projectForm[3].template',
    /is a list field/
  );
});
