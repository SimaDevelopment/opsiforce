import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { storeProviderKeys } from './store-bifrost-provider-keys.mjs';

const USERNAME = 'opsiforce-admin';
const PASSWORD = 'secret-password';

function redact(value) {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(24)}${value.slice(-4)}`;
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function createFakeBifrost() {
  const state = { providers: new Map(), environment: {}, keyUpdates: 0 };

  function resolvedValue(secret) {
    return secret.type === 'env' ? (state.environment[secret.ref.slice('env.'.length)] ?? '') : secret.value;
  }

  function redactedKey(key) {
    const { secret, ...rest } = key;
    const shown = { value: redact(resolvedValue(secret)), type: secret.type };
    if (secret.ref) shown.ref = secret.ref;
    return { ...rest, value: shown };
  }

  const server = createServer((request, response) => {
    const expected = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
    if (request.headers.authorization !== expected) return send(response, 401, { error: 'unauthorized' });

    const path = new URL(request.url, 'http://bifrost').pathname.split('/').filter(Boolean).map(decodeURIComponent);
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.method === 'GET' && path.join('/') === 'api/providers') {
        const providers = [...state.providers.keys()].map((name) => ({ name, provider_status: 'active' }));
        return send(response, 200, { providers, total: providers.length });
      }
      const provider = state.providers.get(path[2]);
      if (path[0] !== 'api' || path[1] !== 'providers' || path[3] !== 'keys' || !provider) {
        return send(response, 404, { error: 'not found' });
      }
      if (request.method === 'GET' && path.length === 4) {
        return send(response, 200, { keys: provider.keys.map(redactedKey), total: provider.keys.length });
      }
      if (request.method === 'PUT' && path.length === 5) {
        const index = provider.keys.findIndex((key) => key.id === path[4]);
        if (index === -1) return send(response, 404, { error: 'key not found' });
        const { value, ...rest } = JSON.parse(body);
        const type = value.type ?? (String(value.value).startsWith('env.') ? 'env' : 'plain_text');
        const secret = type === 'env' ? { ref: value.value, type } : { value: value.value, type };
        provider.keys[index] = { ...rest, id: path[4], secret };
        state.keyUpdates += 1;
        return send(response, 200, redactedKey(provider.keys[index]));
      }
      return send(response, 405, { error: 'method not allowed' });
    });
  });

  return {
    state,
    server,
    addProvider(name, keys) {
      state.providers.set(name, { keys });
    },
    storedSecret(providerName, keyId) {
      return state.providers.get(providerName).keys.find((key) => key.id === keyId);
    },
  };
}

const OPENAI_KEY = 'sk-openai-real-secret-value-1234';
const ANTHROPIC_KEY = 'sk-ant-real-secret-value-5678';

describe('storeProviderKeys', () => {
  const bifrost = createFakeBifrost();
  let bifrostUrl;

  before(async () => {
    await new Promise((resolve) => bifrost.server.listen(0, '127.0.0.1', resolve));
    bifrostUrl = `http://127.0.0.1:${bifrost.server.address().port}`;
  });

  after(() => bifrost.server.close());

  beforeEach(() => {
    bifrost.state.providers.clear();
    bifrost.state.keyUpdates = 0;
    bifrost.state.environment = { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY };
    bifrost.addProvider('openai', [
      {
        id: 'openai-primary',
        name: 'openai-primary',
        secret: { ref: 'env.OPENAI_API_KEY', type: 'env' },
        weight: 1,
        models: ['*'],
        enabled: true,
      },
    ]);
    bifrost.addProvider('anthropic', [
      {
        id: 'anthropic-primary',
        name: 'anthropic-primary',
        secret: { ref: 'env.ANTHROPIC_API_KEY', type: 'env' },
        weight: 1,
        models: ['*'],
        enabled: true,
      },
    ]);
  });

  const run = (environment = { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY }) =>
    storeProviderKeys({ bifrostUrl, username: USERNAME, password: PASSWORD, environment });

  test('stores each env key reference as a plain_text value, keeping the rest of the key', async () => {
    const result = await run();

    assert.deepEqual(result.stored.toSorted(), ['anthropic/anthropic-primary', 'openai/openai-primary']);
    assert.deepEqual(bifrost.storedSecret('openai', 'openai-primary'), {
      id: 'openai-primary',
      name: 'openai-primary',
      secret: { value: OPENAI_KEY, type: 'plain_text' },
      weight: 1,
      models: ['*'],
      enabled: true,
    });
    assert.deepEqual(bifrost.storedSecret('anthropic', 'anthropic-primary').secret, {
      value: ANTHROPIC_KEY,
      type: 'plain_text',
    });
  });

  test('a second run changes nothing', async () => {
    await run();
    const updatesAfterFirstRun = bifrost.state.keyUpdates;

    const result = await run();

    assert.equal(bifrost.state.keyUpdates, updatesAfterFirstRun);
    assert.deepEqual(result.stored, []);
    assert.deepEqual(result.alreadyStored.toSorted(), ['anthropic/anthropic-primary', 'openai/openai-primary']);
    assert.deepEqual(bifrost.storedSecret('openai', 'openai-primary').secret, {
      value: OPENAI_KEY,
      type: 'plain_text',
    });
  });

  test('leaves keys created through the API untouched', async () => {
    bifrost.addProvider('t1a2b3c4-kimi', [
      {
        id: 'kimi-k1',
        name: 't1a2b3c4-kimi-k1',
        secret: { value: 'sk-kimi-tenant-key-0000', type: 'plain_text' },
        weight: 1,
        models: ['kimi-k2'],
        enabled: true,
      },
    ]);

    const result = await run();

    assert.ok(result.alreadyStored.includes('t1a2b3c4-kimi/t1a2b3c4-kimi-k1'));
    assert.deepEqual(bifrost.storedSecret('t1a2b3c4-kimi', 'kimi-k1').secret, {
      value: 'sk-kimi-tenant-key-0000',
      type: 'plain_text',
    });
  });

  test('skips a reference whose variable is empty, since there is no key to store', async () => {
    const result = await run({ OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: '' });

    assert.deepEqual(result.stored, ['openai/openai-primary']);
    assert.deepEqual(result.empty, ['anthropic/anthropic-primary']);
    assert.deepEqual(bifrost.storedSecret('anthropic', 'anthropic-primary').secret, {
      ref: 'env.ANTHROPIC_API_KEY',
      type: 'env',
    });
  });

  test('refuses to run when a referenced variable is not provided at all', async () => {
    await assert.rejects(run({ OPENAI_API_KEY: OPENAI_KEY }), /ANTHROPIC_API_KEY/);

    assert.equal(bifrost.state.keyUpdates, 0);
  });

  test('fails on wrong admin credentials', async () => {
    await assert.rejects(
      storeProviderKeys({ bifrostUrl, username: USERNAME, password: 'wrong', environment: {} }),
      /401/
    );
  });
});
