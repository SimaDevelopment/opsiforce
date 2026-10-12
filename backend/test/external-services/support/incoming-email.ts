import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { db } from '../../../db';
import { externalServiceConfig } from '../../../db/schema';
import { environmentDirectory } from './inbound';

export const EMAIL_SERVICE = 'incoming-email';
export const EMAIL_WEBHOOK_PATH = `/api/external-services/webhooks/${EMAIL_SERVICE}`;
export const RECEIVING_DOMAIN = 'mail.example.test';
export const MAILGUN_SIGNING_KEY = 'mailgun-signing-key-1';
export const RECEIVING_EMAIL = { receive: { 'email.received': true } };

export interface MailAttachment {
  filename: string;
  mimeType: string;
  text: string;
}

export interface Mail {
  to: string;
  messageId?: string;
  subject?: string;
  text?: string;
  attachments?: MailAttachment[];
  signingKey?: string;
}

function mailgunFields(mail: Mail): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = crypto.randomUUID();
  const signature = createHmac('sha256', mail.signingKey ?? MAILGUN_SIGNING_KEY)
    .update(timestamp + token)
    .digest('hex');
  const messageId = mail.messageId ?? `<${crypto.randomUUID()}@customer.example>`;
  return {
    recipient: mail.to,
    sender: 'ann@customer.example',
    from: 'Ann Customer <ann@customer.example>',
    subject: mail.subject ?? 'Invoice 42',
    'body-plain': mail.text ?? 'Please find the invoice attached.',
    'stripped-text': mail.text ?? 'Please find the invoice attached.',
    'Message-Id': messageId,
    'message-headers': JSON.stringify([['Message-Id', messageId]]),
    timestamp,
    token,
    signature,
  };
}

export function sendMail(app: NestFastifyApplication, mail: Mail) {
  const boundary = `----mailgun${crypto.randomUUID().replaceAll('-', '')}`;
  const parts = [
    ...Object.entries(mailgunFields(mail)).map(
      ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ),
    ...(mail.attachments ?? []).map(
      (attachment, index) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="attachment-${index + 1}"; filename="${attachment.filename}"\r\nContent-Type: ${attachment.mimeType}\r\n\r\n${attachment.text}\r\n`
    ),
    `--${boundary}--\r\n`,
  ];
  return app.inject({
    method: 'POST',
    url: EMAIL_WEBHOOK_PATH,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: parts.join(''),
  });
}

export async function storeV1Address(projectEnvironmentId: string, address: string): Promise<void> {
  await db.insert(externalServiceConfig).values({ service: EMAIL_SERVICE, projectEnvironmentId, value: { address } });
}

const EXTERNAL_SERVICES_V2_MIGRATION = join(__dirname, '../../../db/migrations/0076_external-services-v2.sql');

const ADDRESS_MIGRATION_STATEMENTS = [
  `INSERT INTO "external_services" ("id", "origin", "slug")\nVALUES (gen_random_uuid()::text, 'built_in', 'incoming-email')`,
  `WITH "service" AS (\n\tSELECT "id" FROM "external_services" WHERE "slug" = 'incoming-email'`,
];

export async function runAddressMigration(): Promise<void> {
  const statements = readFileSync(EXTERNAL_SERVICES_V2_MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim());
  for (const prefix of ADDRESS_MIGRATION_STATEMENTS) {
    const statement = statements.find((candidate) => candidate.startsWith(prefix));
    if (!statement) throw new Error(`No address migration statement starts with ${prefix}`);
    await db.execute(sql.raw(statement));
  }
}

const V1_STORE = `CREATE TABLE messages (
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
   CREATE UNIQUE INDEX messages_service_provider_message_id ON messages (service, provider_message_id);
   CREATE TABLE attachments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
     filename TEXT,
     content_type TEXT,
     size_bytes INTEGER NOT NULL,
     content BLOB
   );
   PRAGMA user_version = 1;`;

function databaseFileOf(storageRoot: string, projectEnvironmentId: string): string {
  return join(environmentDirectory(storageRoot, projectEnvironmentId), 'data', 'external-services.db');
}

export async function storedBeforeV2(
  storageRoot: string,
  projectEnvironmentId: string,
  message: { service: string; delivered: boolean }
): Promise<number> {
  const file = databaseFileOf(storageRoot, projectEnvironmentId);
  await mkdir(dirname(file), { recursive: true });
  const connection = await open({ filename: file, driver: sqlite3.Database });
  try {
    await connection.exec(V1_STORE);
    const result = await connection.run(
      `INSERT INTO messages (service, received_at, raw_payload, app_delivered_at, provider_message_id, routing_key, payload)
       VALUES (?, '2026-09-01T10:00:00.000Z', '{}', ?, ?, 'old@mail.example.test', '{}')`,
      message.service,
      message.delivered ? '2026-09-01T10:00:05.000Z' : null,
      `<old-${crypto.randomUUID()}@customer.example>`
    );
    return result.lastID as number;
  } finally {
    await connection.close();
  }
}

export interface LegacyRows {
  messages: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
}

export async function legacyRows(storageRoot: string, projectEnvironmentId: string): Promise<LegacyRows> {
  const connection = await open({
    filename: databaseFileOf(storageRoot, projectEnvironmentId),
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY,
  });
  try {
    return {
      messages: await connection.all('SELECT * FROM messages ORDER BY id'),
      attachments: await connection.all('SELECT * FROM attachments ORDER BY id'),
    };
  } finally {
    await connection.close();
  }
}
