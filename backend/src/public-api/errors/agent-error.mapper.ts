import { connectionRefusalOf, type ConnectionRefusal } from '../../agent-session/connection-refusals';
import { Errors, PublicApiError } from './public-api-error';

const PUBLIC_API_REFUSAL: Record<ConnectionRefusal, () => PublicApiError> = {
  starting: () => Errors.environmentStarting(),
  disabled: () => Errors.environmentDisabled(),
  failed: () => Errors.environmentFailed(),
  'not-found': () => Errors.projectNotFound(),
  'agent-timeout': () => Errors.agentTimeout(),
  'agent-unreachable': () => Errors.agentUnreachable(),
  unexpected: () => Errors.unexpected(),
};

export async function mappingAgentErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const refusal = connectionRefusalOf(error);
    throw refusal ? PUBLIC_API_REFUSAL[refusal]() : error;
  }
}
