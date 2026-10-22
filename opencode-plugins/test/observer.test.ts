import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startObserver } from '../observer/observe.ts';
import { GATEWAY_KEY, GATEWAY_URL, bodies, fakeHost, settle } from './support/fake-host.ts';

test('a started execution is posted to the gateway as run.started with the gateway key', async () => {
  const host = fakeHost();
  const stop = startObserver(host);

  host.emit({ type: 'session.execution.started', data: { sessionID: 'ses_1' } });
  await settle();
  stop();

  assert.deepEqual(host.posts, [
    {
      url: `${GATEWAY_URL}/agent/observations`,
      authorization: `Bearer ${GATEWAY_KEY}`,
      contentType: 'application/json',
      body: { kind: 'run.started', sessionId: 'ses_1' },
    },
  ]);
});

const terminalEvents = [
  { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } },
  { type: 'session.execution.failed', data: { sessionID: 'ses_1', error: { type: 'provider', message: 'boom' } } },
  ...['user', 'shutdown', 'superseded', 'inactivity'].map((reason) => ({
    type: 'session.execution.interrupted',
    data: { sessionID: 'ses_1', reason },
  })),
];

for (const event of terminalEvents) {
  const reason = 'reason' in event.data ? ` (${event.data.reason})` : '';
  test(`${event.type}${reason} is posted as run.ended`, async () => {
    const host = fakeHost();
    const stop = startObserver(host);

    host.emit(event);
    await settle();
    stop();

    assert.deepEqual(bodies(host), [{ kind: 'run.ended', sessionId: 'ses_1' }]);
  });
}

const sessions = { ses_root: {}, ses_child: { parentID: 'ses_root' } };

test('a renamed session is posted as titled with its title and whether it is a root', async () => {
  const host = fakeHost({ sessions });
  const stop = startObserver(host);

  host.emit({ type: 'session.renamed', data: { sessionID: 'ses_root', title: 'Book club tracker' } });
  await settle();
  host.emit({ type: 'session.renamed', data: { sessionID: 'ses_child', title: 'Explore the schema' } });
  await settle();
  stop();

  assert.deepEqual(bodies(host), [
    { kind: 'titled', sessionId: 'ses_root', root: true, title: 'Book club tracker' },
    { kind: 'titled', sessionId: 'ses_child', root: false, title: 'Explore the schema' },
  ]);
});

const userItem = { type: 'user', payload: { text: 'hi' }, delivery: 'steer' };

test('a user item entering an inbox is posted as prompted with whether the session is a root', async () => {
  const host = fakeHost({ sessions });
  const stop = startObserver(host);

  host.emit({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_root', inboxID: 'msg_1', item: userItem } });
  await settle();
  host.emit({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_child', inboxID: 'msg_2', item: userItem } });
  await settle();
  stop();

  assert.deepEqual(bodies(host), [
    { kind: 'prompted', sessionId: 'ses_root', root: true },
    { kind: 'prompted', sessionId: 'ses_child', root: false },
  ]);
});

for (const type of ['synthetic', 'compaction', 'move']) {
  test(`a ${type} inbox item is not posted`, async () => {
    const host = fakeHost({ sessions });
    const stop = startObserver(host);

    host.emit({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_root', inboxID: 'msg_1', item: { type } } });
    await settle();
    stop();

    assert.deepEqual(host.posts, []);
  });
}

test('events the observer does not map are not posted', async () => {
  const host = fakeHost({ sessions });
  const stop = startObserver(host);

  host.emit({ type: 'session.inbox.delivered', data: { sessionID: 'ses_root' } });
  host.emit({ type: 'session.created', data: { sessionID: 'ses_root' } });
  host.emit({ type: 'plugin.updated' });
  await settle();
  stop();

  assert.deepEqual(host.posts, []);
});

const started = (sessionID: string) => ({ type: 'session.execution.started', data: { sessionID } });

test('a failing post is retried a few times with growing backoff, then dropped and logged', async () => {
  const host = fakeHost({ respond: () => new Response('down', { status: 503 }) });
  const stop = startObserver(host);

  host.emit(started('ses_1'));
  await settle();
  stop();

  assert.equal(host.posts.length, 4);
  assert.deepEqual(host.sleeps, [1500, 3000, 4500]);
  assert.ok(host.logged.some((line) => String(line[0]).includes('dropped after 4 attempts')));
});

test('a post that succeeds on a retry is delivered once and nothing is dropped', async () => {
  const host = fakeHost({
    respond: (attempt) => {
      if (attempt === 1) throw new TypeError('fetch failed');
      return new Response(null, { status: attempt === 2 ? 502 : 202 });
    },
  });
  const stop = startObserver(host);

  host.emit(started('ses_1'));
  await settle();
  stop();

  assert.equal(host.posts.length, 3);
  assert.ok(!host.logged.some((line) => String(line[0]).includes('dropped')));
});

test('after a dropped observation the next event is still posted', async () => {
  const host = fakeHost({ respond: (attempt) => new Response(null, { status: attempt <= 4 ? 503 : 202 }) });
  const stop = startObserver(host);

  host.emit(started('ses_1'));
  await settle();
  host.emit(started('ses_2'));
  await settle();
  stop();

  assert.deepEqual(bodies(host).at(-1), { kind: 'run.started', sessionId: 'ses_2' });
  assert.equal(host.posts.length, 5);
});

test('a throwing handler is logged and the consumer keeps going', async () => {
  const host = fakeHost({ sessions });
  const stop = startObserver(host);

  host.emit({ type: 'session.renamed', data: { sessionID: 'ses_gone', title: 'Lost' } });
  await settle();
  host.emit(started('ses_root'));
  await settle();
  stop();

  assert.ok(host.logged.some((line) => String(line[0]).includes('threw')));
  assert.deepEqual(bodies(host), [{ kind: 'run.started', sessionId: 'ses_root' }]);
});

test('a failed event stream is logged and resubscribed', async () => {
  const host = fakeHost();
  const stop = startObserver(host);

  host.emit(started('ses_1'));
  host.failStream(new Error('encode failed'));
  await settle();
  host.emit(started('ses_2'));
  await settle();
  stop();

  assert.equal(host.subscriptions, 2);
  assert.ok(host.logged.some((line) => String(line[0]).includes('event stream failed')));
  assert.deepEqual(bodies(host), [
    { kind: 'run.started', sessionId: 'ses_1' },
    { kind: 'run.started', sessionId: 'ses_2' },
  ]);
});

test('after stop the subscription ends and nothing more is posted', async () => {
  const host = fakeHost();
  const stop = startObserver(host);
  stop();

  host.emit(started('ses_1'));
  await settle();

  assert.deepEqual(host.posts, []);
});

for (const [name, env] of [
  ['the gateway URL', { SERVICE_GATEWAY_API_KEY: GATEWAY_KEY }],
  ['the gateway key', { SERVICE_GATEWAY_URL: GATEWAY_URL }],
  ['both', {}],
  ['an empty gateway key', { SERVICE_GATEWAY_URL: GATEWAY_URL, SERVICE_GATEWAY_API_KEY: '' }],
] as const) {
  test(`starting throws when ${name} is missing`, () => {
    const host = fakeHost({ env });

    assert.throws(() => startObserver(host), /opsiforce\.observer: SERVICE_GATEWAY_URL and SERVICE_GATEWAY_API_KEY/);
    assert.equal(host.subscriptions, 0);
  });
}

test('starting returns at once with the consumer running and no I/O awaited', async () => {
  const host = fakeHost({ sessions });
  host.getSession = () => new Promise(() => {});
  host.fetch = () => new Promise(() => {});

  const stop = startObserver(host);

  assert.equal(typeof stop, 'function');
  assert.equal(host.subscriptions, 1);
  host.emit({ type: 'session.renamed', data: { sessionID: 'ses_root', title: 'Hangs' } });
  await settle();
  stop();
});
