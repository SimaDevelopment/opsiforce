import type { JsonObject } from '../../common/json';
import {
  VendorRateLimitedError,
  VendorSignInUnavailableError,
  VendorUnavailableError,
  type AccessTokenCheck,
  type LinkedAccountDescription,
  type RefreshResult,
  type SignInPoll,
  type StartedSignIn,
  type UsageWindow,
  type VendorAdapter,
  type VendorCredential,
  type VendorUsage,
} from '../vendor-adapter';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const USER_AGENT = 'opsiforce-linked-accounts';
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_S = 5;
const AUTH_CLAIMS = 'https://api.openai.com/auth';
const PROFILE_CLAIMS = 'https://api.openai.com/profile';
const PENDING_STATUSES = new Set([403, 404]);
const PERSONAL_ACCESS_TOKEN_PREFIX = 'at-';
const API_KEY_PREFIX = 'sk-';
const PERMANENT_REFRESH_CODES = new Set([
  'refresh_token_reused',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'invalid_grant',
]);

interface DeviceHandle {
  deviceAuthId: string;
  userCode: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
}

type Claims = Record<string, unknown>;

interface UsageWindowPayload {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

interface UsagePayload {
  plan_type?: unknown;
  rate_limit?: { primary_window?: UsageWindowPayload | null; secondary_window?: UsageWindowPayload | null } | null;
}

function usageWindowOf(window: UsageWindowPayload | null | undefined): UsageWindow[] {
  if (typeof window?.used_percent !== 'number' || typeof window.limit_window_seconds !== 'number') return [];
  return [
    {
      windowMinutes: Math.round(window.limit_window_seconds / 60),
      usedPercent: Math.min(100, Math.max(0, window.used_percent)),
      resetsAt: typeof window.reset_at === 'number' ? new Date(window.reset_at * 1000) : null,
    },
  ];
}

function claimsOf(token: string): Claims {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Claims) : {};
  } catch {
    return {};
  }
}

function stringClaim(claims: unknown, name: string): string | null {
  if (typeof claims !== 'object' || claims === null) return null;
  const value = (claims as Claims)[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

function errorCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  return stringClaim(error, 'code');
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class ChatGptAdapter implements VendorAdapter {
  readonly vendor = 'chatgpt' as const;

  constructor(
    private readonly issuer: string,
    private readonly usageUrl: string
  ) {}

  async startSignIn(): Promise<StartedSignIn> {
    const response = await this.post('/api/accounts/deviceauth/usercode', { client_id: CLIENT_ID });
    if (response.status === 429) throw new VendorRateLimitedError('OpenAI is limiting sign-ins right now');
    if (response.status === 404) {
      throw new VendorSignInUnavailableError(
        'Device code sign-in is off for this ChatGPT account; turn it on in its security settings'
      );
    }
    if (!response.ok) throw new Error(`OpenAI did not start the sign-in (${response.status})`);
    const body = (await response.json()) as {
      device_auth_id: string;
      user_code?: string;
      usercode?: string;
      interval?: string;
    };
    const userCode = body.user_code ?? body.usercode ?? '';
    const interval = Number.parseInt(body.interval ?? '', 10);
    const handle: DeviceHandle = { deviceAuthId: body.device_auth_id, userCode };
    return {
      handle: { ...handle },
      userCode,
      verificationUrl: `${this.issuer}/codex/device`,
      pollIntervalMs: (Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_S) * 1000,
    };
  }

  async pollSignIn(handle: JsonObject): Promise<SignInPoll> {
    const response = await this.post('/api/accounts/deviceauth/token', {
      device_auth_id: handle.deviceAuthId,
      user_code: handle.userCode,
    });
    if (PENDING_STATUSES.has(response.status)) return { outcome: 'pending' };
    if (response.status === 429) return { outcome: 'rate-limited' };
    if (!response.ok) return { outcome: 'failed', message: `OpenAI ended the sign-in (${response.status})` };
    const code = (await response.json()) as { authorization_code: string; code_verifier: string };
    return this.exchange(code.authorization_code, code.code_verifier);
  }

  async refresh(credential: VendorCredential): Promise<RefreshResult> {
    if (!credential.refreshToken) {
      return { outcome: 'failed', permanent: true, reason: 'This sign-in has no refresh token' };
    }
    const response = await this.post('/oauth/token', {
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
    });
    const body = await jsonOf(response);
    if (response.ok) {
      const tokens = body as TokenResponse;
      if (!tokens.access_token) return { outcome: 'failed', permanent: false, reason: 'OpenAI sent no access token' };
      return {
        outcome: 'refreshed',
        credential: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? credential.refreshToken },
      };
    }
    const code = errorCodeOf(body);
    const permanent = response.status === 401 || (code !== null && PERMANENT_REFRESH_CODES.has(code));
    if (permanent)
      return { outcome: 'failed', permanent, reason: `OpenAI ended this sign-in (${code ?? response.status})` };
    return {
      outcome: 'failed',
      permanent,
      reason: `OpenAI could not refresh the sign-in (${code ?? response.status})`,
    };
  }

  pastedTokenRefusal(accessToken: string): string | null {
    if (accessToken.startsWith(API_KEY_PREFIX)) {
      return 'This is an OpenAI API key; add it as an Official API key instead';
    }
    if (!accessToken.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)) {
      return 'Paste a Codex access token from a Business or Enterprise workspace; it starts with at-';
    }
    return null;
  }

  async whoami(accessToken: string): Promise<AccessTokenCheck> {
    const response = await fetch(`${this.issuer}/api/accounts/v1/user-auth-credential/whoami`, {
      headers: { authorization: `Bearer ${accessToken}`, 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await jsonOf(response);
    if (response.ok) return { outcome: 'accepted', accountId: stringClaim(body, 'chatgpt_account_id') };
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    return {
      outcome: 'failed',
      permanent,
      reason: permanent
        ? `OpenAI no longer accepts this access token (${response.status})`
        : `OpenAI could not check the access token (${response.status})`,
    };
  }

  async revoke(credential: VendorCredential): Promise<void> {
    const response = await this.post('/oauth/revoke', {
      token: credential.refreshToken ?? credential.accessToken,
      token_type_hint: credential.refreshToken ? 'refresh_token' : 'access_token',
      client_id: CLIENT_ID,
    });
    if (response.status === 429 || response.status >= 500) {
      throw new VendorUnavailableError(`OpenAI did not revoke the sign-in (${response.status})`);
    }
  }

  describe(credential: VendorCredential): LinkedAccountDescription {
    const claims = claimsOf(credential.accessToken);
    const exp = typeof claims.exp === 'number' ? claims.exp : null;
    return {
      accountId: stringClaim(claims[AUTH_CLAIMS], 'chatgpt_account_id') ?? stringClaim(claims, 'chatgpt_account_id'),
      signedInAs: stringClaim(claims, 'email') ?? stringClaim(claims[PROFILE_CLAIMS], 'email'),
      expiresAt: exp === null ? null : new Date(exp * 1000),
      signedInWith: credential.refreshToken ? 'device' : 'access-token',
    };
  }

  async usage(accessToken: string, accountId: string | null): Promise<VendorUsage> {
    const response = await fetch(this.usageUrl, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'user-agent': USER_AGENT,
        ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new VendorUnavailableError(`OpenAI did not return the usage (${response.status})`);
    const body = ((await jsonOf(response)) ?? {}) as UsagePayload;
    return {
      plan: typeof body.plan_type === 'string' ? body.plan_type : null,
      windows: [...usageWindowOf(body.rate_limit?.primary_window), ...usageWindowOf(body.rate_limit?.secondary_window)],
    };
  }

  private async exchange(authorizationCode: string, codeVerifier: string): Promise<SignInPoll> {
    const response = await fetch(`${this.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: `${this.issuer}/deviceauth/callback`,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const tokens = (await jsonOf(response)) as TokenResponse | null;
    if (!response.ok || !tokens?.access_token) {
      return { outcome: 'failed', message: `OpenAI did not issue the tokens (${response.status})` };
    }
    return {
      outcome: 'completed',
      credential: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? null },
    };
  }

  private post(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.issuer}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}
