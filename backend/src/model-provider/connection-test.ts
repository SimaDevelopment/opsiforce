import type { BaseFormat } from './base-formats';

const CONNECTION_TEST_TIMEOUT_MS = 10_000;

const KEY_REJECTED = 'The key was rejected';
const UNREACHABLE_ADDRESS = "Can't reach this address";
const REDIRECTED_ADDRESS = 'Enter the final URL';

export type ConnectionTestOutcome = { passed: true } | { passed: false; reason: string };

function failureReason(status: number): string {
  if (status === 401 || status === 403) return KEY_REJECTED;
  if (status === 0 || (status >= 300 && status < 400)) return REDIRECTED_ADDRESS;
  return `The test failed with HTTP ${status}`;
}

export async function testConnection(url: string, format: BaseFormat, key: string): Promise<ConnectionTestOutcome> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: format.connectionTest.headers(key),
      redirect: 'manual',
      signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
    });
  } catch {
    return { passed: false, reason: UNREACHABLE_ADDRESS };
  }
  await response.body?.cancel().catch(() => undefined);
  return response.ok ? { passed: true } : { passed: false, reason: failureReason(response.status) };
}
