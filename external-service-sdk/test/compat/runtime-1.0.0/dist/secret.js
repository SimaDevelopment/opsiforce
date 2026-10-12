export const secretMask = '[secret]';
const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
export class Secret {
    #value;
    constructor(value) {
        this.#value = value;
    }
    reveal() {
        return this.#value;
    }
    toJSON() {
        return secretMask;
    }
    toString() {
        return secretMask;
    }
    [Symbol.toPrimitive]() {
        return secretMask;
    }
    [inspectCustom]() {
        return secretMask;
    }
}
