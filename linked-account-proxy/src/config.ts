export const PORT = 8455;

export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface BackendConfig {
  url: string;
  serviceToken: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

export function resolveBackend(): BackendConfig {
  return {
    url: requiredEnv('LINKED_ACCOUNT_PROXY_BACKEND_URL').replace(/\/+$/, ''),
    serviceToken: requiredEnv('LINKED_ACCOUNT_PROXY_SERVICE_TOKEN'),
  };
}
