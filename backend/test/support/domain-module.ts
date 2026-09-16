import { Global, InjectionToken, Module, type Provider, type Type } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { AgentService } from '../../src/agent/agent.service';
import { AgentConnectionService } from '../../src/agent-session/agent-connection.service';
import { AgentSessionGateway } from '../../src/agent-session/agent-session.gateway';
import { PodOpencodeClient } from '../../src/agent-session/pod-opencode.client';
import { AgentUpdateService } from '../../src/agent-update/agent-update.service';
import { AGENT_WORKSPACE_UPDATE_QUEUE } from '../../src/agent-update/agent-update.types';
import { DefaultsService } from '../../src/defaults/defaults.service';
import { EnvironmentService } from '../../src/environment/environment.service';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { GitService } from '../../src/git/git.service';
import { ForwardedIdentityService } from '../../src/identity/forwarded-identity.service';
import { PermissionGuard } from '../../src/permission/permission.guard';
import { AppReadinessService } from '../../src/project/app-readiness.service';
import { AppService } from '../../src/project/app.service';
import { AgentStatusService } from '../../src/project/agent-status.service';
import { ProjectAuthService } from '../../src/project/project-auth.service';
import { ProjectEventsService } from '../../src/project/project-events.service';
import { ProjectFilesService } from '../../src/project/project-files.service';
import { ProjectService } from '../../src/project/project.service';
import { PROJECT_DUPLICATE_QUEUE } from '../../src/project/project-duplicate.types';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { EnvironmentVariablesService } from '../../src/project-environment/environment-variables.service';
import { ProjectPoolService } from '../../src/pool/project-pool.service';
import { PodCacheService } from '../../src/pod/pod.cache.service';
import { PodService } from '../../src/pod/pod.service';
import { ProxyService } from '../../src/proxy/proxy.service';
import { ScheduleService } from '../../src/schedule/schedule.service';
import { TenantService } from '../../src/tenant/tenant.service';
import { TimeoutService } from '../../src/timeout/timeout.service';
import { UserService } from '../../src/user/user.service';
import { WorkspaceService } from '../../src/workspace/workspace.service';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ExternalServiceProvisioningService } from '../../src/external-services';
import {
  FakeBifrostService,
  FakeExternalServiceProvisioningService,
  FakePodCacheService,
  FakePodService,
  FakeProjectAuthService,
  FakeProjectEventsService,
  FakeProjectPoolService,
  FakeQueue,
  FakeScheduleService,
  FakeTimeoutService,
} from './infra-fakes';

const REAL_SERVICES = [
  AgentConnectionService,
  AgentService,
  AgentSessionGateway,
  AgentStatusService,
  AgentUpdateService,
  AppReadinessService,
  AppService,
  DefaultsService,
  EnvironmentService,
  EnvironmentVariablesService,
  ForwardedIdentityService,
  GatewayKeyService,
  GitService,
  PermissionGuard,
  PodOpencodeClient,
  ProjectEnvironmentService,
  ProjectFilesService,
  ProjectService,
  ProxyService,
  TenantService,
  UserService,
  WorkspaceService,
];

const FAKED_SERVICES: { provide: InjectionToken; useClass: Type }[] = [
  { provide: BifrostService, useClass: FakeBifrostService },
  { provide: ExternalServiceProvisioningService, useClass: FakeExternalServiceProvisioningService },
  { provide: PodCacheService, useClass: FakePodCacheService },
  { provide: PodService, useClass: FakePodService },
  { provide: ProjectAuthService, useClass: FakeProjectAuthService },
  { provide: ProjectEventsService, useClass: FakeProjectEventsService },
  { provide: ProjectPoolService, useClass: FakeProjectPoolService },
  { provide: ScheduleService, useClass: FakeScheduleService },
  { provide: TimeoutService, useClass: FakeTimeoutService },
  { provide: getQueueToken(PROJECT_DUPLICATE_QUEUE), useClass: FakeQueue },
  { provide: getQueueToken(AGENT_WORKSPACE_UPDATE_QUEUE), useClass: FakeQueue },
];

export const DOMAIN_TEST_PROVIDERS: Provider[] = [...REAL_SERVICES, ...FAKED_SERVICES];

@Global()
@Module({
  providers: DOMAIN_TEST_PROVIDERS,
  exports: [...REAL_SERVICES, ...FAKED_SERVICES.map(({ provide }) => provide)],
})
export class DomainTestModule {}
