import { eachKeyedField } from "./form-levels.js";
const templateVariablePattern = /\{\{\s*([^{}\s]+)\s*\}\}/g;
export function templateVariablesOf(template) {
    return [...template.matchAll(templateVariablePattern)].map((match) => match[1] ?? '');
}
export function infoTemplateVariablesOf(form) {
    const variables = new Set();
    eachKeyedField(form, (field) => {
        if (field.type === 'info' && field.template !== undefined) {
            for (const variable of templateVariablesOf(field.template))
                variables.add(variable);
        }
    });
    return [...variables];
}
export function renderInfoTemplate(template, valueOf) {
    let blank = false;
    const rendered = template.replace(templateVariablePattern, (_, variable) => {
        const value = valueOf(variable);
        if (value === '')
            blank = true;
        return value;
    });
    return blank ? '' : rendered;
}
