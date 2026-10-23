import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  EnvironmentNotRunning,
  PodResponded,
  PodTimeout,
  PodUnreachable,
} from '../src/agent-session/agent-session.errors';
import { mappingConnectionRefusals } from '../src/agent-session/connection-refusals';
import { LockNotAvailable } from '../src/common/locks';

async function failingWith(error: unknown): Promise<never> {
  throw error;
}

async function refusalOf(error: unknown): Promise<{ status: number; code: unknown }> {
  try {
    await mappingConnectionRefusals(() => failingWith(error));
  } catch (refusal) {
    if (!(refusal instanceof HttpException)) throw refusal;
    return { status: refusal.getStatus(), code: (refusal.getResponse() as { code?: unknown }).code };
  }
  throw new Error('The connection was not refused');
}

describe('refusing a connection on the internal connect route', () => {
  it('answers a starting environment with a 503 the client waits out', async () => {
    expect(await refusalOf(new EnvironmentNotRunning('starting'))).toEqual({
      status: 503,
      code: 'environment_starting',
    });
  });

  it('names every other environment state and agent failure instead of answering 500', async () => {
    expect(await refusalOf(new EnvironmentNotRunning('disabled'))).toEqual({
      status: 409,
      code: 'environment_disabled',
    });
    expect(await refusalOf(new EnvironmentNotRunning('failed'))).toEqual({ status: 409, code: 'environment_failed' });
    expect(await refusalOf(new EnvironmentNotRunning('not-found'))).toEqual({ status: 404, code: 'not_found' });
    expect(await refusalOf(new PodTimeout('slow'))).toEqual({ status: 504, code: 'agent_timeout' });
    expect(await refusalOf(new LockNotAvailable('session'))).toEqual({ status: 504, code: 'agent_timeout' });
    expect(await refusalOf(new PodUnreachable('refused'))).toEqual({ status: 502, code: 'agent_unreachable' });
    expect(await refusalOf(new PodResponded(500, null, ''))).toEqual({ status: 502, code: 'agent_unreachable' });
  });

  it('leaves an unrelated failure alone', async () => {
    const failure = new Error('database down');

    await expect(mappingConnectionRefusals(() => failingWith(failure))).rejects.toBe(failure);
  });
});
