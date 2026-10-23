import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService } from '../src/project/project.service';
import { ProjectStatus } from '../src/project/project.types';
import { ProjectEnvironmentService } from '../src/project-environment/project-environment.service';
import { createObservationSeam, type ObservationSeam, type ObservedProject } from './support/observation-seam';
import { waitFor } from './support/wait-for';

let seam: ObservationSeam;

beforeAll(async () => {
  seam = await createObservationSeam();
});

afterAll(async () => {
  await seam?.close();
});

beforeEach(() => seam.reset());

function agentKeyTouchesOf(project: ObservedProject): number {
  return seam.timeouts.callsTo('touch').filter((call) => call.args.environmentId === project.environmentId).length;
}

function agentKeyTouchesSince(project: ObservedProject): () => number {
  const before = agentKeyTouchesOf(project);
  return () => agentKeyTouchesOf(project) - before;
}

async function createRunningProject(): Promise<ObservedProject> {
  const project = await seam.createRunningProject();
  await waitFor(() => agentKeyTouchesOf(project) > 0);
  return project;
}

describe('a Working Agent holds its pod', () => {
  it('touches the agent key on every run.started, and only for the reporting environment', async () => {
    const project = await createRunningProject();
    const bystander = await createRunningProject();
    const touches = agentKeyTouchesSince(project);
    const bystanderTouches = agentKeyTouchesSince(bystander);

    await seam.runStarted(project, 'ses_a');
    expect(touches()).toBe(1);
    await seam.runStarted(project, 'ses_b');

    expect(touches()).toBe(2);
    expect(bystanderTouches()).toBe(0);
  });

  it('touches the agent key on each re-read while Working', async () => {
    const project = await createRunningProject();
    await seam.runStarted(project, 'ses_a');
    seam.pod.setActive(['ses_a']);
    const touches = agentKeyTouchesSince(project);

    await seam.rereadClock.elapse();
    expect(touches()).toBe(1);
    await seam.rereadClock.elapse();

    expect(touches()).toBe(2);
    expect(await seam.agentStatusOf(project)).toBe('working');
  });

  it('touches the agent key when run.ended turns the environment Idle', async () => {
    const project = await createRunningProject();
    await seam.runStarted(project, 'ses_a');
    const touches = agentKeyTouchesSince(project);

    await seam.runEnded(project, 'ses_a');

    expect(await seam.agentStatusOf(project)).toBe('idle');
    expect(touches()).toBe(1);
  });

  it('touches the agent key when a re-read finds nothing running and turns the environment Idle', async () => {
    const project = await createRunningProject();
    await seam.runStarted(project, 'ses_a');
    const touches = agentKeyTouchesSince(project);

    await seam.rereadClock.elapse();

    expect(await seam.agentStatusOf(project)).toBe('idle');
    expect(touches()).toBe(1);
  });

  it('never touches the agent key while Idle', async () => {
    const project = await createRunningProject();
    const touches = agentKeyTouchesSince(project);

    await seam.runEnded(project, 'ses_never_started');
    await seam.rereadClock.elapse();
    await seam.rereadClock.elapse();

    expect(await seam.agentStatusOf(project)).toBe('idle');
    expect(touches()).toBe(0);
  });

  it('stops touching once a lifecycle change clears the environment', async () => {
    const project = await createRunningProject();
    await seam.runStarted(project, 'ses_a');
    seam.pod.setActive(['ses_a']);
    const touches = agentKeyTouchesSince(project);

    await seam.app.get(ProjectService).disable(project.projectId, project.tenant.tenantId);
    await seam.rereadClock.elapse();

    expect(await seam.agentStatusOf(project)).toBe('idle');
    expect(touches()).toBe(0);
  });

  it('does not touch the agent key of an environment whose pod is gone', async () => {
    const project = await createRunningProject();
    await seam.runStarted(project, 'ses_a');
    seam.pod.setActive(['ses_a']);
    await seam.app
      .get(ProjectEnvironmentService)
      .patch(project.environmentId, { status: ProjectStatus.Suspended, podIp: null });
    const touches = agentKeyTouchesSince(project);

    await seam.rereadClock.elapse();

    expect(await seam.agentStatusOf(project)).toBe('idle');
    expect(touches()).toBe(0);
  });
});
