import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Field } from '@opsiforce/external-service-sdk';
import {
  isTargetField,
  isWellFormedLabels,
  serviceConfigurationSourceOf,
  serviceSettingsFormOf,
} from '@opsiforce/external-service-sdk/platform';

test('serviceConfigurationSourceOf names the list and label key a choice field reads, and nothing for other options', () => {
  assert.deepEqual(
    serviceConfigurationSourceOf({
      key: 'mailbox',
      type: 'select',
      label: 'Mailbox',
      options: { serviceConfiguration: 'mailboxes', labelKey: 'label' },
    }),
    { serviceConfiguration: 'mailboxes', labelKey: 'label' }
  );
  assert.equal(
    serviceConfigurationSourceOf({ key: 'pick', type: 'select', label: 'Pick', options: [{ value: 'a', label: 'A' }] }),
    null
  );
  assert.equal(serviceConfigurationSourceOf({ key: 'name', type: 'text', label: 'Name' }), null);
});

test('serviceSettingsFormOf keeps every field an Agent can preset, picks included, and leaves out what is per Project', () => {
  const projectForm: Field[] = [
    { key: 'repositories', type: 'multiselect', options: { call: 'repositories' } },
    { key: 'board', type: 'select', options: { serviceConfiguration: 'boards', labelKey: 'name' } },
    { key: 'token', type: 'secret' },
    { key: 'address', type: 'text', generate: { length: 12, alphabet: 'digits', unique: true } },
    { key: 'access', type: 'list', item: [{ key: 'repository', type: 'select', options: { call: 'repositories' } }] },
    { key: 'deployKeys', type: 'list', item: [{ key: 'key', type: 'secret' }] },
    { key: 'reviewers', type: 'list', item: [{ key: 'login', type: 'text' }] },
    { key: 'refresh', type: 'button', label: 'Refresh', call: 'refresh' },
    { key: 'status', type: 'info', call: 'status' },
    {
      type: 'section',
      title: 'Pull requests',
      fields: [
        { key: 'pullRequests', type: 'toggle' },
        { key: 'mode', type: 'radio', options: [{ value: 'draft', label: 'Draft' }] },
      ],
    },
    { type: 'section', title: 'Hooks', fields: [{ key: 'hookSecret', type: 'secret' }] },
    { key: 'perDay', type: 'number' },
  ];

  assert.deepEqual(serviceSettingsFormOf(projectForm), [
    { key: 'repositories', type: 'multiselect', options: { call: 'repositories' } },
    { key: 'board', type: 'select', options: { serviceConfiguration: 'boards', labelKey: 'name' } },
    { key: 'access', type: 'list', item: [{ key: 'repository', type: 'select', options: { call: 'repositories' } }] },
    { key: 'reviewers', type: 'list', item: [{ key: 'login', type: 'text' }] },
    {
      type: 'section',
      title: 'Pull requests',
      fields: [
        { key: 'pullRequests', type: 'toggle' },
        { key: 'mode', type: 'radio', options: [{ value: 'draft', label: 'Draft' }] },
      ],
    },
    { key: 'perDay', type: 'number' },
  ]);
});

test('isTargetField marks a pick from the service or its configuration, and nothing else', () => {
  const targets: Exclude<Field, { type: 'section' }>[] = [
    { key: 'repositories', type: 'multiselect', options: { call: 'repositories' } },
    { key: 'board', type: 'select', options: { serviceConfiguration: 'boards', labelKey: 'name' } },
    { key: 'access', type: 'list', item: [{ key: 'repository', type: 'select', options: { call: 'repositories' } }] },
  ];
  const plain: Exclude<Field, { type: 'section' }>[] = [
    { key: 'token', type: 'secret' },
    { key: 'mode', type: 'radio', options: [{ value: 'draft', label: 'Draft' }] },
    { key: 'reviewers', type: 'list', item: [{ key: 'login', type: 'text' }] },
    { key: 'perDay', type: 'number' },
  ];

  assert.deepEqual(
    targets.map((field) => isTargetField(field)),
    targets.map(() => true)
  );
  assert.deepEqual(
    plain.map((field) => isTargetField(field)),
    plain.map(() => false)
  );
});

test('isWellFormedLabels accepts only field-to-value-to-label maps with short labels', () => {
  assert.equal(isWellFormedLabels({ repository: { r_1: 'example-org/web' } }), true);
  assert.equal(isWellFormedLabels({}), true);
  assert.equal(isWellFormedLabels({ repository: { r_1: 7 } }), false);
  assert.equal(isWellFormedLabels({ repository: ['example-org/web'] }), false);
  assert.equal(isWellFormedLabels({ repository: { r_1: 'x'.repeat(201) } }), false);
  assert.equal(isWellFormedLabels(null), false);
});
