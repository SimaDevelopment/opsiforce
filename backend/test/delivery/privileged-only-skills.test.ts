import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_NAME } from '../../src/agent/agent.types';
import { EnvironmentSkillsService } from '../../src/delivery/environment-skills';
import { ensureBuiltInAgent } from '../support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import { createTenantRow, createUserRow } from '../support/org-fixtures';

async function appBuilderProjectSkills(agentPrivileged: boolean): Promise<string[]> {
  const previous = process.env.AGENT_PRIVILEGED;
  process.env.AGENT_PRIVILEGED = String(agentPrivileged);
  let harness: DomainTestHarness | undefined;
  try {
    harness = await createDomainTestingModule();
    const tenantId = await createTenantRow();
    const userId = await createUserRow();
    await harness.environments.ensureDefaultForTenant(tenantId);
    const agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
    const projectId = (await harness.projects.create({ agentId }, tenantId, { createdBy: userId })).id;
    const listed = await harness.moduleRef.get(EnvironmentSkillsService).list(projectId);
    await harness.projects.remove(projectId, tenantId);
    return listed.skills.map((skill) => skill.name);
  } finally {
    await harness?.close();
    if (previous === undefined) delete process.env.AGENT_PRIVILEGED;
    else process.env.AGENT_PRIVILEGED = previous;
  }
}

describe("an App Builder Project's Skills in the chat bar", () => {
  let withoutPrivilegedPods: string[];
  let withPrivilegedPods: string[];

  beforeAll(async () => {
    withoutPrivilegedPods = await appBuilderProjectSkills(false);
    withPrivilegedPods = await appBuilderProjectSkills(true);
  });

  it('leave docker out on a deployment without privileged agent pods', () => {
    expect(withoutPrivilegedPods).toContain('platform');
    expect(withoutPrivilegedPods).not.toContain('docker');
  });

  it('list docker on a deployment with privileged agent pods', () => {
    expect(withPrivilegedPods).toContain('docker');
  });
});
