import { Injectable } from '@nestjs/common';

export class PublishCancelledError extends Error {
  constructor() {
    super('Publish cancelled');
  }
}

@Injectable()
export class PublishCancellations {
  private readonly running = new Map<string, AbortController>();

  begin(publishJobId: string): AbortSignal {
    const controller = new AbortController();
    this.running.set(publishJobId, controller);
    return controller.signal;
  }

  end(publishJobId: string): void {
    this.running.delete(publishJobId);
  }

  cancel(publishJobId: string): boolean {
    const controller = this.running.get(publishJobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

export function unlessCancelled<T>(cancelled: AbortSignal, wait: Promise<T>): Promise<T> {
  if (cancelled.aborted) {
    wait.catch(() => undefined);
    return Promise.reject(new PublishCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onCancel = () => reject(new PublishCancelledError());
    cancelled.addEventListener('abort', onCancel, { once: true });
    wait.then(resolve, reject).finally(() => cancelled.removeEventListener('abort', onCancel));
  });
}
