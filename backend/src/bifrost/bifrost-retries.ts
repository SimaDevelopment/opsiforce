import type { Logger } from '@nestjs/common';

export const BIFROST_WRITE_BACKOFF_MS = [500, 1000, 2000];

export async function retryBifrostWrite(logger: Logger, label: string, write: () => Promise<void>): Promise<boolean> {
  for (let attempt = 0; attempt < BIFROST_WRITE_BACKOFF_MS.length; attempt++) {
    try {
      await write();
      return true;
    } catch (err) {
      const delay = BIFROST_WRITE_BACKOFF_MS[attempt];
      logger.warn(`${label} attempt ${attempt + 1} failed: ${(err as Error).message}; retrying in ${delay}ms`);
      if (attempt < BIFROST_WRITE_BACKOFF_MS.length - 1) await sleep(delay);
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
