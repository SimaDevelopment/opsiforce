import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Perms } from '../../src/permission/permission.constants';
import { PodService } from '../../src/pod/pod.service';
import { ProjectStatus } from '../../src/project/project.types';
import { PROJECT_FIELDS } from './support/dto-fields';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import type { FakePodService } from '../support/infra-fakes';
import {
  addMember,
  addServiceAccount,
  createAgent,
  createFolder,
  createOrganization,
  createProject,
  createSharedWorkspace,
  disablePrivateWorkspaces,
  disableProject,
  placementOf,
  privateWorkspaceCountOf,
  privateWorkspaceIdOf,
  type MemberFixture,
  type OrganizationFixture,
} from '../support/project-fixtures';
import { waitFor } from '../support/wait-for';

interface CallerHeaders {
  headers: Record<string, string>;
}

interface CreatedProject {
  id: string;
  environments: { name: string; isDefault: boolean; status: string }[];
}

interface ErrorItem {
  detail: string;
  pointer: string;
  in: string;
}

function pointers(res: LightMyRequestResponse): string[] {
  const { errors } = res.json<{ errors: ErrorItem[] }>();
  return errors.map((error) => error.pointer);
}

describe('projects write routes', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let pods: FakePodService;
  let agentId: string;

  function post(caller: CallerHeaders, body: Record<string, string>): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url: '/api/v1/projects', headers: caller.headers, payload: body });
  }

  function remove(caller: CallerHeaders, projectId: string): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}`, headers: caller.headers });
  }

  function restart(caller: CallerHeaders, projectId: string): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/restart`, headers: caller.headers });
  }

  async function createdProjectId(caller: CallerHeaders, body: Record<string, string>): Promise<string> {
    const res = await post(caller, { title: 'Placed', agentId, ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    app = harness.app;
    pods = app.get<FakePodService>(PodService);
    agentId = await createAgent();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('the body it accepts', () => {
    let member: MemberFixture;

    beforeAll(async () => {
      member = await addMember(app, await createOrganization(app));
    });

    it('refuses a body without a title or an Agent', async () => {
      const res = await post(member, {});

      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe('urn:opsiforce:error:validation-error');
      expect(pointers(res).toSorted()).toEqual(['#/agentId', '#/title']);
    });

    it('refuses a title that is blank once trimmed, and one over thirty characters', async () => {
      const blank = await post(member, { title: '   ', agentId });
      expect(blank.statusCode).toBe(400);
      expect(pointers(blank)).toEqual(['#/title']);

      const long = await post(member, { title: 'x'.repeat(31), agentId });
      expect(long.statusCode).toBe(400);
      expect(pointers(long)).toEqual(['#/title']);
    });

    it('trims the title and the description it stores', async () => {
      const res = await post(member, { title: '  Trimmed  ', agentId, description: '  spaced  ' });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ title: 'Trimmed', description: 'spaced' });
    });

    it('refuses a description over a hundred characters', async () => {
      const res = await post(member, { title: 'Wordy', agentId, description: 'x'.repeat(101) });

      expect(res.statusCode).toBe(400);
      expect(pointers(res)).toEqual(['#/description']);
    });

    it('refuses a time zone that is not an IANA name', async () => {
      const res = await post(member, { title: 'Zoned', agentId, timezone: 'Mars/Olympus' });

      expect(res.statusCode).toBe(400);
      expect(pointers(res)).toEqual(['#/timezone']);
    });

    it('keeps an IANA time zone', async () => {
      const res = await post(member, { title: 'Zoned', agentId, timezone: 'Europe/Kyiv' });

      expect(res.statusCode).toBe(201);
      expect(res.json().timezone).toBe('Europe/Kyiv');
    });

    it('reports one issue per unknown key, including an initial prompt', async () => {
      const res = await post(member, { title: 'Chatty', agentId, prompt: 'do the thing', podClass: 'large' });

      expect(res.statusCode).toBe(400);
      expect(pointers(res).toSorted()).toEqual(['#/podClass', '#/prompt']);
    });
  });

  describe('references it cannot resolve', () => {
    let organization: OrganizationFixture;
    let member: MemberFixture;
    let workspaceId: string;

    beforeAll(async () => {
      organization = await createOrganization(app);
      member = await addMember(app, organization);
      workspaceId = await createSharedWorkspace(app, organization, member);
    });

    it('answers 422 for an unknown Agent id', async () => {
      const unknown = randomUUID();
      const res = await post(member, { title: 'Agentless', agentId: unknown });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:invalid-reference',
        errors: [{ pointer: '#/agentId', in: 'body', detail: expect.stringContaining(unknown) }],
      });
    });

    it('answers 422 for a workspace in another Organization', async () => {
      const other = await createOrganization(app);
      const otherMember = await addMember(app, other);
      const foreign = await createSharedWorkspace(app, other, otherMember);

      const res = await post(member, { title: 'Foreign', agentId, workspaceId: foreign });

      expect(res.statusCode).toBe(422);
      expect(pointers(res)).toEqual(['#/workspaceId']);
    });

    it('answers 422 for a workspace the caller is not a member of', async () => {
      const outsider = await addMember(app, organization);

      const res = await post(outsider, { title: 'Not mine', agentId, workspaceId });

      expect(res.statusCode).toBe(422);
      expect(pointers(res)).toEqual(['#/workspaceId']);
    });

    it('answers 422 for a folder that lives in another workspace', async () => {
      const otherWorkspaceId = await createSharedWorkspace(app, organization, member);
      const folder = await createFolder(app, organization, member, otherWorkspaceId);

      const res = await post(member, { title: 'Misfiled', agentId, workspaceId, folderId: folder.id });

      expect(res.statusCode).toBe(422);
      expect(pointers(res)).toEqual(['#/folderId']);
    });

    it('answers 422 for an unknown folder id', async () => {
      const res = await post(member, { title: 'Nowhere', agentId, workspaceId, folderId: randomUUID() });

      expect(res.statusCode).toBe(422);
      expect(pointers(res)).toEqual(['#/folderId']);
    });

    it('names every offending field in one answer', async () => {
      const res = await post(member, {
        title: 'All wrong',
        agentId: randomUUID(),
        workspaceId: randomUUID(),
        folderId: randomUUID(),
      });

      expect(res.statusCode).toBe(422);
      expect(pointers(res).toSorted()).toEqual(['#/agentId', '#/folderId', '#/workspaceId']);
    });

    it('names the folder too when its workspace is one the caller cannot reach', async () => {
      const other = await createOrganization(app);
      const otherMember = await addMember(app, other);
      const foreign = await createSharedWorkspace(app, other, otherMember);
      const folder = await createFolder(app, other, otherMember, foreign);

      const res = await post(member, { title: 'Foreign folder', agentId, workspaceId: foreign, folderId: folder.id });

      expect(res.statusCode).toBe(422);
      expect(pointers(res).toSorted()).toEqual(['#/folderId', '#/workspaceId']);
    });
  });

  describe('where a Project lands', () => {
    it('puts a member Project in their Personal workspace while private workspaces are on', async () => {
      const organization = await createOrganization(app);
      const member = await addMember(app, organization);

      const projectId = await createdProjectId(member, {});

      const placement = await placementOf(projectId);
      expect(placement).toMatchObject({ workspaceType: 'private', workspaceOwnerId: member.userId, folderId: null });
      expect(placement.workspaceId).toBe(await privateWorkspaceIdOf(app, organization, member));
    });

    it('adds no workspace of its own to a creation it rejects', async () => {
      const organization = await createOrganization(app);
      const member = await addMember(app, organization, [Perms.usePublicApi, Perms.manageWorkspaces]);
      const before = await privateWorkspaceCountOf(member.keycloakId);

      const res = await post(member, { title: 'Rejected', agentId: randomUUID() });

      expect(res.statusCode).toBe(422);
      expect(await privateWorkspaceCountOf(member.keycloakId)).toBe(before);
    });

    it('puts a member Project in Public once the Organization turns private workspaces off', async () => {
      const organization = await createOrganization(app);
      await disablePrivateWorkspaces(organization);
      const member = await addMember(app, organization);

      const projectId = await createdProjectId(member, {});

      expect(await placementOf(projectId)).toMatchObject({ workspaceId: null, workspaceType: null });
    });

    it('puts a service account Project in Public without can_manage_workspaces, and never gives it a Personal workspace', async () => {
      const organization = await createOrganization(app);
      const serviceAccount = addServiceAccount(organization);

      const projectId = await createdProjectId(serviceAccount, {});

      expect(await placementOf(projectId)).toMatchObject({ workspaceId: null, workspaceType: null });
      expect(await privateWorkspaceCountOf(serviceAccount.keycloakId)).toBe(0);
    });

    it('lets a service account into Public without the permission when private workspaces are off', async () => {
      const organization = await createOrganization(app);
      await disablePrivateWorkspaces(organization);
      const serviceAccount = addServiceAccount(organization);

      const projectId = await createdProjectId(serviceAccount, {});

      expect(await placementOf(projectId)).toMatchObject({ workspaceId: null });
    });

    it('honours an explicit workspace the caller belongs to, without any workspace permission', async () => {
      const organization = await createOrganization(app);
      const member = await addMember(app, organization);
      const workspaceId = await createSharedWorkspace(app, organization, member);

      const projectId = await createdProjectId(member, { workspaceId });

      expect(await placementOf(projectId)).toMatchObject({ workspaceId, workspaceType: 'shared' });
    });

    it('honours an explicit folder inside that workspace', async () => {
      const organization = await createOrganization(app);
      const member = await addMember(app, organization);
      const workspaceId = await createSharedWorkspace(app, organization, member);
      const folder = await createFolder(app, organization, member, workspaceId);

      const projectId = await createdProjectId(member, { workspaceId, folderId: folder.id });

      expect(await placementOf(projectId)).toMatchObject({ workspaceId, folderId: folder.id });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}`,
        headers: member.headers,
      });
      expect(res.json()).toMatchObject({ folder: { id: folder.id, name: folder.name } });
    });

    it('honours a Personal workspace named explicitly', async () => {
      const organization = await createOrganization(app);
      const member = await addMember(app, organization);
      const privateWorkspaceId = await privateWorkspaceIdOf(app, organization, member);

      const projectId = await createdProjectId(member, { workspaceId: privateWorkspaceId });

      expect(await placementOf(projectId)).toMatchObject({ workspaceId: privateWorkspaceId });
    });
  });

  describe('the answer to a creation', () => {
    let organization: OrganizationFixture;
    let member: MemberFixture;
    let body: CreatedProject;
    let projectId: string;

    beforeAll(async () => {
      organization = await createOrganization(app);
      member = await addMember(app, organization);
      const res = await post(member, { title: 'Fresh', agentId, description: 'A new one' });
      expect(res.statusCode).toBe(201);
      body = res.json<CreatedProject>();
      projectId = body.id;
    });

    it('carries exactly the documented Project fields', () => {
      expect(Object.keys(body)).toEqual(PROJECT_FIELDS);
      expect(body).toMatchObject({
        title: 'Fresh',
        description: 'A new one',
        agent: { id: agentId, name: expect.any(String) },
        disabled: false,
        timezone: 'UTC',
        lastPromptAt: null,
      });
    });

    it('reports the Development environment as starting', () => {
      expect(body.environments).toEqual([
        expect.objectContaining({ name: 'Development', isDefault: true, status: ProjectStatus.Starting }),
      ]);
    });

    it('is readable straight away and becomes active once its pod is ready', async () => {
      const read = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers: member.headers });
      expect(read.statusCode).toBe(200);
      expect(read.json<CreatedProject>().environments[0].status).toBe(ProjectStatus.Starting);

      const podName = pods.assignedPodName(projectId);
      await waitFor(() => pods.callsTo('waitForReady').some((call) => call.args.podName === podName));
      pods.markPodReady(podName);

      await waitFor(async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/projects/${projectId}`,
          headers: member.headers,
        });
        return res.json<CreatedProject>().environments[0].status === ProjectStatus.Active;
      });
    });
  });

  describe('restarting a Project', () => {
    let organization: OrganizationFixture;
    let restarter: MemberFixture;

    beforeAll(async () => {
      organization = await createOrganization(app);
      restarter = await addMember(app, organization, [Perms.usePublicApi, Perms.restartProject]);
    });

    it('answers 204 and recreates the Development pod on the same workspace', async () => {
      const projectId = await createProject(app, organization, { title: 'Restarted' });
      const podName = pods.assignedPodName(projectId);
      const deletesBefore = pods.callsTo('deletePod').filter((call) => call.args.podName === podName).length;

      const res = await restart(restarter, projectId);

      expect(res.statusCode, res.body).toBe(204);
      expect(res.body).toBe('');
      expect(pods.callsTo('deletePod').filter((call) => call.args.podName === podName).length).toBe(
        deletesBefore + 1
      );
    });

    it('refuses a visible Project to a member without can_restart_project', async () => {
      const projectId = await createProject(app, organization, { title: 'Kept running' });
      const member = await addMember(app, organization);

      const res = await restart(member, projectId);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:permission-denied',
        permission: Perms.restartProject,
      });
    });

    it('reports a disabled Project as locked', async () => {
      const projectId = await createProject(app, organization, { title: 'Disabled' });
      await disableProject(projectId);

      const res = await restart(restarter, projectId);

      expect(res.statusCode).toBe(423);
      expect(res.json().type).toBe('urn:opsiforce:error:environment-disabled');
    });

    it('answers 404 before the permission for a Project the caller cannot see', async () => {
      const owner = await addMember(app, organization);
      const workspaceId = await createSharedWorkspace(app, organization, owner);
      const hiddenId = await createProject(app, organization, { title: 'Hidden', workspaceId });
      const outsider = await addMember(app, organization);

      const res = await restart(outsider, hiddenId);

      expect(res.statusCode).toBe(404);
      expect(res.json().type).toBe('urn:opsiforce:error:project-not-found');
    });
  });

  describe('deleting a Project', () => {
    let organization: OrganizationFixture;
    let deleter: MemberFixture;

    beforeAll(async () => {
      organization = await createOrganization(app);
      deleter = await addMember(app, organization, [Perms.usePublicApi, Perms.deleteProject]);
    });

    it('answers 204 and then 404 on a repeat', async () => {
      const projectId = await createProject(app, organization, { title: 'Doomed' });

      const first = await remove(deleter, projectId);
      expect(first.statusCode).toBe(204);
      expect(first.body).toBe('');

      const repeat = await remove(deleter, projectId);
      expect(repeat.statusCode).toBe(404);
      expect(repeat.json().type).toBe('urn:opsiforce:error:project-not-found');

      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}`,
        headers: deleter.headers,
      });
      expect(read.statusCode).toBe(404);
    });

    it('answers 404 for an unknown Project id', async () => {
      expect((await remove(deleter, randomUUID())).statusCode).toBe(404);
    });

    it('refuses a visible Project to a member without can_delete_project', async () => {
      const projectId = await createProject(app, organization, { title: 'Kept' });
      const member = await addMember(app, organization);

      const res = await remove(member, projectId);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:permission-denied',
        permission: Perms.deleteProject,
      });
      expect(await placementOf(projectId)).toMatchObject({ workspaceId: null });
    });

    it('answers 404 before the permission for a Project the caller cannot see', async () => {
      const owner = await addMember(app, organization);
      const workspaceId = await createSharedWorkspace(app, organization, owner);
      const hiddenId = await createProject(app, organization, { title: 'Hidden', workspaceId });
      const outsider = await addMember(app, organization);

      const res = await remove(outsider, hiddenId);

      expect(res.statusCode).toBe(404);
      expect(res.json().type).toBe('urn:opsiforce:error:project-not-found');
      expect(await placementOf(hiddenId)).toMatchObject({ workspaceId });
    });
  });
});
