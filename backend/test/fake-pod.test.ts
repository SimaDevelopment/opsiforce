import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { podErrors, startFakePod, type FakePod, type FakePodEvent } from './support/fake-pod';
import type { JsonValue } from './support/json';

let pod: FakePod;

beforeEach(async () => {
  pod = await startFakePod();
});

afterEach(async () => {
  await pod.stop();
});

function bodyOf(res: Response): ReadableStream<Uint8Array> {
  if (res.body === null) throw new Error('response has no body');
  return res.body;
}

async function readFrames(res: Response, frameCount: number): Promise<string[]> {
  const reader = bodyOf(res).getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const frames: string[] = [];
  while (frames.length < frameCount) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const parts = buffered.split('\n\n');
    buffered = parts.pop() ?? '';
    frames.push(...parts.filter((part) => part.length > 0));
  }
  return frames;
}

const event = (kind: string, data: JsonValue, id?: string): FakePodEvent => ({ id, event: kind, data });

describe('the fake pod session routes', () => {
  it('serves the routes the public API talks to and records every request', async () => {
    const session = pod.addSession({ title: 'Primary' });

    const listed = await fetch(`${pod.url}/api/session`);
    expect(await listed.json()).toMatchObject({ data: [{ id: session.id, title: 'Primary' }] });

    const created = await fetch(`${pod.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Second' }),
    });
    expect(await created.json()).toMatchObject({ data: { title: 'Second' } });

    const info = await fetch(`${pod.url}/api/session/${session.id}`);
    expect(await info.json()).toMatchObject({ data: { id: session.id } });

    const prompted = await fetch(`${pod.url}/api/session/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', delivery: 'queue' }),
    });
    expect(await prompted.json()).toMatchObject({
      data: { sessionID: session.id, type: 'user', delivery: 'queue', payload: { text: 'hello' } },
    });

    const inbox = await fetch(`${pod.url}/api/session/${session.id}/inbox`);
    expect(await inbox.json()).toMatchObject({ data: [{ payload: { text: 'hello' } }] });

    pod.setMessages(session.id, { data: [{ id: 'msg_1', role: 'user' }], cursor: { previous: null, next: 'next-1' } });
    const listedMessages = await fetch(`${pod.url}/api/session/${session.id}/message?limit=1`);
    expect(await listedMessages.json()).toMatchObject({ cursor: { next: 'next-1' } });

    const waited = await fetch(`${pod.url}/api/session/${session.id}/wait`, { method: 'POST' });
    expect(waited.status).toBe(204);

    pod.setActive([session.id]);
    const activeBefore = await fetch(`${pod.url}/api/session/active`);
    expect(await activeBefore.json()).toEqual({ data: { [session.id]: { type: 'running' } } });

    const interrupted = await fetch(`${pod.url}/api/session/${session.id}/interrupt`, { method: 'POST' });
    expect(await interrupted.json()).toEqual({ interrupted: true });

    const activeAfter = await fetch(`${pod.url}/api/session/active`);
    expect(await activeAfter.json()).toEqual({ data: {} });

    expect(pod.requests.map((entry) => entry.route)).toEqual([
      'session.list',
      'session.create',
      'session.get',
      'session.prompt',
      'session.inbox',
      'session.message',
      'session.wait',
      'session.active',
      'session.interrupt',
      'session.active',
    ]);
    expect(pod.requestsTo('session.prompt')[0]).toMatchObject({
      sessionId: session.id,
      body: { text: 'hello' },
    });
    expect(pod.requestsTo('session.message')[0].query).toEqual({ limit: '1' });
  });

  it('answers 404 for an unknown session and for an unknown route', async () => {
    const missingSession = await fetch(`${pod.url}/api/session/ses_missing`);
    expect(missingSession.status).toBe(404);
    expect(await missingSession.json()).toEqual(podErrors.sessionNotFound('ses_missing'));

    const missingRoute = await fetch(`${pod.url}/api/session/ses_missing/compact`, { method: 'POST' });
    expect(missingRoute.status).toBe(404);
    expect(pod.requests.at(-1)?.route).toBe('unknown');
  });
});

describe('scripting the fake pod', () => {
  it('delays a scripted response', async () => {
    const session = pod.addSession();
    pod.script('session.get', { delayMs: 150 });

    const started = Date.now();
    const res = await fetch(`${pod.url}/api/session/${session.id}`);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('returns a scripted error status and body, once or stickily', async () => {
    const session = pod.addSession();

    pod.script('session.prompt', { status: 409, body: podErrors.conflict('busy', 'msg_1'), once: true });
    const conflict = await fetch(`${pod.url}/api/session/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual(podErrors.conflict('busy', 'msg_1'));

    const recovered = await fetch(`${pod.url}/api/session/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi again' }),
    });
    expect(recovered.status).toBe(200);

    pod.script('session.active', { status: 503, body: podErrors.unavailable('pod restarting') });
    expect((await fetch(`${pod.url}/api/session/active`)).status).toBe(503);
    expect((await fetch(`${pod.url}/api/session/active`)).status).toBe(503);

    pod.clearScripts();
    expect((await fetch(`${pod.url}/api/session/active`)).status).toBe(200);
  });
});

describe('the fake pod event stream', () => {
  it('replays a scripted sequence and pushes live events to every subscriber', async () => {
    pod.replayToNewStreams([event('server.connected', {}, '1')]);

    const first = await fetch(`${pod.url}/api/event`);
    const second = await fetch(`${pod.url}/api/event`);
    expect(first.headers.get('content-type')).toBe('text/event-stream');
    expect(pod.openStreams).toBe(2);

    pod.emit(event('session.text.delta', { sessionID: 'ses_1', text: 'hi' }, '2'));

    const [firstFrames, secondFrames] = await Promise.all([readFrames(first, 2), readFrames(second, 2)]);

    expect(firstFrames).toEqual([
      'id: 1\nevent: server.connected\ndata: {}',
      'id: 2\nevent: session.text.delta\ndata: {"sessionID":"ses_1","text":"hi"}',
    ]);
    expect(secondFrames).toEqual(firstFrames);
  });

  it('drops an open stream mid-flight', async () => {
    const res = await fetch(`${pod.url}/api/event`);
    const reader = bodyOf(res).getReader();

    pod.emit(event('session.execution.started', { sessionID: 'ses_1' }));
    const firstRead = await reader.read();
    expect(new TextDecoder().decode(firstRead.value)).toContain('session.execution.started');

    pod.closeStreams();
    await expect(reader.read()).rejects.toThrow();
    expect(pod.openStreams).toBe(0);
  });

  it('ends an open stream cleanly', async () => {
    const res = await fetch(`${pod.url}/api/event`);
    const reader = bodyOf(res).getReader();

    pod.endStreams();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(pod.openStreams).toBe(0);
  });
});
