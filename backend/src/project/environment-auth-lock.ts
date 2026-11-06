import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { projectEnvironments } from '../../db/schema';
import type { Transaction } from '../external-services/configuration/transaction';
import type { ProjectAuthMode } from './project.types';

export interface LockedEnvironmentAuth {
  authMode: ProjectAuthMode;
  signInProviderId: string | null;
}

export async function lockEnvironmentAuth(
  tx: Transaction,
  environmentId: string
): Promise<LockedEnvironmentAuth | undefined> {
  const [current] = await tx
    .select({ authMode: projectEnvironments.authMode, signInProviderId: projectEnvironments.signInProviderId })
    .from(projectEnvironments)
    .where(eq(projectEnvironments.id, environmentId))
    .for('update');
  return current;
}

export function withEnvironmentAuthLock<T>(
  environmentId: string,
  work: (tx: Transaction, current: LockedEnvironmentAuth | undefined) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => work(tx, await lockEnvironmentAuth(tx, environmentId)));
}
