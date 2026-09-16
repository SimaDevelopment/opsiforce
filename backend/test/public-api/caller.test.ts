import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { users, workspaces } from '../../db/schema';
import { Perms } from '../../src/permission/permission.constants';
import type { ApiError } from '../../src/public-api/errors/error.schema';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import { organizationName, proxyHeaders, serviceAccountUsername } from '../support/proxy-identity';

const SEVERAL_PERMISSIONS = [Perms.usePublicApi, Perms.deleteProject, Perms.manageWorkspaces];

function withoutInstance(apiError: ApiError): Omit<ApiError, 'instance'> {
  const { instance: _instance, ...rest } = apiError;
  return rest;
}

async function privateWorkspaceCount(keycloakId: string): Promise<number> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.keycloakId, keycloakId));
  if (!user) return 0;
  const rows = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerId, user.id));
  return rows.length;
}

describe('public api caller and GET /me', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('identity', () => {
    it('answers a single-organization caller without an organization header', async () => {
      const organization = organizationName();
      const headers = proxyHeaders({ organizations: [organization] });

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        username: headers['x-forwarded-preferred-username'],
        email: headers['x-forwarded-email'],
        organization: { name: organization },
        organizations: [{ name: organization }],
        permissions: [Perms.usePublicApi],
      });
      expect(body.organization.id).toEqual(expect.any(String));
      expect(body.organizations).toHaveLength(1);
    });

    it('reports the platform user id, not the token subject', async () => {
      const userId = randomUUID();
      const headers = proxyHeaders({ userId, organizations: [organizationName()] });

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });

      const { id } = res.json();
      expect(id).not.toBe(userId);
      const [row] = await db.select({ id: users.id }).from(users).where(eq(users.keycloakId, userId));
      expect(id).toBe(row.id);
    });

    it('sorts the raw permission names', async () => {
      const headers = proxyHeaders({
        organizations: [organizationName()],
        permissions: SEVERAL_PERMISSIONS,
      });

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });

      expect(res.json().permissions).toEqual(SEVERAL_PERMISSIONS.toSorted());
    });

    it('creates the user row on the first call', async () => {
      const userId = randomUUID();
      const headers = proxyHeaders({ userId, organizations: [organizationName()] });

      const before = await db.select({ id: users.id }).from(users).where(eq(users.keycloakId, userId));
      expect(before).toHaveLength(0);

      await app.inject({ method: 'GET', url: '/api/v1/me', headers });

      const after = await db.select({ id: users.id }).from(users).where(eq(users.keycloakId, userId));
      expect(after).toHaveLength(1);
    });
  });

  describe('organization selection', () => {
    it('asks a multi-organization caller to name one, listing them by id and name', async () => {
      const first = organizationName('first');
      const second = organizationName('second');
      const headers = proxyHeaders({ organizations: [first, second] });

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      const body = res.json();
      expect(body).toMatchObject({ type: 'urn:opsiforce:error:organization-required', status: 400 });
      expect(body.organizations).toEqual([
        { id: expect.any(String), name: first },
        { id: expect.any(String), name: second },
      ]);
    });

    it('acts in the organization the header names', async () => {
      const first = organizationName('first');
      const second = organizationName('second');
      const headers = proxyHeaders({ organizations: [first, second], organization: second });

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.organization).toMatchObject({ name: second });
      expect(body.organizations.map((org: { name: string }) => org.name)).toEqual([first, second]);
    });

    it('answers one indistinguishable 403 for a foreign and for an unknown organization', async () => {
      const member = organizationName('member');
      const foreign = organizationName('foreign');
      await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: proxyHeaders({ organizations: [foreign] }),
      });

      const toForeign = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: proxyHeaders({ organizations: [member], organization: foreign }),
      });
      const toUnknown = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: proxyHeaders({ organizations: [member], organization: organizationName('nowhere') }),
      });

      expect(toForeign.statusCode).toBe(403);
      expect(toUnknown.statusCode).toBe(403);
      expect(withoutInstance(toForeign.json<ApiError>())).toEqual(withoutInstance(toUnknown.json<ApiError>()));
      expect(toForeign.json()).toMatchObject({ type: 'urn:opsiforce:error:organization-forbidden', status: 403 });
    });
  });

  describe('entry permission', () => {
    it('rejects a member without can_use_public_api and names the permission', async () => {
      const headers = proxyHeaders({
        organizations: [organizationName()],
        permissions: [Perms.manageWorkspaces],
      });

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:permission-denied',
        status: 403,
        permission: Perms.usePublicApi,
      });
    });

    it('does not leak the organization list to a caller without the entry permission', async () => {
      const headers = proxyHeaders({
        organizations: [organizationName('first'), organizationName('second')],
        permissions: [],
      });

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });

      expect(res.statusCode).toBe(403);
      expect(res.json().organizations).toBeUndefined();
    });
  });

  describe('missing identity', () => {
    it('answers 401 before any 403, and never a redirect', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/me' });

      expect(res.statusCode).toBe(401);
      expect(res.headers.location).toBeUndefined();
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:unauthenticated', status: 401 });
    });

    it('answers 401 when only the groups header arrives', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { 'x-forwarded-groups': `role:opsiforce_${Perms.usePublicApi}` },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:unauthenticated' });
    });
  });

  describe('service accounts', () => {
    it('creates a service-account user with no Personal workspace on its first call', async () => {
      const userId = randomUUID();
      const headers = proxyHeaders({
        userId,
        username: serviceAccountUsername('telegram'),
        email: null,
        organizations: [organizationName()],
      });

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ email: null, username: headers['x-forwarded-preferred-username'] });
      expect(await privateWorkspaceCount(userId)).toBe(0);
    });

    it('still creates a Personal workspace for a human caller', async () => {
      const userId = randomUUID();
      const headers = proxyHeaders({ userId, organizations: [organizationName()] });

      const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });

      expect(res.statusCode).toBe(200);
      expect(await privateWorkspaceCount(userId)).toBe(1);
    });
  });

  describe('static mode', () => {
    it('treats the deployment-wide static identity as an admin caller and ignores bearer tokens', async () => {
      const staticHarness = await createPublicApiTestApp();
      try {
        const staticApp = staticHarness.app;
        const headers = {
          ...proxyHeaders({
            organizations: [organizationName('local')],
            permissions: SEVERAL_PERMISSIONS,
          }),
          authorization: 'Bearer not-a-real-token',
        };

        const me = await staticApp.inject({ method: 'GET', url: '/api/v1/me', headers });
        expect(me.statusCode).toBe(200);
        expect(me.json().permissions).toEqual(SEVERAL_PERMISSIONS.toSorted());
      } finally {
        await staticHarness.close();
      }
    });
  });
});
