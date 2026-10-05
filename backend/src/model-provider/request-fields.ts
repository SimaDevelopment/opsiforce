export function field(input: unknown, name: string): unknown {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[name] : undefined;
}

export function isLinkedAccountInput(input: unknown): boolean {
  return field(input, 'kind') === 'linked-account';
}
