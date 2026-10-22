import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertAccepted, assertRefused, errorsOf } from './support/check.ts';
import { trelloManifest } from './support/fixtures.ts';

test('the Trello example is a valid manifest', () => {
  assertAccepted(trelloManifest());
});

test('a manifest needs sdk 2, a displayName and a description', () => {
  const { sdk: _sdk, displayName: _displayName, description: _description, ...rest } = trelloManifest();

  assertRefused(rest, 'sdk', /sdk must be 2/);
  assertRefused(rest, 'displayName', /expected string/);
  assertRefused(rest, 'description', /expected string/);
  assertRefused({ ...trelloManifest(), sdk: 1 }, 'sdk', /sdk must be 2/);
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

for (const key of ['operations', 'bounds', '$defs']) {
  test(`a manifest refuses ${key}: SDK 2 has no Operations`, () => {
    const errors = errorsOf({ ...trelloManifest(), [key]: {} });
    assert.ok(
      errors.some((error) => error.message.includes(`${key}: SDK 2 has no Operations`)),
      JSON.stringify(errors)
    );
  });
}

test('an Event needs a title and a description, and no data schema', () => {
  const manifest = trelloManifest();
  delete manifest.events['card.moved'].title;
  assertRefused(manifest, 'events["card.moved"].title', /expected string/);

  const withData = trelloManifest();
  withData.events['card.moved'].data = { type: 'object' };
  assertRefused(withData, 'events["card.moved"]', /data is not allowed: describe the Event data in the Service skill/);
});

test('Event types are dotted snake_case', () => {
  const manifest = trelloManifest();
  manifest.events.CardMoved = manifest.events['card.moved'];

  assertRefused(manifest, 'events.CardMoved', /dotted snake_case/);
});
