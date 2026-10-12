import { fieldNamed, isPlainObject, serviceConfigurationSourceOf, } from "./form-levels.js";
import { problem, ServiceError } from "./problems.js";
export const ALL = Symbol.for('opsiforce.external-service.bounds.all');
export const maxAllowedInProblem = 50;
const labelsKey = '_labels';
export class OutOfBoundsError extends ServiceError {
    problem;
    constructor(outOfBounds) {
        super({ status: 403, code: 'out-of-bounds', detail: outOfBounds.detail });
        this.problem = outOfBounds;
    }
    toProblem() {
        return this.problem;
    }
}
export function findBoundSites(manifest, target, value) {
    const schema = targetSchema(manifest, target);
    if (!schema)
        return [];
    const sites = new Map();
    collectSites(schema, value, '', manifest.$defs ?? {}, sites);
    return [...sites.values()];
}
export function createBoundsChecker(options) {
    const { manifest } = options;
    const projectConfiguration = isPlainObject(options.projectConfiguration) ? options.projectConfiguration : {};
    const serviceConfiguration = isPlainObject(options.serviceConfiguration) ? options.serviceConfiguration : {};
    const boundNamed = (name) => {
        const bound = manifest.bounds?.[name];
        if (!bound)
            throw new TypeError(`bound "${name}" is not declared in service.json`);
        return bound;
    };
    const values = (name, whereInputs) => allowedValues(boundNamed(name), projectConfiguration, whereInputs);
    const has = (name, value, whereInputs) => {
        const allowed = values(name, whereInputs);
        return allowed === ALL || (typeof value === 'string' && allowed.includes(value));
    };
    const outOfBounds = (target, name, value, whereInputs, pointer) => {
        const bound = boundNamed(name);
        const allowed = values(name, whereInputs);
        const listed = allowed === ALL ? [] : allowed;
        const shown = listed.slice(0, maxAllowedInProblem).map((allowedValue) => ({
            value: allowedValue,
            label: labelOf(manifest, bound, allowedValue, projectConfiguration, serviceConfiguration),
        }));
        const where = pointer === undefined ? '' : ` at ${pointer}`;
        return problem({
            status: 403,
            code: 'out-of-bounds',
            title: 'Out of bounds',
            detail: `The value${where} is outside the "${name}" bound of this Project configuration.`,
            ...target,
            bound: name,
            ...(pointer === undefined ? {} : { pointer }),
            value,
            allowed: shown,
            truncated: listed.length > shown.length,
        });
    };
    return {
        values,
        has,
        assert(name, value, whereInputs) {
            if (has(name, value, whereInputs))
                return;
            const target = options.operation === undefined ? {} : { operation: options.operation };
            throw new OutOfBoundsError(outOfBounds(target, name, value, whereInputs));
        },
        filter(name, items, key, whereInputs) {
            const allowed = values(name, whereInputs);
            if (allowed === ALL)
                return [...items];
            return items.filter((item) => {
                const value = item[key];
                return typeof value === 'string' && allowed.includes(value);
            });
        },
        check(target, value) {
            for (const site of findBoundSites(manifest, target, value)) {
                if (!has(site.bound, site.value, value)) {
                    return outOfBounds(target, site.bound, site.value, value, site.pointer);
                }
            }
            return null;
        },
        touched(target, value) {
            return findBoundSites(manifest, target, value).map((site) => Object.assign(site, {
                label: labelOf(manifest, boundNamed(site.bound), site.value, projectConfiguration, serviceConfiguration),
            }));
        },
    };
}
function targetSchema(manifest, target) {
    if ('operation' in target)
        return manifest.operations?.[target.operation]?.input;
    return manifest.events?.[target.event]?.data;
}
function resolveRef(schema, defs) {
    let resolved = schema;
    for (let hops = 0; resolved.$ref !== undefined && hops < 64; hops++) {
        const target = defs[resolved.$ref.slice('#/$defs/'.length)];
        if (!target)
            return resolved;
        resolved = target;
    }
    return resolved;
}
function escapePointerToken(token) {
    return String(token).replaceAll('~', '~0').replaceAll('/', '~1');
}
function collectSites(schema, value, pointer, defs, sites) {
    const resolved = resolveRef(schema, defs);
    if (resolved.boundTo !== undefined && typeof value === 'string') {
        sites.set(`${resolved.boundTo} ${pointer}`, { bound: resolved.boundTo, pointer, value });
    }
    if (isPlainObject(value)) {
        for (const [key, propertyValue] of Object.entries(value)) {
            const property = resolved.properties?.[key];
            const propertySchema = property ?? (typeof resolved.additionalProperties === 'object' ? resolved.additionalProperties : undefined);
            if (propertySchema) {
                collectSites(propertySchema, propertyValue, `${pointer}/${escapePointerToken(key)}`, defs, sites);
            }
        }
    }
    if (Array.isArray(value) && resolved.items) {
        const items = resolved.items;
        value.forEach((item, index) => collectSites(items, item, `${pointer}/${index}`, defs, sites));
    }
    for (const alternative of [...(resolved.anyOf ?? []), ...(resolved.oneOf ?? [])]) {
        collectSites(alternative, value, pointer, defs, sites);
    }
}
function readPointer(document, pointer) {
    let current = document;
    for (const token of pointer.split('/').slice(1)) {
        const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
        if (Array.isArray(current))
            current = current[Number(key)];
        else if (isPlainObject(current))
            current = current[key];
        else
            return undefined;
    }
    return current;
}
function stringsIn(value) {
    if (typeof value === 'string')
        return value === '' ? [] : [value];
    if (Array.isArray(value))
        return value.filter((entry) => typeof entry === 'string' && entry !== '');
    return [];
}
function allowedValues(bound, projectConfiguration, whereInputs) {
    for (const [key, expected] of Object.entries(bound.unless ?? {})) {
        if (projectConfiguration[key] === expected)
            return ALL;
    }
    const [fieldKey = '', itemKey] = bound.path.split('[].');
    const configured = projectConfiguration[fieldKey];
    if (itemKey === undefined)
        return unique(stringsIn(configured));
    if (!Array.isArray(configured))
        return [];
    const matching = configured.filter(isPlainObject).filter((item) => Object.entries(bound.where ?? {}).every(([itemField, pointer]) => {
        if (whereInputs === undefined)
            return true;
        const wanted = readPointer(whereInputs, pointer);
        return wanted !== undefined && item[itemField] === wanted;
    }));
    return unique(matching.flatMap((item) => stringsIn(item[itemKey])));
}
function unique(values) {
    return [...new Set(values)];
}
function labelOf(manifest, bound, value, projectConfiguration, serviceConfiguration) {
    const [fieldKey = '', itemKey] = bound.path.split('[].');
    const storedLabels = projectConfiguration[labelsKey];
    const labels = isPlainObject(storedLabels) ? storedLabels : {};
    for (const labelKey of [bound.path, itemKey ?? fieldKey]) {
        const fieldLabels = labels[labelKey];
        if (isPlainObject(fieldLabels) && typeof fieldLabels[value] === 'string')
            return fieldLabels[value];
    }
    const listField = fieldNamed(manifest.projectForm, fieldKey);
    const field = itemKey === undefined ? listField : listField?.type === 'list' ? fieldNamed(listField.item, itemKey) : undefined;
    return optionLabel(field, value, serviceConfiguration) ?? value;
}
function optionLabel(field, value, serviceConfiguration) {
    if (!field || !('options' in field))
        return undefined;
    const options = field.options;
    if (Array.isArray(options))
        return options.find((option) => option.value === value)?.label;
    const source = serviceConfigurationSourceOf(field);
    if (!source)
        return undefined;
    const items = serviceConfiguration[source.serviceConfiguration];
    if (!Array.isArray(items))
        return undefined;
    const item = items.filter(isPlainObject).find((candidate) => candidate.id === value);
    const label = item?.[source.labelKey];
    return typeof label === 'string' ? label : undefined;
}
