import { setTimeout } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { Deadline } from '../src/common/deadline';
import { PodTimeout } from '../src/agent-session/agent-session.errors';

const spent = () => new PodTimeout('the budget ran out');

describe('a Deadline running work that shares its cancellation signal', () => {
  it('reports the caller reason whichever rejection wins the race', async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const deadline = Deadline.in(5);

      await expect(
        deadline.run(() => setTimeout(1_000, undefined, { signal: deadline.signal() }), spent)
      ).rejects.toBeInstanceOf(PodTimeout);
    }
  });

  it('reports the caller reason when an external cancellation lands mid-flight', async () => {
    const controller = new AbortController();
    const deadline = Deadline.in(1_000, controller.signal);
    const work = deadline.run(() => setTimeout(1_000, undefined, { signal: deadline.signal() }), spent);

    controller.abort();

    await expect(work).rejects.toBeInstanceOf(PodTimeout);
  });

  it('leaves an unrelated failure alone', async () => {
    const deadline = Deadline.in(1_000);

    await expect(deadline.run(() => Promise.reject(new Error('pod said no')), spent)).rejects.toThrow('pod said no');
  });

  it('reports the caller reason before starting work it has no budget for', async () => {
    const deadline = Deadline.in(0);

    await expect(
      deadline.run(() => Promise.resolve('should never run'), spent)
    ).rejects.toBeInstanceOf(PodTimeout);
  });
});
