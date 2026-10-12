export const secretMask = '[secret]';

const inspectCustom = Symbol.for('nodejs.util.inspect.custom');

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return secretMask;
  }

  toString(): string {
    return secretMask;
  }

  [Symbol.toPrimitive](): string {
    return secretMask;
  }

  [inspectCustom](): string {
    return secretMask;
  }
}
