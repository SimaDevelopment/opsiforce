import { sql } from 'drizzle-orm';
import type { DrizzleDB } from '../../db';

export type DbExecutor = DrizzleDB | Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

const PROJECT_GIT_NAMESPACE = 'opsiforce:project-git';
const ENVIRONMENT_SESSION_NAMESPACE = 'opsiforce:environment-session';
const LOCK_NOT_AVAILABLE = '55P03';

export class LockNotAvailable extends Error {
  constructor(resource: string) {
    super(`Could not acquire the lock on ${resource} in time`);
    this.name = 'LockNotAvailable';
  }
}

export async function lockProjectGit(executor: DbExecutor, projectId: string): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${PROJECT_GIT_NAMESPACE}), hashtext(${projectId}))`);
}

export async function lockEnvironmentSession(
  executor: DbExecutor,
  environmentId: string,
  timeoutMs: number
): Promise<void> {
  const bounded = Math.max(1, Math.floor(timeoutMs));
  await executor.execute(sql`select set_config('lock_timeout', ${String(bounded)}, true)`);
  try {
    await executor.execute(
      sql`select pg_advisory_xact_lock(hashtext(${ENVIRONMENT_SESSION_NAMESPACE}), hashtext(${environmentId}))`
    );
  } catch (error) {
    if (isLockTimeout(error)) throw new LockNotAvailable(`environment ${environmentId}`);
    throw error;
  }
}

function isLockTimeout(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as Error & { code?: string }).code === LOCK_NOT_AVAILABLE) return true;
  }
  return false;
}
