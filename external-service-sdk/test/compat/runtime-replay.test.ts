import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formCallResultSchemas } from '@opsiforce/external-service-sdk/server';

interface WireGolden {
  service: string;
  route: 'operations' | 'options' | 'info' | 'buttons' | 'hooks' | 'inbound';
  name?: string;
  body: unknown;
}

interface FrozenAnswer {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface FrozenRuntime {
  manifestHash: string;
  health(): { sdk: number; sdkVersion: string };
  dispatch(request: { route: string; name?: string; body: unknown }): Promise<FrozenAnswer>;
}

interface FrozenServer {
  computeManifestHash(manifest: unknown): string;
  createServiceRuntime(options: {
    manifest: unknown;
    handlers: Record<string, unknown>;
    origin: 'built_in' | 'custom';
    log: (line: string) => void;
  }): FrozenRuntime;
}

type FormField = Record<string, unknown> & { type: string; fields?: FormField[]; item?: FormField[] };

const compatFolder = dirname(fileURLToPath(import.meta.url));
const wireFolder = join(compatFolder, 'wire');
const frozenRuntimes = readdirSync(compatFolder, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('runtime-'))
  .map((entry) => entry.name);

function readJson<Value>(path: string): Value {
  return JSON.parse(readFileSync(path, 'utf8')) as Value;
}

function eachField(fields: FormField[] | undefined, visit: (field: FormField) => void): void {
  for (const field of fields ?? []) {
    visit(field);
    eachField(field.fields, visit);
    eachField(field.item, visit);
  }
}

function named(names: Iterable<string>, answer: () => unknown): Record<string, () => unknown> {
  return Object.fromEntries([...names].map((name) => [name, answer]));
}

function stubHandlers(manifest: Record<string, unknown>, manifestHash: string): Record<string, unknown> {
  const calls = { options: new Set<string>(), info: new Set<string>(), buttons: new Set<string>() };
  for (const form of [manifest.serviceForm, manifest.projectForm] as (FormField[] | undefined)[]) {
    eachField(form, (field) => {
      const options = field.options as { call?: string } | undefined;
      if (options && !Array.isArray(options) && typeof options.call === 'string') calls.options.add(options.call);
      if (field.type === 'info' && typeof field.call === 'string') calls.info.add(field.call);
      if (field.type === 'button' && typeof field.call === 'string') calls.buttons.add(field.call);
    });
  }
  return {
    manifestHash,
    operations: named(Object.keys((manifest.operations as object | undefined) ?? {}), () => ({ ok: true })),
    options: named(calls.options, () => [{ value: 'v1', label: 'First' }]),
    info: named(calls.info, () => ({ text: 'Fine', level: 'info' })),
    buttons: named(calls.buttons, () => ({ message: 'Done' })),
    hooks: { onServiceConfigurationSaved: () => {}, onProjectConfigurationSaved: () => {} },
    ...(manifest.inbound === true ? { inbound: () => ({ events: [] }) } : {}),
  };
}

function parsedAnswer(golden: WireGolden, answer: FrozenAnswer): unknown {
  if (golden.route === 'hooks') return assert.equal(answer.body.byteLength, 0);
  const json: unknown = JSON.parse(new TextDecoder().decode(answer.body));
  if (golden.route === 'options' || golden.route === 'info' || golden.route === 'buttons') {
    return formCallResultSchemas[golden.route].parse(json);
  }
  if (golden.route === 'inbound') assert.ok(Array.isArray((json as { events?: unknown }).events));
  return json;
}

const goldens = readdirSync(wireFolder)
  .filter((file) => file.endsWith('.json'))
  .toSorted()
  .map((file) => ({ file, golden: readJson<WireGolden>(join(wireFolder, file)) }));

test('there is a wire golden for every /_service route', () => {
  assert.deepEqual(goldens.map(({ golden }) => golden.route).toSorted(), [
    'buttons',
    'hooks',
    'inbound',
    'info',
    'operations',
    'options',
  ]);
});

for (const runtimeFolder of frozenRuntimes) {
  for (const { file, golden } of goldens) {
    test(`the frozen ${runtimeFolder} answers today's ${file} request`, async () => {
      const frozen = (await import(
        pathToFileURL(join(compatFolder, runtimeFolder, 'dist', 'server.js')).href
      )) as FrozenServer;
      const manifest = readJson<Record<string, unknown>>(
        join(compatFolder, 'manifests', `built-in.backend-${golden.service}.json`)
      );
      const manifestHash = frozen.computeManifestHash(manifest);
      const runtime = frozen.createServiceRuntime({
        manifest,
        handlers: stubHandlers(manifest, manifestHash),
        origin: 'built_in',
        log: () => {},
      });

      const answer = await runtime.dispatch({ route: golden.route, name: golden.name, body: golden.body });

      assert.ok([200, 204].includes(answer.status), new TextDecoder().decode(answer.body));
      assert.equal(answer.headers['x-opsiforce-manifest'], manifestHash);
      parsedAnswer(golden, answer);
      assert.equal(runtime.health().sdkVersion, runtimeFolder.slice('runtime-'.length));
    });
  }
}
