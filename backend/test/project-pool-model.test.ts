import 'reflect-metadata';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ db: {} }));
import { ProjectPoolService } from '../src/pool/project-pool.service';
let root: string;
let service: any;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pool-model-'));
  service = Object.create(ProjectPoolService.prototype);
  Object.assign(service, { storageMountPath: root, agentVersionByName: new Map([['app-builder', '0.5.0']]),
    agentModelSelectionByName: new Map([['app-builder', { model: 'openai/test', variant: 'high' }]]) });
  await mkdir(join(root, '.opsiforce/agents'), { recursive: true });
  await mkdir(join(root, '.opencode'), { recursive: true });
  await writeFile(join(root, '.opsiforce/agents/app-builder.json'), JSON.stringify({contentVersion:'0.5.0'}));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function config(model: string, agentModel = model) {
  await writeFile(join(root, '.opencode/opencode.json'), JSON.stringify({ model, agents: {'app-builder': {model:agentModel}} }));
}
it('keeps a freshly generated workspace with effort-qualified model references', async () => {
  await config('openai/test#high');
  expect(await service.workspaceAtTarget('', 'app-builder')).toBe(true);
});
it.each([['openai/test', 'openai/test#high'], ['openai/test#low', 'openai/test#low'], ['openai/test#high', 'openai/other#high']])('rejects real model drift: %s / %s', async (model, agentModel) => {
  await config(model, agentModel);
  expect(await service.workspaceAtTarget('', 'app-builder')).toBe(false);
});
it('accepts bare references when no variant is configured', async () => {
  service.agentModelSelectionByName.set('app-builder', {model:'openai/test'});
  await config('openai/test');
  expect(await service.workspaceAtTarget('', 'app-builder')).toBe(true);
  await config('openai/test#high');
  expect(await service.workspaceAtTarget('', 'app-builder')).toBe(false);
});
it('still rejects old templates and missing files', async () => {
  await config('openai/test#high');
  service.agentVersionByName.set('app-builder','0.6.0');
  expect(await service.workspaceAtTarget('', 'app-builder')).toBe(false);
  await rm(join(root,'.opsiforce/agents/app-builder.json'));
  expect(await service.workspaceAtTarget('', 'app-builder')).toBe(false);
});
