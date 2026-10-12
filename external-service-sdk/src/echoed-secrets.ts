import type { ServiceResponse } from './runtime.ts';

export const forwardedAnswerHeaders: readonly string[] = ['content-type', 'content-disposition', 'retry-after'];

const minCheckedSecretLength = 8;

const decoder = new TextDecoder();

export function containsSentSecret(
  response: Pick<ServiceResponse, 'body' | 'headers'>,
  sentSecrets: readonly string[]
): boolean {
  const texts = [decoder.decode(response.body), ...forwardedAnswerHeaders.map((name) => response.headers[name] ?? '')];
  return sentSecrets
    .filter((secret) => secret.length >= minCheckedSecretLength)
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])
    .some((secret) => texts.some((text) => text.includes(secret)));
}
