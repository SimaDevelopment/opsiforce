import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const APP_USERS_PROVIDER_PATH = '/api/app-auth/';

export function enablePlatformCors(app: NestFastifyApplication) {
  app.enableCors({
    delegator: (request, callback) =>
      callback(null, { origin: !request.url.startsWith(APP_USERS_PROVIDER_PATH), credentials: true }),
  });
}
