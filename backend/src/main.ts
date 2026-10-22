import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { assertModelCatalogShipped } from './agent/agent-models';
import { AppModule } from './app.module';
import { registerBuiltInsAdapterRoutes } from './external-services/built-ins/built-ins-routes';
import { requirePermissionHook } from './permission/permission.hook';
import { configurePublicApi, createHttpAdapter } from './public-api/public-api.bootstrap';
import { assertBuiltInSkillsShipped } from './store/skill-tree';

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
  await registerBuiltInsAdapterRoutes(app);

  fastify.addHook('onRequest', requirePermissionHook('/api/admin/queues', 'can_view_queue_dashboard'));

  app.enableCors({
    origin: true,
    credentials: true,
  });

  await app.listen(3001, '0.0.0.0');
}

void bootstrap();
