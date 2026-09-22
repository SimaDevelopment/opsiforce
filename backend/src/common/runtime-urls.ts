export const RUNTIME_PROXY_PREFIX = '/api/proxy';

export function runtimeBaseUrl(environmentId: string): string {
  return `${RUNTIME_PROXY_PREFIX}/${environmentId}`;
}

export function runtimeOpenapiUrl(environmentId: string): string {
  return `${runtimeBaseUrl(environmentId)}/openapi.json`;
}
