import { z } from 'zod';

export const inputSchemaLimits = {
  maxDepth: 8,
  maxSchemaBytes: 64 * 1024,
  maxProperties: 200,
  maxEnumValues: 500,
  maxAlternatives: 20,
} as const;

export const inputFormats = ['date-time', 'date', 'email', 'uri', 'uuid', 'hostname', 'ipv4'] as const;

export const jsonValueSchema = z.json().meta({ id: 'JsonValue' });

const jsonTypes = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;

export type JsonType = (typeof jsonTypes)[number];
export type InputFormat = (typeof inputFormats)[number];

export interface InputSchema {
  $ref?: string;
  type?: JsonType | JsonType[];
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, InputSchema>;
  required?: string[];
  additionalProperties?: boolean | InputSchema;
  minProperties?: number;
  maxProperties?: number;
  items?: InputSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  format?: InputFormat;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  anyOf?: InputSchema[];
  oneOf?: InputSchema[];
  boundTo?: string;
}

const refusedKeywordReasons = new Map([
  ['pattern', 'pattern is not allowed in input schemas; check the value in the handler instead'],
  ['patternProperties', 'patternProperties is not allowed in input schemas; check the keys in the handler instead'],
  ['$id', '$id is not allowed in input schemas'],
  ['id', 'id is not allowed in input schemas'],
  ['$defs', '$defs is allowed only at the top level of service.json'],
  ['definitions', 'definitions is not allowed; use the top-level $defs'],
  ['$schema', '$schema is not allowed inside an input schema'],
  ['$anchor', '$anchor is not allowed in input schemas'],
  ['$dynamicRef', '$dynamicRef is not allowed in input schemas'],
  ['$dynamicAnchor', '$dynamicAnchor is not allowed in input schemas'],
  ['not', 'not is not allowed in input schemas'],
  ['if', 'if/then/else is not allowed in input schemas'],
  ['then', 'if/then/else is not allowed in input schemas'],
  ['else', 'if/then/else is not allowed in input schemas'],
  ['allOf', 'allOf is not allowed in input schemas; merge the schemas or use anyOf/oneOf'],
  ['dependentSchemas', 'dependentSchemas is not allowed in input schemas'],
  ['dependentRequired', 'dependentRequired is not allowed in input schemas'],
  ['unevaluatedProperties', 'unevaluatedProperties is not allowed in input schemas'],
  ['unevaluatedItems', 'unevaluatedItems is not allowed in input schemas'],
  ['contains', 'contains is not allowed in input schemas'],
  ['prefixItems', 'prefixItems is not allowed in input schemas'],
  ['propertyNames', 'propertyNames is not allowed in input schemas'],
]);

export function describeUnrecognizedKeys(keys: readonly string[], reasons: ReadonlyMap<string, string>): string {
  return keys.map((key) => reasons.get(key) ?? `${key} is not allowed here`).join('; ');
}

const refusedKeywordError = (issue: z.core.$ZodRawIssue) =>
  issue.code === 'unrecognized_keys' ? describeUnrecognizedKeys(issue.keys, refusedKeywordReasons) : undefined;

const localRef = z
  .string()
  .regex(
    /^#\/\$defs\/[A-Za-z][A-Za-z0-9_]{0,63}$/,
    '$ref must point to #/$defs/<name>; remote references are not allowed'
  );

const boundName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, 'boundTo must name a declared bound');

const jsonType = z.enum(jsonTypes);

const count = z.int().min(0).max(1_000_000);

export const inputSchemaSchema: z.ZodType<InputSchema> = z
  .strictObject(
    {
      $ref: localRef.optional(),
      type: z.union([jsonType, z.array(jsonType).min(1).max(jsonTypes.length)]).optional(),
      title: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
      default: jsonValueSchema.optional(),
      examples: z.array(jsonValueSchema).max(10).optional(),
      enum: z.array(jsonValueSchema).min(1).max(inputSchemaLimits.maxEnumValues).optional(),
      const: jsonValueSchema.optional(),
      get properties() {
        return z
          .record(z.string().min(1).max(128), inputSchemaSchema)
          .refine((properties) => Object.keys(properties).length <= inputSchemaLimits.maxProperties, {
            message: `at most ${inputSchemaLimits.maxProperties} properties`,
          })
          .optional();
      },
      required: z.array(z.string().min(1).max(128)).max(inputSchemaLimits.maxProperties).optional(),
      get additionalProperties() {
        return z.union([z.boolean(), inputSchemaSchema]).optional();
      },
      minProperties: count.optional(),
      maxProperties: count.optional(),
      get items() {
        return inputSchemaSchema.optional();
      },
      minItems: count.optional(),
      maxItems: count.optional(),
      uniqueItems: z.boolean().optional(),
      minLength: count.optional(),
      maxLength: count.optional(),
      format: z.enum(inputFormats).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      exclusiveMinimum: z.number().optional(),
      exclusiveMaximum: z.number().optional(),
      multipleOf: z.number().positive().optional(),
      get anyOf() {
        return z.array(inputSchemaSchema).min(1).max(inputSchemaLimits.maxAlternatives).optional();
      },
      get oneOf() {
        return z.array(inputSchemaSchema).min(1).max(inputSchemaLimits.maxAlternatives).optional();
      },
      boundTo: boundName.optional(),
    },
    { error: refusedKeywordError }
  )
  .superRefine((schema, ctx) => {
    if (schema.$ref !== undefined) {
      const siblings = Object.keys(schema).filter((key) => key !== '$ref' && key !== 'description');
      if (siblings.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `$ref takes only a description beside it, not ${siblings.join(', ')}`,
        });
      }
    } else if (schema.type === undefined) {
      ctx.addIssue({ code: 'custom', message: 'every input schema needs a type (or a $ref)', path: ['type'] });
    }
  })
  .meta({ id: 'InputSchema' });
