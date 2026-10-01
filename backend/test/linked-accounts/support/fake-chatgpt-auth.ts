import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { text } from 'node:stream/consumers';

export type DeviceTokenReply = 'pending' | 'rate-limited' | 'approved';

export type RefreshReply =
  | 'rotate'
  | 'refresh_token_reused'
  | 'refresh_token_expired'
  | 'refresh_token_invalidated'
  | 'invalid_grant'
  | 'unauthorized'
  | 'server-error';

export interface RevokeRequest {
  token: string;
  tokenTypeHint: string | undefined;
  clientId: string | undefined;
}

export interface UsageRequest {
  accessToken: string;
  accountId: string | undefined;
}

export interface FakeChatGptAccount {
  email: string;
  accountId: string;
}

export interface FakeChatGptAuth {
  issuer: string;
  userCode: string;
  usercodeRequests: number;
  devicePolls: number;
  refreshRequests: Array<{ refreshToken: string; contentType: string | undefined }>;
  issuedAccessTokens: string[];
  revokeRequests: RevokeRequest[];
  whoamiRequests: number;
  usageRequests: UsageRequest[];
  currentRefreshToken: () => string | undefined;
  replyToDevicePolls: (reply: DeviceTokenReply) => void;
  signInAs: (account: FakeChatGptAccount) => void;
  issueTokensLasting: (ms: number) => void;
  delayRefreshes: (ms: number) => void;
  replyToRefreshes: (reply: RefreshReply) => void;
  failRevokesWith: (status: number | null) => void;
  failWhoamisWith: (status: number | null) => void;
  reportUsage: (usage: Record<string, unknown> | number) => void;
  issuePersonalAccessToken: (account: FakeChatGptAccount) => string;
  endPersonalAccessToken: (token: string) => void;
  reset: () => void;
  close: () => Promise<void>;
}

export const FAKE_USER_CODE = 'ABCD-1234';
const DEVICE_AUTH_ID = 'deviceauth_fake';
const AUTHORIZATION_CODE = 'authorization-code-fake';
const CODE_VERIFIER = 'code-verifier-fake';
const HOUR_MS = 60 * 60 * 1000;
const ISSUER_HOSTNAME = 'auth.openai.com';
const USAGE_HOSTNAME = 'chatgpt.com';
const USAGE_PATH = '/backend-api/wham/usage';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function fakeAccessToken(claims: Record<string, unknown>): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.signature`;
}

export async function startFakeChatGptAuth(): Promise<FakeChatGptAuth> {
  let devicePollReply: DeviceTokenReply = 'pending';
  let account: FakeChatGptAccount = { email: 'platform@example.test', accountId: 'chatgpt-account-platform' };
  let tokenLifetimeMs = HOUR_MS;
  let refreshDelayMs = 0;
  let refreshGeneration = 0;
  let currentRefreshToken: string | undefined;
  let refreshReply: RefreshReply = 'rotate';
  let revokeFailureStatus: number | null = null;
  let whoamiFailureStatus: number | null = null;
  let personalAccessTokenCount = 0;
  let usageReply: Record<string, unknown> | number = 404;
  const personalAccessTokens = new Map<string, FakeChatGptAccount>();

  const state = {
    usercodeRequests: 0,
    devicePolls: 0,
    refreshRequests: [] as Array<{ refreshToken: string; contentType: string | undefined }>,
    issuedAccessTokens: [] as string[],
    revokeRequests: [] as RevokeRequest[],
    whoamiRequests: 0,
    usageRequests: [] as UsageRequest[],
  };

  function issueTokens(): { access_token: string; refresh_token: string; id_token: string } {
    refreshGeneration += 1;
    currentRefreshToken = `refresh-token-${refreshGeneration}`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const accessToken = fakeAccessToken({
      exp: Math.floor((Date.now() + tokenLifetimeMs) / 1000),
      iat: nowSeconds,
      'https://api.openai.com/auth': { chatgpt_account_id: account.accountId },
      'https://api.openai.com/profile': { email: account.email },
      generation: refreshGeneration,
    });
    state.issuedAccessTokens.push(accessToken);
    return { access_token: accessToken, refresh_token: currentRefreshToken, id_token: fakeAccessToken({}) };
  }

  async function handleToken(req: IncomingMessage, raw: string, res: ServerResponse): Promise<void> {
    const contentType = req.headers['content-type'];
    const fields: Record<string, string> = contentType?.startsWith('application/json')
      ? (JSON.parse(raw) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(raw));
    if (fields.grant_type === 'authorization_code') {
      if (fields.code !== AUTHORIZATION_CODE || fields.code_verifier !== CODE_VERIFIER) {
        return send(res, 400, { error: 'invalid_grant' });
      }
      return send(res, 200, issueTokens());
    }
    if (fields.grant_type === 'refresh_token') {
      state.refreshRequests.push({ refreshToken: fields.refresh_token ?? '', contentType });
      if (refreshDelayMs > 0) await delay(refreshDelayMs);
      if (refreshReply === 'server-error') return send(res, 503, { error: 'upstream unavailable' });
      if (refreshReply === 'unauthorized') return send(res, 401, {});
      if (refreshReply === 'invalid_grant') return send(res, 400, { error: 'invalid_grant' });
      if (refreshReply !== 'rotate') return send(res, 401, { error: { code: refreshReply } });
      if (fields.refresh_token !== currentRefreshToken) {
        return send(res, 401, { error: { code: 'refresh_token_reused' } });
      }
      return send(res, 200, issueTokens());
    }
    send(res, 400, { error: 'unsupported_grant_type' });
  }

  function handleRevoke(raw: string, res: ServerResponse): void {
    const fields = JSON.parse(raw) as { token?: string; token_type_hint?: string; client_id?: string };
    state.revokeRequests.push({
      token: fields.token ?? '',
      tokenTypeHint: fields.token_type_hint,
      clientId: fields.client_id,
    });
    if (revokeFailureStatus !== null) return send(res, revokeFailureStatus, { error: 'revoke failed' });
    if (fields.token === currentRefreshToken) currentRefreshToken = undefined;
    if (fields.token) personalAccessTokens.delete(fields.token);
    send(res, 200, {});
  }

  function handleWhoami(req: IncomingMessage, res: ServerResponse): void {
    state.whoamiRequests += 1;
    if (whoamiFailureStatus !== null) return send(res, whoamiFailureStatus, { error: 'whoami failed' });
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const owner = personalAccessTokens.get(token);
    if (!owner) return send(res, 401, { error: { code: 'token_expired' } });
    send(res, 200, {
      email: owner.email,
      chatgpt_user_id: `user-${owner.accountId}`,
      chatgpt_account_id: owner.accountId,
      chatgpt_plan_type: 'business',
      chatgpt_account_is_fedramp: false,
    });
  }

  function handleUsage(req: IncomingMessage, res: ServerResponse): void {
    const accountId = req.headers['chatgpt-account-id'];
    state.usageRequests.push({
      accessToken: req.headers.authorization?.replace(/^Bearer /, '') ?? '',
      accountId: typeof accountId === 'string' ? accountId : undefined,
    });
    if (typeof usageReply === 'number') return send(res, usageReply, { error: 'usage failed' });
    send(res, 200, usageReply);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://fake-chatgpt-auth').pathname;
    const raw = await text(req);
    if (req.method === 'POST' && path === '/api/accounts/deviceauth/usercode') {
      state.usercodeRequests += 1;
      return send(res, 200, { device_auth_id: DEVICE_AUTH_ID, user_code: FAKE_USER_CODE, interval: '5' });
    }
    if (req.method === 'POST' && path === '/api/accounts/deviceauth/token') {
      state.devicePolls += 1;
      const body = JSON.parse(raw) as { device_auth_id?: string; user_code?: string };
      if (body.device_auth_id !== DEVICE_AUTH_ID || body.user_code !== FAKE_USER_CODE) {
        return send(res, 400, { error: 'unknown device code' });
      }
      if (devicePollReply === 'pending') return send(res, 403, { error: 'authorization_pending' });
      if (devicePollReply === 'rate-limited') return send(res, 429, { error: 'slow_down' });
      return send(res, 200, {
        authorization_code: AUTHORIZATION_CODE,
        code_challenge: 'code-challenge-fake',
        code_verifier: CODE_VERIFIER,
      });
    }
    if (req.method === 'POST' && path === '/oauth/token') return handleToken(req, raw, res);
    if (req.method === 'POST' && path === '/oauth/revoke') return handleRevoke(raw, res);
    if (req.method === 'GET' && path === '/api/accounts/v1/user-auth-credential/whoami') return handleWhoami(req, res);
    if (req.method === 'GET' && path === USAGE_PATH) return handleUsage(req, res);
    send(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => send(res, 500, { error: err.message }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const routedHostnames = new Set([ISSUER_HOSTNAME, USAGE_HOSTNAME]);
  const unroutedFetch = globalThis.fetch;
  const routedFetch: typeof fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.protocol !== 'https:' || !routedHostnames.has(target.hostname)) return unroutedFetch(input, init);
    target.protocol = 'http:';
    target.host = `127.0.0.1:${port}`;
    return unroutedFetch(target, init);
  };
  globalThis.fetch = routedFetch;

  return {
    issuer: `https://${ISSUER_HOSTNAME}`,
    userCode: FAKE_USER_CODE,
    get usercodeRequests() {
      return state.usercodeRequests;
    },
    get devicePolls() {
      return state.devicePolls;
    },
    get refreshRequests() {
      return state.refreshRequests;
    },
    get issuedAccessTokens() {
      return state.issuedAccessTokens;
    },
    get revokeRequests() {
      return state.revokeRequests;
    },
    get whoamiRequests() {
      return state.whoamiRequests;
    },
    get usageRequests() {
      return state.usageRequests;
    },
    currentRefreshToken: () => currentRefreshToken,
    replyToDevicePolls: (reply) => {
      devicePollReply = reply;
    },
    signInAs: (next) => {
      account = next;
    },
    issueTokensLasting: (ms) => {
      tokenLifetimeMs = ms;
    },
    delayRefreshes: (ms) => {
      refreshDelayMs = ms;
    },
    replyToRefreshes: (reply) => {
      refreshReply = reply;
    },
    failRevokesWith: (status) => {
      revokeFailureStatus = status;
    },
    failWhoamisWith: (status) => {
      whoamiFailureStatus = status;
    },
    reportUsage: (usage) => {
      usageReply = usage;
    },
    issuePersonalAccessToken: (owner) => {
      personalAccessTokenCount += 1;
      const token = `at-${owner.accountId}-${personalAccessTokenCount}`;
      personalAccessTokens.set(token, owner);
      return token;
    },
    endPersonalAccessToken: (token) => {
      personalAccessTokens.delete(token);
    },
    reset: () => {
      devicePollReply = 'pending';
      tokenLifetimeMs = HOUR_MS;
      refreshDelayMs = 0;
      refreshGeneration = 0;
      currentRefreshToken = undefined;
      refreshReply = 'rotate';
      revokeFailureStatus = null;
      whoamiFailureStatus = null;
      personalAccessTokens.clear();
      usageReply = 404;
      state.usageRequests = [];
      state.revokeRequests = [];
      state.whoamiRequests = 0;
      state.usercodeRequests = 0;
      state.devicePolls = 0;
      state.refreshRequests = [];
      state.issuedAccessTokens = [];
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (globalThis.fetch === routedFetch) globalThis.fetch = unroutedFetch;
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
