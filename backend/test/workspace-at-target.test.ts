import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { workspaceAtTarget, type WorkspaceTarget } from '../src/pool/workspace-at-target';
let root: string;
let agent: WorkspaceTarget;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pool-model-'));
  agent = {
    name: 'app-builder',
    builtInVersion: '0.5.0',
    builtInModelSelection: { model: 'openai/test', variant: 'high' },
  };
  await mkdir(join(root, '.opsiforce/agents'), { recursive: true });
  await mkdir(join(root, '.opencode'), { recursive: true });
  await writeFile(join(root, '.opsiforce/agents/app-builder.json'), JSON.stringify({ contentVersion: '0.5.0' }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function config(model: string, agentModel = model) {
  await writeFile(
    join(root, '.opencode/opencode.json'),
    JSON.stringify({ model, agents: { 'app-builder': { model: agentModel } } })
  );
}
it('keeps a freshly generated workspace with effort-qualified model references', async () => {
  await config('openai/test#high');
  expect(await workspaceAtTarget(root, agent)).toBe(true);
});
it.each([
  ['openai/test', 'openai/test#high'],
  ['openai/test#low', 'openai/test#low'],
  ['openai/test#high', 'openai/other#high'],
])('rejects real model drift: %s / %s', async (model, agentModel) => {
  await config(model, agentModel);
  expect(await workspaceAtTarget(root, agent)).toBe(false);
});
it('accepts bare references when no variant is configured', async () => {
  agent.builtInModelSelection = { model: 'openai/test' };
  await config('openai/test');
  expect(await workspaceAtTarget(root, agent)).toBe(true);
  await config('openai/test#high');
  expect(await workspaceAtTarget(root, agent)).toBe(false);
});
it('still rejects old templates and missing files', async () => {
  await config('openai/test#high');
  agent.builtInVersion = '0.6.0';
  expect(await workspaceAtTarget(root, agent)).toBe(false);
  await rm(join(root, '.opsiforce/agents/app-builder.json'));
  expect(await workspaceAtTarget(root, agent)).toBe(false);
});
