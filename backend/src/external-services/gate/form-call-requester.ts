import { AsyncLocalStorage } from 'node:async_hooks';

const requester = new AsyncLocalStorage<string>();

export function withFormCallRequester<T>(userId: string, call: () => Promise<T>): Promise<T> {
  return requester.run(userId, call);
}

export function formCallRequester(): string | undefined {
  return requester.getStore();
}
