import {
  EnvironmentNotRunning,
  isPodFailure,
  PodResponded,
  PodTimeout,
  PodUnreachable,
  type EnvironmentNotRunningState,
} from '../../agent-session/agent-session.errors';
import { LockNotAvailable } from '../../common/locks';
import { Errors, PublicApiError } from './public-api-error';

const ERROR_BY_ENVIRONMENT_STATE: Record<EnvironmentNotRunningState, () => PublicApiError> = {
  starting: () => Errors.environmentStarting(),
  disabled: () => Errors.environmentDisabled(),
  failed: () => Errors.environmentFailed(),
  'not-found': () => Errors.projectNotFound(),
};

function toPublicApiError(error: unknown): PublicApiError | null {
  if (error instanceof EnvironmentNotRunning) return ERROR_BY_ENVIRONMENT_STATE[error.state]();
  if (error instanceof PodTimeout) return Errors.agentTimeout();
  if (error instanceof LockNotAvailable) return Errors.agentTimeout();
  if (error instanceof PodUnreachable) return Errors.agentUnreachable();
  if (error instanceof PodResponded) {
    return isPodFailure(error) ? Errors.agentUnreachable() : Errors.unexpected();
  }
  return null;
}

export async function mappingAgentErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toPublicApiError(error) ?? error;
  }
}
