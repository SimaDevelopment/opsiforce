import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { configuration } from '../src/config/configuration';
import { ProxyController } from '../src/proxy/proxy.controller';
import { ProjectStatus } from '../src/project/project.types';
import { PodService } from '../src/pod/pod.service';
import { ProjectEnvironmentService } from '../src/project-environment/project-environment.service';
import { DomainTestModule } from './support/domain-module';
import type { FakePodService } from './support/infra-fakes';
import { startFakePod, type FakePod } from './support/fake-pod';
import {
  addMember,
  addServiceAccount,
  createOrganization,
  createProject,
  createSharedWorkspace,
  privateWorkspaceCountOf,
  privateWorkspaceIdOf,
  type MemberFixture,
  type OrganizationFixture,
} from './support/project-fixtures';
import { proxyHeaders } from './support/proxy-identity';
import { waitFor } from './support/wait-for';

const CONTROL_TOKEN = 'proxy-control-token-for-tests';

@Module({ controllers: [ProxyController] })
class ProxyTestModule {}

let pod: FakePod;
let app: NestFastifyApplication;
let pods: FakePodService;
let environments: ProjectEnvironmentService;

beforeAll(async () => {
  pod = await startFakePod();
  process.env.AGENT_PORT = String(pod.port);
  process.env.PROXY_CONTROL_TOKEN = CONTROL_TOKEN;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }),
      DomainTestModule,
      ProxyTestModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  pods = app.get<PodService, FakePodService>(PodService);
  environments = app.get(ProjectEnvironmentService);
});

afterAll(async () => {
  await app.close();
  await pod.stop().catch(() => undefined);
});

function ensure(environmentId: string, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: `/api/internal/proxy/projects/${environmentId}/ensure`,
    headers: { 'x-proxy-control-token': CONTROL_TOKEN, ...headers },
    payload: { surface: 'agent' },
  });
}

async function runningProjectIn(
  organization: OrganizationFixture,
  options: { workspaceId?: string | null } = {}
): Promise<string> {
  const projectId = await createProject(app, organization, options);
  const podName = pods.assignedPodName(projectId);
  await waitFor(() => pods.callsTo('waitForReady').some((call) => call.args.podName === podName));
  pods.markPodReady(podName, '127.0.0.1');
  await waitFor(async () => (await environments.findByIdOrNull(projectId))?.status === ProjectStatus.Active);
  return projectId;
}

describe('authorizing a runtime through the proxy ensure call', () => {
  it('lets a member of the organization reach a public project', async () => {
    const organization = await createOrganization(app);
    const member = await addMember(app, organization);
    const projectId = await runningProjectIn(organization);

    const res = await ensure(projectId, member.headers);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ state: 'ready' });
  });

  it('hides a project in a workspace the caller is not a member of', async () => {
    const organization = await createOrganization(app);
    const owner = await addMember(app, organization);
    const outsider = await addMember(app, organization);
    const workspaceId = await createSharedWorkspace(app, organization, owner);
    const projectId = await runningProjectIn(organization, { workspaceId });

    expect((await ensure(projectId, owner.headers)).statusCode).toBe(201);

    const hidden = await ensure(projectId, outsider.headers);
    expect(hidden.statusCode).toBe(404);
  });

  it('hides a private workspace project from another member of the same organization', async () => {
    const organization = await createOrganization(app);
    const owner = await addMember(app, organization);
    const other = await addMember(app, organization);
    const workspaceId = await privateWorkspaceIdOf(app, organization, owner);
    const projectId = await runningProjectIn(organization, { workspaceId });

    expect((await ensure(projectId, owner.headers)).statusCode).toBe(201);
    expect((await ensure(projectId, other.headers)).statusCode).toBe(404);
  });

  it('keeps organizations isolated', async () => {
    const organization = await createOrganization(app);
    const elsewhere = await createOrganization(app);
    const stranger = await addMember(app, elsewhere);
    const projectId = await runningProjectIn(organization);

    expect((await ensure(projectId, stranger.headers)).statusCode).toBe(404);
  });

  it('refuses a request that carries no forwarded identity', async () => {
    const organization = await createOrganization(app);
    const projectId = await runningProjectIn(organization);

    const res = await app.inject({
      method: 'POST',
      url: `/api/internal/proxy/projects/${projectId}/ensure`,
      headers: { 'x-proxy-control-token': CONTROL_TOKEN, 'x-forwarded-groups': 'opsiforce-anything' },
      payload: { surface: 'agent' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('still requires the control token', async () => {
    const organization = await createOrganization(app);
    const member = await addMember(app, organization);
    const projectId = await runningProjectIn(organization);

    const res = await app.inject({
      method: 'POST',
      url: `/api/internal/proxy/projects/${projectId}/ensure`,
      headers: member.headers,
      payload: { surface: 'agent' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('does not need the caller to have visited the platform API first', async () => {
    const organization = await createOrganization(app);
    const projectId = await runningProjectIn(organization);
    const keycloakId = randomUUID();
    const headers = proxyHeaders({ userId: keycloakId, organizations: [organization.name] });

    expect((await ensure(projectId, headers)).statusCode).toBe(201);

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.keycloakId, keycloakId));
    expect(user).toBeDefined();
  });
});

describe('identity side effects of reaching a runtime', () => {
  it('creates no personal workspace for a service account', async () => {
    const organization = await createOrganization(app);
    const serviceAccount = addServiceAccount(organization);
    const projectId = await runningProjectIn(organization);

    expect((await ensure(projectId, serviceAccount.headers)).statusCode).toBe(201);
    expect(await privateWorkspaceCountOf(serviceAccount.keycloakId)).toBe(0);
  });

  it('keeps a known profile when the edge omits a field', async () => {
    const organization = await createOrganization(app);
    const member = await addMember(app, organization);
    const projectId = await runningProjectIn(organization);

    await ensure(projectId, member.headers);
    const withEmail = await profileOf(member);

    const withoutEmail = proxyHeaders({
      userId: member.keycloakId,
      username: withEmail.displayName ?? undefined,
      email: null,
      organizations: [organization.name],
    });
    expect((await ensure(projectId, withoutEmail)).statusCode).toBe(201);

    expect(await profileOf(member)).toEqual(withEmail);
  });

  it('preserves the display name when username and email are absent', async () => {
    const organization = await createOrganization(app);
    const member = await addMember(app, organization);
    const projectId = await runningProjectIn(organization);
    await ensure(projectId, member.headers);
    const original = await profileOf(member);
    const headers = { ...member.headers };
    delete headers['x-forwarded-preferred-username'];
    delete headers['x-forwarded-email'];
    expect((await ensure(projectId, headers)).statusCode).toBe(201);
    expect(await profileOf(member)).toEqual(original);
  });

  it('runs the same path for the fixed identity a static deployment injects', async () => {
    const organization = await createOrganization(app);
    const projectId = await runningProjectIn(organization);
    const staticIdentity = proxyHeaders({
      userId: 'static-user',
      username: 'static',
      organizations: [organization.name],
    });

    expect((await ensure(projectId, staticIdentity)).statusCode).toBe(201);
    expect((await ensure(projectId, staticIdentity)).statusCode).toBe(201);
  });
});

async function profileOf(member: MemberFixture): Promise<{ email: string | null; displayName: string | null }> {
  const [row] = await db
    .select({ email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.keycloakId, member.keycloakId));
  return row;
}
