import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { assertModelCatalogShipped } from './agent/agent-models';
import { AppModule } from './app.module';
import { webhookBodyLimitHook } from './external-services/http/webhook-body-limit.hook';
import { requirePermissionHook } from './permission/permission.hook';
import { configurePublicApi, createHttpAdapter } from './public-api/public-api.bootstrap';
import { assertBuiltInSkillsShipped } from './store/skill-tree';

const WEBHOOK_ROUTE_PREFIX = '/api/external-services/webhooks/';
const WEBHOOK_JSON_BODY_LIMIT = 5 * 1024 * 1024;

async function bootstrap() {
  assertModelCatalogShipped();
  assertBuiltInSkillsShipped();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createHttpAdapter({ bodyLimit: Number.MAX_SAFE_INTEGER, genReqId: () => randomUUID() })
  );

  const fastify = app.getHttpAdapter().getInstance();
  await fastify.register(import('@fastify/multipart'), {
    limits: {
      fileSize: Number.MAX_SAFE_INTEGER,
      files: Number.MAX_SAFE_INTEGER,
      parts: Number.MAX_SAFE_INTEGER,
    },
  });
  fastify.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });
  await fastify.register(import('@fastify/compress'), {
    encodings: ['br', 'gzip', 'deflate'],
    threshold: 1024,
  });

  await configurePublicApi(app);

  fastify.addHook('onRequest', requirePermissionHook('/api/admin/queues', 'can_view_queue_dashboard'));
  fastify.addHook('preParsing', webhookBodyLimitHook(WEBHOOK_ROUTE_PREFIX, WEBHOOK_JSON_BODY_LIMIT));

  app.enableCors({
    origin: true,
    credentials: true,
  });

  await app.listen(3001, '0.0.0.0');
}

void bootstrap();
