import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

import { inputFormatCheckers } from './input-formats.ts';
import type { InputSchema } from './input-schema.ts';
import type { ServiceManifest } from './manifest.ts';

export type InputValidator = ValidateFunction;

export interface ManifestValidators {
  operations: Record<string, InputValidator>;
  events: Record<string, InputValidator>;
}

export type InputSchemaCompiler = (schema: InputSchema) => InputValidator;

export function createInputSchemaCompiler(defs: Record<string, InputSchema> = {}): InputSchemaCompiler {
  const ajv = new Ajv2020({
    strict: true,
    allowUnionTypes: true,
    allErrors: false,
    useDefaults: true,
    coerceTypes: false,
    addUsedSchema: false,
  });
  ajv.addKeyword({ keyword: 'boundTo', schemaType: 'string' });
  for (const [name, check] of Object.entries(inputFormatCheckers)) {
    ajv.addFormat(name, { type: 'string', validate: check });
  }
  return (schema) => ajv.compile(structuredClone({ ...schema, $defs: defs }));
}

export function compileManifestValidators(manifest: ServiceManifest): ManifestValidators {
  const compile = createInputSchemaCompiler(manifest.$defs);
  const compileEach = <T>(entries: Record<string, T> | undefined, schemaOf: (entry: T) => InputSchema) =>
    Object.fromEntries(Object.entries(entries ?? {}).map(([name, entry]) => [name, compile(schemaOf(entry))]));
  return {
    operations: compileEach(manifest.operations, (operation) => operation.input),
    events: compileEach(manifest.events, (event) => event.data),
  };
}
