import { Secret } from "./secret.js";
export const reservedProjectConfigurationKeys = ['operations', 'receive', '_labels'];
export function placedFieldsOf(fields, conditions = []) {
    return fields.flatMap((field) => {
        const own = field.visibleWhen ? [...conditions, field.visibleWhen] : conditions;
        if (field.type === 'section')
            return placedFieldsOf(field.fields, own);
        return [{ field, conditions: own }];
    });
}
export function isValueField(field) {
    return field.type !== 'info' && field.type !== 'button';
}
export function valueFieldsOf(fields) {
    return placedFieldsOf(fields)
        .map(({ field }) => field)
        .filter(isValueField);
}
export function fieldNamed(fields, key) {
    return placedFieldsOf(fields ?? []).find(({ field }) => field.key === key)?.field;
}
export function eachKeyedField(fields, visit) {
    for (const { field } of placedFieldsOf(fields ?? [])) {
        visit(field);
        if (field.type === 'list')
            eachKeyedField(field.item, visit);
    }
}
export function serviceConfigurationSourceOf(field) {
    if (!('options' in field) || Array.isArray(field.options) || !('serviceConfiguration' in field.options))
        return null;
    return { serviceConfiguration: field.options.serviceConfiguration, labelKey: field.options.labelKey };
}
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Secret);
}
export function withSecrets(fields, values) {
    if (!isPlainObject(values))
        return {};
    const result = { ...values };
    for (const field of valueFieldsOf(fields ?? [])) {
        const value = values[field.key];
        if (field.type === 'secret' && typeof value === 'string')
            result[field.key] = new Secret(value);
        if (field.type === 'list' && Array.isArray(value)) {
            result[field.key] = value.map((item) => (isPlainObject(item) ? withSecrets(field.item, item) : item));
        }
    }
    return result;
}
export function withoutKeys(values, keys) {
    if (!isPlainObject(values))
        return {};
    return Object.fromEntries(Object.entries(values).filter(([key]) => !keys.includes(key)));
}
