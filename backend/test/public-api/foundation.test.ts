import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProbeModule } from './support/probe-api';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import { organizationName, proxyHeaders } from '../support/proxy-identity';

const identity = proxyHeaders({ organizations: [organizationName('foundation')] });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('public api foundation', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    harness = await createPublicApiTestApp({}, [ProbeModule]);
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('request id', () => {
    it('echoes a fresh request id on every public-api response', async () => {
      const first = await app.inject({ method: 'GET', url: '/api/v1/me', headers: identity });
      const second = await app.inject({ method: 'GET', url: '/api/v1/me', headers: identity });
      expect(first.headers['x-request-id']).toMatch(UUID);
      expect(second.headers['x-request-id']).not.toBe(first.headers['x-request-id']);
    });
  });

  describe('routing', () => {
    it('turns an unknown path under /api/v1 into a route-not-found error', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/nope', headers: identity });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:route-not-found', status: 404 });
    });

    it('turns an unknown method on a known path into a route-not-found error', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/v1/me', headers: identity });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:route-not-found' });
    });

    it('answers the bare /api/v1 prefix with an error, not the internal 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1', headers: identity });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:route-not-found' });
    });

    it('leaves internal routes on Nest defaults', async () => {
      const missing = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(missing.headers['content-type']).toMatch(/^application\/json/);
      expect(missing.json()).toMatchObject({ statusCode: 404 });
      expect(missing.headers['x-request-id']).toBeUndefined();

      const internal = await app.inject({ method: 'GET', url: '/api/internal/ping', headers: identity });
      expect(internal.statusCode).toBe(200);
      expect(internal.json()).toEqual({ ok: true });
    });
  });

  describe('errors', () => {
    it('carries the request id as instance and as the header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/nope', headers: identity });
      const requestId = res.headers['x-request-id'];
      expect(requestId).toMatch(UUID);
      expect(res.json()).toMatchObject({ instance: `urn:uuid:${String(requestId)}` });
    });

    it('ignores a caller-supplied request id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/nope',
        headers: { ...identity, 'request-id': 'forged-by-the-caller' },
      });
      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(res.json()).toMatchObject({ instance: expect.stringMatching(/^urn:uuid:[0-9a-f-]{36}$/) });
    });

    it('keeps the original status when a foreign 4xx has no named fallback', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/probe/unmapped', headers: identity });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:bad-request',
        status: 413,
        detail: 'payload too large',
      });
    });

    it('answers 401 unauthenticated when the identity headers are missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/probe/foreign' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:unauthenticated' });
    });

    it('maps a foreign 4xx to its status-named fallback and keeps the message', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/probe/foreign', headers: identity });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:not-found',
        title: 'Not found',
        detail: 'the widget is gone',
      });
    });

    it('passes a catalogue error through with its headers', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/probe/catalogue', headers: identity });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:environment-starting', status: 503 });
    });

    it('hides the reason when a response violates its own schema', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/probe/unserializable', headers: identity });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:unexpected' });
      expect(res.json()).not.toHaveProperty('detail');
    });

    it('refuses a public route argument that has no schema', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/probe/unvalidated',
        headers: { ...identity, 'content-type': 'application/json' },
        payload: { name: 'x' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:unexpected' });
    });
  });

  describe('validation', () => {
    it('reports a body schema violation with a pointer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/probe/echo',
        headers: { ...identity, 'content-type': 'application/json' },
        payload: { name: 7 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:validation-error',
        errors: [{ pointer: '#/name', in: 'body' }],
      });
    });

    it('reports one item per unrecognized key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/probe/echo',
        headers: { ...identity, 'content-type': 'application/json' },
        payload: { name: 'x', extra: 1, other: 2 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ errors: { pointer: string; in: string }[] }>().errors).toEqual([
        { detail: 'Unrecognized key: "extra"', pointer: '#/extra', in: 'body' },
        { detail: 'Unrecognized key: "other"', pointer: '#/other', in: 'body' },
      ]);
    });

    it('marks a query violation as in: query', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/probe/paged?limit=abc', headers: identity });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errors: [{ pointer: '#/limit', in: 'query' }] });
    });

    it('turns a malformed JSON body into a validation error pointing at the root', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/probe/echo',
        headers: { ...identity, 'content-type': 'application/json' },
        payload: '{bad',
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:validation-error',
        errors: [{ pointer: '#', in: 'body' }],
      });
    });

    it('turns an empty JSON body into a validation error pointing at the root', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/probe/echo',
        headers: { ...identity, 'content-type': 'application/json' },
        payload: '',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:validation-error',
        errors: [{ pointer: '#', in: 'body' }],
      });
    });
  });
});
