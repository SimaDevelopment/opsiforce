import type { DbExecutor } from '../common/locks';

export const PROJECT_LIFECYCLE = 'PROJECT_LIFECYCLE';

export interface ProjectLifecycle {
  created(projectEnvironmentId: string): Promise<void>;
  delivered(projectEnvironmentId: string): Promise<void>;
  copied(projectEnvironmentId: string): Promise<void>;
  updated(projectEnvironmentId: string): Promise<void>;
  resetting(projectEnvironmentId: string): Promise<void>;
  disabled(projectId: string): Promise<void>;
  enabled(projectId: string): Promise<void>;
  environmentRemoving(projectEnvironmentId: string): Promise<void>;
  removing(tx: DbExecutor, projectId: string): Promise<void>;
  neverSleeps(projectEnvironmentId: string): Promise<boolean>;
}
