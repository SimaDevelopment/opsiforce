import {
  BadGatewayException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LockNotAvailable } from '../common/locks';
import {
  EnvironmentNotRunning,
  PodResponded,
  PodTimeout,
  PodUnreachable,
  type EnvironmentNotRunningState,
} from './agent-session.errors';

const REFUSAL_BY_ENVIRONMENT_STATE: Record<EnvironmentNotRunningState, () => HttpException> = {
  starting: () =>
    new ServiceUnavailableException({ code: 'environment_starting', message: 'The environment is starting' }),
  disabled: () => new ConflictException({ code: 'environment_disabled', message: 'The environment is disabled' }),
  failed: () => new ConflictException({ code: 'environment_failed', message: 'The environment failed to start' }),
  'not-found': () => new NotFoundException({ code: 'not_found', message: 'The environment no longer exists' }),
};

function toConnectionRefusal(error: unknown): HttpException | null {
  if (error instanceof EnvironmentNotRunning) return REFUSAL_BY_ENVIRONMENT_STATE[error.state]();
  if (error instanceof PodTimeout || error instanceof LockNotAvailable) {
    return new GatewayTimeoutException({ code: 'agent_timeout', message: 'The agent did not respond in time' });
  }
  if (error instanceof PodUnreachable || error instanceof PodResponded) {
    return new BadGatewayException({ code: 'agent_unreachable', message: 'The agent could not be reached' });
  }
  return null;
}

export async function mappingConnectionRefusals<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toConnectionRefusal(error) ?? error;
  }
}
