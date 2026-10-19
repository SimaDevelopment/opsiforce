import { z } from 'zod';

import { formSchema } from './fields.ts';

export const sdkVersion = 2;

export const manifestLimits = {
  maxManifestBytes: 256 * 1024,
  maxIconBytes: 32 * 1024,
} as const;

export const eventTypeSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/, 'Event types are dotted snake_case, like card.moved');

const noOperations = 'SDK 2 has no Operations; enforce this in your Service policy';

const refusedKeyReasons = new Map([
  ['name', 'name is not allowed: a service is identified by its folder or registry slug'],
  ['version', 'version is not allowed: Publish records the manifest hash instead'],
  ['operations', `operations: ${noOperations}`],
  ['bounds', `bounds: ${noOperations}`],
  ['$defs', `$defs: ${noOperations}`],
]);

export function describeUnrecognizedKeys(keys: readonly string[], reasons: ReadonlyMap<string, string>): string {
  return keys.map((key) => reasons.get(key) ?? `${key} is not allowed here`).join('; ');
}

export const eventSchema = z.strictObject(
  {
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys' && issue.keys.includes('data')
        ? 'data is not allowed: describe the Event data in the Service skill'
        : undefined,
  }
);

export const serviceManifestSchema = z
  .strictObject(
    {
      $schema: z.string().max(500).optional(),
      sdk: z.literal(sdkVersion, { error: `sdk must be ${sdkVersion}` }),
      displayName: z.string().min(1).max(80),
      description: z.string().min(1).max(300),
      icon: z
        .string()
        .max(200)
        .regex(
          /^(?!.*\.\.)(?!\/)[A-Za-z0-9_\-./]+\.svg$/,
          'icon must be a relative path to an .svg file in the service folder'
        )
        .optional(),
      inbound: z.boolean().optional(),
      serviceForm: formSchema.optional(),
      projectForm: formSchema.optional(),
      events: z.record(eventTypeSchema, eventSchema).optional(),
    },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys' ? describeUnrecognizedKeys(issue.keys, refusedKeyReasons) : undefined,
    }
  )
  .meta({ id: 'ServiceManifest', title: 'External Service manifest (service.json)' });

export type ServiceManifest = z.infer<typeof serviceManifestSchema>;
export type ServiceEvent = z.infer<typeof eventSchema>;

export function manifestSdkOf(input: unknown): unknown {
  return typeof input === 'object' && input !== null ? (input as { sdk?: unknown }).sdk : undefined;
}

export function serviceManifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(serviceManifestSchema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' });
}
