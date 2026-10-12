import { Ajv2020 } from 'ajv/dist/2020.js';
import { inputFormatCheckers } from "./input-formats.js";
export function createInputSchemaCompiler(defs = {}) {
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
export function compileManifestValidators(manifest) {
    const compile = createInputSchemaCompiler(manifest.$defs);
    const compileEach = (entries, schemaOf) => Object.fromEntries(Object.entries(entries ?? {}).map(([name, entry]) => [name, compile(schemaOf(entry))]));
    return {
        operations: compileEach(manifest.operations, (operation) => operation.input),
        events: compileEach(manifest.events, (event) => event.data),
    };
}
