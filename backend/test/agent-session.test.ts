import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projectAgentUpdates, projectEnvironments, projects } from '../db/schema';
import { DEFAULT_AGENT_NAME } from '../src/agent/agent.types';
import { AgentUpdateService } from '../src/agent-update/agent-update.service';
import { AgentUpdateStatus } from '../src/agent-update/agent-update.types';
import { AgentStatusService } from '../src/project/agent-status.service';
import {
  EnvironmentNotRunning,
  PodResponded,
  PodTimeout,
  PodUnreachable,
} from '../src/agent-session/agent-session.errors';
import { PodOpencodeClient } from '../src/agent-session/pod-opencode.client';
import { Deadline } from '../src/common/deadline';
import type { ProjectEnvironmentContext } from '../src/project-environment/project-environment.types';
import { AgentStatus, ProjectStatus } from '../src/project/project.types';
import { lockEnvironmentSession } from '../src/common/locks';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';
import { podErrors, startFakePod, type FakePod } from './support/fake-pod';
import { disableProject } from './support/project-fixtures';
import { waitFor } from './support/wait-for';

let pod: FakePod;
let harness: DomainTestHarness;
let second: DomainTestHarness;

beforeAll(async () => {
  pod = await startFakePod();
  process.env.AGENT_PORT = String(pod.port);
  process.env.AGENT_WAKE_HOLD_MS = '2000';
  process.env.AGENT_WAKE_POLL_MS = '100';
  harness = await createDomainTestingModule();
  second = await createDomainTestingModule();
});

afterAll(async () => {
  await second.close();
  await harness.close();
  await pod.stop().catch(() => undefined);
});

beforeEach(() => {
  pod.sessions.clear();
  pod.setActive([]);
  pod.clearScripts();
  pod.setHealth({ status: 200, body: { healthy: true, version: '1.18.4', pid: 1 } });
});

function latch(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function callsSince(route: Parameters<FakePod['requestsTo']>[0]): () => number {
  const before = pod.requestsTo(route).length;
  return () => pod.requestsTo(route).length - before;
}

async function markNextPodReady(projectId: string, podIp = '127.0.0.1'): Promise<void> {
  const podName = harness.fakes.pods.assignedPodName(projectId);
  const before = harness.fakes.pods.callsTo('waitForReady').length;
  await waitFor(() => harness.fakes.pods.callsTo('waitForReady').length > before);
  harness.fakes.pods.markPodReady(podName, podIp);
  await waitFor(
    async () => (await harness.projectEnvironments.findByIdOrNull(projectId))?.status === ProjectStatus.Active
  );
}

async function createRunningProject(): Promise<ProjectEnvironmentContext> {
  const tenant = await harness.tenants.getOrCreateTenant(`agent-session-${randomUUID().slice(0, 8)}`);
  const project = await harness.projects.create({ title: 'Agent session' }, tenant.id);
  await markNextPodReady(project.id);
  return environmentOf(project.id);
}

async function environmentOf(environmentId: string): Promise<ProjectEnvironmentContext> {
  const env = await harness.projectEnvironments.findByIdOrNull(environmentId);
  if (!env) throw new Error(`No environment ${environmentId}`);
  return env;
}

async function setStatus(
  environmentId: string,
  status: ProjectStatus,
  podIp: string | null = null
): Promise<ProjectEnvironmentContext> {
  await harness.projectEnvironments.patch(environmentId, { status, podIp });
  return environmentOf(environmentId);
}

async function rememberSession(environmentId: string, sessionId: string | null): Promise<void> {
  await db.update(projectEnvironments).set({ sessionId }).where(eq(projectEnvironments.id, environmentId));
}

async function rememberedSessionOf(environmentId: string): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: projectEnvironments.sessionId })
    .from(projectEnvironments)
    .where(eq(projectEnvironments.id, environmentId));
  return row?.sessionId ?? null;
}

function notRunningState(error: unknown): string {
  if (!(error instanceof EnvironmentNotRunning)) throw error;
  return error.state;
}

async function stateOfConnect(env: ProjectEnvironmentContext): Promise<string> {
  return harness.agentConnections.connect(env).then(
    () => 'ready',
    (error: unknown) => notRunningState(error)
  );
}

describe('connecting to a project environment', () => {
  it('bounds a slow ensure without continuing into session resolution', async () => {
    const env = await createRunningProject();
    const created = callsSince('session.create');
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(harness.projects, 'ensureEnvironment').mockImplementationOnce(async () => {
      await pending;
      return { state: 'ready', env };
    });
    try {
      await expect(harness.agentSessions.wakeForConnection(env, Deadline.in(30))).rejects.toMatchObject({
        state: 'starting',
      });
      expect(created()).toBe(0);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('bounds a slow reload gate within the same wake budget', async () => {
    const env = await createRunningProject();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const updates = harness.moduleRef.get(AgentUpdateService);
    const spy = vi.spyOn(updates, 'applyPendingReloadForEnvironment').mockImplementationOnce(async () => {
      await pending;
      return null;
    });
    try {
      await expect(harness.agentSessions.wakeForConnection(env, Deadline.in(30))).rejects.toMatchObject({
        state: 'starting',
      });
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('wakes a suspended environment and answers once the runtime is ready', async () => {
    const env = await createRunningProject();
    await harness.fakes.pods.deletePod(harness.fakes.pods.assignedPodName(env.id));
    const suspended = await setStatus(env.id, ProjectStatus.Suspended);

    const connecting = harness.agentConnections.connect(suspended);
    await markNextPodReady(env.id);

    const connection = await connecting;
    expect(connection.environmentId).toBe(env.id);
    expect(connection.sessionId).toMatch(/^ses_/);
  });

  it('reports the build the ready runtime identifies, and null when it identifies none', async () => {
    const env = await createRunningProject();

    expect((await harness.agentConnections.connect(env)).build).toBe('1.18.4');

    pod.setHealth({ status: 200, body: { healthy: true, pid: 1 } });
    expect((await harness.agentConnections.connect(env)).build).toBeNull();
    pod.setHealth({ status: 200, body: { healthy: true, version: '1.18.4', pid: 1 } });
  });

  it('treats a runtime that is not serving yet as a starting environment, not a connection', async () => {
    const env = await createRunningProject();
    pod.setHealth({ status: 503, body: { healthy: false } });

    const error: unknown = await harness.agentConnections.connect(env).catch((reason: unknown) => reason);
    pod.setHealth({ status: 200, body: { healthy: true, version: '1.18.4', pid: 1 } });

    expect(error).toBeInstanceOf(EnvironmentNotRunning);
    expect(error).toMatchObject({ state: 'starting' });
  });

  it('maps every non-running environment state to a typed error', async () => {
    const env = await createRunningProject();

    expect(await stateOfConnect(await setStatus(env.id, ProjectStatus.Failed))).toBe('failed');
    expect(await stateOfConnect(await setStatus(env.id, ProjectStatus.Pending))).toBe('not-found');
    expect(await stateOfConnect(await setStatus(env.id, ProjectStatus.Claiming))).toBe('not-found');
  });

  it('reports a disabled environment as disabled', async () => {
    const env = await createRunningProject();
    await disableProject(env.projectId);

    expect(await stateOfConnect(await environmentOf(env.id))).toBe('disabled');
  });

  it('gives up once the connection budget expires rather than waiting on a second phase', async () => {
    const env = await createRunningProject();
    await harness.fakes.pods.deletePod(harness.fakes.pods.assignedPodName(env.id));
    const starting = await setStatus(env.id, ProjectStatus.Starting);

    const startedAt = Date.now();
    const error: unknown = await harness.agentConnections.connect(starting).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(EnvironmentNotRunning);
    expect(error).toMatchObject({ state: 'starting' });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await setStatus(env.id, ProjectStatus.Active, '127.0.0.1');
  });

  it('reports a budget spent on a ready runtime as a timeout, not as a startup state', async () => {
    const env = await createRunningProject();
    pod.script('session.list', { delayMs: 2_500 });

    const error: unknown = await harness.agentConnections.connect(env).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PodTimeout);
    expect(error).not.toBeInstanceOf(EnvironmentNotRunning);
  });

  it('stops waiting as soon as the caller goes away', async () => {
    const env = await createRunningProject();
    await harness.fakes.pods.deletePod(harness.fakes.pods.assignedPodName(env.id));
    const starting = await setStatus(env.id, ProjectStatus.Starting);

    const controller = new AbortController();
    const connecting = harness.agentConnections.connect(starting, { signal: controller.signal });
    controller.abort();

    await expect(connecting).rejects.toBeInstanceOf(EnvironmentNotRunning);
    await setStatus(env.id, ProjectStatus.Active, '127.0.0.1');
  });

  it('applies a pending agent reload before answering', async () => {
    const env = await createRunningProject();
    const updateId = await insertPendingReload(env);

    await harness.agentConnections.connect(env);

    expect(await reloadStatusOf(updateId)).toBe(AgentUpdateStatus.Applied);
  });

  it('keeps holding when the reload gate recreates the pod', async () => {
    const env = await createRunningProject();
    const updateId = await insertPendingReload(env, { requiresPodRecreate: true });

    const connecting = harness.agentConnections.connect(env);
    await markNextPodReady(env.id);

    await expect(connecting).resolves.toMatchObject({ environmentId: env.id });
    expect(await reloadStatusOf(updateId)).toBe(AgentUpdateStatus.Applied);
  });

  it('applies the same reload gate on the proxy controller path', async () => {
    const env = await createRunningProject();
    const updateId = await insertPendingReload(env);

    const ensured = await harness.agentSessions.ensureAgentSurface(env);

    expect(ensured.state).toBe('ready');
    expect(await reloadStatusOf(updateId)).toBe(AgentUpdateStatus.Applied);
  });

  it('waking never starts a pod for an environment that is already active', async () => {
    const env = await createRunningProject();
    const podsCreated = harness.fakes.pods.callsTo('createAssignedPod').length;

    await harness.agentSessions.wakeForConnection(env, Deadline.in(1_000));

    expect(harness.fakes.pods.callsTo('createAssignedPod')).toHaveLength(podsCreated);
  });
});

describe('resolving the primary session', () => {
  it('keeps the remembered session when it is still a root', async () => {
    const env = await createRunningProject();
    const remembered = pod.addSession();
    await rememberSession(env.id, remembered.id);
    const created = callsSince('session.create');

    const connection = await harness.agentConnections.connect(env);

    expect(connection.sessionId).toBe(remembered.id);
    expect(created()).toBe(0);
  });

  it('falls back to the root created first, even when the runtime lists it last', async () => {
    const env = await createRunningProject();
    const oldest = pod.addSession({ time: { created: 1_000, updated: 9_000 } });
    pod.addSession({ time: { created: 2_000, updated: 2_000 } });
    pod.addSession({ time: { created: 3_000, updated: 1_000 } });
    await rememberSession(env.id, null);

    const connection = await harness.agentConnections.connect(env);

    expect(connection.sessionId).toBe(oldest.id);
    expect(pod.requestsTo('session.list')[0]?.query).toMatchObject({ parentID: 'null' });
    expect(pod.requestsTo('session.list')[0]?.query).not.toHaveProperty('limit');
    expect(await rememberedSessionOf(env.id)).toBe(oldest.id);
  });

  it('walks every page of roots before choosing the one created first', async () => {
    const env = await createRunningProject();
    for (let i = 0; i < 60; i += 1) pod.addSession({ time: { created: 10_000 + i, updated: 10_000 + i } });
    const oldest = pod.addSession({ time: { created: 1_000, updated: 99_000 } });
    await rememberSession(env.id, null);

    const connection = await harness.agentConnections.connect(env);

    expect(connection.sessionId).toBe(oldest.id);
    expect(pod.requestsTo('session.list').length).toBeGreaterThanOrEqual(2);
    expect(pod.requestsTo('session.list').at(-1)?.query).toHaveProperty('cursor');
  });

  it('refuses to bind from a partial scan when the root list outlives the page budget', async () => {
    for (let i = 0; i < 60; i += 1) pod.addSession({ time: { created: 10_000 + i, updated: 10_000 + i } });
    pod.addSession({ time: { created: 1_000, updated: 99_000 } });
    const client = harness.moduleRef.get(PodOpencodeClient);

    const error: unknown = await client
      .oldestRootSession(`http://127.0.0.1:${pod.port}`, { maxPages: 1 })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PodTimeout);
  });

  it('lets the terminal empty page through when every root fits inside the page budget', async () => {
    for (let i = 0; i < 49; i += 1) pod.addSession({ time: { created: 10_000 + i, updated: 10_000 + i } });
    const oldest = pod.addSession({ time: { created: 1_000, updated: 99_000 } });
    const client = harness.moduleRef.get(PodOpencodeClient);
    const listed = callsSince('session.list');

    const found = await client.oldestRootSession(`http://127.0.0.1:${pod.port}`, { maxPages: 1 });

    expect(found?.id).toBe(oldest.id);
    expect(listed()).toBe(2);
  });

  it('never adopts a child session as the primary one', async () => {
    const env = await createRunningProject();
    const root = pod.addSession({ time: { created: 5_000, updated: 5_000 } });
    pod.addSession({ parentID: root.id, time: { created: 1_000, updated: 1_000 } });
    await rememberSession(env.id, null);

    expect((await harness.agentConnections.connect(env)).sessionId).toBe(root.id);
  });

  it('replaces a remembered session the runtime confirms is gone', async () => {
    const env = await createRunningProject();
    await rememberSession(env.id, 'ses_vanished');

    const connection = await harness.agentConnections.connect(env);

    expect(connection.sessionId).not.toBe('ses_vanished');
    expect(await rememberedSessionOf(env.id)).toBe(connection.sessionId);
  });

  it('creates one only when the runtime has no root at all', async () => {
    const env = await createRunningProject();
    await rememberSession(env.id, null);
    const created = callsSince('session.create');

    const connection = await harness.agentConnections.connect(env);

    expect(created()).toBe(1);
    expect(await rememberedSessionOf(env.id)).toBe(connection.sessionId);
  });

  it('does not treat an upstream failure as a missing session', async () => {
    const env = await createRunningProject();
    const remembered = pod.addSession();
    await rememberSession(env.id, remembered.id);
    const created = callsSince('session.create');
    pod.script('session.get', { status: 503, body: podErrors.unavailable('busy'), once: true });

    const error: unknown = await harness.agentConnections.connect(env).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PodResponded);
    expect(created()).toBe(0);
    expect(await rememberedSessionOf(env.id)).toBe(remembered.id);
  });

  it('recovers when a session was created upstream but the binding never persisted', async () => {
    const env = await createRunningProject();
    await rememberSession(env.id, null);
    const orphan = pod.addSession({ time: { created: 1_000, updated: 1_000 } });
    const created = callsSince('session.create');

    const connection = await harness.agentConnections.connect(env);

    expect(connection.sessionId).toBe(orphan.id);
    expect(created()).toBe(0);
    expect(await rememberedSessionOf(env.id)).toBe(orphan.id);
  });

  it('lets other native sessions coexist without becoming the primary one', async () => {
    const env = await createRunningProject();
    const primary = pod.addSession({ time: { created: 1_000, updated: 1_000 } });
    await rememberSession(env.id, primary.id);
    pod.addSession({ time: { created: 500, updated: 500 } });

    expect((await harness.agentConnections.connect(env)).sessionId).toBe(primary.id);
  });
});

describe('two service instances connecting at once', () => {
  it('converges on one usable session and never deletes a race candidate', async () => {
    const env = await createRunningProject();
    await rememberSession(env.id, null);
    const created = callsSince('session.create');
    const deleted = callsSince('session.delete');
    pod.script('session.create', { delayMs: 300 });

    const [left, right] = await Promise.all([
      harness.agentConnections.connect(env),
      second.agentConnections.connect(await environmentOf(env.id)),
    ]);

    expect(left.sessionId).toBe(right.sessionId);
    expect(pod.sessions.has(left.sessionId)).toBe(true);
    expect(created()).toBe(1);
    expect(deleted()).toBe(0);
    expect(await rememberedSessionOf(env.id)).toBe(left.sessionId);
  });

  it('connects on a bound environment while another caller holds its session lock', async () => {
    const env = await createRunningProject();
    const primary = pod.addSession();
    await rememberSession(env.id, primary.id);
    const created = callsSince('session.create');

    const held = latch();
    const holding = db.transaction(async (tx) => {
      await lockEnvironmentSession(tx, env.id, 5_000);
      held.release();
      await sleep(1_500);
    });
    await held.promise;

    const startedAt = Date.now();
    const connection = await harness.agentConnections.connect(await environmentOf(env.id));
    const waited = Date.now() - startedAt;
    await holding;

    expect(connection.sessionId).toBe(primary.id);
    expect(created()).toBe(0);
    expect(waited).toBeLessThan(1_000);
  });

  it('serializes around an existing root instead of creating a second one', async () => {
    const env = await createRunningProject();
    const existing = pod.addSession({ time: { created: 1_000, updated: 1_000 } });
    await rememberSession(env.id, null);
    const created = callsSince('session.create');

    const [left, right] = await Promise.all([
      harness.agentConnections.connect(env),
      second.agentConnections.connect(await environmentOf(env.id)),
    ]);

    expect(left.sessionId).toBe(existing.id);
    expect(right.sessionId).toBe(existing.id);
    expect(created()).toBe(0);
  });
});

async function insertPendingReload(
  env: ProjectEnvironmentContext,
  options: { requiresPodRecreate?: boolean } = {}
): Promise<string> {
  const id = randomUUID();
  await db.insert(projectAgentUpdates).values({
    id,
    projectId: env.projectId,
    projectEnvironmentId: env.id,
    agentId: env.agentId,
    targetVersion: '9.9.9',
    status: AgentUpdateStatus.ReloadPending,
    requiresPodRecreate: options.requiresPodRecreate ?? false,
  });
  return id;
}

async function reloadStatusOf(updateId: string): Promise<string> {
  const [row] = await db
    .select({ status: projectAgentUpdates.status })
    .from(projectAgentUpdates)
    .where(eq(projectAgentUpdates.id, updateId));
  return row.status;
}

describe('probing a pod for its active sessions', () => {
  it('reports whether the pod is busy without a directory parameter', async () => {
    const env = await createRunningProject();
    const session = pod.addSession();

    expect(await harness.agentSessions.activeSessions(env)).toEqual({ sessionIds: [], busy: false });

    pod.setActive([session.id]);
    expect(await harness.agentSessions.activeSessions(env)).toEqual({ sessionIds: [session.id], busy: true });
    pod.setActive([]);

    expect(pod.requestsTo('session.active').at(-1)?.query).toEqual({});
  });

  it('times out after three seconds', async () => {
    const env = await createRunningProject();
    pod.script('session.active', { delayMs: 3_500, once: true });

    await expect(harness.agentSessions.activeSessions(env)).rejects.toBeInstanceOf(PodTimeout);
  });

  it('surfaces an opencode error as PodResponded', async () => {
    const env = await createRunningProject();
    pod.script('session.active', { status: 503, body: podErrors.unavailable('busy'), once: true });

    const error: unknown = await harness.agentSessions.activeSessions(env).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PodResponded);
    expect(error).toMatchObject({ status: 503, tag: 'ServiceUnavailableError' });
  });
});

describe('the internal active probes', () => {
  it('lets agent status reconcile a working environment through the probe', async () => {
    const env = await createRunningProject();
    const session = pod.addSession();
    pod.setActive([session.id]);

    await harness.moduleRef.get(AgentStatusService).onApplicationBootstrap();
    pod.setActive([]);

    expect(harness.moduleRef.get(AgentStatusService).statusOf(env.projectId)).toBe(AgentStatus.Working);
  });

  it('defers an agent reload while the probe reports a busy session', async () => {
    const env = await createRunningProject();
    const session = pod.addSession();
    pod.setActive([session.id]);
    await insertPendingReload(env, { requiresPodRecreate: true });

    const outcome = await harness.moduleRef.get(AgentUpdateService).applyPendingReloadForEnvironment(env.id);
    pod.setActive([]);

    expect(outcome).toMatchObject({ status: 'pending', reloadStatus: 'pending:active-session' });
  });
});

describe('the agent the session runs under', () => {
  it('creates the primary session on the Project’s agent', async () => {
    const env = await createRunningProject();
    const before = pod.requestsTo('session.create').length;

    await harness.agentConnections.connect(env);

    const created = pod.requestsTo('session.create').slice(before);
    expect(created).toHaveLength(1);
    expect((created[0].body as { agent?: string }).agent).toBe(DEFAULT_AGENT_NAME);
  });

  it('re-points an adopted session that carries no agent, and leaves a pinned one alone', async () => {
    const env = await createRunningProject();
    const orphan = pod.addSession({ agent: null });
    const switched = callsSince('session.switchAgent');

    await harness.agentConnections.connect(env);

    expect(switched()).toBe(1);
    expect(await rememberedSessionOf(env.id)).toBe(orphan.id);

    await harness.agentConnections.connect(await environmentOf(env.id));
    expect(switched()).toBe(1);
  });

  it('runs an imported Project under the slug its export carried', async () => {
    const env = await createRunningProject();
    await db.update(projects).set({ importedAgent: 'acme-support' }).where(eq(projects.id, env.projectId));
    pod.addSession({ agent: null });
    const before = pod.requestsTo('session.switchAgent').length;

    await harness.agentConnections.connect(await environmentOf(env.id));

    const switched = pod.requestsTo('session.switchAgent').slice(before);
    expect(switched).toHaveLength(1);
    expect(switched[0].body).toEqual({ agent: 'acme-support' });
  });
});

describe('reporting a pod failure back to the environment', () => {
  it('does not report a pod failure when a live runtime answers a service error', async () => {
    const env = await createRunningProject();
    const remembered = pod.addSession();
    await rememberSession(env.id, remembered.id);
    await harness.fakes.pods.deletePod(harness.fakes.pods.assignedPodName(env.id));
    pod.script('session.get', { status: 503, body: podErrors.unavailable('busy'), once: true });

    await expect(harness.agentConnections.connect(env)).rejects.toBeInstanceOf(PodResponded);
    await sleep(300);

    expect((await environmentOf(env.id)).status).toBe(ProjectStatus.Active);
  });

  it('reports an unreachable pod during a connection and restarts the environment', async () => {
    const env = await createRunningProject();
    await harness.fakes.pods.deletePod(harness.fakes.pods.assignedPodName(env.id));
    await pod.stop();

    await expect(harness.agentConnections.connect(env)).rejects.toBeInstanceOf(PodUnreachable);
    await waitFor(async () => (await environmentOf(env.id)).status === ProjectStatus.Starting);
  });
});
