import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppUsersService } from '../../src/app-users/app-users.service';
import {
  ISSUER,
  cookieHeader,
  cookiesFrom,
  createAppUsersTestApp,
  form,
  hiddenField,
  pkce,
  projectUsingAppUsers,
  type AppUsersProject,
} from './support/app';

interface SentMail {
  to: string;
  from: string;
  subject: string;
  text: string;
}

let app: NestFastifyApplication;
let mailgun: Server;
let sent: SentMail[] = [];
let failSending = false;

function field(body: string, name: string): string {
  const match = new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(body);
  return match?.[1] ?? '';
}

beforeAll(async () => {
  mailgun = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (failSending) {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"message":"mail is down"}');
        return;
      }
      sent.push({
        to: field(body, 'to'),
        from: field(body, 'from'),
        subject: field(body, 'subject'),
        text: field(body, 'text'),
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"<test@mail>","message":"Queued"}');
    });
  });
  await new Promise<void>((resolve) => mailgun.listen(0, '127.0.0.1', resolve));
  app = await createAppUsersTestApp({ mailgunUrl: `http://127.0.0.1:${(mailgun.address() as AddressInfo).port}` });
});

beforeEach(() => {
  sent = [];
  failSending = false;
});

afterAll(async () => {
  await app.close();
  await new Promise((resolve) => mailgun.close(resolve));
});

const linkIn = (mail: SentMail) => /https:\/\/\S+set-password\?token=[\w-]+/.exec(mail.text)?.[0] ?? '';

function ownerCall(project: AppUsersProject, method: 'GET' | 'POST', path: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/projects/${project.projectId}${path}`,
    headers: project.owner.headers,
    payload,
  });
}

function authorizeQuery(project: AppUsersProject) {
  return form({
    response_type: 'code',
    client_id: project.projectId,
    redirect_uri: project.callbackUrl,
    scope: 'openid profile email',
    state: 'opaque-state',
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
  });
}

async function askForReset(project: AppUsersProject, email: string) {
  const request = authorizeQuery(project);
  const page = await app.inject({ method: 'GET', url: `/api/app-auth/forgot?${form({ request })}` });
  return app.inject({
    method: 'POST',
    url: '/api/app-auth/forgot',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(cookiesFrom(page.headers['set-cookie'])),
    },
    payload: form({ email, request: hiddenField(page.body, 'request'), csrf: hiddenField(page.body, 'csrf') }),
  });
}

function choosePassword(link: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/app-auth/set-password',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ token: new URL(link).searchParams.get('token') ?? '', password, confirm: password }),
  });
}

describe('App User emails through Mailgun', () => {
  it('emails an invite the person uses to choose their own password', async () => {
    const project = await projectUsingAppUsers(app);
    expect((await ownerCall(project, 'GET', '/app-users')).json()).toMatchObject({ email: true });
    const user = (await ownerCall(project, 'POST', '/app-users', { email: 'new@example-org.com' })).json() as {
      id: string;
    };

    const link = await ownerCall(project, 'POST', `/app-users/${user.id}/links`, {
      purpose: 'invite',
      environmentId: project.projectId,
      send: true,
    });
    expect(link.json()).toMatchObject({ emailed: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'new@example-org.com',
      from: 'Opsiforce <apps@mail.example-org.com>',
      subject: 'You’re invited to Equipment Monitor',
    });
    expect(linkIn(sent[0])).toBe((link.json() as { url: string }).url);
    expect((await choosePassword(linkIn(sent[0]), 'a password they chose')).statusCode).toBe(200);
    expect(
      (await app.get(AppUsersService).signIn(project.projectId, 'new@example-org.com', 'a password they chose')).outcome
    ).toBe('signed-in');
  });

  it('offers Forgot password and emails a reset link that leads back to the sign-in', async () => {
    const project = await projectUsingAppUsers(app);
    await ownerCall(project, 'POST', '/app-users', { email: 'ada@example-org.com', password: 'the old password' });

    const signIn = await app.inject({ method: 'GET', url: `/api/app-auth/authorize?${authorizeQuery(project)}` });
    expect(signIn.body).toContain('Forgot password?</a>');

    const asked = await askForReset(project, 'Ada@Example-org.com');
    expect(asked.body).toContain('Check your email');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ada@example-org.com', subject: 'Reset your password for Equipment Monitor' });

    const saved = await choosePassword(linkIn(sent[0]), 'a brand new password');
    expect(saved.body).toContain(`${ISSUER}/authorize?`);
    expect(
      (await app.get(AppUsersService).signIn(project.projectId, 'ada@example-org.com', 'a brand new password')).outcome
    ).toBe('signed-in');
  });

  it('answers the same for an unknown email, sends nothing for it, and sends one email a minute at most', async () => {
    const project = await projectUsingAppUsers(app);
    await ownerCall(project, 'POST', '/app-users', { email: 'ada@example-org.com', password: 'the old password' });

    const unknown = await askForReset(project, 'nobody@example-org.com');
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toContain('Check your email');
    expect(sent).toHaveLength(0);

    await askForReset(project, 'ada@example-org.com');
    await askForReset(project, 'ada@example-org.com');
    expect(sent).toHaveLength(1);
  });

  it('hands the owner the working link when Mailgun refuses an email, and keeps the visitor’s answer unchanged', async () => {
    const project = await projectUsingAppUsers(app);
    const user = (
      await ownerCall(project, 'POST', '/app-users', { email: 'ada@example-org.com', password: 'the old password' })
    ).json() as { id: string };
    failSending = true;

    const owner = await ownerCall(project, 'POST', `/app-users/${user.id}/links`, { purpose: 'reset', send: true });
    expect(owner.statusCode).toBe(201);
    const link = owner.json() as { url: string; emailed: boolean; emailError?: string };
    expect(link).toMatchObject({ emailed: false });
    expect(link.emailError).toBeTruthy();
    failSending = false;
    expect((await choosePassword(link.url, 'a password from the shown link')).statusCode).toBe(200);
    failSending = true;

    const visitor = await askForReset(project, 'ada@example-org.com');
    expect(visitor.statusCode).toBe(200);
    expect(visitor.body).toContain('Check your email');
  });
});
