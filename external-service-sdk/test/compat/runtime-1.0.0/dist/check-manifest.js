import { templateVariablesOf } from "./info-template.js";
import { createInputSchemaCompiler } from "./input-validators.js";
import { inputSchemaLimits } from "./input-schema.js";
import { manifestLimits, serviceManifestSchema } from "./manifest.js";
import { boundInputsOf } from "./schema-inputs.js";
const utf8 = new TextEncoder();
function utf8ByteLength(text) {
    return utf8.encode(text).byteLength;
}
const valueFieldTypes = new Set([
    'text',
    'textarea',
    'number',
    'toggle',
    'radio',
    'select',
    'multiselect',
    'secret',
    'list',
    'keyValue',
]);
const boundableFieldTypes = new Set(['text', 'textarea', 'radio', 'select', 'multiselect']);
const templateFieldTypes = new Set(['text', 'textarea', 'number', 'toggle', 'radio', 'select']);
const scalarBoundableFieldTypes = new Set(['text', 'textarea', 'radio', 'select']);
const reservedProjectKeys = new Set(['operations', 'receive']);
const reservedListItemKeys = new Set(['id']);
export function formatProblemPath(path) {
    return path
        .map((segment) => {
        if (typeof segment === 'number')
            return `[${segment}]`;
        const key = String(segment);
        return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
    })
        .join('')
        .replace(/^\./, '');
}
class ProblemList {
    problems = [];
    error(path, message) {
        this.problems.push({ severity: 'error', path: formatProblemPath(path), message });
    }
    warning(path, message) {
        this.problems.push({ severity: 'warning', path: formatProblemPath(path), message });
    }
    get hasErrors() {
        return this.problems.some((problem) => problem.severity === 'error');
    }
}
export function checkServiceManifest(input, options) {
    const problems = new ProblemList();
    const bytes = utf8ByteLength(JSON.stringify(input) ?? '');
    if (bytes > manifestLimits.maxManifestBytes) {
        problems.error([], `service.json is ${bytes} bytes; the limit is ${manifestLimits.maxManifestBytes}`);
        return { ok: false, problems: problems.problems };
    }
    const parsed = serviceManifestSchema.safeParse(input);
    if (!parsed.success) {
        for (const issue of parsed.error.issues)
            reportZodIssue(problems, issue);
        return { ok: false, problems: problems.problems };
    }
    const manifest = parsed.data;
    checkForms(manifest, problems);
    checkInputSchemas(manifest, problems);
    checkBounds(manifest, problems);
    checkEvents(manifest, options, problems);
    if (!problems.hasErrors)
        compileInputSchemas(manifest, problems);
    warnOnUnboundChanges(manifest, problems);
    return { ok: !problems.hasErrors, manifest, problems: problems.problems };
}
function reportZodIssue(problems, issue) {
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
        const closest = issue.errors.reduce((best, errors) => (errors.length < best.length ? errors : best));
        for (const nested of closest)
            reportZodIssue(problems, { ...nested, path: [...issue.path, ...nested.path] });
        return;
    }
    if (issue.code === 'invalid_key') {
        for (const nested of issue.issues)
            problems.error(issue.path, nested.message);
        return;
    }
    problems.error(issue.path, issue.message);
}
function flattenLevel(fields, path) {
    return fields.flatMap((field, index) => {
        const fieldPath = [...path, index];
        const nested = field.type === 'section' ? flattenLevel(field.fields, [...fieldPath, 'fields']) : [];
        return [{ field, path: fieldPath }, ...nested];
    });
}
function keyedFields(placed) {
    const keyed = new Map();
    for (const { field } of placed) {
        if (field.type !== 'section' && !keyed.has(field.key))
            keyed.set(field.key, field);
    }
    return keyed;
}
function topLevelFields(fields) {
    return keyedFields(flattenLevel(fields ?? [], []));
}
function checkForms(manifest, problems) {
    const serviceFields = topLevelFields(manifest.serviceForm);
    for (const form of ['serviceForm', 'projectForm']) {
        const placed = flattenLevel(manifest[form] ?? [], [form]);
        checkLevel(placed, { form, inItem: false, serviceFields }, problems);
    }
}
function checkLevel(placed, context, problems) {
    const keyed = keyedFields(placed);
    const seen = new Set();
    for (const { field, path } of placed) {
        if (field.visibleWhen)
            checkFieldReference(field.visibleWhen.field, field, keyed, [...path, 'visibleWhen'], problems);
        if (field.type === 'section')
            continue;
        if (seen.has(field.key))
            problems.error([...path, 'key'], `key "${field.key}" is used twice at this level`);
        seen.add(field.key);
        if (context.inItem && reservedListItemKeys.has(field.key)) {
            problems.error([...path, 'key'], `"${field.key}" is reserved: the platform assigns each list item its id`);
        }
        if (!context.inItem && context.form === 'projectForm' && reservedProjectKeys.has(field.key)) {
            problems.error([...path, 'key'], `"${field.key}" is reserved in a Project configuration`);
        }
        if (field.was !== undefined && keyed.has(field.was)) {
            problems.error([...path, 'was'], `was names "${field.was}", which is still a field at this level`);
        }
        checkFieldRules(field, path, keyed, context, problems);
    }
}
function checkFieldReference(key, owner, keyed, path, problems) {
    const target = keyed.get(key);
    if (!target) {
        problems.error(path, `"${key}" is not a field at the same level`);
    }
    else if (owner.type !== 'section' && target === owner) {
        problems.error(path, 'a field cannot refer to itself');
    }
    else if (!valueFieldTypes.has(target.type)) {
        problems.error(path, `"${key}" is a ${target.type} field and holds no value`);
    }
}
function checkFieldRules(field, path, keyed, context, problems) {
    switch (field.type) {
        case 'text':
        case 'textarea':
            checkTextValidate(field.validate, [...path, 'validate'], problems);
            if (field.type === 'text' && field.generate && field.default !== undefined) {
                problems.error([...path, 'default'], 'a generated field cannot also have a default');
            }
            break;
        case 'number':
            if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
                problems.error([...path, 'min'], 'min is greater than max');
            }
            break;
        case 'radio':
        case 'select':
        case 'multiselect':
            checkOptions(field, path, keyed, context, problems);
            if (field.type === 'multiselect' && field.minItems !== undefined && field.maxItems !== undefined) {
                if (field.minItems > field.maxItems)
                    problems.error([...path, 'minItems'], 'minItems is greater than maxItems');
            }
            break;
        case 'info':
            checkInfo(field, path, keyed, context, problems);
            break;
        case 'list': {
            const itemPlaced = flattenLevel(field.item, [...path, 'item']);
            checkLevel(itemPlaced, { ...context, inItem: true }, problems);
            break;
        }
        case 'toggle':
        case 'secret':
        case 'keyValue':
        case 'button':
            break;
    }
}
function checkTextValidate(validate, path, problems) {
    if (!validate)
        return;
    if (validate.minLength !== undefined && validate.maxLength !== undefined && validate.minLength > validate.maxLength) {
        problems.error([...path, 'minLength'], 'minLength is greater than maxLength');
    }
    if (validate.allowHttp !== undefined && validate.format !== 'url') {
        problems.error([...path, 'allowHttp'], 'allowHttp applies only to format "url"');
    }
}
function checkOptions(field, path, keyed, context, problems) {
    const options = field.options;
    const optionsPath = [...path, 'options'];
    if (Array.isArray(options)) {
        const values = new Set();
        options.forEach((option, index) => {
            if (values.has(option.value))
                problems.error([...optionsPath, index, 'value'], `option "${option.value}" is listed twice`);
            values.add(option.value);
        });
        const defaults = field.default === undefined ? [] : Array.isArray(field.default) ? field.default : [field.default];
        for (const value of defaults) {
            if (!values.has(value))
                problems.error([...path, 'default'], `default "${value}" is not one of the options`);
        }
        return;
    }
    if ('call' in options) {
        options.dependsOn?.forEach((key, index) => checkFieldReference(key, field, keyed, [...optionsPath, 'dependsOn', index], problems));
        return;
    }
    if (context.form !== 'projectForm') {
        problems.error([...optionsPath, 'serviceConfiguration'], 'serviceConfiguration options exist only in the Project form');
        return;
    }
    const list = context.serviceFields.get(options.serviceConfiguration);
    if (!list || list.type !== 'list') {
        problems.error([...optionsPath, 'serviceConfiguration'], `"${options.serviceConfiguration}" is not a list field of the Service form`);
        return;
    }
    const itemFields = topLevelFields(list.item);
    if (!itemFields.has(options.labelKey)) {
        problems.error([...optionsPath, 'labelKey'], `"${options.labelKey}" is not a field of the "${list.key}" items`);
    }
}
function checkInfo(field, path, keyed, context, problems) {
    const sources = [field.text, field.template, field.call].filter((source) => source !== undefined);
    if (sources.length !== 1) {
        problems.error(path, 'an info field takes exactly one of text, template or call');
    }
    if (field.template === undefined)
        return;
    const templatePath = [...path, 'template'];
    for (const variable of templateVariablesOf(field.template)) {
        if (variable === 'webhookUrl')
            continue;
        const serviceKey = /^serviceConfiguration\.(.+)$/.exec(variable)?.[1];
        if (serviceKey !== undefined) {
            if (context.form !== 'projectForm') {
                problems.error(templatePath, `{{${variable}}}: serviceConfiguration variables exist only in the Project form`);
            }
            else {
                checkTemplateField(variable, context.serviceFields.get(serviceKey), 'is not a Service form field', templatePath, problems);
            }
            continue;
        }
        const message = 'is not a field at the same level, serviceConfiguration.<key> or webhookUrl';
        checkTemplateField(variable, keyed.get(variable), message, templatePath, problems);
    }
}
function checkTemplateField(variable, field, missingMessage, path, problems) {
    if (!field) {
        problems.error(path, `{{${variable}}} ${missingMessage}`);
    }
    else if (!templateFieldTypes.has(field.type)) {
        problems.error(path, `{{${variable}}} is a ${field.type} field; a template shows only plain single values`);
    }
}
function schemaRoots(manifest) {
    return {
        operations: Object.entries(manifest.operations ?? {}).map(([name, operation]) => ({
            path: ['operations', name, 'input'],
            schema: operation.input,
        })),
        events: Object.entries(manifest.events ?? {}).map(([type, event]) => ({
            path: ['events', type, 'data'],
            schema: event.data,
        })),
        defs: Object.entries(manifest.$defs ?? {}).map(([name, schema]) => ({ path: ['$defs', name], schema })),
    };
}
function childSchemas(schema, path) {
    const children = [];
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
        children.push({ path: [...path, 'properties', name], schema: property });
    }
    if (typeof schema.additionalProperties === 'object') {
        children.push({ path: [...path, 'additionalProperties'], schema: schema.additionalProperties });
    }
    if (schema.items)
        children.push({ path: [...path, 'items'], schema: schema.items });
    for (const keyword of ['anyOf', 'oneOf']) {
        schema[keyword]?.forEach((alternative, index) => children.push({ path: [...path, keyword, index], schema: alternative }));
    }
    return children;
}
function eachSchemaNode(root, visit) {
    visit(root);
    for (const child of childSchemas(root.schema, root.path))
        eachSchemaNode(child, visit);
}
function refTarget(ref) {
    return ref.slice('#/$defs/'.length);
}
function checkInputSchemas(manifest, problems) {
    const defs = manifest.$defs ?? {};
    const roots = schemaRoots(manifest);
    const allRoots = [...roots.operations, ...roots.events, ...roots.defs];
    for (const root of allRoots) {
        const bytes = utf8ByteLength(JSON.stringify(root.schema));
        if (bytes > inputSchemaLimits.maxSchemaBytes) {
            problems.error(root.path, `this schema is ${bytes} bytes; the limit is ${inputSchemaLimits.maxSchemaBytes}`);
        }
        eachSchemaNode(root, ({ schema, path }) => {
            if (schema.$ref !== undefined && !(refTarget(schema.$ref) in defs)) {
                problems.error([...path, '$ref'], `${schema.$ref} does not exist in $defs`);
            }
            if (schema.boundTo !== undefined && schema.type !== 'string') {
                problems.error([...path, 'boundTo'], 'boundTo applies only to a string schema (or the items of an array)');
            }
        });
    }
    if (problems.hasErrors)
        return;
    const cycle = findRefCycle(defs);
    if (cycle) {
        problems.error(['$defs', cycle[0] ?? ''], `$defs refer to each other in a cycle: ${cycle.join(' → ')}`);
        return;
    }
    for (const root of [...roots.operations, ...roots.events, ...roots.defs]) {
        const depth = schemaDepth(root.schema, defs);
        if (depth > inputSchemaLimits.maxDepth) {
            problems.error(root.path, `this schema nests ${depth} levels deep; the limit is ${inputSchemaLimits.maxDepth}`);
        }
    }
    for (const root of [...roots.operations, ...roots.events]) {
        if (resolveRef(root.schema, defs).type !== 'object') {
            problems.error(root.path, 'must be an object schema (type "object")');
        }
    }
}
function refsIn(schema) {
    const refs = [];
    eachSchemaNode({ path: [], schema }, ({ schema: node }) => {
        if (node.$ref !== undefined)
            refs.push(refTarget(node.$ref));
    });
    return refs;
}
function findRefCycle(defs) {
    const done = new Set();
    const visit = (name, trail) => {
        if (trail.includes(name))
            return [...trail.slice(trail.indexOf(name)), name];
        if (done.has(name))
            return undefined;
        const schema = defs[name];
        for (const target of schema ? refsIn(schema) : []) {
            const cycle = visit(target, [...trail, name]);
            if (cycle)
                return cycle;
        }
        done.add(name);
        return undefined;
    };
    for (const name of Object.keys(defs)) {
        const cycle = visit(name, []);
        if (cycle)
            return cycle;
    }
    return undefined;
}
function resolveRef(schema, defs) {
    let resolved = schema;
    while (resolved.$ref !== undefined) {
        const target = defs[refTarget(resolved.$ref)];
        if (!target)
            return resolved;
        resolved = target;
    }
    return resolved;
}
function schemaDepth(schema, defs) {
    const resolved = resolveRef(schema, defs);
    const children = childSchemas(resolved, []);
    return 1 + Math.max(0, ...children.map((child) => schemaDepth(child.schema, defs)));
}
function checkBounds(manifest, problems) {
    const bounds = manifest.bounds ?? {};
    const projectFields = topLevelFields(manifest.projectForm);
    for (const [name, bound] of Object.entries(bounds)) {
        const path = ['bounds', name];
        const [fieldKey = '', itemKey] = bound.path.split('[].');
        const field = projectFields.get(fieldKey);
        if (itemKey === undefined) {
            if (!field || !boundableFieldTypes.has(field.type)) {
                problems.error([...path, 'path'], boundPathMessage(bound.path, field));
            }
            if (bound.where)
                problems.error([...path, 'where'], 'where works only with a list item path (list[].field)');
        }
        else if (!field || field.type !== 'list') {
            problems.error([...path, 'path'], `"${fieldKey}" is not a list field of the Project form`);
        }
        else {
            const itemFields = topLevelFields(field.item);
            const itemField = itemFields.get(itemKey);
            if (!itemField || !boundableFieldTypes.has(itemField.type)) {
                problems.error([...path, 'path'], boundPathMessage(bound.path, itemField));
            }
            for (const whereKey of Object.keys(bound.where ?? {})) {
                const whereField = itemFields.get(whereKey);
                if (!whereField || !scalarBoundableFieldTypes.has(whereField.type)) {
                    problems.error([...path, 'where', whereKey], `"${whereKey}" is not a single-value field of the "${fieldKey}" items`);
                }
            }
        }
        for (const unlessKey of Object.keys(bound.unless ?? {})) {
            if (!valueFieldTypes.has(projectFields.get(unlessKey)?.type ?? 'section')) {
                problems.error([...path, 'unless', unlessKey], `"${unlessKey}" is not a Project form field`);
            }
        }
    }
    const used = new Set();
    const roots = schemaRoots(manifest);
    for (const root of [...roots.operations, ...roots.events, ...roots.defs]) {
        eachSchemaNode(root, ({ schema, path }) => {
            if (schema.boundTo === undefined)
                return;
            used.add(schema.boundTo);
            if (!(schema.boundTo in bounds)) {
                problems.error([...path, 'boundTo'], `"${schema.boundTo}" is not declared in bounds`);
            }
        });
    }
    for (const name of Object.keys(bounds)) {
        if (!used.has(name))
            problems.warning(['bounds', name], `bound "${name}" is declared but no input or Event uses it`);
    }
}
function boundPathMessage(path, field) {
    if (!field)
        return `"${path}" is not a Project form field`;
    return `"${path}" is a ${field.type} field; a bound reads a text, textarea, radio, select or multiselect field`;
}
function checkEvents(manifest, options, problems) {
    const events = Object.entries(manifest.events ?? {});
    if (events.length > 0 && manifest.inbound !== true) {
        problems.error(['events'], 'Events arrive only through inbound; set "inbound": true');
    }
    if (options.origin !== 'built_in' || problems.hasErrors)
        return;
    const defs = manifest.$defs ?? {};
    for (const [type, event] of events) {
        if (boundInputsOf(event.data, defs).length === 0) {
            problems.error(['events', type, 'data'], 'a Built-in External Service binds every Event type: mark the property that routes it with boundTo');
        }
    }
}
function compileInputSchemas(manifest, problems) {
    const compile = createInputSchemaCompiler(manifest.$defs);
    const roots = schemaRoots(manifest);
    for (const root of [...roots.operations, ...roots.events]) {
        try {
            compile(root.schema);
        }
        catch (error) {
            problems.error(root.path, error instanceof Error ? error.message : String(error));
        }
    }
}
function warnOnUnboundChanges(manifest, problems) {
    if (problems.hasErrors)
        return;
    const defs = manifest.$defs ?? {};
    for (const [name, operation] of Object.entries(manifest.operations ?? {})) {
        if (operation.kind === 'read')
            continue;
        if (boundInputsOf(operation.input, defs).length === 0) {
            problems.warning(['operations', name], `${operation.kind} Operation with no bound: any id the caller passes reaches the service; confirm this before Publish`);
        }
    }
}
