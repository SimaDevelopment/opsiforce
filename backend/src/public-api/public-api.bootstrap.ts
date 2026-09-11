import { VERSION_NEUTRAL, VersioningType } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PublicApiFastifyAdapter } from './public-api-fastify.adapter';
import { setupPublicApi } from './public-api.docs';

type FastifyAdapterOptions = ConstructorParameters<typeof PublicApiFastifyAdapter>[0];

export function createHttpAdapter(options: FastifyAdapterOptions = {}): PublicApiFastifyAdapter {
  return new PublicApiFastifyAdapter({ ...options, requestIdHeader: false });
}

export async function configurePublicApi(app: NestFastifyApplication): Promise<void> {
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: VERSION_NEUTRAL });
  await setupPublicApi(app);
}
