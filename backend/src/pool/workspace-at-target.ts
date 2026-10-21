import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentModelSelection } from '../agent/agent-config';
import { modelReference } from '../delivery/delivery.types';

export interface WorkspaceTarget {
  packageName: string;
  contentVersion: string | null;
  modelSelection: AgentModelSelection | null;
}

export async function workspaceAtTarget(workspaceRoot: string, target: WorkspaceTarget): Promise<boolean> {
  const { packageName, contentVersion: targetVersion, modelSelection } = target;
  if (!targetVersion && !modelSelection) return true;
  if (targetVersion) {
    const ledgerPath = join(workspaceRoot, '.opsiforce', 'agents', `${packageName}.json`);
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
    return config.model === expected && config.agents?.[packageName]?.model === expected;
  } catch {
    return false;
  }
}
