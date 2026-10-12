import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeManifestHash, createServiceRuntime } from '@opsiforce/external-service-sdk/server';

import sdkPackage from '../package.json' with { type: 'json' };
import trelloHandlers from './fixtures/trello/handlers.ts';
import whatsappHandlers from './fixtures/whatsapp/handlers.ts';
import { fixtureManifest, trelloManifest } from './support/fixtures.ts';
import { echoManifest } from './support/runtime.ts';

test('the Trello handlers boot against the Trello manifest', () => {
  const runtime = createServiceRuntime({ manifest: trelloManifest(), handlers: trelloHandlers, log: () => {} });

  assert.equal(runtime.manifestHash, computeManifestHash(trelloManifest()));
  assert.deepEqual(runtime.health(), {
    sdk: 1,
    sdkVersion: sdkPackage.version,
    manifestHash: computeManifestHash(trelloManifest()),
    handlers: {
      operations: ['create_card', 'delete_card', 'list_cards'],
      options: ['listBoards'],
      info: [],
      buttons: ['ping'],
      hooks: ['onProjectConfigurationSaved'],
      inbound: true,
    },
  });
});

test('an inbound-only built-in boots with no Operations', () => {
  const runtime = createServiceRuntime({
    manifest: fixtureManifest('whatsapp'),
    handlers: whatsappHandlers,
    origin: 'built_in',
    log: () => {},
  });

  assert.deepEqual(runtime.health().handlers, {
    operations: [],
    options: ['listChats'],
    info: ['webhookStatus'],
    buttons: ['showQr'],
    hooks: [],
    inbound: true,
  });
});

test('boot refuses a missing handler and names every one', () => {
  const { delete_card: _deleteCard, ...operations } = trelloHandlers.operations;
  const handlers = { ...trelloHandlers, operations, buttons: {}, inbound: undefined };

  assert.throws(
    () => createServiceRuntime({ manifest: trelloManifest(), handlers, log: () => {} }),
    (error: Error) => {
      assert.match(error.message, /missing handlers?: operations\.delete_card, buttons\.ping, inbound/i);
      return true;
    }
  );
});

test('boot refuses a handler service.json does not declare', () => {
  const handlers = { ...trelloHandlers, operations: { ...trelloHandlers.operations, archive_card: () => ({}) } };

  assert.throws(
    () => createServiceRuntime({ manifest: trelloManifest(), handlers, log: () => {} }),
    /operations\.archive_card is not declared in service\.json/
  );
});

test('boot refuses a stale manifest hash and says how to fix it', () => {
  const manifest = trelloManifest();
  manifest.operations.list_cards.description = 'List the cards on an allowed board, newest first.';

  assert.throws(
    () => createServiceRuntime({ manifest, handlers: trelloHandlers, log: () => {} }),
    /service\.types\.ts is stale.*run external-service-cli types/i
  );
});

test('boot refuses an invalid manifest with its problems', () => {
  const manifest = { ...echoManifest(), sdk: 2 };

  assert.throws(
    () =>
      createServiceRuntime({
        manifest,
        handlers: { manifestHash: computeManifestHash(manifest), operations: { echo: () => ({}) } },
        log: () => {},
      }),
    /service\.json is invalid[^]*sdk: sdk must be 1/
  );
});

test('the manifest hash ignores key order and whitespace but not content', () => {
  const manifest = echoManifest();
  const reordered = JSON.parse(
    JSON.stringify({ operations: manifest.operations, description: manifest.description, sdk: 1, displayName: 'Echo' })
  );

  assert.equal(computeManifestHash(reordered), computeManifestHash(manifest));
  assert.notEqual(computeManifestHash({ ...manifest, displayName: 'Echo 2' }), computeManifestHash(manifest));
  assert.match(computeManifestHash(manifest), /^[0-9a-f]{64}$/);
});
