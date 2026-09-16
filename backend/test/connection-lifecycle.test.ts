import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db } from '../db';
import { withConnectionCancellation } from '../src/common/connection-cancellation';
import { mappingAgentErrors } from '../src/public-api/errors/agent-error.mapper';
import { Deadline } from '../src/common/deadline';
import { lockEnvironmentSession, LockNotAvailable } from '../src/common/locks';

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('connection lifecycle', () => {
  it('aborts a completed HTTP request whose pending response is abandoned', async () => {
    const entered = latch();
    const cancelled = latch();
    const server = createServer((req, res) => {
      req.resume();
      void withConnectionCancellation(res, async (signal) => {
        signal.addEventListener('abort', cancelled.release, { once: true });
        entered.release();
        await cancelled.promise;
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const caller = request(`http://127.0.0.1:${address.port}`, { method: 'POST' });
    caller.on('error', () => {});
    try {
      caller.end();
      await entered.promise;
      caller.destroy();
      await cancelled.promise;
    } finally {
      caller.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('bounds a slow readiness operation and does not start its next step', async () => {
    const pending = latch();
    const deadline = Deadline.in(30);
    const started = Date.now();
    try {
      await expect(
        deadline.run(
          () => pending.promise,
          () => new Error('budget spent')
        )
      ).rejects.toThrow('budget spent');
      expect(Date.now() - started).toBeLessThan(500);
      expect(() => deadline.assertUnspent(() => new Error('budget spent'))).toThrow('budget spent');
    } finally {
      pending.release();
    }
  });

  it('times out on real database contention and allows the next connection', async () => {
    const id = randomUUID();
    const locked = latch();
    const release = latch();
    const holder = db.transaction(async (tx) => {
      await lockEnvironmentSession(tx, id, 1000);
      locked.release();
      await release.promise;
    });
    await locked.promise;
    try {
      await expect(db.transaction((tx) => lockEnvironmentSession(tx, id, 60))).rejects.toBeInstanceOf(LockNotAvailable);
      await expect(
        mappingAgentErrors(() => db.transaction((tx) => lockEnvironmentSession(tx, id, 60)))
      ).rejects.toMatchObject({ status: 504 });
    } finally {
      release.release();
      await holder;
    }
    await db.transaction((tx) => lockEnvironmentSession(tx, id, 1000));
  });
});
