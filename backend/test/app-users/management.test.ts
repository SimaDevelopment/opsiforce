import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppUsersService } from '../../src/app-users/app-users.service';
import { addMember, createTenant } from '../support/project-fixtures';
import { ISSUER, createAppUsersTestApp, projectUsingAppUsers, type AppUsersProject } from './support/app';

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await createAppUsersTestApp();
});

afterAll(async () => {
  await app.close();
});

function call(
  project: AppUsersProject,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path = '',
  payload?: object,
  headers = project.owner.headers
) {
  return app.inject({ method, url: `/api/projects/${project.projectId}${path}`, headers, payload });
}

const users = (project: AppUsersProject) => call(project, 'GET', '/app-users');

async function role(project: AppUsersProject, name: string, description?: string) {
  return (await call(project, 'POST', '/app-user-roles', { name, description })).json() as { id: string };
}

const NEW_USER = { email: '  Grace@Example.TEST ', name: 'Grace', password: 'long enough password' };

describe('managing a Project’s App Users', () => {
  it('creates, lists, edits and deletes users without ever returning a password', async () => {
    const project = await projectUsingAppUsers(app);
    await role(project, 'admin');
    await role(project, 'editor');

    const created = await call(project, 'POST', '/app-users', { ...NEW_USER, roles: ['editor', 'admin'] });
    expect(created.statusCode).toBe(201);
    const user = created.json() as { id: string } & Record<string, unknown>;
    expect(user).toMatchObject({
      email: 'grace@example.test',
      name: 'Grace',
      roles: ['admin', 'editor'],
      status: 'active',
    });

    const listed = await users(project);
    expect(listed.json()).toMatchObject({
      users: [expect.objectContaining({ id: user.id })],
      roles: [
        { name: 'admin', members: 1 },
        { name: 'editor', members: 1 },
      ],
      email: false,
    });
    expect(listed.body).not.toMatch(/password_?hash|scrypt/i);

    const edited = await call(project, 'PATCH', `/app-users/${user.id}`, {
      roles: ['editor'],
      disabled: true,
      name: 'Grace H.',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ roles: ['editor'], status: 'disabled', name: 'Grace H.' });

    expect((await call(project, 'PATCH', `/app-users/${user.id}`, { disabled: false })).json()).toMatchObject({
      status: 'active',
    });

    expect((await call(project, 'DELETE', `/app-users/${user.id}`)).statusCode).toBe(204);
    expect((await users(project)).json()).toMatchObject({ users: [] });
  });

  it('renames a role for everyone who holds it and drops it from them when deleted', async () => {
    const project = await projectUsingAppUsers(app);
    const editor = await role(project, 'editor', 'Can change content');
    await call(project, 'POST', '/app-users', { ...NEW_USER, roles: ['editor'] });

    const renamed = await call(project, 'PATCH', `/app-user-roles/${editor.id}`, { name: 'Writer' });
    expect(renamed.json()).toMatchObject({ name: 'writer', description: 'Can change content', members: 1 });
    expect((await users(project)).json()).toMatchObject({ users: [{ roles: ['writer'] }] });

    expect((await call(project, 'DELETE', `/app-user-roles/${editor.id}`)).statusCode).toBe(204);
    expect((await users(project)).json()).toMatchObject({ users: [{ roles: [] }], roles: [] });
  });

  it('refuses a duplicate role, a role name the App could not read, and an unknown role on a user', async () => {
    const project = await projectUsingAppUsers(app);
    await role(project, 'admin');

    expect((await call(project, 'POST', '/app-user-roles', { name: 'Admin' })).statusCode).toBe(409);
    expect((await call(project, 'POST', '/app-user-roles', { name: 'team lead' })).statusCode).toBe(400);
    expect((await call(project, 'POST', '/app-users', { ...NEW_USER, roles: ['owner'] })).statusCode).toBe(400);
    expect((await users(project)).json()).toMatchObject({ users: [] });
  });

  it('invites a user who has no password until they choose one through their link', async () => {
    const project = await projectUsingAppUsers(app);
    const { password: _password, ...invitee } = NEW_USER;
    const user = (await call(project, 'POST', '/app-users', invitee)).json() as { id: string; status: string };
    expect(user.status).toBe('invited');

    const link = await call(project, 'POST', `/app-users/${user.id}/links`, {
      purpose: 'invite',
      environmentId: project.projectId,
    });
    expect(link.statusCode).toBe(201);
    const { url, expiresAt } = link.json() as { url: string; expiresAt: string };
    expect(url.startsWith(`${ISSUER}/set-password?token=`)).toBe(true);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect((await new AppUsersService().signIn(project.projectId, 'grace@example.test', '')).outcome).toBe(
      'wrong-credentials'
    );
  });

  it('voids outstanding links when the owner corrects the email or sets the password', async () => {
    const project = await projectUsingAppUsers(app);
    const { password: _password, ...invitee } = NEW_USER;
    const user = (await call(project, 'POST', '/app-users', invitee)).json() as { id: string };
    const linkFor = async (purpose: 'invite' | 'reset') => {
      const { url } = (await call(project, 'POST', `/app-users/${user.id}/links`, { purpose })).json() as {
        url: string;
      };
      const { pathname, search } = new URL(url);
      return () => app.inject({ method: 'GET', url: `${pathname}${search}` });
    };

    const invite = await linkFor('invite');
    expect((await invite()).statusCode).toBe(200);
    await call(project, 'PATCH', `/app-users/${user.id}`, { name: 'Grace H.' });
    expect((await invite()).statusCode).toBe(200);
    await call(project, 'PATCH', `/app-users/${user.id}`, { email: 'grace.hopper@example.test' });
    expect((await invite()).statusCode).toBe(410);

    const reset = await linkFor('reset');
    expect((await reset()).statusCode).toBe(200);
    await call(project, 'PATCH', `/app-users/${user.id}`, { password: 'a password the owner set' });
    expect((await reset()).statusCode).toBe(410);
  });

  it('shows the owner an account locked by wrong passwords until they set a new one', async () => {
    const project = await projectUsingAppUsers(app);
    const user = (await call(project, 'POST', '/app-users', NEW_USER)).json() as { id: string; email: string };
    const appUsers = app.get(AppUsersService);
    for (let attempt = 0; attempt < 5; attempt++) await appUsers.signIn(project.projectId, user.email, 'wrong guess');

    const {
      users: [locked],
    } = (await users(project)).json() as { users: { lockedUntil: string | null }[] };
    expect(new Date(locked.lockedUntil ?? 0).getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);

    const reset = await call(project, 'PATCH', `/app-users/${user.id}`, { password: 'a brand new password' });
    expect(reset.json()).toMatchObject({ lockedUntil: null });
    expect((await appUsers.signIn(project.projectId, user.email, 'a brand new password')).outcome).toBe('signed-in');
  });

  it('rejects a short password, a malformed email and a name the gate could not forward as a header', async () => {
    const project = await projectUsingAppUsers(app);

    expect((await call(project, 'POST', '/app-users', { ...NEW_USER, password: 'short' })).statusCode).toBe(400);
    expect((await call(project, 'POST', '/app-users', { ...NEW_USER, email: 'not-an-email' })).statusCode).toBe(400);
    expect((await call(project, 'POST', '/app-users', { ...NEW_USER, name: 'Ada\nLovelace' })).statusCode).toBe(400);

    const user = (await call(project, 'POST', '/app-users', { ...NEW_USER, name: 'Ada Lovelace' })).json();
    expect((await call(project, 'PATCH', `/app-users/${user.id}`, { name: 'Ada\u0000' })).statusCode).toBe(400);
    expect((await call(project, 'GET', '/app-users')).json().users[0].name).toBe('Ada Lovelace');
  });

  it('sends no link to a disabled user, for another Project’s environment, or by email without Mailgun', async () => {
    const project = await projectUsingAppUsers(app);
    const other = await projectUsingAppUsers(app);
    const user = (await call(project, 'POST', '/app-users', NEW_USER)).json() as { id: string };

    const foreign = await call(project, 'POST', `/app-users/${user.id}/links`, {
      purpose: 'reset',
      environmentId: other.projectId,
    });
    expect(foreign.statusCode).toBe(404);
    const unsent = await call(project, 'POST', `/app-users/${user.id}/links`, { purpose: 'reset', send: true });
    expect(unsent.statusCode).toBe(400);

    await call(project, 'PATCH', `/app-users/${user.id}`, { disabled: true });
    expect((await call(project, 'POST', `/app-users/${user.id}/links`, { purpose: 'reset' })).statusCode).toBe(400);
  });

  it('is closed to members without the App Auth permission and to other Organizations', async () => {
    const project = await projectUsingAppUsers(app);
    const member = await addMember(app, project.tenant, []);
    const stranger = await addMember(app, await createTenant(app), ['can_manage_project_auth_settings']);

    expect((await call(project, 'GET', '/app-users', undefined, member.headers)).statusCode).toBe(403);
    expect((await call(project, 'GET', '/app-users', undefined, stranger.headers)).statusCode).toBe(404);
    expect((await call(project, 'POST', '/app-user-roles', { name: 'x' }, member.headers)).statusCode).toBe(403);
  });

  it('answers 404 for a user or role of another Project', async () => {
    const project = await projectUsingAppUsers(app);
    const other = await projectUsingAppUsers(app);
    const user = (await call(other, 'POST', '/app-users', NEW_USER)).json() as { id: string };
    const otherRole = await role(other, 'admin');

    expect((await call(project, 'PATCH', `/app-users/${user.id}`, { disabled: true })).statusCode).toBe(404);
    expect((await call(project, 'DELETE', `/app-users/${user.id}`)).statusCode).toBe(404);
    expect((await call(project, 'POST', `/app-users/${user.id}/links`, { purpose: 'reset' })).statusCode).toBe(404);
    expect((await call(project, 'DELETE', `/app-user-roles/${otherRole.id}`)).statusCode).toBe(404);
  });
});
