const assert = require('node:assert/strict');
const { test } = require('node:test');
const { syncProviderRouting } = require('./sync-bifrost-provider-routing.cjs');

const providers = [{ provider: 'custom-openai-1', weight: 1 }, { provider: 'azure', weight: 0 }];
const configs = { chat: providers, backend: providers };

test('migrates paginated project keys, preserves restrictions, and leaves unrelated keys alone', async () => {
  const updates = [];
  const requests = [];
  const pages = [
    { total_count: 3, virtual_keys: [
      { id: 'chat', name: 'project-1234abcd-chat', provider_configs: [{
        provider: 'azure', weight: 1, allowed_models: ['gpt-5.6-sol'],
        allow_all_keys: false, keys: [{ id: 'restricted-key' }], blacklisted_models: ['blocked-model'],
        budget_id: 'budget', rate_limit_id: 'rate-limit',
      }] },
      { id: 'manual', name: 'manual-key', provider_configs: [] },
    ] },
    { total_count: 3, virtual_keys: [
      { id: 'backend', name: 'project-1234abcd-backend', provider_configs: [{
        provider: 'azure', weight: 1, allowed_models: ['*'], allow_all_keys: true, keys: [],
      }] },
    ] },
  ];
  const updated = await syncProviderRouting(async (method, path, body) => {
    requests.push({ method, path });
    if (method === 'GET') return pages.shift();
    updates.push(body);
    return {};
  }, configs);
  assert.equal(updated, 2);
  assert.equal(requests[1].path, '/api/governance/virtual-keys?limit=100&offset=2');
  assert.deepEqual(updates[0], { provider_configs: [
    { provider: 'custom-openai-1', weight: 1, allowed_models: ['*'], key_ids: ['*'] },
    { provider: 'azure', weight: 0, allowed_models: ['gpt-5.6-sol'], key_ids: ['restricted-key'],
      blacklisted_models: ['blocked-model'], budget_id: 'budget', rate_limit_id: 'rate-limit' },
  ] });
  assert.deepEqual(updates[1].provider_configs[1].key_ids, ['*']);
  assert(!requests.some((r) => r.path.endsWith('/manual')));
});

test('already-configured project keys are not rewritten', async () => {
  const updated = await syncProviderRouting(async (method) => {
    assert.equal(method, 'GET');
    return { total_count: 1, virtual_keys: [{ id: 'same', name: 'project-1234abcd-chat', provider_configs: providers }] };
  }, configs);
  assert.equal(updated, 0);
});

test('does not loop or silently succeed on incomplete pagination', async () => {
  await assert.rejects(syncProviderRouting(async () => ({ total_count: 1, virtual_keys: [] }), configs), /empty page/);
  await assert.rejects(syncProviderRouting(async () => ({}), configs), /Unexpected/);
});

test('propagates update failures so the deployment cannot report success', async () => {
  await assert.rejects(syncProviderRouting(async (method) => {
    if (method === 'PUT') throw new Error('HTTP 500');
    return { total_count: 1, virtual_keys: [{ id: 'key', name: 'project-1234abcd-chat', provider_configs: [] }] };
  }, configs), /HTTP 500/);
});
