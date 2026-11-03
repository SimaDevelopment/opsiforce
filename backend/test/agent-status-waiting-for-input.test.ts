import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentStatusService } from '../src/project/agent-status.service';
import { ProjectService } from '../src/project/project.service';
import { ProjectEnvironmentService } from '../src/project-environment/project-environment.service';
import { ProjectStatus } from '../src/project/project.types';
import { createObservationSeam, type ObservationSeam } from './support/observation-seam';
import { waitFor } from './support/wait-for';

let seam: ObservationSeam;

beforeAll(async () => {
  seam = await createObservationSeam();
});

afterAll(async () => {
  await seam?.close();
});

beforeEach(() => seam.reset());

describe('waiting for input from input observations', () => {
  it('turns waiting on input.requested and off on input.resolved, on the projects list and the stream', async () => {
    const project = await seam.createRunningProject();
    const stream = await seam.openAgentStatusStream(project.member);
    await waitFor(() => stream.waitingOf(project.projectId).length === 1);

    await seam.runStarted(project, 'ses_a');
    await seam.inputRequested(project, 'per_1');
    expect(await seam.waitingForInputOf(project)).toBe(true);
    const publicProject = await seam.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.projectId}`,
      headers: project.member.headers,
    });
    expect(publicProject.json()).toMatchObject({ agentStatus: 'working', waitingForInput: true });
    await seam.inputResolved(project, 'per_1');
    expect(await seam.waitingForInputOf(project)).toBe(false);
    await seam.runEnded(project, 'ses_a');

    await waitFor(() => stream.waitingOf(project.projectId).length === 5);
    expect(stream.events.filter((event) => event.projectId === project.projectId)).toEqual([
      { projectId: project.projectId, agentStatus: 'idle', waitingForInput: false },
      { projectId: project.projectId, agentStatus: 'working', waitingForInput: false },
      { projectId: project.projectId, agentStatus: 'working', waitingForInput: true },
      { projectId: project.projectId, agentStatus: 'working', waitingForInput: false },
      { projectId: project.projectId, agentStatus: 'idle', waitingForInput: false },
    ]);
    stream.close();
  });

  it('stays waiting until every pending request is resolved', async () => {
    const project = await seam.createRunningProject();

    await seam.inputRequested(project, 'per_1');
    await seam.inputRequested(project, 'frm_1');
    await seam.inputResolved(project, 'per_1');
    expect(await seam.waitingForInputOf(project)).toBe(true);

    await seam.inputResolved(project, 'frm_1');
    expect(await seam.waitingForInputOf(project)).toBe(false);
  });

  it('treats a repeated request as one and ignores a resolution for a request it never saw', async () => {
    const project = await seam.createRunningProject();

    const unknown = await seam.inputResolved(project, 'per_unknown');
    await seam.inputRequested(project, 'per_1');
    await seam.inputRequested(project, 'per_1');
    await seam.inputResolved(project, 'per_unknown');
    expect(unknown.statusCode).toBe(204);
    expect(await seam.waitingForInputOf(project)).toBe(true);

    await seam.inputResolved(project, 'per_1');
    expect(await seam.waitingForInputOf(project)).toBe(false);
  });

  it('ignores an input observation without a request id', async () => {
    const project = await seam.createRunningProject();

    const res = await seam.observe(project.gatewayKey, { kind: 'input.requested', sessionId: 'ses_a' });

    expect(res.statusCode).toBe(204);
    expect(await seam.waitingForInputOf(project)).toBe(false);
  });

  it('leaves Agent Status alone: a request alone does not make the Agent Working', async () => {
    const project = await seam.createRunningProject();

    await seam.inputRequested(project, 'frm_1');

    expect(await seam.agentStatusOf(project)).toBe('idle');
    expect(await seam.waitingForInputOf(project)).toBe(true);
  });
});

describe('the re-read resyncs pending input', () => {
  it('heals a lost input.resolved while the run goes on', async () => {
    const project = await seam.createRunningProject();
    await seam.runStarted(project, 'ses_a');
    await seam.inputRequested(project, 'per_1');

    seam.pod.setActive(['ses_a']);
    seam.pod.setPendingInput({});
    await seam.rereadClock.elapse();

    expect(await seam.waitingForInputOf(project)).toBe(false);
    expect(await seam.agentStatusOf(project)).toBe('working');
  });

  it('picks up a lost input.requested while Working', async () => {
    const project = await seam.createRunningProject();
    await seam.runStarted(project, 'ses_a');

    seam.pod.setActive(['ses_a']);
    seam.pod.setPendingInput({ forms: ['frm_1'] });
    await seam.rereadClock.elapse();

    expect(await seam.waitingForInputOf(project)).toBe(true);
  });

  it('keeps re-reading an environment that is waiting but not Working', async () => {
    const project = await seam.createRunningProject();
    await seam.inputRequested(project, 'per_1');

    seam.pod.setPendingInput({ permissions: ['per_1'] });
    await seam.rereadClock.elapse();
    expect(await seam.waitingForInputOf(project)).toBe(true);

    seam.pod.setPendingInput({});
    await seam.rereadClock.elapse();
    expect(await seam.waitingForInputOf(project)).toBe(false);
  });

  it('stops waiting when the pod is gone', async () => {
    const project = await seam.createRunningProject();
    await seam.inputRequested(project, 'per_1');
    seam.pod.setPendingInput({ permissions: ['per_1'] });
    await seam.app.get(ProjectEnvironmentService).patch(project.environmentId, { status: ProjectStatus.Suspended });

    await seam.rereadClock.elapse();

    expect(await seam.waitingForInputOf(project)).toBe(false);
  });

  it('finds requests already pending on boot', async () => {
    const project = await seam.createRunningProject();
    seam.pod.setPendingInput({ permissions: ['per_before_boot'] });

    await seam.app.get(AgentStatusService).onApplicationBootstrap();

    expect(await seam.waitingForInputOf(project)).toBe(true);
    expect(await seam.agentStatusOf(project)).toBe('idle');
  });
});

describe('the lifecycle clears', () => {
  it('stops waiting when the Project is disabled', async () => {
    const project = await seam.createRunningProject();
    await seam.inputRequested(project, 'per_1');
    seam.pod.setPendingInput({ permissions: ['per_1'] });

    await seam.app.get(ProjectService).disable(project.projectId, project.tenant.tenantId);

    expect(await seam.waitingForInputOf(project)).toBe(false);
  });
});
