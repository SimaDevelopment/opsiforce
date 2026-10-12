import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ServiceLog, ServiceState } from '@opsiforce/external-service-sdk';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';
import { testService } from '@opsiforce/external-service-sdk/testing';

import trelloHandlers from './fixtures/trello/handlers.ts';
import whatsappHandlers from './fixtures/whatsapp/handlers.ts';
import { fixtureManifest, trelloManifest } from './support/fixtures.ts';

const whatsappConfiguration = {
  channels: [{ id: 'li_sales', channelId: 'ch_1', label: 'Sales', apiToken: 'tok_1', webhookSecret: 'whsec_1' }],
};

function whatsapp() {
  return testService(fixtureManifest('whatsapp'), whatsappHandlers, {
    origin: 'built_in',
    serviceConfiguration: whatsappConfiguration,
  });
}

test('options, info and button drive the form-call handlers with unsaved values', async () => {
  const service = whatsapp();

  const options = await service.options('listChats', { query: 'ac', values: { channel: 'li_sales' } });
  const info = await service.info('webhookStatus');
  const button = await service.button('showQr');

  assert.deepEqual(options.body, [{ value: 'chat_1', label: 'Chats of li_sales' }]);
  assert.deepEqual(info.body, { text: 'Webhook on Sales', level: 'success' });
  assert.deepEqual(button.body, { link: 'https://whapi.cloud/qr', label: 'Open QR code' });
});

test('options refuses a callback service.json does not name', async () => {
  const response = await whatsapp().options('listGroups');

  assert.equal(response.status, 404);
  assert.equal(response.problem?.type, 'urn:opsiforce:error:unknown-handler');
});

const notesManifest = {
  sdk: 1,
  displayName: 'Notes',
  description: 'Keeps notes in state.',
  serviceForm: [{ key: 'token', type: 'secret' }],
  projectForm: [
    { key: 'folder', type: 'text' },
    { key: 'savedBy', type: 'info', call: 'savedBy' },
  ],
  operations: {
    add_note: {
      kind: 'write',
      description: 'Add a note.',
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
};

interface NotesContext {
  state: ServiceState;
  log: ServiceLog;
  serviceConfiguration: { token: unknown };
  caller?: { environmentId: string };
}

const notesHandlers = {
  manifestHash: computeManifestHash(notesManifest),
  operations: {
    add_note: async (input: { text: string }, ctx: NotesContext) => {
      const stored = (await ctx.state.get<string[]>('notes')) ?? [];
      await ctx.state.set('notes', [...stored, input.text]);
      ctx.log.info('note added', { token: ctx.serviceConfiguration.token, count: stored.length + 1 });
      return { count: stored.length + 1 };
    },
  },
  info: {
    savedBy: async (_request: { values: Record<string, unknown> }, ctx: NotesContext) => ({
      text: ctx.caller ? `Shown for ${ctx.caller.environmentId}` : 'No environment',
    }),
  },
  hooks: {
    onProjectConfigurationSaved: async (
      change: { previous: Record<string, unknown> | null; current: Record<string, unknown> | null },
      ctx: NotesContext
    ) => {
      await ctx.state.set('folder', change.current?.folder ?? null);
      await ctx.state.set('saved-by', ctx.caller?.environmentId ?? null);
    },
  },
};

function notes() {
  return testService(notesManifest, notesHandlers, {
    serviceConfiguration: { token: 'tok_secret' },
    projectConfiguration: { folder: 'inbox', operations: { add_note: true } },
  });
}

test('ctx.state is one memory store across calls, readable from the test', async () => {
  const service = notes();
  await service.state.set('notes', ['seeded']);

  await service.call('add_note', { text: 'first' });
  const second = await service.call('add_note', { text: 'second' });

  assert.deepEqual(second.body, { count: 3 });
  assert.deepEqual(await service.state.list(), [{ key: 'notes', value: ['seeded', 'first', 'second'] }]);
});

test('ctx.state replaces a key, deletes one and lists by prefix in key order', async () => {
  const service = notes();
  await service.state.set('board:b2', 2);
  await service.state.set('board:b1', 1);
  await service.state.set('other', 0);
  await service.state.set('board:b1', 'again');
  await service.state.delete('board:b2');

  assert.deepEqual(await service.state.list('board:'), [{ key: 'board:b1', value: 'again' }]);
  assert.equal(await service.state.get('board:b2'), undefined);
  await assert.rejects(service.state.set('', 1), /keys are 1 to 256 characters/);
});

test('ctx.log lines are captured with the callId, secrets masked', async () => {
  const service = notes();

  const response = await service.call('add_note', { text: 'first' });

  assert.equal(service.logs.length, 1);
  assert.equal(service.logs[0]?.message, 'note added');
  assert.equal(service.logs[0]?.callId, response.callId);
  assert.equal(service.logs[0]?.token, '[secret]');
});

test('hook drives an after-save hook, which answers 204', async () => {
  const service = notes();

  const response = await service.hook('onProjectConfigurationSaved', {
    previous: { folder: 'inbox' },
    current: { folder: 'archive' },
  });

  assert.equal(response.status, 204);
  assert.equal(await service.state.get('folder'), 'archive');
});

test('a Project hook sees the caller of the environment whose configuration was saved, as on the platform', async () => {
  const service = testService(notesManifest, notesHandlers, {
    serviceConfiguration: { token: 'tok_secret' },
    projectConfiguration: { folder: 'inbox', operations: { add_note: true } },
    caller: { environmentId: 'env-notes' },
  });

  await service.hook('onProjectConfigurationSaved', { previous: null, current: { folder: 'inbox' } });

  assert.equal(await service.state.get('saved-by'), 'env-notes');
});

test('a Project form call sees the caller of the environment being edited, as on the platform', async () => {
  const service = testService(notesManifest, notesHandlers, {
    serviceConfiguration: { token: 'tok_secret' },
    caller: { environmentId: 'env-notes' },
  });

  const info = await service.info('savedBy', { values: { folder: 'inbox' } });

  assert.deepEqual(info.body, { text: 'Shown for env-notes' });
});

test('a configuration the platform would never deliver is refused when the test service is made', () => {
  assert.throws(
    () => testService(trelloManifest(), trelloHandlers, { projectConfiguration: { boardIds: ['b1'] } }),
    /projectConfiguration does not fit service\.json.*workspace/
  );
  assert.throws(
    () =>
      testService(trelloManifest(), trelloHandlers, {
        serviceConfiguration: { workspaces: [{ id: 'li_1', apiKey: 'k' }] },
        projectConfiguration: { workspace: 'li_1' },
      }),
    /serviceConfiguration does not fit service\.json.*label/
  );
});

test('a handler set that does not match service.json refuses to start, as in a pod', () => {
  const { buttons: _buttons, ...withoutButtons } = trelloHandlers;

  assert.throws(
    () => testService(trelloManifest(), withoutButtons, { projectConfiguration: { workspace: 'li_1' } }),
    /missing handlers: buttons\.ping/
  );
});
