import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { parseJson, type JsonObject, type JsonValue } from './json';

export type FakePodRoute =
  | 'health'
  | 'session.list'
  | 'session.create'
  | 'session.get'
  | 'session.delete'
  | 'session.prompt'
  | 'session.message'
  | 'session.wait'
  | 'session.interrupt'
  | 'session.inbox'
  | 'session.inbox.steer'
  | 'session.inbox.cancel'
  | 'session.active'
  | 'event';

export interface RecordedPodRequest {
  route: FakePodRoute | 'unknown';
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: JsonValue;
  raw: string;
  sessionId: string | null;
  inboxId: string | null;
  receivedAt: number;
}

export interface RouteScript {
  delayMs?: number;
  status?: number;
  body?: JsonValue;
  once?: boolean;
}

export interface FakePodEvent {
  id?: string;
  event: string;
  data: JsonValue;
}

export interface SessionInfo extends JsonObject {
  id: string;
  parentID: string | null;
  projectID: string;
  title: string;
  cost: number;
  tokens: JsonObject;
  time: JsonObject;
  location: JsonObject;
}

export interface InboxEntry extends JsonObject {
  id: string;
  sessionID: string;
  timeCreated: number;
  type: 'user';
  payload: JsonObject;
  delivery: 'steer' | 'queue';
}

export interface MessagePage extends JsonObject {
  data: JsonValue[];
  cursor: { previous: string | null; next: string | null };
}

export interface FakePod {
  url: string;
  port: number;
  requests: RecordedPodRequest[];
  requestsTo: (route: FakePodRoute) => RecordedPodRequest[];
  sessions: Map<string, SessionInfo>;
  addSession: (overrides?: Partial<SessionInfo>) => SessionInfo;
  setMessages: (sessionId: string, page: MessagePage) => void;
  setActive: (sessionIds: string[]) => void;
  setHealth: (health: { status: number; body: JsonValue }) => void;
  script: (route: FakePodRoute, script: RouteScript) => void;
  clearScripts: () => void;
  replayToNewStreams: (events: FakePodEvent[]) => void;
  emit: (event: FakePodEvent) => void;
  openStreams: number;
  closeStreams: () => void;
  endStreams: () => void;
  stop: () => Promise<void>;
}

const JSON_TYPE = 'application/json';

export const podErrors = {
  sessionNotFound: (sessionID: string): JsonObject => ({
    _tag: 'SessionNotFoundError',
    sessionID,
    message: `Session ${sessionID} not found`,
  }),
  invalidRequest: (message: string, field: string | null = null): JsonObject => ({
    _tag: 'InvalidRequestError',
    message,
    field,
  }),
  invalidCursor: (message = 'Invalid cursor'): JsonObject => ({ _tag: 'InvalidCursorError', message }),
  conflict: (message: string, resource: string | null = null): JsonObject => ({
    _tag: 'ConflictError',
    message,
    resource,
  }),
  unknown: (message: string): JsonObject => ({ _tag: 'UnknownError', message, ref: null }),
  unavailable: (message: string, service: string | null = null): JsonObject => ({
    _tag: 'ServiceUnavailableError',
    message,
    service,
  }),
};

interface RouteMatch {
  route: FakePodRoute | 'unknown';
  sessionId: string | null;
  inboxId: string | null;
}

function matchRoute(method: string, pathname: string): RouteMatch {
  const unscoped = (route: FakePodRoute | 'unknown'): RouteMatch => ({ route, sessionId: null, inboxId: null });

  if (pathname === '/api/health' && method === 'GET') return unscoped('health');
  if (pathname === '/api/event' && method === 'GET') return unscoped('event');
  if (pathname === '/api/session/active' && method === 'GET') return unscoped('session.active');
  if (pathname === '/api/session') {
    if (method === 'GET') return unscoped('session.list');
    if (method === 'POST') return unscoped('session.create');
  }

  const scoped = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!scoped) return unscoped('unknown');
  const sessionId = decodeURIComponent(scoped[1]);
  const rest = scoped[2] ?? '';
  const scopedTo = (route: FakePodRoute | 'unknown', inboxId: string | null = null): RouteMatch => ({
    route,
    sessionId,
    inboxId,
  });

  if (rest === '' && method === 'GET') return scopedTo('session.get');
  if (rest === '' && method === 'DELETE') return scopedTo('session.delete');
  if (rest === '/prompt' && method === 'POST') return scopedTo('session.prompt');
  if (rest === '/message' && method === 'GET') return scopedTo('session.message');
  if (rest === '/wait' && method === 'POST') return scopedTo('session.wait');
  if (rest === '/interrupt' && method === 'POST') return scopedTo('session.interrupt');
  if (rest === '/inbox' && method === 'GET') return scopedTo('session.inbox');

  const inboxItem = /^\/inbox\/([^/]+)(\/steer)?$/.exec(rest);
  if (inboxItem) {
    const inboxId = decodeURIComponent(inboxItem[1]);
    if (inboxItem[2] === '/steer' && method === 'POST') return scopedTo('session.inbox.steer', inboxId);
    if (inboxItem[2] === undefined && method === 'DELETE') return scopedTo('session.inbox.cancel', inboxId);
  }
  return scopedTo('unknown');
}

function sendJson(res: ServerResponse, status: number, body: JsonValue): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function sessionNotFound(res: ServerResponse, sessionId: string | null): void {
  sendJson(res, 404, podErrors.sessionNotFound(sessionId ?? ''));
}

function writeEvent(res: ServerResponse, event: FakePodEvent): void {
  if (event.id !== undefined) res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.event}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

function createdAt(session: SessionInfo): number {
  const time = session.time;
  const created = typeof time === 'object' && time !== null && !Array.isArray(time) ? time.created : 0;
  return typeof created === 'number' ? created : 0;
}

function asObject(value: JsonValue): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function asOptionalString(value: JsonValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function withSkillName(skill: JsonValue): JsonObject {
  const requested = asObject(skill);
  return { ...requested, name: asOptionalString(requested.name) ?? asOptionalString(requested.id) ?? 'skill' };
}

export async function startFakePod(): Promise<FakePod> {
  const requests: RecordedPodRequest[] = [];
  const sessions = new Map<string, SessionInfo>();
  const messages = new Map<string, MessagePage>();
  const inboxes = new Map<string, InboxEntry[]>();
  const admissions = new Map<string, InboxEntry>();
  const scripts = new Map<FakePodRoute, RouteScript>();
  const streams = new Set<ServerResponse>();
  let active: string[] = [];
  let health: { status: number; body: JsonValue } = { status: 200, body: { healthy: true, version: '1.18.4', pid: 1 } };
  let replayed: FakePodEvent[] = [];
  let sessionCounter = 0;
  let messageCounter = 0;

  const nextSessionId = (): string => `ses_${(++sessionCounter).toString().padStart(24, '0')}`;
  const nextMessageId = (): string => `msg_${(++messageCounter).toString().padStart(24, '0')}`;

  function addSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
    const now = Date.now();
    const session: SessionInfo = {
      id: overrides.id ?? nextSessionId(),
      parentID: null,
      projectID: 'prj_fake',
      title: 'Fake session',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
      location: { type: 'directory', path: '/workspace/project' },
      ...overrides,
    };
    sessions.set(session.id, session);
    return session;
  }

  function takeScript(route: FakePodRoute): RouteScript | undefined {
    const script = scripts.get(route);
    if (script?.once) scripts.delete(route);
    return script;
  }

  function openStream(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    streams.add(res);
    res.on('close', () => streams.delete(res));
    for (const event of replayed) writeEvent(res, event);
  }

  function respondForSession(session: SessionInfo, request: RecordedPodRequest, res: ServerResponse): void {
    switch (request.route) {
      case 'session.get':
        return sendJson(res, 200, { data: session });
      case 'session.delete':
        sessions.delete(session.id);
        return sendNoContent(res);
      case 'session.prompt': {
        const prompt = asObject(request.body);
        const { id: requested, delivery, ...rest } = prompt;
        const payload = { ...rest, ...(Array.isArray(rest.skills) ? { skills: rest.skills.map(withSkillName) } : {}) };
        const id = asOptionalString(requested) ?? nextMessageId();
        const entry: InboxEntry = {
          id,
          sessionID: session.id,
          timeCreated: Date.now(),
          type: 'user',
          payload,
          delivery: delivery === 'steer' ? 'steer' : 'queue',
        };
        const admitted = admissions.get(id);
        if (admitted) {
          if (JSON.stringify(admitted.payload) !== JSON.stringify(entry.payload)) {
            return sendJson(res, 409, podErrors.conflict(`Prompt message ID conflicts: ${id}`, id));
          }
          return sendJson(res, 200, { data: admitted });
        }
        admissions.set(id, entry);
        inboxes.set(session.id, [...(inboxes.get(session.id) ?? []), entry]);
        return sendJson(res, 200, { data: entry });
      }
      case 'session.message': {
        if (request.query.cursor && request.query.order) {
          return sendJson(res, 400, podErrors.invalidCursor('cursor cannot be combined with order'));
        }
        return sendJson(res, 200, messages.get(session.id) ?? { data: [], cursor: { previous: null, next: null } });
      }
      case 'session.wait':
        return sendNoContent(res);
      case 'session.interrupt': {
        const interrupted = active.includes(session.id);
        active = active.filter((id) => id !== session.id);
        return sendJson(res, 200, { interrupted });
      }
      case 'session.inbox':
        return sendJson(res, 200, { data: inboxes.get(session.id) ?? [] });
      case 'session.inbox.steer': {
        const items = inboxes.get(session.id) ?? [];
        const steered = items.map((item) =>
          item.id === request.inboxId ? { ...item, delivery: 'steer' as const } : item
        );
        inboxes.set(session.id, steered);
        return sendNoContent(res);
      }
      case 'session.inbox.cancel': {
        const items = inboxes.get(session.id) ?? [];
        inboxes.set(
          session.id,
          items.filter((item) => item.id !== request.inboxId)
        );
        return sendNoContent(res);
      }
      default:
        return sessionNotFound(res, session.id);
    }
  }

  function respond(request: RecordedPodRequest, res: ServerResponse): void {
    switch (request.route) {
      case 'unknown':
        return sendJson(res, 404, podErrors.unknown(`No route for ${request.method} ${request.path}`));
      case 'event':
        return openStream(res);
      case 'health':
        return sendJson(res, health.status, health.body);
      case 'session.list': {
        const wantsRoots = request.query.parentID === 'null';
        const listed = [...sessions.values()].filter((session) => !wantsRoots || session.parentID === null);
        const ordered = listed.toSorted((a, b) =>
          request.query.order === 'desc' ? createdAt(b) - createdAt(a) : createdAt(a) - createdAt(b)
        );
        const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
        const page = limit === undefined ? ordered : ordered.slice(0, limit);
        return sendJson(res, 200, { data: page, cursor: { previous: null, next: null } });
      }
      case 'session.create': {
        const requested = asObject(request.body);
        const overrides: Partial<SessionInfo> = {};
        const id = asOptionalString(requested.id);
        const title = asOptionalString(requested.title);
        const parentID = asOptionalString(requested.parentID);
        if (id !== undefined) overrides.id = id;
        if (title !== undefined) overrides.title = title;
        if (parentID !== undefined) overrides.parentID = parentID;
        return sendJson(res, 200, { data: addSession(overrides) });
      }
      case 'session.active':
        return sendJson(res, 200, { data: Object.fromEntries(active.map((id) => [id, { type: 'running' }])) });
      default: {
        const session = request.sessionId === null ? undefined : sessions.get(request.sessionId);
        if (!session) return sessionNotFound(res, request.sessionId);
        return respondForSession(session, request, res);
      }
    }
  }

  async function record(req: IncomingMessage): Promise<RecordedPodRequest> {
    const url = new URL(req.url ?? '/', 'http://fake-pod');
    const method = req.method ?? 'GET';
    const raw = await text(req);
    const { route, sessionId, inboxId } = matchRoute(method, url.pathname);
    const request: RecordedPodRequest = {
      route,
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: parseJson(raw),
      raw,
      sessionId,
      inboxId,
      receivedAt: Date.now(),
    };
    requests.push(request);
    return request;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const request = await record(req);
      if (request.route === 'unknown') return respond(request, res);

      const script = takeScript(request.route);
      if (script?.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      if (script?.status !== undefined) {
        if (script.status === 204) return sendNoContent(res);
        return sendJson(res, script.status, script.body ?? null);
      }
      if (script?.body !== undefined) return sendJson(res, 200, script.body);

      respond(request, res);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? (address as AddressInfo).port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    requestsTo: (route) => requests.filter((entry) => entry.route === route),
    sessions,
    addSession,
    setMessages: (sessionId, page) => messages.set(sessionId, page),
    setActive: (sessionIds) => {
      active = [...sessionIds];
    },
    setHealth: (next) => {
      health = next;
    },
    script: (route, script) => scripts.set(route, script),
    clearScripts: () => scripts.clear(),
    replayToNewStreams: (events) => {
      replayed = [...events];
    },
    emit: (event) => {
      for (const stream of streams) writeEvent(stream, event);
    },
    get openStreams() {
      return streams.size;
    },
    closeStreams: () => {
      for (const stream of streams) stream.destroy();
      streams.clear();
    },
    endStreams: () => {
      for (const stream of streams) stream.end();
      streams.clear();
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        for (const stream of streams) stream.destroy();
        streams.clear();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
