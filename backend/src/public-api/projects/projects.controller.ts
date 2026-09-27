import { Body, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { withConnectionCancellation } from '../../common/connection-cancellation';
import { AllowsGatewayCaller } from '../auth/allows-gateway-caller.decorator';
import { Caller } from '../auth/caller';
import { Errors } from '../errors/public-api-error';
import { PublicApiController, PublicApiErrors, PublicNoContentResponse, PublicResponse } from '../public-api.decorator';
import { PublicProjectsService } from './projects.service';
import {
  ConnectionSchema,
  CreateProjectSchema,
  EnvironmentPathSchema,
  ProjectListQuerySchema,
  ProjectPageSchema,
  ProjectPathSchema,
  ProjectSchema,
  type ConnectionDto,
  type CreateProject,
  type EnvironmentPath,
  type ProjectDto,
  type ProjectListQuery,
  type ProjectPageDto,
  type ProjectPath,
} from './projects.schema';

@ApiTags('Projects')
@PublicApiController('projects')
export class ProjectsController {
  constructor(private readonly projects: PublicProjectsService) {}

  @Get()
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'List Projects',
    description:
      'Every Project you can see in the selected Organization. Public Projects are visible to all members; a workspace Project only to that workspace. Disabled ones appear with disabled true. Newest first; page with the opaque cursor.\n\n**Use it for** a dashboard or a "which Project?" picker, and for reconciling a local list on a schedule — page with cursor until nextCursor is null. Filter with agentId to find everything running one Agent, for instance before retiring it.',
  })
  @PublicResponse(200, ProjectPageSchema)
  @PublicApiErrors('validation-error')
  list(
    @Caller() caller: Caller,
    @Query({ schema: ProjectListQuerySchema }) query: ProjectListQuery
  ): Promise<ProjectPageDto> {
    return this.projects.list(caller, query);
  }

  @Post()
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Create a Project',
    description:
      'Answers at once, normally with the Development environment still starting; poll the Project until it reports active. Omit workspaceId and the Project lands where the app would put it: a member gets their Personal workspace, a service account the Organization-wide Public area. An Organization with private workspaces turned off puts every omitted placement in Public.\n\n**Use it for** giving a piece of work its own Agent: one Project per support ticket, per customer, per chat thread. The usual sequence is List Agents to pick an agentId, Create a Project, poll Get a Project until the Development environment is active, then Send a Prompt. You can skip the polling — a Prompt wakes a cold environment by itself — so poll only when you want to show progress.',
  })
  @ApiBody({
    required: true,
    schema: { $ref: '#/components/schemas/CreateProject' },
    examples: {
      minimal: {
        summary: 'Smallest useful call',
        description: 'A title and an agentId from GET /agents. Everything else takes a default.',
        value: { title: 'Public API Live Check', agentId: 'e70306b2-e32e-4d7f-b812-cfed76d6e693' },
      },
      perTicket: {
        summary: 'One Project per support ticket',
        description: 'A Project opened for ticket 4821, named so a user can find it in the app.',
        value: {
          title: 'Ticket 4821',
          agentId: 'e70306b2-e32e-4d7f-b812-cfed76d6e693',
          description: 'Checkout fails on Safari',
          timezone: 'Europe/Kyiv',
        },
      },
      intoWorkspace: {
        summary: 'Into a chosen workspace',
        description: "Place it beside a team's other Projects instead of the default placement.",
        value: {
          title: 'Weekly report',
          agentId: 'e70306b2-e32e-4d7f-b812-cfed76d6e693',
          workspaceId: 'c08c1ba8-e822-406a-a942-77cf5299d75f',
        },
      },
    },
  })
  @PublicResponse(201, ProjectSchema)
  @PublicApiErrors('validation-error', 'invalid-reference', 'test-project-exists')
  create(@Caller() caller: Caller, @Body({ schema: CreateProjectSchema }) body: CreateProject): Promise<ProjectDto> {
    return this.projects.create(caller, body);
  }

  @Get(':id')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Get a Project',
    description:
      'One Project by id. A Project in another Organization, in a workspace you are not in, or that never existed all answer 404 alike, so the API never confirms a hidden Project is there.\n\n**Use it for** polling a freshly created Project until environments[0].status is active, and for a cheap status refresh afterwards: agentStatus tells you whether the Agent is busy and lastPromptAt when it last worked, without touching the pod.',
  })
  @PublicResponse(200, ProjectSchema)
  @PublicApiErrors('project-not-found')
  async get(@Caller() caller: Caller, @Param({ schema: ProjectPathSchema }) path: ProjectPath): Promise<ProjectDto> {
    const project = await this.projects.findVisible(caller, path.id);
    if (!project) throw Errors.projectNotFound();
    return project;
  }

  @Post(':id/environments/:environmentId/connect')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Connect to an environment',
    description:
      'Wakes the environment if it is asleep and answers once its opencode runtime is ready and the Project\'s primary Session is bound. The answer is everything a client needs to talk to the runtime directly: where it is, where its own OpenAPI document is, which Session to open and which build answered.\n\nThe URLs are origin-relative. Resolve them against the origin you called this API on, and send your bearer token only to that origin.\n\nThe call is bounded: an environment still starting when the budget runs out answers 503 with Retry-After, so retry rather than treating it as a failure. A 200 is a usable connection now, not a promise the environment will never restart — reconnect after a restart.\n\n**Then what?** This is the last call in this API for that conversation. Chat is native opencode: everything after this goes to `baseUrl` in the runtime\'s own shapes, which this document does not reproduce and does not version.\n\n```\nPOST   {baseUrl}/api/session/{sessionId}/prompt      {"id":"msg_…","text":"…"}\nGET    {baseUrl}/api/session/{sessionId}/message?limit=50&order=desc\nGET    {baseUrl}/api/event                            (server-sent events)\nPOST   {baseUrl}/api/session/{sessionId}/wait         (returns when the Session is idle)\nPOST   {baseUrl}/api/session/{sessionId}/interrupt\nGET    {baseUrl}/api/session/{sessionId}/inbox\n```\n\nThe authoritative reference for those is `openapiUrl` — the deployed runtime\'s own OpenAPI document, fetched with the same bearer token. It is per environment and per build, which is why it is returned here instead of linked from this page. The matching client is `@opencode-ai/client`, pinned to the same build string this call reports as `build`.\n\nTwo things to know before you write against it. Native `wait` means the Session went idle, not that your prompt succeeded — read the outcome from the messages or the events. And send your own `id` on a prompt so a retry is harmless: the runtime returns the first admission again for the same id and body, and conflicts on a different one.\n\n**Use it for** the one step between creating a Project and talking to it.',
  })
  @PublicResponse(200, ConnectionSchema)
  @PublicApiErrors(
    'validation-error',
    'project-not-found',
    'environment-starting',
    'environment-disabled',
    'environment-failed',
    'agent-unreachable',
    'agent-timeout'
  )
  connect(
    @Caller() caller: Caller,
    @Param({ schema: EnvironmentPathSchema }) path: EnvironmentPath,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<ConnectionDto> {
    return withConnectionCancellation(reply.raw, (signal) =>
      this.projects.connect(caller, path.id, path.environmentId, signal)
    );
  }

  @Post(':id/restart')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Restart a Project',
    description:
      "Throws the Development environment's pod away and starts a new one on the same workspace. Files under /workspace survive; everything installed into the container in chat does not, and startup.sh runs from cold — which is exactly what happens when a Project idles out or is published. Requires can_restart_project. Answers 204 at once; poll Get a Project until environments[0].status is active, then Connect again, because a new pod is a new Connection. A disabled Project answers 423.\n\n**Use it for** proving an App comes back on its own — the Skill & Agent Builder runs it once per test after the child's App is live.",
  })
  @PublicNoContentResponse('The pod is being recreated')
  @PublicApiErrors('project-not-found', 'permission-denied', 'environment-disabled')
  restart(@Caller() caller: Caller, @Param({ schema: ProjectPathSchema }) path: ProjectPath): Promise<void> {
    return this.projects.restart(caller, path.id);
  }

  @Post(':id/test/update')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Update a Test Project',
    description:
      "Overlays the Agent's saved Development Template onto the Test Project's workspace and commits the files it wrote as \"Template update\". It overwrites and adds, replacing a path the Template turned from a file into a folder or back, and deletes nothing else: remove a file the Template dropped through the shell yourself. The pod keeps running and the conversation carries on, so restart the Project yourself when something that runs has changed. The Project's Bifrost spend keeps its running total.\n\nOnly the gateway key of the Builder chat that created the Test Project may call it. Everyone else is refused with 403.\n\n**Use it for** getting a Template fix into the child byte for byte after saving it, without losing the conversation.",
  })
  @PublicNoContentResponse('The Template is overlaid and committed')
  @PublicApiErrors('project-not-found', 'permission-denied')
  updateTest(@Caller() caller: Caller, @Param({ schema: ProjectPathSchema }) path: ProjectPath): Promise<void> {
    return this.projects.updateTest(caller, path.id);
  }

  @Post(':id/test/reset')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Reset a Test Project',
    description:
      "Stops the pod, wipes the workspace, and lays the Template, prompt and Skills from the Agent's Development exactly as a create does. It then unpins the primary Session, so the next Connect binds a new one, resets the Project's Bifrost spend, and starts the pod, so first boot runs again. The Project id, its side pane and its preview URL stay the same. Answers 204 once the pod is starting; poll Get a Project until environments[0].status is active, then Connect again.\n\nOnly the gateway key of the Builder chat that created the Test Project may call it. Everyone else is refused with 403. A disabled Project answers 423.\n\n**Use it for** a clean start in the same Test Project, when the child's conversation or workspace no longer tells you anything about the Template.",
  })
  @PublicNoContentResponse('The workspace is laid again and the pod is starting')
  @PublicApiErrors('project-not-found', 'permission-denied', 'environment-disabled')
  resetTest(@Caller() caller: Caller, @Param({ schema: ProjectPathSchema }) path: ProjectPath): Promise<void> {
    return this.projects.resetTest(caller, path.id);
  }

  @Delete(':id')
  @AllowsGatewayCaller()
  @ApiOperation({
    summary: 'Delete a Project',
    description:
      'Permanent, and requires can_delete_project. The Project, its environments and their pods are gone; a second call answers 404. A Project you cannot see answers 404 before the permission is even checked.\n\n**Use it for** tearing down short-lived Projects — a preview per pull request, a scratch Project per ticket — at the end of their life. There is no archive and no undo, so for something a user may come back to, disable it in the app instead.',
  })
  @PublicNoContentResponse('The Project is gone')
  @PublicApiErrors('project-not-found', 'permission-denied')
  remove(@Caller() caller: Caller, @Param({ schema: ProjectPathSchema }) path: ProjectPath): Promise<void> {
    return this.projects.delete(caller, path.id);
  }
}
