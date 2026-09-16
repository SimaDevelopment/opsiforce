import type { ServerResponse } from 'node:http';

export async function withConnectionCancellation<T>(
  response: ServerResponse,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abort = () => {
    if (!response.writableFinished) controller.abort();
  };
  response.once('close', abort);
  if (response.destroyed) abort();
  try {
    return await work(controller.signal);
  } finally {
    response.off('close', abort);
  }
}
