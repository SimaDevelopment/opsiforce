import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAgentImage } from './images.mjs';

const NAMESPACE = 'local';
const RELEASE = 'opsiforce-bifrost';
const PROVIDER_KEYS_SECRET = 'opsiforce-bifrost-provider-keys';

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const DEFAULT_MODEL_ID = 'gpt-6.1-sol';

function ensureCluster(ctx) {
  const host = ctx.tryCapture('minikube', ['status', '-f', '{{.Host}}']);
  if (host === 'Running') return;
  if (host === 'Stopped') {
    throw new Error('minikube is stopped. Resume it with `minikube start`, then re-run `yarn dev`.');
  }
  throw new Error('minikube is not running — the LLM step needs a live cluster. Run `yarn dev --reset` then `yarn dev`.');
}

function printChoiceCopy(ctx) {
  const { bold, dim, cyan } = ctx.c;
  ctx.print(bold('Connect an LLM for the app-builder agent.'));
  ctx.print('');
  ctx.print(`${cyan('1)')} ${bold('ChatGPT / Codex subscription')}  ${dim('(recommended, default)')}`);
  ctx.print(dim('   Drives a ChatGPT subscription you already pay for — no extra API charges.'));
  ctx.print(dim('   Sign in once on Settings → Model providers; Opsiforce keeps the sign-in refreshed.'));
  ctx.print(dim('   Rides an unofficial OpenAI endpoint that can change without notice (see ADR-0018).'));
  ctx.print('');
  ctx.print(`${cyan('2)')} ${bold('Your OpenAI API key')}`);
  ctx.print(dim('   Uses a key you provide; OpenAI bills your account per token of usage.'));
  ctx.print(dim('   Always available and fully supported — you pay OpenAI directly.'));
  ctx.print('');
}

async function chooseProvider(ctx) {
  const prior = ctx.config.llm?.provider;
  if (prior) return prior;

  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  if (ctx.flags?.yes || !process.stdin.isTTY) return hasKey ? 'key' : 'subscription';

  printChoiceCopy(ctx);
  const answer = (await ctx.ask('  Choose [1]: ', { defaultValue: '1' })).trim().toLowerCase();
  if (answer === '2' || answer === 'key' || answer === 'openai') return 'key';
  return 'subscription';
}

function askSecret(promptText) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(promptText);
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Aborted.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function promptOpenAiKey(ctx) {
  const fromEnv = process.env.OPENAI_API_KEY?.trim();
  if (fromEnv) {
    ctx.note('using the OpenAI API key from $OPENAI_API_KEY.');
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    throw new Error('The OpenAI key path needs a key — set $OPENAI_API_KEY or run `yarn dev` interactively.');
  }
  const key = (await askSecret('  Paste your OpenAI API key (sk-…, hidden): ')).trim();
  if (!key) {
    throw new Error('No OpenAI API key entered. Re-run `yarn dev` and paste a key, or choose the subscription path.');
  }
  if (!key.startsWith('sk-')) ctx.warn("That doesn't look like an OpenAI key (expected sk-…); continuing anyway.");
  return key;
}

function parseModelIds(payload) {
  const data = payload?.data;
  if (!Array.isArray(data)) return null;
  const ids = data.map((entry) => entry?.id).filter((id) => typeof id === 'string');
  return ids.length > 0 ? ids : null;
}

async function queryOpenAiModels(apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return parseModelIds(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function agentsJsonPath(ctx) {
  return join(ctx.paths.packageRoot, 'agent-config', 'agents.json');
}

function opencodeConfigPath(ctx) {
  return join(ctx.paths.packageRoot, 'agent-config', 'opencode.local.json');
}

function modelCatalogPath(ctx) {
  return join(ctx.paths.packageRoot, 'agent-config', 'models.json');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function defaultAgentName(agents) {
  const names = Object.keys(agents ?? {});
  return names.find((name) => agents[name]?.default === true) ?? names[0];
}

function currentModelId(ctx) {
  const config = readJson(agentsJsonPath(ctx));
  const name = defaultAgentName(config.agents);
  const model = name ? config.agents[name]?.model : undefined;
  const id = typeof model === 'string' ? model.split('/').pop() : undefined;
  return id ?? DEFAULT_MODEL_ID;
}

function openAiWhitelist(ctx) {
  try {
    const models = readJson(opencodeConfigPath(ctx)).providers?.openai?.models;
    return models && typeof models === 'object' ? Object.keys(models) : [];
  } catch {
    return [];
  }
}

function setAgentModel(ctx, modelId) {
  const target = `openai/${modelId}`;

  const agents = readJson(agentsJsonPath(ctx));
  const name = defaultAgentName(agents.agents);
  if (name) agents.agents[name].model = target;
  writeJson(agentsJsonPath(ctx), agents);

  const opencode = readJson(opencodeConfigPath(ctx));
  opencode.model = target;
  const models = opencode.providers?.openai?.models;
  if (models && typeof models === 'object' && !(modelId in models)) models[modelId] = {};
  writeJson(opencodeConfigPath(ctx), opencode);

  const catalog = readJson(modelCatalogPath(ctx));
  const catalogModels = catalog.openai?.models;
  if (catalogModels && typeof catalogModels === 'object' && !(modelId in catalogModels)) {
    const { experimental, ...template } = catalogModels[DEFAULT_MODEL_ID] ?? Object.values(catalogModels)[0] ?? {};
    catalogModels[modelId] = {
      ...template,
      id: modelId,
      name: modelId,
      family: modelId,
      release_date: new Date().toISOString().slice(0, 10),
    };
    writeJson(modelCatalogPath(ctx), catalog);
  }
}

async function ensureUsableModel(ctx, availableIds) {
  const current = currentModelId(ctx);
  if (availableIds === null) {
    ctx.warn(`Could not query the provider's models; keeping the default (${current}).`);
    return;
  }
  if (availableIds.includes(current)) {
    ctx.note(`verified the agent's default model (${current}) is available.`);
    return;
  }

  ctx.warn(`The chosen provider does not serve ${current}; selecting an available model…`);
  const whitelist = openAiWhitelist(ctx);
  const preferred = whitelist.filter((model) => availableIds.includes(model));
  const pool = preferred.length > 0 ? preferred : availableIds;
  const suggested = pool[0];

  ctx.print(`  Available: ${pool.slice(0, 12).join(', ')}${pool.length > 12 ? ', …' : ''}`);
  const answer = (await ctx.ask(`  Model to use [${suggested}]: `, { defaultValue: suggested })).trim();
  const chosen = availableIds.includes(answer) ? answer : suggested;
  const wasBaked = whitelist.includes(chosen);

  setAgentModel(ctx, chosen);
  ctx.note(`agent default model set to openai/${chosen}.`);
  if (!wasBaked) {
    ctx.note(`${chosen} is not in the prebuilt agent image — rebuilding the agent image so new agents can use it…`);
    try {
      buildAgentImage(ctx, { force: true });
      ctx.note('agent image rebuilt with the selected model.');
    } catch (error) {
      ctx.warn(
        `Could not rebuild the agent image (${error.message}). Run \`yarn dev --reset\` so ${chosen} takes effect.`
      );
    }
  }
}

function ensureGatewayInstalled(ctx) {
  const status = ctx.tryCapture('helm', ['status', RELEASE, '--namespace', NAMESPACE]);
  if (status === null) {
    throw new Error('Bifrost is not installed yet — the gateway step must run first. Re-run `yarn dev`.');
  }
}

function setOpenAiProviderKey(ctx, apiKey) {
  const patch = JSON.stringify({ data: { 'openai-api-key': Buffer.from(apiKey, 'utf8').toString('base64') } });
  ctx.run('kubectl', ['patch', 'secret', PROVIDER_KEYS_SECRET, '--namespace', NAMESPACE, '--type', 'merge', '-p', patch]);
}

function reloadGateway(ctx) {
  const restarted = ctx.tryCapture('kubectl', [
    'rollout',
    'restart',
    `deployment/${RELEASE}`,
    '--namespace',
    NAMESPACE,
  ]);
  if (restarted === null) {
    ctx.warn(
      `Could not restart Bifrost; run \`kubectl rollout restart deployment/${RELEASE} --namespace ${NAMESPACE}\` so its openai provider picks up the key.`
    );
    return;
  }
  ctx.tryCapture('kubectl', ['rollout', 'status', `deployment/${RELEASE}`, '--namespace', NAMESPACE, '--timeout=120s']);
  ctx.note('Bifrost reloaded; its openai provider now carries your key.');
}

function persistOpenAiKey(ctx, apiKey) {
  const envFile = join(ctx.paths.packageRoot, '.env');
  const kept = ctx.exists(envFile)
    ? readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('OPENAI_API_KEY='))
    : [];
  writeFileSync(envFile, `${[...kept, `OPENAI_API_KEY=${apiKey}`].join('\n')}\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);
}

export async function run(ctx) {
  ensureCluster(ctx);

  const provider = await chooseProvider(ctx);
  let apiKey;

  if (provider === 'subscription') {
    ctx.note(
      'the ChatGPT subscription is signed in on Settings → Model providers and served by the in-cluster linked-account proxy.'
    );
  } else {
    apiKey = await promptOpenAiKey(ctx);
    ensureGatewayInstalled(ctx);
    setOpenAiProviderKey(ctx, apiKey);
    persistOpenAiKey(ctx, apiKey);
    reloadGateway(ctx);
    ctx.note('saved the key to .env; the backend adopts the built-in openai model provider on its first boot.');
  }
  ctx.config.llm = { provider };

  if (provider === 'key') await ensureUsableModel(ctx, await queryOpenAiModels(apiKey));

  ctx.note(
    provider === 'subscription'
      ? 'LLM ready once you sign in ChatGPT on the Built-in model providers card at Settings → Model providers.'
      : 'LLM ready — agent requests route through Bifrost to the OpenAI API with your key.'
  );
}
