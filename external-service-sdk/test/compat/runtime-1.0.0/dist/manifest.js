import { z } from 'zod';
import { describeUnrecognizedKeys, inputSchemaSchema, jsonValueSchema } from "./input-schema.js";
import { fieldKeySchema, formSchema } from "./fields.js";
export const sdkVersion = 1;
export const manifestLimits = {
    maxManifestBytes: 256 * 1024,
    maxIconBytes: 32 * 1024,
    maxOperationInputBytes: 25 * 1024 * 1024,
    maxTimeoutSeconds: 300,
};
export const operationDefaults = {
    inputBytes: 1024 * 1024,
    timeoutSeconds: 30,
};
export const operationKinds = ['read', 'write', 'destructive'];
export const operationNameSchema = z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, 'Operation names are snake_case: a lowercase letter, then a-z, 0-9 or _ (at most 64)');
export const eventTypeSchema = z
    .string()
    .max(100)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/, 'Event types are dotted snake_case, like card.moved');
export const boundNameSchema = z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, 'bound names start with a letter and use only letters, digits and _');
const defNameSchema = z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, '$defs names start with a letter and use only letters, digits and _');
const jsonPointer = z
    .string()
    .max(200)
    .regex(/^(\/[^/]+)+$/, 'must be a JSON Pointer into the input, like /channel');
const oneEntry = (record, what) => record.refine((value) => Object.keys(value).length === 1, { message: `${what} takes exactly one entry` });
export const boundSchema = z.strictObject({
    path: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}(\[\]\.[a-zA-Z][a-zA-Z0-9_]{0,63})?$/, 'a bound path is a Project form field (boards) or a list item field (channels[].chats)'),
    where: oneEntry(z.record(fieldKeySchema, jsonPointer), 'where').optional(),
    unless: oneEntry(z.record(fieldKeySchema, z.union([z.string().max(200), z.number(), z.boolean()])), 'unless').optional(),
});
export const operationSchema = z.strictObject({
    kind: z.enum(operationKinds),
    title: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(500),
    input: inputSchemaSchema,
    outputExample: jsonValueSchema.optional(),
    limits: z
        .strictObject({
        inputBytes: z.int().min(1).max(manifestLimits.maxOperationInputBytes).optional(),
        timeoutSeconds: z.int().min(1).max(manifestLimits.maxTimeoutSeconds).optional(),
    })
        .optional(),
});
export const eventSchema = z.strictObject({
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    data: inputSchemaSchema,
});
const headerKeyReasons = new Map([
    ['name', 'name is not allowed: a service is identified by its folder or registry slug'],
    ['version', 'version is not allowed: Publish records the manifest hash instead'],
]);
export const serviceManifestSchema = z
    .strictObject({
    $schema: z.string().max(500).optional(),
    sdk: z.literal(sdkVersion, { error: `sdk must be ${sdkVersion}` }),
    displayName: z.string().min(1).max(80),
    description: z.string().min(1).max(300),
    icon: z
        .string()
        .max(200)
        .regex(/^(?!.*\.\.)(?!\/)[A-Za-z0-9_\-./]+\.svg$/, 'icon must be a relative path to an .svg file in the service folder')
        .optional(),
    inbound: z.boolean().optional(),
    serviceForm: formSchema.optional(),
    projectForm: formSchema.optional(),
    operations: z.record(operationNameSchema, operationSchema).optional(),
    events: z.record(eventTypeSchema, eventSchema).optional(),
    bounds: z.record(boundNameSchema, boundSchema).optional(),
    $defs: z.record(defNameSchema, inputSchemaSchema).optional(),
}, {
    error: (issue) => issue.code === 'unrecognized_keys' ? describeUnrecognizedKeys(issue.keys, headerKeyReasons) : undefined,
})
    .meta({ id: 'ServiceManifest', title: 'External Service manifest (service.json)' });
export function serviceManifestJsonSchema() {
    return z.toJSONSchema(serviceManifestSchema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' });
}
