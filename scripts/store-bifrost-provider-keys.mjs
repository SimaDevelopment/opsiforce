import { pathToFileURL } from 'node:url';

const ENV_REFERENCE_PREFIX = 'env.';

function createAdminClient({ bifrostUrl, username, password }) {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const baseUrl = bifrostUrl.replace(/\/+$/, '');

  return async function request(method, path, body) {
    const headers = { authorization, 'content-type': 'application/json' };
    const options = body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) };
    const response = await fetch(`${baseUrl}${path}`, options);
    if (!response.ok) {
      throw new Error(`Bifrost ${method} ${path} answered ${response.status}: ${await response.text()}`);
    }
    return response.json();
  };
}

function envVariableOf(key) {
  if (key.value?.type !== 'env' || !key.value.ref?.startsWith(ENV_REFERENCE_PREFIX)) return null;
  return key.value.ref.slice(ENV_REFERENCE_PREFIX.length);
}

async function listKeysByProvider(request) {
  const { providers } = await request('GET', '/api/providers');
  const entries = [];
  for (const { name } of providers) {
    const { keys } = await request('GET', `/api/providers/${encodeURIComponent(name)}/keys`);
    for (const key of keys ?? []) entries.push({ provider: name, key });
  }
  return entries;
}

export async function storeProviderKeys({ bifrostUrl, username, password, environment }) {
  const request = createAdminClient({ bifrostUrl, username, password });
  const entries = await listKeysByProvider(request);

  const missing = entries.map(({ key }) => envVariableOf(key)).filter((name) => name && !(name in environment));
  if (missing.length > 0) {
    throw new Error(
      `Provide the value of every referenced variable before storing keys: ${[...new Set(missing)].join(', ')}`
    );
  }

  const result = { stored: [], alreadyStored: [], empty: [] };
  for (const { provider, key } of entries) {
    const label = `${provider}/${key.name}`;
    const variable = envVariableOf(key);
    if (!variable) {
      result.alreadyStored.push(label);
      continue;
    }
    const value = environment[variable];
    if (!value) {
      result.empty.push(label);
      continue;
    }
    await request('PUT', `/api/providers/${encodeURIComponent(provider)}/keys/${encodeURIComponent(key.id)}`, {
      ...key,
      value: { value, type: 'plain_text' },
    });
    result.stored.push(label);
  }
  return result;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const result = await storeProviderKeys({
    bifrostUrl: requiredEnv('BIFROST_URL'),
    username: requiredEnv('BIFROST_ADMIN_USERNAME'),
    password: requiredEnv('BIFROST_ADMIN_PASSWORD'),
    environment: process.env,
  });
  for (const label of result.stored) process.stdout.write(`stored        ${label}\n`);
  for (const label of result.alreadyStored) process.stdout.write(`already value ${label}\n`);
  for (const label of result.empty) process.stdout.write(`empty, kept   ${label}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
