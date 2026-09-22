import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { workerDatabaseName } from '../setup/workers';

const POSTGRES_IMAGE = 'postgres:16';
const MIGRATIONS_FOLDER = './db/migrations';
const TEMPLATE_CLONE_ATTEMPTS = 20;
const TEMPLATE_CLONE_RETRY_MS = 100;

export interface TestPostgres {
  url: string;
  stop: () => Promise<void>;
}

export async function startTestPostgres(workerCount: number): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('opsiforce')
    .withUsername('opsiforce')
    .withPassword('opsiforce')
    .start();

  const url = container.getConnectionUri();
  await applyMigrations(url);
  await cloneTemplateForWorkers(url, workerCount);

  return {
    url,
    stop: async () => {
      await container.stop();
    },
  };
}

async function applyMigrations(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: 'public' });
  } finally {
    await client.end();
  }
}

async function cloneTemplateForWorkers(templateUrl: string, workerCount: number): Promise<void> {
  const templateName = new URL(templateUrl).pathname.slice(1);
  const maintenanceUrl = new URL(templateUrl);
  maintenanceUrl.pathname = '/postgres';

  const client = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    for (let poolId = 1; poolId <= workerCount; poolId += 1) {
      await createDatabaseFromTemplate(client, workerDatabaseName(poolId), templateName);
    }
  } finally {
    await client.end();
  }
}

async function createDatabaseFromTemplate(client: postgres.Sql, name: string, templateName: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${templateName}"`);
      return;
    } catch (error) {
      const stillInUse = error instanceof Error && error.message.includes('is being accessed by other users');
      if (!stillInUse || attempt >= TEMPLATE_CLONE_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, TEMPLATE_CLONE_RETRY_MS));
    }
  }
}
