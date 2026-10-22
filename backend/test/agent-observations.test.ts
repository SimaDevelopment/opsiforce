import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GatewayKeyService } from '../src/gateway/gateway-key.service';
import { AgentStatusService } from '../src/project/agent-status.service';
import { ProjectService } from '../src/project/project.service';
import { ProjectEnvironmentService } from '../src/project-environment/project-environment.service';
import { ProjectStatus } from '../src/project/project.types';
import { addNamedEnvironment } from './support/project-fixtures';
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

function activeReadsSince(): () => number {
  const before = seam.pod.requestsTo('session.active').length;
  return () => seam.pod.requestsTo('session.active').length - before;
}

describe('the observation route', () => {
  it('refuses a request without a gateway key, with an unknown key or with a revoked one', async () => {
    const project = await seam.createRunningProject();
    const revoked = await seam.createRunningProject();
    await seam.app.get(GatewayKeyService).revokeEnvironmentKeys(revoked.environmentId);

    const missing = await seam.observe(null, { kind: 'run.started', sessionId: 'ses_a' });
    const unknown = await seam.observe('gw-not-a-key', { kind: 'run.started', sessionId: 'ses_a' });
    const stale = await seam.runStarted(revoked, 'ses_a');

    expect([missing.statusCode, unknown.statusCode, stale.statusCode]).toEqual([401, 401, 401]);
    expect(await seam.agentStatusOf(project)).toBe('idle');
    expect(await seam.agentStatusOf(revoked)).toBe('idle');
  });

  it('applies an observation to the environment behind the key and to no other', async () => {
    const reporting = await seam.createRunningProject();
    const bystander = await seam.createRunningProject();

    const res = await seam.runStarted(reporting, 'ses_a');

    expect(res.statusCode).toBe(204);
    expect(await seam.agentStatusOf(reporting)).toBe('working');
    expect(await seam.agentStatusOf(bystander)).toBe('idle');
  });

  it('answers an unknown kind with a 2xx and changes nothing', async () => {
    const project = await seam.createRunningProject();

    const idle = await seam.observe(project.gatewayKey, { kind: 'run.paused', sessionId: 'ses_a', extra: true });
    expect(idle.statusCode).toBe(204);
    expect(await seam.agentStatusOf(project)).toBe('idle');

    await seam.runStarted(project, 'ses_a');
    const working = await seam.observe(project.gatewayKey, { kind: 'constructor', sessionId: 'ses_a' });
    expect(working.statusCode).toBe(204);
    expect(await seam.agentStatusOf(project)).toBe('working');
  });

  it('refuses a body without a kind or a session', async () => {
    const project = await seam.createRunningProject();

    const responses = await Promise.all([
      seam.observe(project.gatewayKey, { sessionId: 'ses_a' }),
      seam.observe(project.gatewayKey, { kind: 'run.started' }),
      seam.observe(project.gatewayKey, { kind: 'run.started', sessionId: 42 }),
      seam.observe(project.gatewayKey, [{ kind: 'run.started', sessionId: 'ses_a' }]),
    ]);

    expect(responses.map((res) => res.statusCode)).toEqual([400, 400, 400, 400]);
    expect(await seam.agentStatusOf(project)).toBe('idle');
  });
});

describe('Agent Status from run observations', () => {
  it('turns Working on run.started and Idle on run.ended, on the public API and the stream', async () => {
    const project = await seam.createRunningProject();
    const stream = await seam.openAgentStatusStream(project.member);
    await waitFor(() => stream.statusesOf(project.projectId).length === 1);

    await seam.runStarted(project, 'ses_a');
    expect(await seam.agentStatusOf(project)).toBe('working');
    await seam.runEnded(project, 'ses_a');
    expect(await seam.agentStatusOf(project)).toBe('idle');

    await waitFor(() => stream.statusesOf(project.projectId).length === 3);
    expect(stream.statusesOf(project.projectId)).toEqual(['idle', 'working', 'idle']);
    expect(stream.events.find((event) => event.projectId === project.projectId)).toEqual({
      projectId: project.projectId,
      agentStatus: 'idle',
    });
    stream.close();
  });

  it('treats a second run.started for the same session as a no-op', async () => {
    const project = await seam.createRunningProject();

    await seam.runStarted(project, 'ses_a');
    await seam.runStarted(project, 'ses_a');
    await seam.runEnded(project, 'ses_a');

    expect(await seam.agentStatusOf(project)).toBe('idle');
  });

  it('ignores a run.ended for a session it never saw start', async () => {
    const project = await seam.createRunningProject();
    const stream = await seam.openAgentStatusStream(project.member);
    await waitFor(() => stream.statusesOf(project.projectId).length === 1);

    const whileIdle = await seam.runEnded(project, 'ses_unknown');
    await seam.runStarted(project, 'ses_a');
    const whileWorking = await seam.runEnded(project, 'ses_unknown');

    expect([whileIdle.statusCode, whileWorking.statusCode]).toEqual([204, 204]);
    expect(await seam.agentStatusOf(project)).toBe('working');
    await seam.runEnded(project, 'ses_a');
    await waitFor(() => stream.statusesOf(project.projectId).length === 3);
    expect(stream.statusesOf(project.projectId)).toEqual(['idle', 'working', 'idle']);
    stream.close();
  });

  it('keeps the environment Working while a background sub-agent outlives its parent’s run', async () => {
    const project = await seam.createRunningProject();

    await seam.runStarted(project, 'ses_parent');
    await seam.runStarted(project, 'ses_child');
    await seam.runEnded(project, 'ses_parent');
    expect(await seam.agentStatusOf(project)).toBe('working');

    await seam.runEnded(project, 'ses_child');
    expect(await seam.agentStatusOf(project)).toBe('idle');
  });

  it('counts the Project Working while any of its environments is', async () => {
    const project = await seam.createRunningProject();
    const secondEnvironmentId = await addNamedEnvironment(seam.app, project.tenant, project.projectId, 'Staging');
    const second: ObservedProject = {
      ...project,
      environmentId: secondEnvironmentId,
      gatewayKey: await seam.app
        .get(GatewayKeyService)
        .createKey(project.projectId, secondEnvironmentId, project.tenant.tenantId),
    };

    await seam.runStarted(project, 'ses_default');
    await seam.runStarted(second, 'ses_second');
    await seam.runEnded(project, 'ses_default');
    expect(await seam.agentStatusOf(project)).toBe('working');

    await seam.runEnded(second, 'ses_second');
    expect(await seam.agentStatusOf(project)).toBe('idle');
  });
});

describe('the re-read while Working', () => {
  it('keeps Working while the pod still lists the session, and heals a lost run.ended', async () => {
    const project = await seam.createRunningProject();
    await seam.runStarted(project, 'ses_a');

    seam.pod.setActive(['ses_a']);
    await seam.rereadClock.elapse();
    expect(await seam.agentStatusOf(project)).toBe('working');

    seam.pod.setActive([]);
    await seam.rereadClock.elapse();
    expect(await seam.agentStatusOf(project)).toBe('idle');
  });

  it('replaces the set with what the pod reports running', async () => {
    const project = await seam.createRunningProject();
    await seam.runStarted(project, 'ses_observed');

    seam.pod.setActive(['ses_unobserved']);
    await seam.rereadClock.elapse();
    await seam.runEnded(project, 'ses_observed');
    expect(await seam.agentStatusOf(project)).toBe('working');

    await seam.runEnded(project, 'ses_unobserved');
    expect(await seam.agentStatusOf(project)).toBe('idle');
  });

  it('turns Idle when the pod does not answer', async () => {
    const project = await seam.createRunningProject();
    await seam.runStarted(project, 'ses_a');
    seam.pod.setActive(['ses_a']);
    seam.pod.script('session.active', { delayMs: 3_500, once: true });

    await seam.rereadClock.elapse();

    expect(await seam.agentStatusOf(project)).toBe('idle');
  });

  it('turns Idle when the pod is gone', async () => {
    const project = await seam.createRunningProject();
    await seam.runStarted(project, 'ses_a');
    seam.pod.setActive(['ses_a']);
    await seam.app
      .get(ProjectEnvironmentService)
      .patch(project.environmentId, { status: ProjectStatus.Suspended, podIp: null });

    await seam.rereadClock.elapse();

    expect(await seam.agentStatusOf(project)).toBe('idle');
  });

  it('never re-reads an Idle environment', async () => {
    const project = await seam.createRunningProject();
    const neverWorking = activeReadsSince();
    await seam.rereadClock.elapse();
    expect(neverWorking()).toBe(0);

    await seam.runStarted(project, 'ses_a');
    await seam.runEnded(project, 'ses_a');
    const afterIdle = activeReadsSince();
    await seam.rereadClock.elapse();
    await seam.rereadClock.elapse();

    expect(afterIdle()).toBe(0);
    expect(await seam.agentStatusOf(project)).toBe('idle');
  });

  it('re-reads an environment the boot reconcile found Working', async () => {
    const project = await seam.createRunningProject();
    seam.pod.setActive(['ses_before_boot']);
    await seam.app.get(AgentStatusService).onApplicationBootstrap();
    expect(await seam.agentStatusOf(project)).toBe('working');

    seam.pod.setActive([]);
    await seam.rereadClock.elapse();

    expect(await seam.agentStatusOf(project)).toBe('idle');
  });
});

describe('the lifecycle clears', () => {
  it('turns Idle when the Project is disabled and stops re-reading it', async () => {
    const project = await seam.createRunningProject();
    await seam.runStarted(project, 'ses_a');
    seam.pod.setActive(['ses_a']);

    await seam.app.get(ProjectService).disable(project.projectId, project.tenant.tenantId);
    const reads = activeReadsSince();
    await seam.rereadClock.elapse();

    expect(await seam.agentStatusOf(project)).toBe('idle');
    expect(reads()).toBe(0);
  });
});
