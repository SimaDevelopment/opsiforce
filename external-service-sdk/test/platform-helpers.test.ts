import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Field } from '@opsiforce/external-service-sdk';
import { serviceConfigurationSourceOf, serviceSettingsFormOf } from '@opsiforce/external-service-sdk/platform';

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

test('serviceSettingsFormOf keeps toggles, numbers, text and fixed selects and leaves out every target', () => {
  const projectForm: Field[] = [
    { key: 'repositories', type: 'multiselect', options: { call: 'repositories' } },
    { key: 'board', type: 'select', options: { serviceConfiguration: 'boards', labelKey: 'name' } },
    { key: 'token', type: 'secret' },
    { key: 'address', type: 'text', generate: { length: 12, alphabet: 'digits', unique: true } },
    { key: 'access', type: 'list', item: [{ key: 'repository', type: 'select', options: { call: 'repositories' } }] },
    { key: 'reviewers', type: 'list', item: [{ key: 'login', type: 'text' }] },
    { key: 'refresh', type: 'button', label: 'Refresh', call: 'refresh' },
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
