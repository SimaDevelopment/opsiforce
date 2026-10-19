import type { ServiceManifest } from '@opsiforce/external-service-sdk';
import type { EventToStore } from './external-service-store';

export interface InboundUpload {
  field: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface EventEnvelope {
  event: EventToStore;
  to: string[];
}

export type EnvelopeReading = { envelope: EventEnvelope } | { problems: string[] };

export const EVENT_PART = 'event';

export const envelopeLimits = {
  typeLength: 100,
  keyLength: 500,
  occurredAtLength: 64,
  receivers: 100,
  receiverIdLength: 100,
  fileNameLength: 255,
} as const;

interface FileEntry {
  part: string;
  name: string;
  mimeType: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function receiversOf(value: unknown, problems: string[]): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > envelopeLimits.receivers ||
    !value.every((entry) => boundedText(entry, envelopeLimits.receiverIdLength))
  ) {
    problems.push(`"to" lists 1 to ${envelopeLimits.receivers} ProjectEnvironment ids`);
    return [];
  }
  return [...new Set(value as string[])];
}

function fileEntriesOf(value: unknown, problems: string[]): FileEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push('"files" is a list of { part, name, mimeType }');
    return [];
  }
  return value.flatMap((entry, index) => {
    if (
      isRecord(entry) &&
      boundedText(entry.part, envelopeLimits.fileNameLength) &&
      boundedText(entry.name, envelopeLimits.fileNameLength) &&
      typeof entry.mimeType === 'string'
    ) {
      return [{ part: entry.part, name: entry.name, mimeType: entry.mimeType }];
    }
    problems.push(
      `files[${index}] needs a part, a name of 1 to ${envelopeLimits.fileNameLength} characters and a mimeType`
    );
    return [];
  });
}

export function readEventEnvelope(
  manifest: ServiceManifest,
  fields: Record<string, string>,
  uploads: readonly InboundUpload[]
): EnvelopeReading {
  const text = fields[EVENT_PART];
  if (text === undefined) return { problems: [`the "${EVENT_PART}" part is missing`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problems: [`the "${EVENT_PART}" part is not JSON`] };
  }
  if (!isRecord(parsed)) return { problems: [`the "${EVENT_PART}" part is not a JSON object`] };
  return checkedEnvelope(manifest, parsed, uploads);
}

export function checkedEnvelope(
  manifest: ServiceManifest,
  parsed: Record<string, unknown>,
  uploads: readonly InboundUpload[]
): EnvelopeReading {
  const problems: string[] = [];
  const { type, key, occurredAt, data } = parsed;
  const declared = boundedText(type, envelopeLimits.typeLength) && Object.hasOwn(manifest.events ?? {}, type);
  if (!declared) problems.push(`type ${JSON.stringify(type)} is not a declared Event type`);
  if (!boundedText(key, envelopeLimits.keyLength)) {
    problems.push(`"key" is 1 to ${envelopeLimits.keyLength} characters`);
  }
  if (!boundedText(occurredAt, envelopeLimits.occurredAtLength) || Number.isNaN(Date.parse(occurredAt))) {
    problems.push('"occurredAt" is not a date');
  }
  if (!isRecord(data)) problems.push('"data" is not a JSON object');
  const to = receiversOf(parsed.to, problems);
  const entries = fileEntriesOf(parsed.files, problems);
  const uploadsByPart = new Map(uploads.map((upload) => [upload.field, upload]));
  for (const entry of entries) {
    if (!uploadsByPart.has(entry.part)) problems.push(`the file part "${entry.part}" is missing`);
  }
  if (problems.length > 0) return { problems };

  return {
    envelope: {
      to,
      event: {
        type: type as string,
        key: key as string,
        occurredAt: new Date(occurredAt as string).toISOString(),
        data: data as Record<string, unknown>,
        files: entries.map((entry) => ({
          name: entry.name,
          mimeType: entry.mimeType,
          bytes: uploadsByPart.get(entry.part)?.bytes ?? new Uint8Array(),
        })),
      },
    },
  };
}
