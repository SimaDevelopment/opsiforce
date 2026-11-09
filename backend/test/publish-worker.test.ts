import { DelayedError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { PublishCancellations } from '../src/publish/publish-cancellations';
import { PublishProcessor } from '../src/publish/publish.processor';

function job(publishJobId: string, projectId: string) {
  return { data: { publishJobId, projectId }, moveToDelayed: vi.fn(async () => undefined) };
}

describe('The publish worker', () => {
  it("hands a busy Project's next publish back to the queue and starts another Project's", async () => {
    const started: string[] = [];
    const publishes = {
      claim: (publishJobId: string) => {
        started.push(publishJobId);
        return new Promise<boolean>(() => undefined);
      },
    };
    const unused = {} as never;
    const worker = new PublishProcessor(
      { getOrThrow: () => '/workspace-data' } as never,
      unused,
      publishes as never,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      new PublishCancellations()
    );

    void worker.process(job('first', 'project-a') as never, 'token');
    await expect.poll(() => started).toEqual(['first']);

    const sameProject = job('second', 'project-a');
    await expect(worker.process(sameProject as never, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(sameProject.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');

    void worker.process(job('other', 'project-b') as never, 'token');
    await expect.poll(() => started).toEqual(['first', 'other']);
  });
});
