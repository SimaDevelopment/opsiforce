import { randomUUID } from 'node:crypto';
import { Controller, Get, Module, type ModuleMetadata } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AgentSessionModule } from '../../../src/agent-session/agent-session.module';
import { configuration } from '../../../src/config/configuration';
import { PermissionGuard } from '../../../src/permission/permission.guard';
import { ProjectEnvironmentModule } from '../../../src/project-environment/project-environment.module';
import { ProjectEventsModule } from '../../../src/project/project-events.module';
import { ProjectModule } from '../../../src/project/project.module';
import { WorkspaceModule } from '../../../src/workspace/workspace.module';
import { configurePublicApi, createHttpAdapter } from '../../../src/public-api/public-api.bootstrap';
import { PublicApiModule } from '../../../src/public-api/public-api.module';
import { TenantGuard } from '../../../src/tenant/tenant.guard';
import { ERROR_MEDIA_TYPE } from '../../../src/public-api/errors/error.schema';
import { DomainTestModule } from '../../support/domain-module';
import { assertProblemsDeclared, observedProblemOf, type ObservedProblem } from './declared-problems';

@Controller('internal')
class InternalController {
  @Get('ping')
  ping(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({})
class StubProjectModule {}

@Module({})
class StubWorkspaceModule {}

@Module({})
class StubAgentSessionModule {}

@Module({})
class StubProjectEnvironmentModule {}

/** Real one opens Redis; DomainTestModule's global fake takes its place. */
@Module({})
class StubProjectEventsModule {}

@Module({
  controllers: [InternalController],
  providers: [
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
class InternalModule {}

export interface PublicApiTestApp {
  app: NestFastifyApplication;
  /** Every `application/problem+json` this app answered, in order. */
  problems: readonly ObservedProblem[];
  listen: () => Promise<string>;
  close: () => Promise<void>;
}

export async function createPublicApiTestApp(
  env: Record<string, string> = {},
  extraModules: NonNullable<ModuleMetadata['imports']> = []
): Promise<PublicApiTestApp> {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }),
      DomainTestModule,
      PublicApiModule,
      InternalModule,
      ...extraModules,
    ],
  })
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
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createHttpAdapter({ genReqId: () => randomUUID() })
  );
  await configurePublicApi(app);

  const problems: ObservedProblem[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (request, reply, payload, done) => {
      if (String(reply.getHeader('content-type') ?? '').startsWith(ERROR_MEDIA_TYPE)) {
        problems.push(observedProblemOf(request.method, request.routeOptions.url, request.url, payload));
      }
      done(null, payload);
    });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    problems,
    listen: async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      return app.getUrl();
    },
    close: async () => {
      try {
        await assertProblemsDeclared(app, problems);
      } finally {
        await app.close();
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  };
}
