import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Module, type ModuleMetadata } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AgentSessionModule } from '../../../src/agent-session/agent-session.module';
import { configuration } from '../../../src/config/configuration';
import { registerBuiltInsAdapterRoutes } from '../../../src/external-services/built-ins/built-ins-routes';
import { CustomServicesModule } from '../../../src/external-services/custom/custom-services.module';
import { DoorbellModule } from '../../../src/external-services/doorbell/doorbell.module';
import { ExternalServicesModule } from '../../../src/external-services/external-services.module';
import { SERVICE_POD_PORT, SERVICE_START_HOLD_MS } from '../../../src/external-services/gate/service-pods';
import { BUILT_IN_SERVICES_DIR } from '../../../src/external-services/registry/built-in-services';
import { GatewayAuthGuard } from '../../../src/gateway/gateway-auth.guard';
import { PermissionGuard } from '../../../src/permission/permission.guard';
import { AppAgentController } from '../../../src/project/app.controller.agent';
import { ProjectEnvironmentModule } from '../../../src/project-environment/project-environment.module';
import { ProjectEventsModule } from '../../../src/project/project-events.module';
import { ProjectModule } from '../../../src/project/project.module';
import { configurePublicApi, createHttpAdapter } from '../../../src/public-api/public-api.bootstrap';
import { PublicApiModule } from '../../../src/public-api/public-api.module';
import { PublishModule } from '../../../src/publish/publish.module';
import { PublishService } from '../../../src/publish/publish.service';
import { PROJECT_PUBLISH_QUEUE } from '../../../src/publish/publish.types';
import { TenantGuard } from '../../../src/tenant/tenant.guard';
import { WorkspaceModule } from '../../../src/workspace/workspace.module';
import { DomainTestModule } from '../../support/domain-module';
import { FakeQueue } from '../../support/infra-fakes';

export const fixtureBuiltInsDir = resolve(__dirname, 'built-ins');
export const brokenBuiltInsDir = resolve(__dirname, 'broken-built-ins');
export const handlerlessBuiltInsDir = resolve(__dirname, 'handlerless-built-ins');
export const FIXTURE_SERVICE = 'fixture-crm';

@Module({})
class StubProjectModule {}

@Module({})
class StubWorkspaceModule {}

@Module({})
class StubAgentSessionModule {}

@Module({})
class StubProjectEnvironmentModule {}

@Module({})
class StubProjectEventsModule {}

@Module({
  providers: [PublishService, { provide: getQueueToken(PROJECT_PUBLISH_QUEUE), useClass: FakeQueue }],
  exports: [PublishService, getQueueToken(PROJECT_PUBLISH_QUEUE)],
})
export class StubPublishModule {}

@Module({
  providers: [
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
class GuardsModule {}

@Module({
  imports: [ExternalServicesModule],
  controllers: [AppAgentController],
  providers: [GatewayAuthGuard],
})
class AppStateModule {}

export interface ExternalServicesTestAppOptions {
  builtInsDir?: string;
  servicePodPort?: number;
  serviceStartHoldMs?: number;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  extraModules?: NonNullable<ModuleMetadata['imports']>;
  providers?: { provide: unknown; useValue: unknown }[];
}

export interface ExternalServicesTestApp {
  app: NestFastifyApplication;
  listen: () => Promise<string>;
  close: () => Promise<void>;
}

export async function createExternalServicesTestApp(
  options: ExternalServicesTestAppOptions = {}
): Promise<ExternalServicesTestApp> {
  const env = options.env ?? {};
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const restoreEnv = () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    let builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration, () => options.config ?? {}],
          ignoreEnvFile: true,
        }),
        DomainTestModule,
        PublicApiModule,
        GuardsModule,
        ExternalServicesModule,
        CustomServicesModule,
        DoorbellModule,
        AppStateModule,
        ...(options.extraModules ?? []),
      ],
    })
      .overrideProvider(BUILT_IN_SERVICES_DIR)
      .useValue(options.builtInsDir ?? fixtureBuiltInsDir)
      .overrideModule(ProjectModule)
      .useModule(StubProjectModule)
      .overrideModule(WorkspaceModule)
      .useModule(StubWorkspaceModule)
      .overrideModule(AgentSessionModule)
      .useModule(StubAgentSessionModule)
      .overrideModule(ProjectEnvironmentModule)
      .useModule(StubProjectEnvironmentModule)
      .overrideModule(ProjectEventsModule)
      .useModule(StubProjectEventsModule)
      .overrideModule(PublishModule)
      .useModule(StubPublishModule);
    if (options.servicePodPort !== undefined) {
      builder = builder.overrideProvider(SERVICE_POD_PORT).useValue(options.servicePodPort);
    }
    if (options.serviceStartHoldMs !== undefined) {
      builder = builder.overrideProvider(SERVICE_START_HOLD_MS).useValue(options.serviceStartHoldMs);
    }
    for (const { provide, useValue } of options.providers ?? []) {
      builder = builder.overrideProvider(provide).useValue(useValue);
    }
    const moduleRef = await builder.compile();

    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      createHttpAdapter({ genReqId: () => randomUUID() })
    );
    await configurePublicApi(app);
    const fastify = app.getHttpAdapter().getInstance();
    await fastify.register(import('@fastify/multipart'));
    await registerBuiltInsAdapterRoutes(app);
    try {
      await app.init();
    } catch (error) {
      await app.close().catch(() => undefined);
      throw error;
    }
    await app.getHttpAdapter().getInstance().ready();

    return {
      app,
      listen: async () => {
        await app.listen({ port: 0, host: '127.0.0.1' });
        return app.getUrl();
      },
      close: async () => {
        try {
          await app.close();
        } finally {
          restoreEnv();
        }
      },
    };
  } catch (error) {
    restoreEnv();
    throw error;
  }
}
