import { Controller, Get, Post } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enablePlatformCors } from '../src/common/platform-cors';

@Controller('projects')
class ProjectsDouble {
  @Get()
  list() {
    return [{ name: 'secret project' }];
  }

  @Post()
  create() {
    return { created: true };
  }
}

describe('platform CORS', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProjectsDouble] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    enablePlatformCors(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a sandboxed page reading or writing the platform API with the session cookie', async () => {
    const fromSandbox = { origin: 'null', cookie: '_oauth2_proxy=session' };

    const read = await app.inject({ method: 'GET', url: '/api/projects', headers: fromSandbox });
    const upload = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { ...fromSandbox, 'content-type': 'text/plain' },
      payload: 'x',
    });
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/projects',
      headers: { origin: 'null', 'access-control-request-method': 'POST' },
    });

    expect(read.statusCode).toBe(403);
    expect(read.body).not.toContain('secret project');
    expect(read.headers['access-control-allow-origin']).toBeUndefined();
    expect(upload.statusCode).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still answers the platform frontend and other origins', async () => {
    const sameOrigin = await app.inject({ method: 'GET', url: '/api/projects' });
    const fromApp = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { origin: 'https://example-org.apps.opsiforce.test' },
    });

    expect(sameOrigin.statusCode).toBe(200);
    expect(fromApp.statusCode).toBe(200);
    expect(fromApp.headers['access-control-allow-origin']).toBe('https://example-org.apps.opsiforce.test');
  });
});
