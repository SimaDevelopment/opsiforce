import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { EnvironmentService } from '../../src/environment/environment.service';
import { Perms } from '../../src/permission/permission.constants';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import { defaultEnvironmentId, seedLiveAgent } from '../support/agent-fixtures';
import { createTenantRow, createUserRow } from '../support/org-fixtures';
import { tenantName, proxyHeaders } from '../support/proxy-identity';

const FUTURE_BASE_MS = Date.UTC(2100, 0, 1);
let nextSlot = 0;

interface SeededAgent {
  id: string;
  name: string;
}

let tenantId: string;
let userId: string;

async function seedAgents(count: number): Promise<SeededAgent[]> {
  const seeded: SeededAgent[] = [];
  for (let index = 0; index < count; index += 1) {
    seeded.push(
      await seedLiveAgent(tenantId, userId, { createdAt: new Date(FUTURE_BASE_MS + (nextSlot + index) * 60_000) })
    );
  }
  nextSlot += count;
  return seeded.toReversed();
}

describe('GET /api/v1/agents', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const tenant = tenantName();
    tenantId = await createTenantRow(tenant);
    userId = await createUserRow();
    harness = await createPublicApiTestApp();
    app = harness.app;
    await harness.app.get(EnvironmentService).ensureDefaultForTenant(tenantId);
    headers = proxyHeaders({ tenants: [tenant] });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('answers the pagination envelope with newest agents first', async () => {
    const seeded = await seedAgents(3);

    const res = await app.inject({ method: 'GET', url: '/api/v1/agents?limit=3', headers });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual(['items', 'nextCursor']);
    expect(body.items.map((item: SeededAgent) => item.id)).toEqual(seeded.map((agent) => agent.id));
  });

  it('exposes only id, name, displayName and description', async () => {
    const [newest] = await seedAgents(1);

    const res = await app.inject({ method: 'GET', url: '/api/v1/agents?limit=1', headers });

    expect(res.json().items[0]).toEqual({
      id: newest.id,
      name: newest.name,
      displayName: expect.any(String),
      description: expect.any(String),
    });
  });

  it('keeps the next page stable when newer agents are added', async () => {
    const seeded = await seedAgents(4);

    const first = await app.inject({ method: 'GET', url: '/api/v1/agents?limit=2', headers });
    const { items, nextCursor } = first.json();
    expect(items.map((item: SeededAgent) => item.id)).toEqual([seeded[0].id, seeded[1].id]);
    expect(nextCursor).toEqual(expect.any(String));

    await seedAgents(2);

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/agents?limit=2&cursor=${encodeURIComponent(nextCursor)}`,
      headers,
    });
    expect(second.json().items.map((item: SeededAgent) => item.id)).toEqual([seeded[2].id, seeded[3].id]);
  });

  it('reports no next cursor on the last page', async () => {
    await seedAgents(1);
    const res = await app.inject({ method: 'GET', url: '/api/v1/agents?limit=200', headers });

    expect(res.json().nextCursor).toBeNull();
  });

  it('defaults to a page of fifty', async () => {
    await seedAgents(51);

    const res = await app.inject({ method: 'GET', url: '/api/v1/agents', headers });

    const { items, nextCursor } = res.json();
    expect(items).toHaveLength(50);
    expect(nextCursor).toEqual(expect.any(String));
  });

  it('walks agents whose creation times differ only below the millisecond', async () => {
    const stamp = `2101-06-0${(nextSlot % 9) + 1} 00:00:00.123456`;
    nextSlot += 1;
    const environmentId = await defaultEnvironmentId(tenantId);
    const seeded = Array.from({ length: 3 }, () => randomUUID());
    for (const id of seeded) {
      await db.execute(
        sql`insert into agents (id, tenant_id, name, origin, visibility, created_by, created_at)
            values (${id}, ${tenantId}, ${`agent-${id.slice(0, 8)}`}, 'custom', 'public', ${userId},
                    timestamp ${sql.raw(`'${stamp}'`)})`
      );
      await db.execute(
        sql`insert into agent_settings (agent_id, default_environment_id) values (${id}, ${environmentId})`
      );
      await db.execute(
        sql`insert into agent_profiles (id, agent_id, environment_id) values (${randomUUID()}, ${id}, ${environmentId})`
      );
    }
    const expected = seeded.toSorted((left, right) => right.localeCompare(left));

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < seeded.length; page += 1) {
      const query: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await app.inject({ method: 'GET', url: `/api/v1/agents?limit=1${query}`, headers });
      const body = res.json();
      walked.push(...body.items.map((item: SeededAgent) => item.id));
      cursor = body.nextCursor;
    }

    expect(walked).toEqual(expected);
  });

  it('refuses a limit above the maximum', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/agents?limit=201', headers });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({
      type: 'urn:opsiforce:error:validation-error',
      errors: [expect.objectContaining({ pointer: '#/limit', in: 'query' })],
    });
  });

  it('refuses a cursor it did not mint', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/agents?cursor=not-a-cursor', headers });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: 'urn:opsiforce:error:validation-error',
      errors: [expect.objectContaining({ pointer: '#/cursor', in: 'query' })],
    });
  });

  it('refuses an unknown query parameter', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/agents?page=2', headers });

    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toEqual([expect.objectContaining({ pointer: '#/page', in: 'query' })]);
  });

  it('needs the public API entry permission', async () => {
    const denied = proxyHeaders({ tenants: [tenantName()], permissions: [] });

    const res = await app.inject({ method: 'GET', url: '/api/v1/agents', headers: denied });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'urn:opsiforce:error:permission-denied',
      permission: Perms.usePublicApi,
    });
  });
});
