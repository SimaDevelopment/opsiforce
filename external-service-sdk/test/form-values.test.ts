import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Field } from '@opsiforce/external-service-sdk';
import { formSchema, formValuesSchema } from '@opsiforce/external-service-sdk/platform';

import { fixtureManifest, trelloManifest } from './support/fixtures.ts';

function form(fields: unknown[]): Field[] {
  return formSchema.parse(fields);
}

function accepts(fields: Field[], values: unknown): Record<string, unknown> {
  const result = formValuesSchema(fields).safeParse(values);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
  return result.data;
}

function refuses(fields: Field[], values: unknown, path: (string | number)[], message: RegExp): void {
  const result = formValuesSchema(fields).safeParse(values);
  assert.equal(result.success, false, `expected ${JSON.stringify(values)} to be refused`);
  assert.ok(
    result.error.issues.some(
      (issue) => JSON.stringify(issue.path) === JSON.stringify(path) && message.test(issue.message)
    ),
    `expected an issue at ${JSON.stringify(path)} matching ${message}, got ${JSON.stringify(result.error.issues)}`
  );
}

test('text: required, length and every format', () => {
  const fields = form([
    { key: 'name', type: 'text', required: true, validate: { minLength: 2, maxLength: 5 } },
    { key: 'email', type: 'text', validate: { format: 'email' } },
    { key: 'sender', type: 'text', validate: { format: 'emailOrDomain' } },
    { key: 'site', type: 'text', validate: { format: 'url' } },
    { key: 'local', type: 'text', validate: { format: 'url', allowHttp: true } },
    { key: 'host', type: 'text', validate: { format: 'hostname' } },
    { key: 'phone', type: 'text', validate: { format: 'e164' } },
    { key: 'network', type: 'text', validate: { format: 'ipOrCidr' } },
  ]);

  accepts(fields, {
    name: 'Ann',
    email: 'ann@example.com',
    sender: 'example.com',
    site: 'https://example.com/a',
    local: 'http://localhost:3000',
    host: 'mail.example.com',
    phone: '+14155550123',
    network: '10.0.0.0/8',
  });
  accepts(fields, { name: 'Ann', sender: 'ann@example.com', network: '2001:db8::1' });
  accepts(fields, { name: 'Ann', network: '2001:db8::/32' });

  refuses(fields, {}, ['name'], /required/);
  refuses(fields, { name: '   ' }, ['name'], /required/);
  refuses(fields, { name: 'A' }, ['name'], /2/);
  refuses(fields, { name: 'Annabel' }, ['name'], /5/);
  refuses(fields, { name: 'Ann', email: 'ann' }, ['email'], /email/);
  refuses(fields, { name: 'Ann', sender: 'example' }, ['sender'], /email address or a domain/);
  refuses(fields, { name: 'Ann', site: 'http://example.com' }, ['site'], /https URL/);
  refuses(fields, { name: 'Ann', local: 'ftp://example.com' }, ['local'], /http or https URL/);
  refuses(fields, { name: 'Ann', host: 'exa mple.com' }, ['host'], /hostname/);
  refuses(fields, { name: 'Ann', phone: '0412 555' }, ['phone'], /E\.164/);
  refuses(fields, { name: 'Ann', network: '10.0.0.0/33' }, ['network'], /IP address or a CIDR/);
  refuses(fields, { name: 'Ann', network: '300.1.1.1' }, ['network'], /IP address or a CIDR/);
  refuses(fields, { name: 42 }, ['name'], /string/);
});

test('an optional blank text counts as no value', () => {
  const fields = form([{ key: 'email', type: 'text', validate: { format: 'email', minLength: 5 } }]);

  assert.deepEqual(accepts(fields, { email: '' }), {});
});

test('textarea, number and toggle', () => {
  const fields = form([
    { key: 'notes', type: 'textarea', required: true, validate: { maxLength: 10 } },
    { key: 'size', type: 'number', min: 1, max: 25, integer: true },
    { key: 'ratio', type: 'number', min: 0.5, step: 0.25 },
    { key: 'on', type: 'toggle' },
  ]);

  accepts(fields, { notes: 'line\nline', size: 25, ratio: 1.25, on: false });
  refuses(fields, { notes: 'x'.repeat(11) }, ['notes'], /10/);
  refuses(fields, { notes: 'n', size: 0 }, ['size'], /1/);
  refuses(fields, { notes: 'n', size: 26 }, ['size'], /25/);
  refuses(fields, { notes: 'n', size: 2.5 }, ['size'], /int/i);
  refuses(fields, { notes: 'n', ratio: 0.6 }, ['ratio'], /multiple of 0\.25 from 0\.5/);
  refuses(fields, { notes: 'n', size: '3' }, ['size'], /number/);
  refuses(fields, { notes: 'n', on: 'yes' }, ['on'], /boolean/);
});

test('radio, select and multiselect with static options take only listed values', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];
  const fields = form([
    { key: 'mode', type: 'radio', required: true, options },
    { key: 'pick', type: 'select', options },
    { key: 'many', type: 'multiselect', options, minItems: 2 },
  ]);

  accepts(fields, { mode: 'a', pick: 'b', many: ['a', 'b'] });
  accepts(fields, { mode: 'b', many: [] });
  refuses(fields, {}, ['mode'], /required/);
  refuses(fields, { mode: 'c' }, ['mode'], /one of: a, b/);
  refuses(fields, { mode: 'a', pick: 'z' }, ['pick'], /one of/);
  refuses(fields, { mode: 'a', many: ['a', 'z'] }, ['many', 1], /one of/);
  refuses(fields, { mode: 'a', many: ['a'] }, ['many'], /at least 2/);
  refuses(fields, { mode: 'a', many: ['a', 'a'] }, ['many'], /twice/);
});

test('call-sourced and serviceConfiguration-sourced options are only shape-checked', () => {
  const projectForm = form(trelloManifest().projectForm);

  accepts(projectForm, { workspace: 'li_x', boardIds: ['any-board-id'] });
  refuses(projectForm, { workspace: '' }, ['workspace'], /required/);
  refuses(projectForm, { workspace: 'li_x', boardIds: [42] }, ['boardIds', 0], /string/);
  refuses(projectForm, { workspace: 'li_x', boardIds: ['x'.repeat(201)] }, ['boardIds', 0], /200/);
});

test('a required multiselect needs at least one value', () => {
  const fields = form([{ key: 'labels', type: 'multiselect', required: true, options: { call: 'listLabels' } }]);

  refuses(fields, { labels: [] }, ['labels'], /required/);
  accepts(fields, { labels: ['l1'] });
});

test('secret: required and multiline', () => {
  const fields = form([
    { key: 'token', type: 'secret', required: true },
    { key: 'key', type: 'secret', multiline: true },
  ]);

  accepts(fields, { token: 'tok', key: '-----BEGIN KEY-----\nabc\n-----END KEY-----' });
  refuses(fields, { token: '' }, ['token'], /required/);
  refuses(fields, { token: 42 }, ['token'], /string/);
});

test('list: items validated by their fields, keep their id, at most maxItems', () => {
  const serviceForm = form(fixtureManifest('whatsapp').serviceForm);
  const item = { id: 'li_1', channelId: 'ch', label: 'Sales', apiToken: 't' };

  assert.deepEqual(accepts(serviceForm, { channels: [item] }), { channels: [item] });
  refuses(serviceForm, { channels: [{ ...item, label: '' }] }, ['channels', 0, 'label'], /required/);
  refuses(serviceForm, { channels: [{ ...item, apiToken: undefined }] }, ['channels', 0, 'apiToken'], /required/);

  const limited = form([
    { key: 'rows', type: 'list', required: true, maxItems: 2, item: [{ key: 'n', type: 'text' }] },
  ]);
  refuses(limited, { rows: [] }, ['rows'], /required/);
  refuses(limited, { rows: [{}, {}, {}] }, ['rows'], /2/);
});

test('keyValue: plain string values', () => {
  const fields = form([{ key: 'headers', type: 'keyValue', required: true }]);

  accepts(fields, { headers: { 'x-team': 'ops' } });
  refuses(fields, { headers: {} }, ['headers'], /required/);
  refuses(fields, { headers: { 'x-team': 1 } }, ['headers', 'x-team'], /string/);
});

test('sections hold flat values; info and button hold none', () => {
  const fields = form([
    {
      type: 'section',
      title: 'Advanced',
      fields: [{ key: 'timeout', type: 'number', required: true }],
    },
    { key: 'about', type: 'info', text: 'Hello' },
    { key: 'test', type: 'button', label: 'Test', call: 'ping' },
  ]);

  assert.deepEqual(accepts(fields, { timeout: 3, about: 'x', test: 'y' }), { timeout: 3 });
  refuses(fields, {}, ['timeout'], /required/);
});

test('visibleWhen hides a field: its value is dropped before validation and it is not required', () => {
  const projectForm = form(trelloManifest().projectForm);
  projectForm[2] = { ...projectForm[2], required: true } as Field;

  assert.deepEqual(accepts(projectForm, { workspace: 'li_x', boardsMode: 'all', boardIds: [42, 'bad'] }), {
    workspace: 'li_x',
    boardsMode: 'all',
  });
  refuses(projectForm, { workspace: 'li_x', boardsMode: 'selected' }, ['boardIds'], /required/);
  refuses(projectForm, { workspace: 'li_x' }, ['boardIds'], /required/);
});

test('visibleWhen supports equals, in and truthy, and hides a whole section', () => {
  const fields = form([
    {
      key: 'kind',
      type: 'select',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
    },
    { key: 'enabled', type: 'toggle' },
    { key: 'forAorB', type: 'text', required: true, visibleWhen: { field: 'kind', in: ['a', 'b'] } },
    {
      type: 'section',
      title: 'When enabled',
      visibleWhen: { field: 'enabled', truthy: true },
      fields: [{ key: 'level', type: 'number', required: true }],
    },
    { key: 'deep', type: 'text', required: true, visibleWhen: { field: 'level', equals: 3 } },
  ]);

  assert.deepEqual(accepts(fields, { kind: 'c', enabled: false, forAorB: 7, level: 'x', deep: 1 }), {
    kind: 'c',
    enabled: false,
  });
  refuses(fields, { kind: 'a' }, ['forAorB'], /required/);
  refuses(fields, { kind: 'c', enabled: true }, ['level'], /required/);
  refuses(fields, { kind: 'c', enabled: true, level: 3 }, ['deep'], /required/);
  accepts(fields, { kind: 'c', enabled: true, level: 2 });
});

test('visibleWhen inside list items works per item', () => {
  const fields = form([
    {
      key: 'rules',
      type: 'list',
      item: [
        {
          key: 'match',
          type: 'radio',
          options: [
            { value: 'any', label: 'Any' },
            { value: 'from', label: 'From' },
          ],
        },
        { key: 'sender', type: 'text', required: true, visibleWhen: { field: 'match', equals: 'from' } },
      ],
    },
  ]);

  assert.deepEqual(accepts(fields, { rules: [{ id: 'li_1', match: 'any', sender: 99 }] }), {
    rules: [{ id: 'li_1', match: 'any' }],
  });
  refuses(fields, { rules: [{ id: 'li_1', match: 'from' }] }, ['rules', 0, 'sender'], /required/);
});
