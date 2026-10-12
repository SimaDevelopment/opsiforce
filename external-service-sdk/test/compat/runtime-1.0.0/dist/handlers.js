export const fileResultMarker = Symbol.for('opsiforce.external-service.file-result');
export const hookNames = ['onServiceConfigurationSaved', 'onProjectConfigurationSaved'];
export function defineHandlers(handlers) {
    return handlers;
}
