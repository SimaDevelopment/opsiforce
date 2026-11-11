import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { customDomains } from '../../db/schema';
import { appUsersClientSecret } from '../../src/app-users/app-users-client';
import { AppUserLinksService } from '../../src/app-users/app-user-links.service';
import { AppUserRolesService } from '../../src/app-users/app-user-roles.service';
import { AppUsersProviderService } from '../../src/app-users/app-users-provider.service';
import { AppUsersService } from '../../src/app-users/app-users.service';
import { ProjectService } from '../../src/project/project.service';
import {
  GATE_SECRET,
  ISSUER,
  claimsOf,
  cookieHeader,
  cookiesFrom,
  createAppUsersTestApp,
  form,
  hiddenField,
  pkce,
  projectUsingAppUsers,
  verifiedWithJwks,
  type AppUsersProject,
} from './support/app';

let app: NestFastifyApplication;
let appUsers: AppUsersService;
let roles: AppUserRolesService;

beforeAll(async () => {
  app = await createAppUsersTestApp();
  appUsers = app.get(AppUsersService);
  roles = app.get(AppUserRolesService);
});

afterAll(async () => {
  await app.close();
});

const PASSWORD = 'correct horse battery';

async function withUser(project: AppUsersProject, overrides: { email?: string; roles?: string[] } = {}) {
  for (const name of overrides.roles ?? []) await roles.create(project.projectId, { name });
  return appUsers.create(project.projectId, {
    email: overrides.email ?? `visitor-${Math.random().toString(16).slice(2, 8)}@example.test`,
    name: 'Ada Visitor',
    roles: overrides.roles ?? [],
    password: PASSWORD,
  });
}

async function customDomain(project: AppUsersProject, flags: { isMain?: boolean; redirectsToMain?: boolean } = {}) {
  const hostname = `shop-${randomUUID().slice(0, 8)}.example-org.com`;
  await db.insert(customDomains).values({
    id: randomUUID(),
    tenantId: project.tenant.tenantId,
    projectEnvironmentId: project.projectId,
    hostname,
    bare: false,
    zoneStart: 'example-org.com',
    status: 'connected',
    isMain: flags.isMain ?? false,
    redirectsToMain: flags.redirectsToMain ?? false,
  });
  return hostname;
}

function authorizeQuery(project: AppUsersProject, challenge: string, extra: Record<string, string> = {}) {
  return form({
    response_type: 'code',
    client_id: project.projectId,
    redirect_uri: project.callbackUrl,
    scope: 'openid profile email',
    state: 'opaque-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  });
}

async function openSignIn(project: AppUsersProject, challenge: string, cookies: Record<string, string> = {}) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/app-auth/authorize?${authorizeQuery(project, challenge)}`,
    headers: Object.keys(cookies).length ? { cookie: cookieHeader(cookies) } : {},
  });
  return { res, cookies: { ...cookies, ...cookiesFrom(res.headers['set-cookie']) } };
}

async function submitSignIn(
  project: AppUsersProject,
  challenge: string,
  email: string,
  password: string,
  carried: Record<string, string> = {}
) {
  const page = await openSignIn(project, challenge, carried);
  const html = page.res.body;
  const res = await app.inject({
    method: 'POST',
    url: '/api/app-auth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(page.cookies) },
    payload: form({
      email,
      password,
      csrf: hiddenField(html, 'csrf'),
      request: hiddenField(html, 'request'),
    }),
  });
  return { res, cookies: { ...page.cookies, ...cookiesFrom(res.headers['set-cookie']) } };
}

function codeFrom(location: string | undefined): string {
  const url = new URL(String(location));
  expect(url.searchParams.get('state')).toBe('opaque-state');
  return String(url.searchParams.get('code'));
}

function token(body: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/api/app-auth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(body),
  });
}

function exchange(project: AppUsersProject, code: string, verifier: string, secret?: string) {
  return token({
    grant_type: 'authorization_code',
    client_id: project.projectId,
    client_secret: secret ?? appUsersClientSecret(GATE_SECRET, project.projectId),
    code,
    redirect_uri: project.callbackUrl,
    code_verifier: verifier,
  });
}

function refresh(project: AppUsersProject, refreshToken: string) {
  return token({
    grant_type: 'refresh_token',
    client_id: project.projectId,
    client_secret: appUsersClientSecret(GATE_SECRET, project.projectId),
    refresh_token: refreshToken,
  });
}

async function signedIn(project: AppUsersProject, email: string) {
  const { verifier, challenge } = pkce();
  const signIn = await submitSignIn(project, challenge, email, PASSWORD);
  const res = await exchange(project, codeFrom(signIn.res.headers.location), verifier);
  expect(res.statusCode).toBe(200);
  return { tokens: res.json() as Record<string, string>, cookies: signIn.cookies };
}

describe('the App Users provider', () => {
  it('describes itself with the public issuer and sign-in page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/app-auth/.well-known/openid-configuration' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      end_session_endpoint: `${ISSUER}/logout`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('signs a visitor in with their email and password and hands the gate a signed ID token', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project, { roles: ['admin', 'editor'] });
    const { verifier, challenge } = pkce();

    const page = await openSignIn(project, challenge);
    expect(page.res.statusCode).toBe(200);
    expect(page.res.headers['content-type']).toContain('text/html');
    expect(page.res.body).toContain('Equipment Monitor');

    const signIn = await submitSignIn(project, challenge, user.email.toUpperCase(), PASSWORD);
    expect(signIn.res.statusCode).toBe(302);
    expect(String(signIn.res.headers.location).startsWith(`${project.callbackUrl}?`)).toBe(true);

    const res = await exchange(project, codeFrom(signIn.res.headers.location), verifier);
    expect(res.statusCode).toBe(200);
    const tokens = res.json() as Record<string, string | number>;
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 300 });
    const idToken = String(tokens.id_token);
    expect(await verifiedWithJwks(app, idToken)).toBe(true);
    expect(claimsOf(idToken)).toMatchObject({
      iss: ISSUER,
      aud: project.projectId,
      sub: user.id,
      email: user.email,
      name: 'Ada Visitor',
      roles: ['admin', 'editor'],
    });
  });

  it('accepts each code once, only with its own verifier and the client’s secret', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);

    const first = pkce();
    const firstCode = codeFrom(
      (await submitSignIn(project, first.challenge, user.email, PASSWORD)).res.headers.location
    );
    expect((await exchange(project, firstCode, pkce().verifier)).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await exchange(project, firstCode, first.verifier)).json()).toMatchObject({ error: 'invalid_grant' });

    const second = pkce();
    const secondCode = codeFrom(
      (await submitSignIn(project, second.challenge, user.email, PASSWORD)).res.headers.location
    );
    const wrongSecret = await exchange(project, secondCode, second.verifier, 'not-the-secret');
    expect(wrongSecret.statusCode).toBe(401);
    expect(wrongSecret.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('signs a visitor in on any address the gate serves, such as one from before the App’s address was edited', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const onOldAddress = {
      ...project,
      callbackUrl: `https://old-monitor-dev-${project.shortId}.apps.opsiforce.localtest.me/oidc/callback`,
    };
    const { verifier, challenge } = pkce();

    const signIn = await submitSignIn(onOldAddress, challenge, user.email, PASSWORD);

    expect(String(signIn.res.headers.location).startsWith(`${onOldAddress.callbackUrl}?`)).toBe(true);
    expect((await exchange(onOldAddress, codeFrom(signIn.res.headers.location), verifier)).statusCode).toBe(200);
  });

  it('signs a visitor in on a Custom domain that serves the App on its own host', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const onDomain = {
      ...project,
      callbackUrl: `https://${await customDomain(project, { isMain: true })}/oidc/callback`,
    };
    const { verifier, challenge } = pkce();

    const signIn = await submitSignIn(onDomain, challenge, user.email, PASSWORD);

    expect(String(signIn.res.headers.location).startsWith(`${onDomain.callbackUrl}?`)).toBe(true);
    expect((await exchange(onDomain, codeFrom(signIn.res.headers.location), verifier)).statusCode).toBe(200);
  });

  it('never redirects to an address that does not serve the environment’s App', async () => {
    const project = await projectUsingAppUsers(app);
    const other = await projectUsingAppUsers(app);
    await customDomain(project, { isMain: true });

    for (const redirectUri of [
      'https://attacker.example/oidc/callback',
      `${project.callbackUrl}?next=/`,
      other.callbackUrl,
      `https://${await customDomain(project, { redirectsToMain: true })}/oidc/callback`,
      `https://${await customDomain(other)}/oidc/callback`,
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/app-auth/authorize?${authorizeQuery(project, pkce().challenge, { redirect_uri: redirectUri })}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
  });

  it('refuses an environment that does not use App Users', async () => {
    const project = await projectUsingAppUsers(app);
    await app
      .get(ProjectService)
      .updateAuth(project.projectId, project.projectId, { mode: 'public' }, project.tenant.tenantId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/app-auth/authorize?${authorizeQuery(project, pkce().challenge)}`,
    });

    expect(res.statusCode).toBe(400);
  });

  it('keeps the visitor on the form after a wrong password and locks the account after five', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const { challenge } = pkce();

    const wrong = await submitSignIn(project, challenge, user.email, 'not the password');
    expect(wrong.res.statusCode).toBe(200);
    expect(wrong.res.headers.location).toBeUndefined();
    expect(wrong.res.body).toContain('Email or password is incorrect');
    expect(wrong.res.body).toMatch(/<input id="password"[^>]* autofocus/);
    expect(wrong.res.body).toContain('Ask the App’s owner for a reset link');

    for (let attempt = 0; attempt < 4; attempt++) await submitSignIn(project, challenge, user.email, 'still wrong');

    const locked = await submitSignIn(project, challenge, user.email, PASSWORD);
    expect(locked.res.statusCode).toBe(200);
    expect(locked.res.body).toContain('Too many attempts');
  });

  it('counts guesses made in parallel towards the lock', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);

    const guesses = await Promise.all(
      Array.from({ length: 12 }, () => appUsers.signIn(project.projectId, user.email, 'parallel guess'))
    );

    expect(guesses.filter((guess) => guess.outcome === 'wrong-credentials').length).toBeLessThan(5);
    expect((await appUsers.signIn(project.projectId, user.email, PASSWORD)).outcome).toBe('locked');
  });

  it('keeps one Project’s visitors out of another Project’s App', async () => {
    const mine = await projectUsingAppUsers(app);
    const theirs = await projectUsingAppUsers(app);
    const user = await withUser(mine);

    const attempt = await submitSignIn(theirs, pkce().challenge, user.email, PASSWORD);

    expect(attempt.res.statusCode).toBe(200);
    expect(attempt.res.body).toContain('Email or password is incorrect');
  });

  it('refuses a sign-in posted without the page’s own anti-forgery token', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const page = await openSignIn(project, pkce().challenge);

    const res = await app.inject({
      method: 'POST',
      url: '/api/app-auth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        email: user.email,
        password: PASSWORD,
        csrf: hiddenField(page.res.body, 'csrf'),
        request: hiddenField(page.res.body, 'request'),
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it('shares no page with a sibling App’s script and takes its forms only from its own pages', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const sibling = 'https://other-app.apps.opsiforce.test';
    const preflight = (url: string) =>
      app.inject({
        method: 'OPTIONS',
        url,
        headers: { origin: sibling, 'access-control-request-method': 'POST' },
      });

    const page = await app.inject({
      method: 'GET',
      url: `/api/app-auth/authorize?${authorizeQuery(project, pkce().challenge, { prompt: 'login' })}`,
      headers: { origin: sibling },
    });
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect((await preflight('/api/app-auth/authorize')).headers['access-control-allow-origin']).toBeUndefined();
    expect(
      (await preflight(`/api/projects/${project.projectId}/app-users`)).headers['access-control-allow-origin']
    ).toBe(sibling);

    const cookies = cookiesFrom(page.headers['set-cookie']);
    const post = (origin: string) =>
      app.inject({
        method: 'POST',
        url: '/api/app-auth/authorize',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(cookies), origin },
        payload: form({
          email: user.email,
          password: PASSWORD,
          csrf: hiddenField(page.body, 'csrf'),
          request: hiddenField(page.body, 'request'),
        }),
      });

    const forged = await post(sibling);
    expect(forged.statusCode).toBe(400);
    expect(forged.headers.location).toBeUndefined();
    expect(forged.headers['set-cookie']).toBeUndefined();

    const own = await post(new URL(ISSUER).origin);
    expect(own.statusCode).toBe(302);
    codeFrom(own.headers.location);
  });

  it('skips the form while the visitor’s provider session lasts', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const { cookies } = await signedIn(project, user.email);

    const again = await openSignIn(project, pkce().challenge, cookies);

    expect(again.res.statusCode).toBe(302);
    codeFrom(again.res.headers.location);
  });

  it('keeps its cookies host-only, so another App on a parent domain cannot plant a session', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const { verifier, challenge } = pkce();
    const signIn = await submitSignIn(project, challenge, user.email, PASSWORD);
    await exchange(project, codeFrom(signIn.res.headers.location), verifier);

    const setCookies = [signIn.res.headers['set-cookie']].flat().filter((line): line is string => Boolean(line));
    expect(setCookies.length).toBeGreaterThan(0);
    for (const line of setCookies) {
      expect(line).toMatch(/^__Host-/);
      expect(line).toContain('; Path=/;');
      expect(line).toContain('; Secure');
      expect(line.toLowerCase()).not.toContain('domain=');
    }

    const planted = Object.fromEntries(
      Object.entries(signIn.cookies).map(([name, value]) => [name.replace(/^__Host-/, ''), value])
    );
    const page = await openSignIn(project, pkce().challenge, planted);
    expect(page.res.statusCode).toBe(200);
    expect(page.res.body).toContain('Sign in to');
  });

  it('signs a visitor in, and offers a reset, while the browser carries an unrelated cookie that is not URI-encoded', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const { verifier, challenge } = pkce();

    const signIn = await submitSignIn(project, challenge, user.email, PASSWORD, { campaign: '100%' });
    expect(signIn.res.statusCode).toBe(302);
    expect((await exchange(project, codeFrom(signIn.res.headers.location), verifier)).statusCode).toBe(200);

    const forgot = await app.inject({
      method: 'GET',
      url: `/api/app-auth/forgot?${form({ request: authorizeQuery(project, pkce().challenge) })}`,
      headers: { cookie: 'campaign=100%; theme=dark%' },
    });
    expect(forgot.statusCode).not.toBe(500);
  });

  it('renews tokens until the owner disables the visitor', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const { tokens, cookies } = await signedIn(project, user.email);

    const renewed = await refresh(project, tokens.refresh_token);
    expect(renewed.statusCode).toBe(200);
    expect(claimsOf((renewed.json() as Record<string, string>).id_token)).toMatchObject({ sub: user.id });

    await appUsers.update(project.projectId, user.id, { disabled: true });

    expect((await refresh(project, tokens.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });
    const page = await openSignIn(project, pkce().challenge, cookies);
    expect(page.res.statusCode).toBe(200);
    const signIn = await submitSignIn(project, pkce().challenge, user.email, PASSWORD);
    expect(signIn.res.statusCode).toBe(200);
    expect(signIn.res.body).toContain('disabled');
  });

  it('issues nothing usable from a check that raced a password reset', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const { tokens } = await signedIn(project, user.email);
    const validated = await appUsers.signIn(project.projectId, user.email, PASSWORD);
    if (validated.outcome !== 'signed-in') throw new Error(`expected a sign-in, got ${validated.outcome}`);

    await appUsers.update(project.projectId, user.id, { password: 'a password the owner set' });

    const provider = app.get(AppUsersProviderService);
    const { verifier, challenge } = pkce();
    const check = await provider.checkAuthorizationRequest(
      Object.fromEntries(new URLSearchParams(authorizeQuery(project, challenge)))
    );
    if (check.outcome !== 'valid') throw new Error(`expected a valid request, got ${check.outcome}`);
    const late = new URL(await provider.issueCode(check.request, validated.user)).searchParams.get('code') ?? '';
    expect((await exchange(project, late, verifier)).json()).toMatchObject({ error: 'invalid_grant' });

    const session = await provider.newSession(validated.user);
    expect(await provider.session(project.projectId, session.value)).toBeNull();
    expect((await refresh(project, tokens.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('ends the provider session on sign-out and returns to the App', async () => {
    const project = await projectUsingAppUsers(app);
    const user = await withUser(project);
    const { tokens, cookies } = await signedIn(project, user.email);

    const res = await app.inject({
      method: 'GET',
      url: `/api/app-auth/logout?${form({
        client_id: project.projectId,
        post_logout_redirect_uri: project.callbackUrl,
        state: 'logout-state',
        id_token_hint: tokens.id_token,
      })}`,
      headers: { cookie: cookieHeader(cookies) },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${project.callbackUrl}?state=logout-state`);
    const after = { ...cookies, ...cookiesFrom(res.headers['set-cookie']) };
    expect((await openSignIn(project, pkce().challenge, after)).res.statusCode).toBe(200);
  });

  it('lets an invited visitor choose their own password through a one-time link and sign in with it', async () => {
    const project = await projectUsingAppUsers(app);
    const invitee = await appUsers.create(project.projectId, { email: 'new@example.test' });
    const link = await app
      .get(AppUserLinksService)
      .createForOwner(project.projectId, invitee.id, 'invite', project.projectId, false);
    const tokenParam = new URL(link.url).searchParams.get('token') ?? '';

    const page = await app.inject({ method: 'GET', url: `/api/app-auth/set-password?token=${tokenParam}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('new@example.test');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    const setPassword = (password: string, confirm = password) =>
      app.inject({
        method: 'POST',
        url: '/api/app-auth/set-password',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ token: tokenParam, password, confirm }),
      });
    expect((await setPassword(PASSWORD, 'something else')).body).toContain('don’t match');
    const saved = await setPassword(PASSWORD);
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toContain('Password saved');

    expect((await setPassword('another password')).statusCode).toBe(410);
    const signIn = await submitSignIn(project, pkce().challenge, 'new@example.test', PASSWORD);
    expect(signIn.res.statusCode).toBe(302);
  });

  it('keeps the link usable when saving the chosen password fails', async () => {
    const project = await projectUsingAppUsers(app);
    const invitee = await appUsers.create(project.projectId, { email: 'retry@example.test' });
    const links = app.get(AppUserLinksService);
    const link = await links.createForOwner(project.projectId, invitee.id, 'invite', project.projectId, false);
    const token = new URL(link.url).searchParams.get('token') ?? '';
    const failingWrite = vi
      .spyOn(appUsers, 'writePasswordChange')
      .mockRejectedValueOnce(new Error('database went away'));

    await expect(links.redeem(token, PASSWORD)).rejects.toThrow('database went away');
    failingWrite.mockRestore();

    expect(await links.open(token)).not.toBeNull();
    expect((await links.redeem(token, PASSWORD)).outcome).toBe('done');
    expect((await appUsers.signIn(project.projectId, 'retry@example.test', PASSWORD)).outcome).toBe('signed-in');
  });
});
