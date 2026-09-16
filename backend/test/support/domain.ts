import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { AgentService } from '../../src/agent/agent.service';
import { AgentConnectionService } from '../../src/agent-session/agent-connection.service';
import { AgentSessionGateway } from '../../src/agent-session/agent-session.gateway';
import { configuration } from '../../src/config/configuration';
import { EnvironmentService } from '../../src/environment/environment.service';
import { ProjectService } from '../../src/project/project.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { ProjectEventsService } from '../../src/project/project-events.service';
import { ProjectPoolService } from '../../src/pool/project-pool.service';
import { PodService } from '../../src/pod/pod.service';
import { ScheduleService } from '../../src/schedule/schedule.service';
import { TenantService } from '../../src/tenant/tenant.service';
import { TimeoutService } from '../../src/timeout/timeout.service';
import { UserService } from '../../src/user/user.service';
import { WorkspaceService } from '../../src/workspace/workspace.service';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ExternalServiceProvisioningService } from '../../src/external-services';
import { DomainTestModule } from './domain-module';
import type {
  FakeBifrostService,
  FakeExternalServiceProvisioningService,
  FakePodService,
  FakeProjectEventsService,
  FakeProjectPoolService,
  FakeScheduleService,
  FakeTimeoutService,
} from './infra-fakes';

export interface DomainTestHarness {
  moduleRef: TestingModule;
  agents: AgentService;
  agentSessions: AgentSessionGateway;
  agentConnections: AgentConnectionService;
  environments: EnvironmentService;
  projects: ProjectService;
  projectEnvironments: ProjectEnvironmentService;
  tenants: TenantService;
  users: UserService;
  workspaces: WorkspaceService;
  fakes: {
    bifrost: FakeBifrostService;
    externalServices: FakeExternalServiceProvisioningService;
    pods: FakePodService;
    pool: FakeProjectPoolService;
    projectEvents: FakeProjectEventsService;
    schedules: FakeScheduleService;
    timeouts: FakeTimeoutService;
  };
  close: () => Promise<void>;
}

export async function createDomainTestingModule(): Promise<DomainTestHarness> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] }), DomainTestModule],
  }).compile();

  return {
    moduleRef,
    agents: moduleRef.get(AgentService),
    agentSessions: moduleRef.get(AgentSessionGateway),
    agentConnections: moduleRef.get(AgentConnectionService),
    environments: moduleRef.get(EnvironmentService),
    projects: moduleRef.get(ProjectService),
    projectEnvironments: moduleRef.get(ProjectEnvironmentService),
    tenants: moduleRef.get(TenantService),
    users: moduleRef.get(UserService),
    workspaces: moduleRef.get(WorkspaceService),
    fakes: {
      bifrost: moduleRef.get<typeof BifrostService, FakeBifrostService>(BifrostService),
      externalServices: moduleRef.get<
        typeof ExternalServiceProvisioningService,
        FakeExternalServiceProvisioningService
      >(ExternalServiceProvisioningService),
      pods: moduleRef.get<typeof PodService, FakePodService>(PodService),
      pool: moduleRef.get<typeof ProjectPoolService, FakeProjectPoolService>(ProjectPoolService),
      projectEvents: moduleRef.get<typeof ProjectEventsService, FakeProjectEventsService>(ProjectEventsService),
      schedules: moduleRef.get<typeof ScheduleService, FakeScheduleService>(ScheduleService),
      timeouts: moduleRef.get<typeof TimeoutService, FakeTimeoutService>(TimeoutService),
    },
    close: () => moduleRef.close(),
  };
}
