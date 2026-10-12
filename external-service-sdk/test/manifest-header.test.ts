import { test } from 'node:test';

import { assertAccepted, assertRefused } from './support/check.ts';
import { trelloManifest } from './support/fixtures.ts';

test('the Trello example is a valid manifest', () => {
  assertAccepted(trelloManifest());
});

test('a manifest needs sdk 1, a displayName and a description', () => {
  const { sdk: _sdk, displayName: _displayName, description: _description, ...rest } = trelloManifest();

  assertRefused(rest, 'sdk', /sdk must be 1/);
  assertRefused(rest, 'displayName', /expected string/);
  assertRefused(rest, 'description', /expected string/);
  assertRefused({ ...trelloManifest(), sdk: 2 }, 'sdk', /sdk must be 1/);
});

test('the description is at most 300 characters', () => {
  assertAccepted({ ...trelloManifest(), description: 'x'.repeat(300) });
  assertRefused({ ...trelloManifest(), description: 'x'.repeat(301) }, 'description', /<=300/);
});

test('a manifest carries no name and no version', () => {
  assertRefused(
    { ...trelloManifest(), name: 'trello' },
    '',
    /name is not allowed: a service is identified by its folder/
  );
  assertRefused(
    { ...trelloManifest(), version: '1.2.0' },
    '',
    /version is not allowed: Publish records the manifest hash/
  );
});

test('the icon is a relative path to an SVG file', () => {
  for (const icon of ['icon.png', '../icon.svg', '/etc/icon.svg', 'https://cdn.test/icon.svg']) {
    assertRefused({ ...trelloManifest(), icon }, 'icon', /relative path to an \.svg file/);
  }
  assertAccepted({ ...trelloManifest(), icon: 'assets/icon.svg' });
});

test('an Operation needs a kind, a description of at most 500 characters and an object input', () => {
  const manifest = trelloManifest();
  manifest.operations.list_cards.kind = 'admin';
  manifest.operations.create_card.description = 'x'.repeat(501);
  delete manifest.operations.delete_card.input;

  assertRefused(manifest, 'operations.list_cards.kind', /Invalid option/);
  assertRefused(manifest, 'operations.create_card.description', /<=500/);
  assertRefused(manifest, 'operations.delete_card.input', /expected object/);
});

test('Operation names are snake_case', () => {
  const manifest = trelloManifest();
  manifest.operations.createCard = manifest.operations.create_card;

  assertRefused(manifest, 'operations.createCard', /snake_case/);
});

test('Operation limits stay within the caps', () => {
  const manifest = trelloManifest();
  manifest.operations.list_cards.limits = { inputBytes: 25 * 1024 * 1024, timeoutSeconds: 300 };
  assertAccepted(manifest);

  manifest.operations.list_cards.limits = { inputBytes: 25 * 1024 * 1024 + 1, timeoutSeconds: 301 };
  assertRefused(manifest, 'operations.list_cards.limits.inputBytes', /<=26214400/);
  assertRefused(manifest, 'operations.list_cards.limits.timeoutSeconds', /<=300/);
});

test('an Operation input must be an object schema', () => {
  const manifest = trelloManifest();
  manifest.operations.list_cards.input = { type: 'string' };

  assertRefused(manifest, 'operations.list_cards.input', /must be an object schema/);
});

test('Events need inbound', () => {
  const manifest = trelloManifest();
  delete manifest.inbound;

  assertRefused(manifest, 'events', /Events arrive only through inbound/);
});

test('an Event needs a title, a description and object data', () => {
  const manifest = trelloManifest();
  delete manifest.events['card.moved'].title;
  manifest.events['card.moved'].data = { type: 'array', items: { type: 'string' } };

  assertRefused(manifest, 'events["card.moved"].title', /expected string/);
});

test('Event data must be an object schema', () => {
  const manifest = trelloManifest();
  manifest.events['card.moved'].data = { type: 'array', items: { type: 'string', boundTo: 'board' } };

  assertRefused(manifest, 'events["card.moved"].data', /must be an object schema/);
});
