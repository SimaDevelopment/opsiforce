// Runs inside the deployed backend so routing and credentials match the image.
// Only project-generated keys are updated; tokens and top-level budgets are kept.
async function syncProviderRouting(request, configs) {
  let offset = 0;
  let updated = 0;
  const limit = 100;
  const keys = [];
  while (true) {
    const page = await request('GET', `/api/governance/virtual-keys?limit=${limit}&offset=${offset}`);
    if (!Array.isArray(page.virtual_keys) || !Number.isInteger(page.total_count)) {
      throw new Error('Unexpected Bifrost virtual-key list response');
    }
    keys.push(...page.virtual_keys);
    offset += page.virtual_keys.length;
    if (offset >= page.total_count) break;
    if (page.virtual_keys.length === 0) throw new Error('Bifrost returned an empty page before total_count');
  }
  // Snapshot all pages before updates, which may change server-side ordering.
  for (const key of keys) {
      const match = /^project-[a-f0-9]{8}-(chat|backend)$/.exec(key.name);
      if (!match) continue;
      const desired = configs[match[1]].map(({ provider, weight }) => {
        const existing = key.provider_configs?.find((config) => config.provider === provider);
        return {
          provider,
          weight,
          allowed_models: existing?.allowed_models ?? ['*'],
          key_ids: !existing || existing.allow_all_keys ? ['*'] : (existing.keys ?? []).map((item) => item.id),
          ...(existing?.blacklisted_models ? { blacklisted_models: existing.blacklisted_models } : {}),
          ...(existing?.budget_id ? { budget_id: existing.budget_id } : {}),
          ...(existing?.rate_limit_id ? { rate_limit_id: existing.rate_limit_id } : {}),
        };
      });
      const current = key.provider_configs ?? [];
      if (current.length === desired.length && desired.every((target) =>
        current.some((config) => config.provider === target.provider && config.weight === target.weight))) continue;
      await request('PUT', `/api/governance/virtual-keys/${encodeURIComponent(key.id)}`, { provider_configs: desired });
      updated++;
  }
  return updated;
}

async function main() {
  const { BIFROST_PROVIDER_CONFIGS } = require(`${process.cwd()}/dist/src/bifrost/bifrost.providers.js`);
  const primary = process.env.BIFROST_UPSTREAM_PROVIDER;
  const fallback = process.env.BIFROST_FALLBACK_PROVIDER;
  if (!primary || !fallback || !['chat', 'backend'].every((type) =>
    BIFROST_PROVIDER_CONFIGS[type].some((p) => p.provider === primary && p.weight === 1) &&
    BIFROST_PROVIDER_CONFIGS[type].some((p) => p.provider === fallback && p.weight === 0))) {
    throw new Error('Deployed backend must support primary/fallback routing; build the updated image first');
  }
  const { BIFROST_ADMIN_USERNAME: username, BIFROST_ADMIN_PASSWORD: password, BIFROST_PROXY_URL: proxyUrl } = process.env;
  if (!username || !password || !proxyUrl) throw new Error('Missing Bifrost connection settings');
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const request = async (method, path, body) => {
    const response = await fetch(`${proxyUrl.replace(/\/v1\/?$/, '')}${path}`, {
      method,
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Bifrost ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
  console.log(`Updated provider routing for ${await syncProviderRouting(request, BIFROST_PROVIDER_CONFIGS)} project keys`);
}

module.exports = { syncProviderRouting };
if (require.main === module || module.id === '[stdin]') {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
