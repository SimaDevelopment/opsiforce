export class Deadline {
  private constructor(
    private readonly at: number,
    readonly cancellation?: AbortSignal
  ) {}

  static in(totalMs: number, cancellation?: AbortSignal): Deadline {
    return new Deadline(Date.now() + totalMs, cancellation);
  }

  async run<T>(work: () => Promise<T>, onSpent: () => Error): Promise<T> {
    this.assertUnspent(onSpent);
    const signal = this.signal();
    let abort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(onSpent());
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      return await Promise.race([work(), cancelled]);
    } catch (error) {
      if (isAbort(error)) throw onSpent();
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  get remainingMs(): number {
    return Math.max(0, this.at - Date.now());
  }

  get expired(): boolean {
    return this.remainingMs === 0;
  }

  get cancelled(): boolean {
    return this.cancellation?.aborted === true;
  }

  assertUnspent(onSpent: () => Error): void {
    if (this.expired || this.cancelled) throw onSpent();
  }

  signal(): AbortSignal {
    const timeout = AbortSignal.timeout(Math.max(1, this.remainingMs));
    return this.cancellation ? AbortSignal.any([timeout, this.cancellation]) : timeout;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
