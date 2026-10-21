import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema';
import { GatewayKeyService } from '../src/gateway/gateway-key.service';
import { addNamedEnvironment } from './support/project-fixtures';
import { createObservationSeam, type ObservationSeam, type ObservedProject } from './support/observation-seam';

let seam: ObservationSeam;

beforeAll(async () => {
  seam = await createObservationSeam();
});

afterAll(async () => {
  await seam?.close();
});

beforeEach(() => {
  seam.pod.sessions.clear();
  seam.pod.clearScripts();
});

async function untitledProject(): Promise<ObservedProject> {
  const project = await seam.createRunningProject();
  await db.update(projects).set({ title: null }).where(eq(projects.id, project.projectId));
  return project;
}

async function connectPrimarySession(project: ObservedProject): Promise<string> {
  const res = await seam.app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project.projectId}/environments/${project.environmentId}/connect`,
    headers: project.member.headers,
  });
  if (res.statusCode !== 200) throw new Error(`connect answered ${res.statusCode}: ${res.body}`);
  return res.json<{ sessionId: string }>().sessionId;
}

function titled(project: ObservedProject, sessionId: string, title: string, root = true) {
  return seam.observe(project.gatewayKey, { kind: 'titled', sessionId, title, root });
}

async function titleOf(project: ObservedProject): Promise<string | null> {
  const res = await seam.app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project.projectId}`,
    headers: project.member.headers,
  });
  if (res.statusCode !== 200) throw new Error(`GET project answered ${res.statusCode}: ${res.body}`);
  return res.json<{ title: string | null }>().title;
}

describe('the Project title from titled observations', () => {
  it('names an untitled Project after its primary Session', async () => {
    const project = await untitledProject();
    const primary = await connectPrimarySession(project);

    const res = await titled(project, primary, 'Quarterly revenue dashboard');

    expect(res.statusCode).toBe(204);
    expect(await titleOf(project)).toBe('Quarterly revenue dashboard');
  });

  it('skips opencode’s placeholder titles and takes the next meaningful one', async () => {
    const project = await untitledProject();
    const primary = await connectPrimarySession(project);

    await titled(project, primary, 'New session - 2026-10-17T09:15:02.123Z');
    await titled(project, primary, '   ');
    expect(await titleOf(project)).toBeNull();

    await titled(project, primary, 'Invoice reminders');
    expect(await titleOf(project)).toBe('Invoice reminders');
  });

  it('keeps the first meaningful title when the primary Session is renamed later', async () => {
    const project = await untitledProject();
    const primary = await connectPrimarySession(project);

    await titled(project, primary, 'Invoice reminders');
    await titled(project, primary, 'Invoice reminders, now with Slack');

    expect(await titleOf(project)).toBe('Invoice reminders');
  });

  it('never renames a Project that already has a title', async () => {
    const project = await seam.createRunningProject();
    const primary = await connectPrimarySession(project);

    await titled(project, primary, 'Something the Agent chose');

    expect(await titleOf(project)).toBe('Observed');
  });

  it('ignores titles of other root sessions and of sub-agent sessions', async () => {
    const project = await untitledProject();
    const primary = await connectPrimarySession(project);

    await titled(project, 'ses_another_root', 'A side conversation');
    await titled(project, primary, 'Reported as a sub-agent', false);

    expect(await titleOf(project)).toBeNull();
  });

  it('ignores a titled before any Connection has bound a primary Session', async () => {
    const project = await untitledProject();

    await titled(project, 'ses_unbound', 'Too early');

    expect(await titleOf(project)).toBeNull();
  });

  it('takes the title from the primary Session of the environment that observed it', async () => {
    const project = await untitledProject();
    const primary = await connectPrimarySession(project);
    const stagingId = await addNamedEnvironment(seam.app, project.tenant, project.projectId, 'Staging');
    const staging: ObservedProject = {
      ...project,
      environmentId: stagingId,
      gatewayKey: await seam.app
        .get(GatewayKeyService)
        .createKey(project.projectId, stagingId, project.tenant.tenantId),
    };

    await titled(staging, primary, 'Not the staging primary');
    expect(await titleOf(project)).toBeNull();

    await titled(project, primary, 'Default environment wins');
    expect(await titleOf(project)).toBe('Default environment wins');
  });
});
