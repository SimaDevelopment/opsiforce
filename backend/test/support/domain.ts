import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { AgentExportService } from '../../src/agent/agent-export.service';
import { AgentImportService } from '../../src/agent/agent-import.service';
import { AgentService } from '../../src/agent/agent.service';
import { AgentConnectionService } from '../../src/agent-session/agent-connection.service';
import { AgentSessionGateway } from '../../src/agent-session/agent-session.gateway';
import { BuilderChatService } from '../../src/builder/builder-chat.service';
import { configuration } from '../../src/config/configuration';
import { DeliveryService } from '../../src/delivery/delivery.service';
import { SkillDeliveryService } from '../../src/delivery/skill-delivery.service';
import { EnvironmentService } from '../../src/environment/environment.service';
import { ProjectImportService } from '../../src/project/project-import.service';
import { ProjectService } from '../../src/project/project.service';
import { SkillService } from '../../src/store/skill.service';
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
  agentExports: AgentExportService;
  agentImports: AgentImportService;
  agentSessions: AgentSessionGateway;
  agentConnections: AgentConnectionService;
  builderChats: BuilderChatService;
  delivery: DeliveryService;
  skillDeliveries: SkillDeliveryService;
  environments: EnvironmentService;
  projects: ProjectService;
  projectImports: ProjectImportService;
  projectEnvironments: ProjectEnvironmentService;
  skills: SkillService;
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
    agentExports: moduleRef.get(AgentExportService),
    agentImports: moduleRef.get(AgentImportService),
    agentSessions: moduleRef.get(AgentSessionGateway),
    agentConnections: moduleRef.get(AgentConnectionService),
    builderChats: moduleRef.get(BuilderChatService),
    delivery: moduleRef.get(DeliveryService),
    skillDeliveries: moduleRef.get(SkillDeliveryService),
    environments: moduleRef.get(EnvironmentService),
    projects: moduleRef.get(ProjectService),
    projectImports: moduleRef.get(ProjectImportService),
    projectEnvironments: moduleRef.get(ProjectEnvironmentService),
    skills: moduleRef.get(SkillService),
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
