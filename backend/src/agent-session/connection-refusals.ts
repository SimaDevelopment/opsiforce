import {
  BadGatewayException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LockNotAvailable } from '../common/locks';
import {
  EnvironmentNotRunning,
  isPodFailure,
  PodResponded,
  PodTimeout,
  type EnvironmentNotRunningState,
} from './agent-session.errors';

export type ConnectionRefusal = EnvironmentNotRunningState | 'agent-timeout' | 'agent-unreachable' | 'unexpected';

export function connectionRefusalOf(error: unknown): ConnectionRefusal | null {
  if (error instanceof EnvironmentNotRunning) return error.state;
  if (error instanceof PodTimeout || error instanceof LockNotAvailable) return 'agent-timeout';
  if (isPodFailure(error)) return 'agent-unreachable';
  if (error instanceof PodResponded) return 'unexpected';
  return null;
}

const HTTP_REFUSAL: Record<ConnectionRefusal, () => HttpException> = {
  starting: () =>
    new ServiceUnavailableException({ code: 'environment_starting', message: 'The environment is starting' }),
  disabled: () => new ConflictException({ code: 'environment_disabled', message: 'The environment is disabled' }),
  failed: () => new ConflictException({ code: 'environment_failed', message: 'The environment failed to start' }),
  'not-found': () => new NotFoundException({ code: 'not_found', message: 'The environment no longer exists' }),
  'agent-timeout': () =>
    new GatewayTimeoutException({ code: 'agent_timeout', message: 'The agent did not respond in time' }),
  'agent-unreachable': () =>
    new BadGatewayException({ code: 'agent_unreachable', message: 'The agent could not be reached' }),
  unexpected: () =>
    new InternalServerErrorException({ code: 'unexpected', message: 'The agent answered unexpectedly' }),
};

export async function mappingConnectionRefusals<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const refusal = connectionRefusalOf(error);
    throw refusal ? HTTP_REFUSAL[refusal]() : error;
  }
}
