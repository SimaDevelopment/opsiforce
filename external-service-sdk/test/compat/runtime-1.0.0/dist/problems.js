export const problemMediaType = 'application/problem+json';
export const problemTypePrefix = 'urn:opsiforce:error:';
export const serviceErrorStatuses = [400, 404, 409, 422, 429, 502];
const problemCodePattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export function problemType(code) {
    return `${problemTypePrefix}${code}`;
}
export function problemTitle(code) {
    const words = code.split('-').join(' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}
export function problem(fields) {
    const { status, code, title, detail, ...extensions } = fields;
    return {
        type: problemType(code),
        title: title ?? problemTitle(code),
        status,
        code,
        ...(detail === undefined ? {} : { detail }),
        ...extensions,
    };
}
export class ServiceError extends Error {
    status;
    code;
    detail;
    title;
    retryAfterSeconds;
    extensions;
    constructor(options) {
        if (!problemCodePattern.test(options.code)) {
            throw new TypeError(`ServiceError code "${options.code}" must be kebab-case, like card-not-found`);
        }
        super(options.detail ?? problemTitle(options.code));
        this.name = 'ServiceError';
        this.status = options.status;
        this.code = options.code;
        this.detail = options.detail;
        this.title = options.title ?? problemTitle(options.code);
        this.retryAfterSeconds = options.retryAfterSeconds;
        this.extensions = options.extensions ?? {};
    }
    toProblem() {
        return problem({
            ...this.extensions,
            status: this.status,
            code: this.code,
            title: this.title,
            detail: this.detail,
            ...(this.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
        });
    }
}
export function rateLimited(options) {
    return new ServiceError({
        status: 429,
        code: 'rate-limited',
        detail: options.detail ?? 'The outside system is rate limiting calls; retry later.',
        retryAfterSeconds: options.retryAfterSeconds,
    });
}
export function upstreamUnauthorized(detail) {
    return new ServiceError({
        status: 502,
        code: 'upstream-unauthorized',
        detail: detail ?? 'The outside system refused the stored credentials.',
    });
}
