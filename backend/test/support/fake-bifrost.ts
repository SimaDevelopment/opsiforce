import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { parseJson, type JsonObject, type JsonValue } from './json';

export interface FakeProviderConfig {
  provider: string;
  weight: number | null;
  allowed_models: string[];
  key_ids: string[];
}

export interface FakeVirtualKey {
  id: string;
  name: string;
  value: string;
  team_id: string | null;
  budgets: JsonValue[];
  provider_configs: FakeProviderConfig[];
}

export type FakeProviderStatus = 'active' | 'error';

export interface FakeProviderKey {
  id: string;
  name: string;
  value: JsonValue;
  models: string[];
  weight: number | null;
  enabled: boolean;
}

export interface FakeProvider {
  name: string;
  baseProviderType: string | null;
  baseUrl: string | null;
  keyLess: boolean;
  status: FakeProviderStatus;
  created: JsonObject | null;
  updated: JsonObject | null;
  keys: FakeProviderKey[];
}

export interface RecordedBifrostWrite {
  method: string;
  path: string;
  body: JsonValue;
}

export interface FakeBifrost {
  url: string;
  env: Record<string, string>;
  writes: RecordedBifrostWrite[];
  requests: RecordedBifrostWrite[];
  setProviders: (names: string[]) => void;
  addProvider: (name: string) => void;
  providerNamed: (name: string) => FakeProvider | undefined;
  loseProvider: (name: string) => void;
  restoreHelmEntry: (name: string) => void;
  keepProvidersOnDelete: () => void;
  deleteProvidersOnDelete: () => void;
  setProviderStatus: (name: string, status: FakeProviderStatus) => void;
  setProviderKeyed: (name: string, keyed: boolean) => void;
  becomeUnreachable: () => void;
  becomeReachable: () => void;
  virtualKeyNamed: (name: string) => FakeVirtualKey | undefined;
  holdVirtualKeys: (ids: string[]) => void;
  chatKeyOf: (projectId: string) => FakeVirtualKey;
  backendKeyOf: (projectId: string) => FakeVirtualKey;
  providerConfigWritesTo: (keyId: string) => RecordedBifrostWrite[];
  refuseProviderConfigWrites: (keyId?: string) => void;
  acceptProviderConfigWrites: () => void;
  refuseKeyWritesTo: (provider: string | null) => void;
  close: () => Promise<void>;
}

export const DOCK_BASE_URL = 'https://codex-oauth-dock.example.test/api/openai-oauth/v1';

const STANDARD_PROVIDER_NAMES = new Set(['openai', 'anthropic', 'azure', 'bedrock', 'cohere', 'gemini', 'vertex']);

const KEYLESS_REFUSALS: Record<string, string> = {
  POST: 'Cannot add keys to a keyless provider',
  PUT: 'Cannot update keys on a keyless provider',
  DELETE: 'Cannot delete keys on a keyless provider',
};

function isEmptyKeyValue(value: JsonValue | undefined): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return value.value === '' && value.ref === undefined;
}

function textOf(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function declaredProvider(
  name: string,
  baseProviderType: string | null,
  baseUrl: string | null,
  keyLess = false
): FakeProvider {
  return { name, baseProviderType, baseUrl, keyLess, status: 'active', created: null, updated: null, keys: [] };
}

const HELM_PROVIDERS: FakeProvider[] = [
  declaredProvider('openai', null, null),
  declaredProvider('anthropic', null, null),
  declaredProvider('custom-openai-1', 'openai', DOCK_BASE_URL, true),
];

function helmProviderNamed(name: string): FakeProvider {
  const declared = HELM_PROVIDERS.find((provider) => provider.name === name);
  return declared ? { ...declared, keys: [] } : declaredProvider(name, null, null);
}

function baseUrlRefusal(baseUrl: string, allowPrivateNetwork: boolean): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `Invalid base URL: ${baseUrl} is not a URL`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Invalid base URL: only http and https are allowed';
  const privateHost = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(url.hostname);
  if (privateHost && !allowPrivateNetwork) return `Invalid base URL: ${url.hostname} is a private network address`;
  return null;
}

function providerResponse(provider: FakeProvider): JsonObject {
  return {
    name: provider.name,
    provider_status: provider.status,
    network_config: { base_url: provider.baseUrl ?? '' },
    custom_provider_config: provider.baseProviderType
      ? { base_provider_type: provider.baseProviderType, is_key_less: provider.keyLess }
      : null,
  };
}

export async function startFakeBifrost(): Promise<FakeBifrost> {
  const writes: RecordedBifrostWrite[] = [];
  const requests: RecordedBifrostWrite[] = [];
  let keepProvidersOnDelete = false;
  const providers = new Map<string, FakeProvider>(HELM_PROVIDERS.map((provider) => [provider.name, { ...provider }]));
  let unreachable = false;
  const keyedProviders = new Set<string>();
  const virtualKeys = new Map<string, FakeVirtualKey>();
  const customers = new Map<string, JsonObject>();
  const teams = new Map<string, JsonObject>();
  const refusedProviderConfigKeys = new Set<string>();
  let refuseEveryProviderConfigWrite = false;
  let keyWritesRefusedTo: string | null = null;

  function send(res: ServerResponse, status: number, body: JsonValue): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function notFound(res: ServerResponse): void {
    send(res, 404, { error: { message: 'not found' } });
  }

  function providerConfigsFrom(value: JsonValue | undefined): FakeProviderConfig[] | { invalid: string } {
    const configs = Array.isArray(value) ? value : [];
    const parsed: FakeProviderConfig[] = [];
    for (const entry of configs) {
      const config = entry as JsonObject;
      const provider = textOf(config.provider);
      if (!providers.has(provider)) return { invalid: provider };
      parsed.push({
        provider,
        weight: typeof config.weight === 'number' ? config.weight : null,
        allowed_models: (config.allowed_models as string[] | undefined) ?? [],
        key_ids: (config.key_ids as string[] | undefined) ?? [],
      });
    }
    return parsed;
  }

  function handleVirtualKeys(method: string, id: string | undefined, body: JsonObject, res: ServerResponse): void {
    if (method === 'POST' && !id) {
      const configs = providerConfigsFrom(body.provider_configs);
      if ('invalid' in configs)
        return send(res, 400, { error: { message: `invalid provider name: ${configs.invalid}` } });
      const key: FakeVirtualKey = {
        id: randomUUID(),
        name: textOf(body.name),
        value: `sk-bf-${randomUUID()}`,
        team_id: (body.team_id as string | undefined) ?? null,
        budgets: (body.budgets as JsonValue[] | undefined) ?? [],
        provider_configs: configs,
      };
      virtualKeys.set(key.id, key);
      return send(res, 200, { message: 'created', virtual_key: key as unknown as JsonObject });
    }
    const key = id ? virtualKeys.get(id) : undefined;
    if (!key) return notFound(res);
    if (method === 'GET') return send(res, 200, { virtual_key: key as unknown as JsonObject });
    if (method === 'DELETE') {
      virtualKeys.delete(key.id);
      return send(res, 200, { message: 'deleted' });
    }
    if (method === 'PUT') {
      if (body.provider_configs !== undefined) {
        if (refuseEveryProviderConfigWrite || refusedProviderConfigKeys.has(key.id))
          return send(res, 500, { error: { message: 'store unavailable' } });
        const configs = providerConfigsFrom(body.provider_configs);
        if ('invalid' in configs) {
          return send(res, 400, { error: { message: `invalid provider name: ${configs.invalid}` } });
        }
        key.provider_configs = configs;
      }
      if (body.budgets !== undefined) key.budgets = body.budgets as JsonValue[];
      if (typeof body.team_id === 'string') key.team_id = body.team_id;
      return send(res, 200, { message: 'updated', virtual_key: key as unknown as JsonObject });
    }
    notFound(res);
  }

  function createProvider(body: JsonObject, res: ServerResponse): void {
    const name = textOf(body.provider);
    if (STANDARD_PROVIDER_NAMES.has(name) && body.custom_provider_config !== undefined) {
      return send(res, 400, { error: { message: `Cannot create a custom provider named ${name}` } });
    }
    if (providers.has(name)) return send(res, 409, { error: { message: `Provider ${name} already exists` } });
    const networkConfig = (body.network_config as JsonObject | undefined) ?? {};
    const customConfig = (body.custom_provider_config as JsonObject | undefined) ?? {};
    const baseUrl = typeof networkConfig.base_url === 'string' ? networkConfig.base_url : null;
    if (baseUrl) {
      const refusal = baseUrlRefusal(baseUrl, networkConfig.allow_private_network === true);
      if (refusal) return send(res, 400, { error: { message: refusal } });
    }
    const provider: FakeProvider = {
      name,
      baseProviderType: typeof customConfig.base_provider_type === 'string' ? customConfig.base_provider_type : null,
      baseUrl,
      keyLess: customConfig.is_key_less === true,
      status: 'active',
      created: body,
      updated: null,
      keys: [],
    };
    providers.set(name, provider);
    send(res, 200, providerResponse(provider));
  }

  function updateProvider(name: string, body: JsonObject, res: ServerResponse): void {
    if (Array.isArray(body.keys) && body.keys.length > 0) {
      return send(res, 400, { error: { message: 'keys are not accepted on this endpoint' } });
    }
    const networkConfig = (body.network_config as JsonObject | undefined) ?? {};
    const customConfig = (body.custom_provider_config as JsonObject | undefined) ?? {};
    const baseUrl =
      typeof networkConfig.base_url === 'string' && networkConfig.base_url ? networkConfig.base_url : null;
    if (baseUrl) {
      const refusal = baseUrlRefusal(baseUrl, networkConfig.allow_private_network === true);
      if (refusal) return send(res, 400, { error: { message: refusal } });
    }
    const existing = providers.get(name);
    const provider = existing ?? declaredProvider(name, null, null);
    provider.baseUrl = baseUrl;
    provider.baseProviderType =
      typeof customConfig.base_provider_type === 'string' ? customConfig.base_provider_type : provider.baseProviderType;
    if (typeof customConfig.is_key_less === 'boolean') provider.keyLess = customConfig.is_key_less;
    provider.updated = body;
    providers.set(name, provider);
    send(res, 200, providerResponse(provider));
  }

  function removeProvider(name: string): void {
    providers.delete(name);
    for (const key of virtualKeys.values()) {
      key.provider_configs = key.provider_configs.filter((config) => config.provider !== name);
    }
  }

  function deleteProvider(provider: FakeProvider, res: ServerResponse): void {
    if (!keepProvidersOnDelete) removeProvider(provider.name);
    send(res, 200, { name: provider.name });
  }

  function keyNamed(name: string): FakeProviderKey | undefined {
    return [...providers.values()].flatMap((provider) => provider.keys).find((key) => key.name === name);
  }

  function handleProviderKeys(
    provider: FakeProvider,
    method: string,
    keyId: string | undefined,
    body: JsonObject,
    res: ServerResponse
  ): void {
    if (!keyId && method === 'GET') {
      const keyedByHelm = keyedProviders.has(provider.name) ? [{ value: { value: 'sk-fake' }, enabled: true }] : [];
      const keys = [...keyedByHelm, ...(provider.keys as unknown as JsonObject[])];
      return send(res, 200, { keys, total: keys.length });
    }
    if (method !== 'GET' && provider.name === keyWritesRefusedTo) {
      return send(res, 500, { error: { message: 'key write refused' } });
    }
    if (method !== 'GET' && provider.keyLess) {
      return send(res, 400, {
        error: { message: KEYLESS_REFUSALS[method] ?? 'Cannot change keys on a keyless provider' },
      });
    }
    if ((method === 'POST' || method === 'PUT') && isEmptyKeyValue(body.value)) {
      return send(res, 400, { error: { message: 'Key value must not be empty' } });
    }
    if (!keyId && method === 'POST') {
      const name = textOf(body.name);
      if (keyNamed(name)) {
        return send(res, 409, { error: { message: 'API key names must be unique across providers' } });
      }
      const key: FakeProviderKey = {
        id: typeof body.id === 'string' ? body.id : randomUUID(),
        name,
        value: body.value ?? null,
        models: (body.models as string[] | undefined) ?? [],
        weight: typeof body.weight === 'number' ? body.weight : null,
        enabled: body.enabled !== false,
      };
      provider.keys.push(key);
      return send(res, 200, { ...key, value: { value: 'redacted', type: 'plain_text' } } as unknown as JsonObject);
    }
    const key = provider.keys.find((candidate) => candidate.id === keyId);
    if (!key) return notFound(res);
    if (method === 'GET') return send(res, 200, key as unknown as JsonObject);
    if (method === 'DELETE') {
      provider.keys = provider.keys.filter((candidate) => candidate !== key);
      return send(res, 200, { id: key.id });
    }
    if (method === 'PUT') {
      const replacement: FakeProviderKey = {
        id: key.id,
        name: textOf(body.name),
        value: body.value ?? null,
        models: (body.models as string[] | undefined) ?? [],
        weight: typeof body.weight === 'number' ? body.weight : null,
        enabled: body.enabled !== false,
      };
      provider.keys = provider.keys.map((candidate) => (candidate === key ? replacement : candidate));
      return send(res, 200, {
        ...replacement,
        value: { value: 'redacted', type: 'plain_text' },
      } as unknown as JsonObject);
    }
    notFound(res);
  }

  function handleGroup(
    store: Map<string, JsonObject>,
    field: 'customer' | 'team',
    method: string,
    id: string | undefined,
    body: JsonObject,
    res: ServerResponse
  ): void {
    if (method === 'POST' && !id) {
      const entity = { ...body, id: randomUUID() };
      store.set(entity.id, entity);
      return send(res, 200, { message: 'created', [field]: entity });
    }
    const entity = id ? store.get(id) : undefined;
    if (!entity) return notFound(res);
    if (method === 'GET') return send(res, 200, { [field]: entity });
    if (method === 'DELETE') {
      store.delete(entity.id as string);
      return send(res, 200, { message: 'deleted' });
    }
    if (method === 'PUT') {
      Object.assign(entity, body);
      return send(res, 200, { message: 'updated', [field]: entity });
    }
    notFound(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://fake-bifrost').pathname;
    const raw = await text(req);
    const body = (parseJson(raw) ?? {}) as JsonObject;
    requests.push({ method, path, body });
    if (method !== 'GET') writes.push({ method, path, body });

    const [, api, area, collection, id] = path.split('/');
    if (api !== 'api') return notFound(res);

    if (area === 'providers') {
      if (method === 'GET' && !collection) {
        const listed = [...providers.values()].toSorted((a, b) => a.name.localeCompare(b.name)).map(providerResponse);
        return send(res, 200, { providers: listed, total: listed.length });
      }
      if (method === 'POST' && !collection) return createProvider(body, res);
      if (method === 'PUT' && collection && !id) return updateProvider(collection, body, res);
      const provider = collection ? providers.get(collection) : undefined;
      if (!provider) return notFound(res);
      if (id === 'keys') return handleProviderKeys(provider, method, path.split('/')[5], body, res);
      if (method === 'GET' && !id) return send(res, 200, providerResponse(provider));
      if (method === 'DELETE' && !id) return deleteProvider(provider, res);
      return notFound(res);
    }

    if (area === 'governance') {
      if (collection === 'virtual-keys') return handleVirtualKeys(method, id, body, res);
      if (collection === 'customers') return handleGroup(customers, 'customer', method, id, body, res);
      if (collection === 'teams') return handleGroup(teams, 'team', method, id, body, res);
    }
    notFound(res);
  }

  const server = createServer((req, res) => {
    if (unreachable) {
      req.socket.destroy();
      return;
    }
    handle(req, res).catch((err: Error) => send(res, 500, { error: { message: err.message } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const virtualKeyNamed = (name: string) => [...virtualKeys.values()].find((key) => key.name === name);
  const projectKey = (projectId: string, keyType: 'chat' | 'backend') => {
    const key = virtualKeyNamed(`project-${projectId.slice(0, 8)}-${keyType}`);
    if (!key) throw new Error(`Project ${projectId} has no ${keyType} virtual key in the fake Bifrost`);
    return key;
  };

  return {
    url,
    env: {
      BIFROST_PROXY_URL: `${url}/v1`,
      BIFROST_ADMIN_USERNAME: 'admin',
      BIFROST_ADMIN_PASSWORD: 'admin',
    },
    writes,
    requests,
    setProviders: (names) => {
      providers.clear();
      for (const name of names) providers.set(name, helmProviderNamed(name));
    },
    addProvider: (name) => {
      providers.set(name, helmProviderNamed(name));
    },
    providerNamed: (name) => providers.get(name),
    loseProvider: removeProvider,
    restoreHelmEntry: (name) => {
      const placeholder: FakeProviderKey = {
        id: randomUUID(),
        name: 'placeholder',
        value: { value: '', type: 'plain_text' },
        models: [],
        weight: 1,
        enabled: true,
      };
      providers.set(name, { ...helmProviderNamed(name), keys: [placeholder] });
    },
    keepProvidersOnDelete: () => {
      keepProvidersOnDelete = true;
    },
    deleteProvidersOnDelete: () => {
      keepProvidersOnDelete = false;
    },
    setProviderStatus: (name, status) => {
      const provider = providers.get(name);
      if (!provider) throw new Error(`The fake Bifrost has no provider ${name}`);
      provider.status = status;
    },
    setProviderKeyed: (name, keyed) => {
      if (keyed) keyedProviders.add(name);
      else keyedProviders.delete(name);
    },
    becomeUnreachable: () => {
      unreachable = true;
    },
    becomeReachable: () => {
      unreachable = false;
    },
    virtualKeyNamed,
    holdVirtualKeys: (ids) => {
      for (const id of ids) {
        if (virtualKeys.has(id)) continue;
        virtualKeys.set(id, { id, name: `held-${id}`, value: '', team_id: null, budgets: [], provider_configs: [] });
      }
    },
    chatKeyOf: (projectId) => projectKey(projectId, 'chat'),
    backendKeyOf: (projectId) => projectKey(projectId, 'backend'),
    providerConfigWritesTo: (keyId) =>
      writes.filter(
        (write) =>
          write.method === 'PUT' &&
          write.path === `/api/governance/virtual-keys/${keyId}` &&
          (write.body as JsonObject).provider_configs !== undefined
      ),
    refuseProviderConfigWrites: (keyId) => {
      if (keyId) refusedProviderConfigKeys.add(keyId);
      else refuseEveryProviderConfigWrite = true;
    },
    acceptProviderConfigWrites: () => {
      refusedProviderConfigKeys.clear();
      refuseEveryProviderConfigWrite = false;
    },
    refuseKeyWritesTo: (name) => {
      keyWritesRefusedTo = name;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
