import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GatewayKeyService } from '../src/gateway/gateway-key.service';
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

async function withSecondEnvironment(project: ObservedProject): Promise<ObservedProject> {
  const environmentId = await addNamedEnvironment(seam.app, project.tenant, project.projectId, 'Staging');
  const gatewayKey = await seam.app
    .get(GatewayKeyService)
    .createKey(project.projectId, environmentId, project.tenant.tenantId);
  return { ...project, environmentId, gatewayKey };
}

describe('per-environment events on the agent-status stream', () => {
  it('reports the environment Working on run.started and Idle on run.ended, in order', async () => {
    const project = await seam.createRunningProject();
    const stream = await seam.openAgentStatusStream(project.member);
    await waitFor(() => stream.statusesOf(project.projectId).length === 1);

    await seam.runStarted(project, 'ses_a');
    await waitFor(() => stream.environmentStatusesOf(project.environmentId).length === 1);
    await seam.runEnded(project, 'ses_a');

    await waitFor(() => stream.environmentStatusesOf(project.environmentId).length === 2);
    expect(stream.environmentEvents.filter((event) => event.environmentId === project.environmentId)).toEqual([
      { projectId: project.projectId, environmentId: project.environmentId, agentStatus: 'working' },
      { projectId: project.projectId, environmentId: project.environmentId, agentStatus: 'idle' },
    ]);
    await waitFor(() => stream.statusesOf(project.projectId).length === 3);
    expect(stream.statusesOf(project.projectId)).toEqual(['idle', 'working', 'idle']);
    stream.close();
  });

  it('sends no Idle event while a sub-agent is still running after its parent’s run ended', async () => {
    const project = await seam.createRunningProject();
    const stream = await seam.openAgentStatusStream(project.member);
    await waitFor(() => stream.statusesOf(project.projectId).length === 1);

    await seam.runStarted(project, 'ses_parent');
    await seam.runStarted(project, 'ses_child');
    await seam.runEnded(project, 'ses_parent');
    await waitFor(() => stream.environmentStatusesOf(project.environmentId).length === 1);
    expect(await seam.agentStatusOf(project)).toBe('working');

    expect(stream.environmentStatusesOf(project.environmentId)).toEqual(['working']);
    stream.close();
  });

  it('reports each environment on its own while the Project-level value changes only at the edges', async () => {
    const project = await seam.createRunningProject();
    const second = await withSecondEnvironment(project);
    const stream = await seam.openAgentStatusStream(project.member);
    await waitFor(() => stream.statusesOf(project.projectId).length === 1);

    await seam.runStarted(project, 'ses_default');
    await waitFor(() => stream.environmentStatusesOf(project.environmentId).length === 1);
    await seam.runStarted(second, 'ses_second');
    await waitFor(() => stream.environmentStatusesOf(second.environmentId).length === 1);
    await seam.runEnded(project, 'ses_default');
    await waitFor(() => stream.environmentStatusesOf(project.environmentId).length === 2);

    expect(stream.environmentEvents.map((event) => [event.environmentId, event.agentStatus])).toEqual([
      [project.environmentId, 'working'],
      [second.environmentId, 'working'],
      [project.environmentId, 'idle'],
    ]);
    expect(stream.statusesOf(project.projectId)).toEqual(['idle', 'working']);
    stream.close();
  });

  it('tells a stream opened mid-run which environments are Working', async () => {
    const project = await seam.createRunningProject();
    await seam.runStarted(project, 'ses_a');

    const stream = await seam.openAgentStatusStream(project.member);
    await waitFor(() => stream.environmentStatusesOf(project.environmentId).length === 1);
    expect(stream.environmentStatusesOf(project.environmentId)).toEqual(['working']);

    await seam.runEnded(project, 'ses_a');
    await waitFor(() => stream.environmentStatusesOf(project.environmentId).length === 2);
    expect(stream.environmentStatusesOf(project.environmentId)).toEqual(['working', 'idle']);
    stream.close();
  });
});
