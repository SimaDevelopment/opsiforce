import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentModelSelection } from '../agent/agent-config';
import { modelReference } from '../delivery/delivery.types';

export interface WorkspaceTarget {
  name: string;
  builtInVersion: string | null;
  builtInModelSelection: AgentModelSelection | null;
}

export async function workspaceAtTarget(workspaceRoot: string, agent: WorkspaceTarget): Promise<boolean> {
  const { name: agentName, builtInVersion: targetVersion, builtInModelSelection: modelSelection } = agent;
  if (!targetVersion && !modelSelection) return true;
  if (targetVersion) {
    const ledgerPath = join(workspaceRoot, '.opsiforce', 'agents', `${agentName}.json`);
    try {
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as { contentVersion?: string };
      if (ledger.contentVersion !== targetVersion) return false;
    } catch {
      return false;
    }
  }

  if (!modelSelection) return true;
  const configPath = join(workspaceRoot, '.opencode', 'opencode.json');
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      model?: string;
      agents?: Record<string, { model?: string } | undefined>;
    };
    const expected = modelReference(modelSelection.model, modelSelection.variant ?? null);
    return config.model === expected && config.agents?.[agentName]?.model === expected;
  } catch {
    return false;
  }
}
