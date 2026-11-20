import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const APP_USERS_PROVIDER_PATH = '/api/app-auth/';

const OPAQUE_ORIGIN = 'null';

export function enablePlatformCors(app: NestFastifyApplication) {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      if (request.headers.origin !== OPAQUE_ORIGIN) return done();
      void reply.code(403).send({ message: 'Requests from a sandboxed page are refused.' });
    });
  app.enableCors({
    delegator: (request, callback) =>
      callback(null, { origin: !request.url.startsWith(APP_USERS_PROVIDER_PATH), credentials: true }),
  });
}
