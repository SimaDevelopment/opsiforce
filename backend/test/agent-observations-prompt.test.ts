import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILDER_AGENT_SLUG } from '../src/agent/agent-visibility';
import { BuilderChatService } from '../src/builder/builder-chat.service';
import type { BuilderChatCaller } from '../src/builder/builder.types';
import { GatewayKeyService } from '../src/gateway/gateway-key.service';
import { ProjectService } from '../src/project/project.service';
import { ensureBuiltInAgent, seedLiveAgent } from './support/agent-fixtures';
import { createObservationSeam, type ObservationSeam, type ObservedProject } from './support/observation-seam';
import { createProject } from './support/project-fixtures';

let seam: ObservationSeam;

beforeAll(async () => {
  seam = await createObservationSeam();
});

afterAll(async () => {
  await seam?.close();
});

function prompted(gatewayKey: string, root: unknown) {
  return seam.observe(gatewayKey, { kind: 'prompted', sessionId: 'ses_prompted', root });
}

async function lastPromptAtOf(project: ObservedProject): Promise<string | null> {
  const res = await seam.app.inject({
    method: 'GET',
    url: `/api/v1/projects/${project.projectId}`,
    headers: project.member.headers,
  });
  if (res.statusCode !== 200) throw new Error(`GET project answered ${res.statusCode}: ${res.body}`);
  return res.json<{ lastPromptAt: string | null }>().lastPromptAt;
}

async function sidebarOrderOf(project: ObservedProject): Promise<string[]> {
  return (await seam.app.get(ProjectService).findAll(project.tenant.tenantId)).map(({ id }) => id);
}

describe('the Prompt stamp from prompted observations', () => {
  it('stamps lastPromptAt on a prompted from a root session', async () => {
    const project = await seam.createRunningProject();
    expect(await lastPromptAtOf(project)).toBeNull();
    const before = Date.now();

    const res = await prompted(project.gatewayKey, true);

    expect(res.statusCode).toBe(204);
    const stamped = await lastPromptAtOf(project);
    expect(Date.parse(stamped ?? '')).toBeGreaterThanOrEqual(before - 1000);
  });

  it('moves the prompted Project to the top of the sidebar', async () => {
    const project = await seam.createRunningProject();
    const newer = await createProject(seam.app, project.tenant, { title: 'Newer' });
    expect(await sidebarOrderOf(project)).toEqual([newer, project.projectId]);

    await prompted(project.gatewayKey, true);

    expect(await sidebarOrderOf(project)).toEqual([project.projectId, newer]);
  });

  it('changes nothing on a prompted from a sub-agent session', async () => {
    const project = await seam.createRunningProject();
    const newer = await createProject(seam.app, project.tenant, { title: 'Newer' });

    const res = await prompted(project.gatewayKey, false);

    expect(res.statusCode).toBe(204);
    expect(await lastPromptAtOf(project)).toBeNull();
    expect(await sidebarOrderOf(project)).toEqual([newer, project.projectId]);
  });

  it('stamps only when root is literally true', async () => {
    const project = await seam.createRunningProject();

    await prompted(project.gatewayKey, 'true');
    await seam.observe(project.gatewayKey, { kind: 'prompted', sessionId: 'ses_prompted' });

    expect(await lastPromptAtOf(project)).toBeNull();
  });

  it('turns a Builder chat started once its root session is prompted', async () => {
    const { tenant, member } = await seam.createRunningProject();
    await ensureBuiltInAgent(BUILDER_AGENT_SLUG);
    const agentId = (await seedLiveAgent(tenant.tenantId, member.userId)).id;
    const caller: BuilderChatCaller = {
      tenantId: tenant.tenantId,
      userId: member.userId,
      canManageSkills: true,
      canManageAgents: true,
      canManageTenantExternalServices: false,
    };
    const builderChats = seam.app.get(BuilderChatService);
    const chat = await builderChats.openFor(caller, { agentId });
    expect(chat.lastPromptAt).toBeNull();
    const chatKey = await seam.app.get(GatewayKeyService).createKey(chat.id, chat.id, tenant.tenantId);

    await prompted(chatKey, true);

    expect((await builderChats.openFor(caller, { agentId })).lastPromptAt).not.toBeNull();
  });
});
