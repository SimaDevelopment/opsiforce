import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import 'reflect-metadata';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentTemplateStore } from '../../src/agent-template/agent-template.store';
import { agentConfigRoot } from '../../src/store/skill-tree';

const SHIPPED_STARTERS = [
  ['app-builder', join('agents', 'app-builder', 'template')],
  ['makara-app-builder', join('private', 'agents', 'makara-app-builder', 'template')],
] as const;

let storage: string;
let store: AgentTemplateStore;

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'opsiforce-starter-templates-'));
  const settings: Record<string, unknown> = { storageMountPath: storage, workspaceCleanupRetentionDays: 1 };
  store = new AgentTemplateStore({ getOrThrow: (key: string) => settings[key] } as unknown as ConfigService);
});

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

describe.each(SHIPPED_STARTERS)('the %s package template through the Template writer', (_name, relative) => {
  const sourceDir = join(agentConfigRoot(), relative);

  it('is refused nowhere, and an unedited lay saves back to the same hash', async () => {
    expect(existsSync(sourceDir)).toBe(true);
    const agentId = randomUUID();
    const developmentId = randomUUID();

    const written = await store.writeUnlocked(agentId, developmentId, sourceDir);

    expect(written.hash).not.toBeNull();
    expect(written.hash).toBe(await store.hashSource(sourceDir));

    const laid = join(storage, 'laid', agentId);
    expect(await store.layInto(agentId, developmentId, laid)).toBe(written.hash);
    expect(await store.hashSource(laid)).toBe(written.hash);
  });
});
