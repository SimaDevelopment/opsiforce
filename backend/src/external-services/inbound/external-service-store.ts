import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import type { Database } from 'sqlite';
import {
  environmentDatabasePath,
  openEnvironmentDatabase,
  type SqlitePragmaProfile,
} from '../../common/environment-database';
import type { JsonValue } from '../../common/json';

const EXTERNAL_SERVICES_DATABASE_FILE = 'external-services.db';

const EXTERNAL_SERVICES_PRAGMAS: SqlitePragmaProfile = {
  journalMode: 'TRUNCATE',
  busyTimeoutMs: 5000,
  synchronous: 'FULL',
};

const LEGACY_MESSAGES_MARK = 'legacy-messages';

interface LegacyAttachment {
  filename: string | null;
  contentType: string | null;
  sizeBytes: number;
  content: Buffer | null;
}

export interface LegacyMessage {
  providerMessageId: string;
  rawPayload: string;
  routingKey: string;
  sender: string | null;
  textBody: string | null;
  payload: JsonValue;
  attachments: LegacyAttachment[];
}

export type LegacyMessageOf = (event: EventToStore) => LegacyMessage;

const STORE_MIGRATIONS = [
  `CREATE TABLE messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     service TEXT NOT NULL,
     received_at TEXT NOT NULL,
     raw_payload TEXT NOT NULL,
     app_delivered_at TEXT,
     provider_message_id TEXT NOT NULL,
     routing_key TEXT NOT NULL,
     sender TEXT,
     text_body TEXT,
     payload TEXT NOT NULL
   );
   CREATE UNIQUE INDEX messages_service_provider_message_id
     ON messages (service, provider_message_id);
   CREATE TABLE attachments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
     filename TEXT,
     content_type TEXT,
     size_bytes INTEGER NOT NULL,
     content BLOB
   );`,
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     service TEXT NOT NULL,
     type TEXT NOT NULL,
     key TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     received_at TEXT NOT NULL,
     data TEXT NOT NULL CHECK (json_valid(data)),
     app_delivered_at TEXT,
     UNIQUE (service, type, key)
   );
   CREATE INDEX events_undelivered ON events (service, id) WHERE app_delivered_at IS NULL;
   CREATE TABLE event_files (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     mime_type TEXT NOT NULL,
     size_bytes INTEGER NOT NULL,
     path TEXT NOT NULL
   );
   CREATE INDEX event_files_event_id ON event_files (event_id);`,
  `CREATE TABLE store_marks (name TEXT PRIMARY KEY, marked_at TEXT NOT NULL);
   INSERT INTO store_marks (name, marked_at)
     SELECT '${LEGACY_MESSAGES_MARK}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE EXISTS (SELECT 1 FROM messages);`,
] as const;

const EVENT_FILES_DIRECTORY = 'external-services/files';

const POD_WORKSPACE = '/workspace';

interface EventFileToStore {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface StoredEvent {
  id: number;
  type: string;
  key: string;
  occurredAt: string;
  receivedAt: string;
  data: unknown;
  appDeliveredAt: string | null;
  files: number;
}

interface StoredEventRow {
  id: number;
  type: string;
  key: string;
  occurred_at: string;
  received_at: string;
  data: string;
  app_delivered_at: string | null;
  files: number;
}

export interface EventToStore {
  type: string;
  key: string;
  occurredAt: string;
  data: Record<string, unknown>;
  files: EventFileToStore[];
}

const INSERT_EVENT = `INSERT OR IGNORE INTO events (service, type, key, occurred_at, received_at, data)
   VALUES (?, ?, ?, ?, ?, ?)`;

const INSERT_EVENT_FILE = `INSERT INTO event_files (event_id, name, mime_type, size_bytes, path)
   VALUES (?, ?, ?, ?, ?)`;

function safeFileName(name: string, taken: Set<string>): string {
  const cleaned = name.replace(/[/\\\p{Cc}]/gu, '_').trim();
  const base = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
  let candidate = base;
  for (let copy = 2; taken.has(candidate); copy++) {
    const dot = base.lastIndexOf('.');
    candidate = dot > 0 ? `${base.slice(0, dot)}-${copy}${base.slice(dot)}` : `${base}-${copy}`;
  }
  taken.add(candidate);
  return candidate;
}

const INSERT_MESSAGE = `INSERT OR IGNORE INTO messages
   (service, received_at, raw_payload, provider_message_id, routing_key, sender, text_body, payload)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_ATTACHMENT = `INSERT INTO attachments (message_id, filename, content_type, size_bytes, content)
   VALUES (?, ?, ?, ?, ?)`;

@Injectable()
export class ExternalServiceStore {
  private readonly logger = new Logger(ExternalServiceStore.name);

  async storeEvents(
    envDirectory: string,
    service: string,
    events: readonly EventToStore[],
    legacyMessageOf?: LegacyMessageOf
  ): Promise<number[]> {
    const fileDirectories: string[] = [];
    return withDatabase(envDirectory, { forWriting: true }, async (connection) => {
      await connection.exec('BEGIN IMMEDIATE');
      try {
        await this.applyMigrations(connection);
        const writesMessages = legacyMessageOf !== undefined && (await isMarkedLegacy(connection));
        const receivedAt = new Date().toISOString();
        const eventIds: number[] = [];
        for (const event of events) {
          const eventId = await insertEvent(connection, { envDirectory, service, event, receivedAt, fileDirectories });
          if (eventId === null) {
            this.logger.log(`Duplicate ${service} ${event.type} Event ${event.key} ignored`);
            continue;
          }
          eventIds.push(eventId);
          if (writesMessages) await this.insertLegacyMessage(connection, service, legacyMessageOf(event));
        }
        await connection.exec('COMMIT');
        return eventIds;
      } catch (err) {
        await connection.exec('ROLLBACK').catch(() => {});
        await Promise.all(fileDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
        throw err;
      }
    });
  }

  async markDelivered(envDirectory: string, rowIds: number[]): Promise<void> {
    if (rowIds.length === 0) return;

    await withDatabase(envDirectory, {}, async (connection) => {
      await connection.run(
        `UPDATE messages SET app_delivered_at = ? WHERE id IN (${placeholders(rowIds.length)})`,
        new Date().toISOString(),
        ...rowIds
      );
    });
  }

  async undeliveredEventIds(envDirectory: string, service: string, limit: number): Promise<number[]> {
    return withDatabase(envDirectory, { whenMissing: [] }, async (connection) => {
      if (!(await hasTable(connection, 'events'))) return [];
      const rows = await connection.all<{ id: number }[]>(
        'SELECT id FROM events WHERE service = ? AND app_delivered_at IS NULL ORDER BY id LIMIT ?',
        service,
        limit
      );
      return rows.map((row) => row.id);
    });
  }

  async recentEvents(envDirectory: string, service: string, limit: number): Promise<StoredEvent[]> {
    return withDatabase(envDirectory, { whenMissing: [] }, async (connection) => {
      if (!(await hasTable(connection, 'events'))) return [];
      const rows = await connection.all<StoredEventRow[]>(
        `SELECT id, type, key, occurred_at, received_at, data, app_delivered_at,
           (SELECT count(*) FROM event_files WHERE event_files.event_id = events.id) AS files
         FROM events WHERE service = ? ORDER BY id DESC LIMIT ?`,
        service,
        limit
      );
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        key: row.key,
        occurredAt: row.occurred_at,
        receivedAt: row.received_at,
        data: JSON.parse(row.data) as unknown,
        appDeliveredAt: row.app_delivered_at,
        files: row.files,
      }));
    });
  }

  async markEventsDelivered(envDirectory: string, eventIds: readonly number[]): Promise<void> {
    if (eventIds.length === 0) return;
    await withDatabase(envDirectory, {}, async (connection) => {
      await connection.run(
        `UPDATE events SET app_delivered_at = ? WHERE app_delivered_at IS NULL AND id IN (${placeholders(eventIds.length)})`,
        new Date().toISOString(),
        ...eventIds
      );
    });
  }

  async undeliveredLegacyRowIds(envDirectory: string, service: string, limit: number): Promise<number[] | null> {
    return withDatabase<number[] | null>(envDirectory, { whenMissing: null }, async (connection) => {
      if (!(await isMarkedLegacy(connection))) return null;
      const rows = await connection.all<{ id: number }[]>(
        'SELECT id FROM messages WHERE service = ? AND app_delivered_at IS NULL ORDER BY id LIMIT ?',
        service,
        limit
      );
      return rows.map((row) => row.id);
    });
  }

  private async insertLegacyMessage(connection: Database, service: string, message: LegacyMessage): Promise<void> {
    const messageId = await this.insertMessage(connection, service, message);
    if (messageId === null) {
      this.logger.log(`Duplicate ${service} message ${message.providerMessageId} ignored`);
      return;
    }
    await insertAttachments(connection, messageId, message);
  }

  private async applyMigrations(connection: Database): Promise<void> {
    const row = await connection.get<{ user_version: number }>('PRAGMA user_version');
    const appliedVersion = row?.user_version ?? 0;
    if (appliedVersion >= STORE_MIGRATIONS.length) return;

    for (let version = appliedVersion; version < STORE_MIGRATIONS.length; version++) {
      await connection.exec(STORE_MIGRATIONS[version]);
    }
    await connection.exec(`PRAGMA user_version = ${STORE_MIGRATIONS.length}`);

    this.logger.log(`Applied external-services schema migrations ${appliedVersion + 1}..${STORE_MIGRATIONS.length}`);
  }

  private async insertMessage(
    connection: Database,
    serviceName: string,
    message: LegacyMessage
  ): Promise<number | null> {
    const result = await connection.run(
      INSERT_MESSAGE,
      serviceName,
      new Date().toISOString(),
      message.rawPayload,
      message.providerMessageId,
      message.routingKey,
      message.sender,
      message.textBody,
      JSON.stringify(message.payload)
    );

    if (!result.changes || result.lastID === undefined) return null;
    return result.lastID;
  }
}

interface DatabaseOpening<T> {
  forWriting?: boolean;
  whenMissing?: T;
}

async function withDatabase<T>(
  envDirectory: string,
  opening: DatabaseOpening<T>,
  use: (connection: Database) => Promise<T>
): Promise<T> {
  const databasePath = environmentDatabasePath(envDirectory, EXTERNAL_SERVICES_DATABASE_FILE);
  if (Object.hasOwn(opening, 'whenMissing') && !existsSync(databasePath)) return opening.whenMissing as T;
  if (opening.forWriting) await mkdir(path.dirname(databasePath), { recursive: true });

  const connection = await openEnvironmentDatabase(
    envDirectory,
    EXTERNAL_SERVICES_DATABASE_FILE,
    EXTERNAL_SERVICES_PRAGMAS
  );
  try {
    return await use(connection);
  } finally {
    await connection.close().catch(() => {});
  }
}

async function hasTable(connection: Database, name: string): Promise<boolean> {
  return (await connection.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name)) !== undefined;
}

async function isMarkedLegacy(connection: Database): Promise<boolean> {
  if (!(await hasTable(connection, 'store_marks'))) return false;
  return (await connection.get('SELECT 1 FROM store_marks WHERE name = ?', LEGACY_MESSAGES_MARK)) !== undefined;
}

async function insertAttachments(connection: Database, messageId: number, message: LegacyMessage): Promise<void> {
  for (const attachment of message.attachments) {
    await connection.run(
      INSERT_ATTACHMENT,
      messageId,
      attachment.filename,
      attachment.contentType,
      attachment.sizeBytes,
      attachment.content
    );
  }
}

interface EventInsert {
  envDirectory: string;
  service: string;
  event: EventToStore;
  receivedAt: string;
  fileDirectories: string[];
}

async function insertEvent(connection: Database, insert: EventInsert): Promise<number | null> {
  const { event } = insert;
  const result = await connection.run(
    INSERT_EVENT,
    insert.service,
    event.type,
    event.key,
    event.occurredAt,
    insert.receivedAt,
    JSON.stringify(event.data)
  );
  if (!result.changes || result.lastID === undefined) return null;
  const eventId = result.lastID;
  if (event.files.length === 0) return eventId;

  const relativeDirectory = `${EVENT_FILES_DIRECTORY}/${eventId}`;
  const directory = environmentDatabasePath(insert.envDirectory, relativeDirectory);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  insert.fileDirectories.push(directory);
  const taken = new Set<string>();
  for (const file of event.files) {
    const name = safeFileName(file.name, taken);
    await writeFile(path.join(directory, name), file.bytes);
    await connection.run(
      INSERT_EVENT_FILE,
      eventId,
      name,
      file.mimeType,
      file.bytes.byteLength,
      `${POD_WORKSPACE}/data/${relativeDirectory}/${name}`
    );
  }
  return eventId;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
