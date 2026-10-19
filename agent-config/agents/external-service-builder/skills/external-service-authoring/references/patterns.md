# Patterns

Short, generic snippets for the pieces most services need. Each says which upstreams it fits; adapt the
names to the upstream's own words and keep the shape. The SDK's own tests cover what they rely on.

## Contents

1. Credentials: a header, a query key, a per-Project secret
2. A minted-token cache
3. A lookup: from an item to its target
4. `through`: filtering a list, narrowing a search
5. One endpoint, many operations: body dispatch
6. A `text/plain` refusal for CLIs
7. An access-level helper
8. A per-Project quota
9. A webhook that delivers
10. A client shim

## 1. Credentials: a header, a query key, a per-Project secret

Fits every upstream; pick the form its docs use. The SDK strips the caller's credentials and any query
key you set before adding these.

```ts
export const api = upstream<Manifest>({
  name: 'api',
  api: 'Boards REST API v1',
  url: ({ serviceConfiguration }) => serviceConfiguration.baseUrl ?? 'https://api.example.com',
  credentials: ({ serviceConfiguration }) => ({
    headers: { authorization: `Bearer ${serviceConfiguration.apiToken.reveal()}` },
  }),
});

export const keyed = upstream<Manifest>({
  name: 'keyed',
  api: 'Boards REST API v1',
  url: 'https://api.example.com',
  credentials: ({ serviceConfiguration }) => ({
    query: { key: serviceConfiguration.apiKey, token: serviceConfiguration.apiToken },
  }),
});

export const personal = upstream<Manifest>({
  name: 'personal',
  api: 'Boards REST API v1, as the Project',
  url: 'https://api.example.com',
  mount: '/me',
  credentials: ({ projectConfiguration }) =>
    projectConfiguration?.personalToken
      ? { headers: { authorization: `Bearer ${projectConfiguration.personalToken.reveal()}` } }
      : {},
});
```

A query key is added to every forwarded request and lookup, so callers never send it and the Service
skill tells them to leave it out of the upstream's examples. A per-Project secret is a `secret` field in
the Project form; its routes' checks refuse a Project that left it empty, naming that setting.

## 2. A minted-token cache

Fits upstreams that issue short-lived tokens from long-lived credentials: app installations signing a
JWT with a private key, OAuth client credentials, refresh tokens. One token per credential set, renewed
before it expires, shared by concurrent requests.

```ts
import { createHash } from 'node:crypto';

import type { Manifest } from '../service.types.ts';

type Minted = { token: string; expiresAt: number };

const renewBeforeMs = 5 * 60_000;
const minted = new Map<string, Promise<Minted>>();

export async function accessToken(configuration: Manifest['serviceConfiguration']): Promise<string> {
  const clientId = configuration.clientId ?? '';
  const clientSecret = configuration.clientSecret?.reveal() ?? '';
  const key = createHash('sha256').update(`${clientId}\n${clientSecret}`).digest('hex');
  const current = await minted.get(key)?.catch(() => undefined);
  if (current && current.expiresAt - renewBeforeMs > Date.now()) return current.token;
  const next = mint(clientId, clientSecret);
  minted.set(key, next);
  return (await next).token;
}

async function mint(clientId: string, clientSecret: string): Promise<Minted> {
  const answer = await fetch('https://auth.example.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!answer.ok) throw new Error(`the token endpoint refused the client credentials (${answer.status})`);
  const { access_token, expires_in } = (await answer.json()) as { access_token: string; expires_in: number };
  return { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
}
```

Then the upstream uses it:

```ts
credentials: async ({ serviceConfiguration }) => ({
  headers: { authorization: `Bearer ${await accessToken(serviceConfiguration)}` },
}),
```

The cache lives in process memory only, keyed by a hash so a Rotate gets a new token; never write a
token to `ctx.state`, a file or a log. For a git upstream the same token usually goes as Basic
credentials, in the user name and password form its docs give, through a second upstream with its own
`credentials`.

## 3. A lookup: from an item to its target

Fits every upstream whose ids name an item without its target: a card id without its board, a ticket
id without its queue, a global node id without its project. Look the target up with the
upstream's own credentials before allowing the request.

```ts
async function boardOfCard(ctx: RouteContext<Manifest>, cardId: string): Promise<string | undefined> {
  const answer = await api.fetch(ctx, `/v1/cards/${encodeURIComponent(cardId)}`);
  if (!answer.ok) return undefined;
  return ((await answer.json()) as { boardId?: string }).boardId;
}

route<Manifest>('PUT|DELETE /v1/cards/:card/**', {
  to: api,
  summary: 'Change a card on a board this Project may change',
  allowedBy: ['boards'],
  check: async (_request, ctx) => needs(ctx, await boardOfCard(ctx, ctx.params.card ?? ''), 'cards', 'Changing a card'),
}),
```

A move or copy names a second target (the list it moves to): look that one up too. Keep no cache: items
move between targets.

## 4. `through`: filtering a list, narrowing a search

Fits list endpoints the upstream cannot scope ("my boards", "my projects") and searches that accept
a target qualifier.

```ts
route<Manifest>('GET /v1/me/boards', {
  to: api,
  summary: 'Your boards, only the ones this Project is given',
  allowedBy: ['boards'],
  check: allowAll,
  through: async (_request, ctx, forward) => {
    const answer = await forward();
    if (!answer.ok) return answer;
    const allowed = allowedBoards(ctx);
    const boards = (await answer.json()) as { id: string }[];
    return Response.json(
      boards.filter((board) => allowed.has(board.id)),
      { status: answer.status, headers: answer.headers }
    );
  },
}),
route<Manifest>('GET /v1/search', {
  to: api,
  summary: 'Search, narrowed to the boards this Project is given',
  allowedBy: ['boards'],
  check: allowAll,
  through: async (request, ctx, forward) => {
    const url = new URL(request.url);
    url.searchParams.set('boards', [...allowedBoards(ctx)].join(','));
    return forward(new Request(url, request));
  },
}),
```

When the qualifier lives inside a free-text query (`board:Roadmap is:open`), read the upstream's query
rules first: many upstreams OR a repeated qualifier, so appending the allowed targets to the caller's
own would widen the search. Keep the caller's targets that are allowed, refuse a search that names only
targets outside the settings (naming them), and add every allowed target when the caller named none.
Filter the answer as well when the query language leaves any doubt. A filtered page may come back
shorter than the page size, and a total or a next-page link the upstream computed may count what was
filtered out or point at the upstream's own host: recompute or drop those, and say so in the Service
skill.

## 5. One endpoint, many operations: body dispatch

Fits GraphQL, JSON-RPC and MCP: one route whose check reads the body, dispatches by method, operation or
tool, and refuses whatever is not listed. Each group file exports its entries, and the route collects
them.

```ts
type MethodCheck = (params: Record<string, unknown>, ctx: RouteContext<Manifest>) => Verdict | Promise<Verdict>;

const methods: Record<string, MethodCheck> = {
  'boards.get': (params, ctx) => needs(ctx, String(params.boardId ?? ''), 'read', 'Reading a board'),
  'cards.archive': (params, ctx) => needs(ctx, String(params.boardId ?? ''), 'cards', 'Archiving a card'),
};

route<Manifest>('POST /rpc', {
  to: api,
  summary: 'JSON-RPC: only the methods listed per group',
  allowedBy: ['boards'],
  check: async (request, ctx) => {
    const body = (await request.json().catch(() => null)) as { method?: unknown; params?: unknown } | null;
    const method = typeof body?.method === 'string' ? body.method : '';
    const methodCheck = methods[method];
    if (!methodCheck) return ctx.notSupported(`JSON-RPC method "${method}" is not supported by this service`);
    ctx.note({ method });
    return methodCheck((body?.params ?? {}) as Record<string, unknown>, ctx);
  },
}),
```

For GraphQL, parse with the `graphql` package (`yarn add graphql`) and check each top-level field of the
one operation sent; a batch (a JSON array body) is refused the same way:

```ts
import { Kind, parse, valueFromASTUntyped, type DocumentNode, type OperationDefinitionNode } from 'graphql';

const fields: Record<string, MethodCheck> = {
  'query board': (args, ctx) => needs(ctx, String(args.id ?? ''), 'read', 'Reading a board'),
  'mutation archiveCard': async (args, ctx) =>
    needs(ctx, await boardOfCard(ctx, String((args.input as { cardId?: string } | undefined)?.cardId ?? '')), 'cards', 'Archiving a card'),
};

async function checkGraphql(request: Request, ctx: RouteContext<Manifest>): Promise<Verdict> {
  const body = (await request.json().catch(() => null)) as
    | { query?: unknown; variables?: Record<string, unknown>; operationName?: string }
    | null;
  let document: DocumentNode;
  try {
    document = parse(typeof body?.query === 'string' ? body.query : '');
  } catch {
    return ctx.notSupported('Send one GraphQL document in "query"');
  }
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION
  );
  const operation = body?.operationName
    ? operations.find((candidate) => candidate.name?.value === body.operationName)
    : operations.length === 1 ? operations[0] : undefined;
  if (!operation) return ctx.notSupported('Send one GraphQL operation, or name it with operationName');
  for (const selection of operation.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) return ctx.notSupported('Top-level fragments are not supported here');
    const name = `${operation.operation} ${selection.name.value}`;
    const fieldCheck = fields[name];
    if (!fieldCheck) return ctx.notSupported(`GraphQL ${name} is not supported by this service`);
    const args = Object.fromEntries(
      (selection.arguments ?? []).map((argument) => [argument.name.value, valueFromASTUntyped(argument.value, body?.variables)])
    );
    const verdict = await fieldCheck(args, ctx);
    if (verdict.verdict !== 'allow') return verdict;
  }
  ctx.note({ operation: operation.name?.value ?? operation.operation });
  return ctx.allow();
}
```

List every query a caller's client sends at login and for each action (introspection such as
`__type`, `viewer`), found in step 2 of the order of work. For MCP, `tools/call` dispatches by
`params.name`, and `tools/list` is a `through` that drops the tools the Project may not call.

## 6. A `text/plain` refusal for CLIs

Fits clients that print a plain body and not JSON: git over HTTP (shown as `remote:` lines) and many
vendor CLIs.

```ts
import type { Refusal } from '@opsiforce/external-service-sdk';

const plainTextPaths = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function refusal(refusal: Refusal, request: Request): Response | undefined {
  if (!plainTextPaths.test(new URL(request.url).pathname)) return undefined;
  return new Response(`${refusal.message}\n`, {
    status: refusal.status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
```

Pass it as `defineService({ …, refusal })`. Keep the default JSON for everything a JSON client reads
(`{ "message" }` is what most REST CLIs print); `refusal.message` already holds the setting and link.

## 7. An access-level helper

Fits every service whose settings are a list of target + access level. Every group's check calls it,
so a refusal always reads the same way.

```ts
import type { RouteContext, Verdict } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../service.types.ts';

const levels = ['read', 'cards', 'admin'] as const;

export type Level = (typeof levels)[number];

const levelLabels: Record<Level, string> = { read: 'Read', cards: 'Change cards', admin: 'Change the board' };

export function levelOn(ctx: RouteContext<Manifest>, boardId: string): Level | undefined {
  const given = ctx.projectConfiguration.boards?.find((entry) => entry.boardId === boardId);
  return given ? (given.access ?? 'read') : undefined;
}

export function needs(ctx: RouteContext<Manifest>, boardId: string | undefined, level: Level, what: string): Verdict {
  const given = boardId === undefined ? undefined : levelOn(ctx, boardId);
  if (given !== undefined && levels.indexOf(given) >= levels.indexOf(level)) return ctx.allow();
  return ctx.notAllowed({
    setting: 'boards',
    message:
      given === undefined
        ? `${what}: board ${boardId ?? '(unknown)'} is not in this Project's Boards`
        : `${what} needs ${levelLabels[level]} on board ${boardId}; this Project has ${levelLabels[given]}`,
  });
}

export function allowedBoards(ctx: RouteContext<Manifest>): Set<string> {
  return new Set((ctx.projectConfiguration.boards ?? []).map((entry) => entry.boardId));
}
```

Normalise ids the way the upstream compares them (lower-case names when the upstream ignores case) on
both sides of the comparison.

## 8. A per-Project quota

Fits a shared upstream limit one looping Agent could burn for every Project (an hourly API quota,
messages sent to people outside the Organization). The cap is a setting; the count is `ctx.state`,
atomic per key. A counter would only display it.

```ts
const keyOf = (ctx: RouteContext<Manifest>) =>
  `cards-created:${ctx.caller.projectEnvironmentId}:${new Date().toISOString().slice(0, 10)}`;

export async function withinDailyQuota(ctx: RouteContext<Manifest>): Promise<Verdict> {
  const cap = ctx.projectConfiguration.cardsPerDay ?? 20;
  let admitted = false;
  await ctx.state.update<number>(keyOf(ctx), (used = 0) => {
    admitted = used < cap;
    return admitted ? used + 1 : used;
  });
  if (admitted) return ctx.allow();
  return ctx.notAllowed({ setting: 'cardsPerDay', message: `This Project already created ${cap} cards today` });
}

export async function giveBack(ctx: RouteContext<Manifest>): Promise<void> {
  await ctx.state.update<number>(keyOf(ctx), (used = 0) => Math.max(0, used - 1));
}
```

Call `withinDailyQuota` last in the check, and in `through` give the slot back when the upstream did not
answer `ok` (and `ctx.count` the success). Old day keys can be deleted by a `background` sweep with
`service.state.list('cards-created:')`.

## 9. A webhook that delivers

Fits every upstream that posts events. Verify, pick receivers by their settings, deliver, return
nothing (`references/inbound.md` has the rules and the tests). Replace `signedBy` with the upstream's
own signature scheme:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WebhookHandler } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../service.types.ts';

function signedBy(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const webhook: WebhookHandler<Manifest> = async (request, ctx) => {
  const body = await request.text();
  if (!signedBy(ctx.serviceConfiguration.signingSecret?.reveal() ?? '', body, request.headers.get('x-signature') ?? '')) {
    return new Response('signature does not match', { status: 401 });
  }
  const delivery = JSON.parse(body) as { id: string; action: 'card.created' | 'card.moved'; at: string; boardId: string; cardId: string };
  const receivers = (await ctx.service.projectConfigurations()).filter(
    ({ projectConfiguration }) =>
      projectConfiguration.notifyOn?.includes(delivery.action) &&
      projectConfiguration.boards?.some((entry) => entry.boardId === delivery.boardId)
  );
  if (receivers.length === 0) return undefined;
  await ctx.service.deliver(
    { type: delivery.action, key: delivery.id, occurredAt: delivery.at, data: { boardId: delivery.boardId, cardId: delivery.cardId } },
    { to: receivers.map((receiver) => receiver.projectEnvironmentId) }
  );
  return undefined;
};
```

## 10. A client shim

Fits a CLI that treats the Service host as a self-hosted instance and asks it something at startup the
upstream the service forwards to does not answer (a version or meta document only the self-hosted
edition serves). Answer just that request, with what the client reads, and say why in the summary:

```ts
route<Manifest>('GET /api/meta', {
  summary: 'Client shim: the version document the CLI asks a self-hosted instance for at login',
  allowedBy: [],
  check: allowAll,
  handle: async (_request, ctx) => {
    const answer = await api.fetch(ctx, '/meta');
    const meta = answer.ok ? ((await answer.json()) as Record<string, unknown>) : {};
    return Response.json({ ...meta, version: meta.version ?? '1.0.0' });
  },
}),
```

Pass the upstream's own document through when it has one and add only the keys the client needs. List
the shim at Stop 1 as a `handle` row with its reason, document it in the Service skill's Invented
endpoints, and prove it live with the client itself.
