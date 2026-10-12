import { operationDefaults } from "./manifest.js";
export const formCallTimeoutSeconds = 10;
export function operationLimitsOf(operation) {
    return {
        inputBytes: operation?.limits?.inputBytes ?? operationDefaults.inputBytes,
        timeoutSeconds: operation?.limits?.timeoutSeconds ?? operationDefaults.timeoutSeconds,
    };
}
export function handlerTimeoutSeconds(manifest, route, name) {
    if (route === 'operations')
        return operationLimitsOf(manifest.operations?.[name ?? '']).timeoutSeconds;
    if (route === 'inbound')
        return operationDefaults.timeoutSeconds;
    return formCallTimeoutSeconds;
}
