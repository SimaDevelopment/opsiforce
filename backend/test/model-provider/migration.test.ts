import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterEach, describe, expect, inject, it } from 'vitest';

const MIGRATIONS_FOLDER = './db/migrations';
const FIRST_MODEL_PROVIDERS_MIGRATION = 74;

interface JournalEntry {
  idx: number;
}

interface Journal {
  entries: JournalEntry[];
}

interface ProviderRow {
  tenant_id: string | null;
  bifrost_provider: string;
  chat_enabled: boolean;
  chat_weight: number;
}

function maintenanceUrl(): string {
  const url = new URL(inject('databaseUrl'));
  url.pathname = '/postgres';
  return url.toString();
}

async function migrateTo(client: postgres.Sql, migrationsFolder: string): Promise<void> {
  await migrate(drizzle(client), { migrationsFolder, migrationsSchema: 'public' });
}

async function providerRows(client: postgres.Sql): Promise<ProviderRow[]> {
  return [
    ...(await client<ProviderRow[]>`
      SELECT tenant_id, bifrost_provider, chat_enabled, chat_weight FROM model_providers ORDER BY tenant_id NULLS FIRST, bifrost_provider`),
  ];
}

describe('the model providers migration', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function emptyDatabase(): Promise<postgres.Sql> {
    const name = `opsiforce_migration_${randomUUID().replaceAll('-', '')}`;
    const maintenance = postgres(maintenanceUrl(), { max: 1, onnotice: () => {} });
    await maintenance.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(inject('databaseUrl'));
    url.pathname = `/${name}`;
    const client = postgres(url.toString(), { max: 1, onnotice: () => {} });
    cleanups.push(async () => {
      await client.end();
      await maintenance.unsafe(`DROP DATABASE "${name}"`);
      await maintenance.end();
    });
    return client;
  }

  async function migrationsBefore(idx: number): Promise<string> {
    const folder = await mkdtemp(path.join(tmpdir(), 'opsiforce-migrations-'));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = path.join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
    await writeFile(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < idx) })
    );
    return folder;
  }

  it('leaves a fresh install without platform providers, so the boot seed creates them from env', async () => {
    const client = await emptyDatabase();

    await migrateTo(client, MIGRATIONS_FOLDER);

    expect(await providerRows(client)).toEqual([]);
  });

  it('cuts an existing deployment over to the providers Helm declares, as platform rows only', async () => {
    const client = await emptyDatabase();
    await migrateTo(client, await migrationsBefore(FIRST_MODEL_PROVIDERS_MIGRATION));
    await client`INSERT INTO tenants (id, name, display_name) VALUES ('t-acme', 'acme', 'Acme'), ('t-globex', 'globex', 'Globex')`;

    await migrateTo(client, MIGRATIONS_FOLDER);

    expect(await providerRows(client)).toEqual([
      { tenant_id: null, bifrost_provider: 'anthropic', chat_enabled: true, chat_weight: 1 },
      { tenant_id: null, bifrost_provider: 'custom-openai-1', chat_enabled: true, chat_weight: 1 },
      { tenant_id: null, bifrost_provider: 'openai', chat_enabled: true, chat_weight: 0 },
    ]);
  });
});
