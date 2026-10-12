import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, desc, eq } from 'drizzle-orm';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { db } from '../../../db';
import { externalServiceCalls } from '../../../db/schema';
import { gateCaller, saveProjectConfiguration, type CallRow, type GateCallerFixture } from './gate';

export const inboundBuiltInsDir = resolve(__dirname, 'inbound-built-ins');
export const INBOX_SERVICE = 'fixture-inbox';
export const INBOX_SIGNING_KEY = 'inbox-signing-key-1';
export const INBOX_WEBHOOK_PATH = `/api/external-services/webhooks/${INBOX_SERVICE}`;

export interface ProviderEvent {
  type: string;
  key: string;
  occurredAt?: string;
  data: Record<string, unknown>;
  files?: { name: string; mimeType: string; text: string; repeat?: number }[];
  withUploads?: boolean;
}

export interface Upload {
  filename: string;
  mimeType: string;
  text: string;
}

export function providerEvent(event: ProviderEvent): Required<Pick<ProviderEvent, 'occurredAt'>> & ProviderEvent {
  return { occurredAt: '2026-10-08T09:30:00.000Z', ...event };
}

export function signatureOf(body: string, key = INBOX_SIGNING_KEY): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

export function sendWebhook(
  app: NestFastifyApplication,
  payload: unknown,
  options: { path?: string; signature?: string } = {}
) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: options.path ?? INBOX_WEBHOOK_PATH,
    headers: { 'content-type': 'application/json', 'x-fixture-signature': options.signature ?? signatureOf(body) },
    payload: body,
  });
}

export function sendMultipartWebhook(app: NestFastifyApplication, payload: unknown, uploads: Upload[]) {
  const boundary = `----fixture${crypto.randomUUID().replaceAll('-', '')}`;
  const field = JSON.stringify(payload);
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${field}\r\n`,
    ...uploads.map(
      (upload) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${upload.filename}"\r\nContent-Type: ${upload.mimeType}\r\n\r\n${upload.text}\r\n`
    ),
    `--${boundary}--\r\n`,
  ];
  return app.inject({
    method: 'POST',
    url: INBOX_WEBHOOK_PATH,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-fixture-signature': signatureOf(field),
    },
    payload: parts.join(''),
  });
}

export async function receivingEnvironment(
  app: INestApplication,
  values: Record<string, unknown>
): Promise<GateCallerFixture> {
  const caller = await gateCaller(app);
  await saveProjectConfiguration(app, INBOX_SERVICE, caller.projectEnvironmentId, values);
  return caller;
}

export interface StoredEvent {
  id: number;
  service: string;
  type: string;
  key: string;
  occurredAt: string;
  receivedAt: string;
  data: Record<string, unknown>;
  appDeliveredAt: string | null;
}

export interface StoredEventFile {
  id: number;
  eventId: number;
  name: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
}

export interface EnvironmentDatabase {
  events: StoredEvent[];
  eventFiles: StoredEventFile[];
  tables: string[];
}

export function environmentDirectory(storageRoot: string, projectEnvironmentId: string): string {
  return join(storageRoot, 'projects', projectEnvironmentId);
}

export async function environmentDatabase(
  storageRoot: string,
  projectEnvironmentId: string
): Promise<EnvironmentDatabase> {
  const file = join(environmentDirectory(storageRoot, projectEnvironmentId), 'data', 'external-services.db');
  if (!existsSync(file)) return { events: [], eventFiles: [], tables: [] };
  const connection = await open({ filename: file, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try {
    const tables = await connection.all<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    if (!tables.some((table) => table.name === 'events')) {
      return { events: [], eventFiles: [], tables: tables.map((table) => table.name) };
    }
    const events = await connection.all<Record<string, unknown>[]>('SELECT * FROM events ORDER BY id');
    const eventFiles = await connection.all<Record<string, unknown>[]>('SELECT * FROM event_files ORDER BY id');
    return {
      tables: tables.map((table) => table.name),
      events: events.map((row) => ({
        id: row.id as number,
        service: row.service as string,
        type: row.type as string,
        key: row.key as string,
        occurredAt: row.occurred_at as string,
        receivedAt: row.received_at as string,
        data: JSON.parse(row.data as string) as Record<string, unknown>,
        appDeliveredAt: (row.app_delivered_at as string | null) ?? null,
      })),
      eventFiles: eventFiles.map((row) => ({
        id: row.id as number,
        eventId: row.event_id as number,
        name: row.name as string,
        mimeType: row.mime_type as string,
        sizeBytes: row.size_bytes as number,
        path: row.path as string,
      })),
    };
  } finally {
    await connection.close();
  }
}

export function fileOnDisk(storageRoot: string, projectEnvironmentId: string, podPath: string): Promise<string> {
  const relative = podPath.replace(/^\/workspace\//, '');
  return readFile(join(environmentDirectory(storageRoot, projectEnvironmentId), relative), 'utf8');
}

export async function latestInboundCall(slug = INBOX_SERVICE): Promise<CallRow | undefined> {
  const [row] = await db
    .select()
    .from(externalServiceCalls)
    .where(and(eq(externalServiceCalls.slug, slug), eq(externalServiceCalls.kind, 'inbound')))
    .orderBy(desc(externalServiceCalls.createdAt))
    .limit(1);
  return row;
}
