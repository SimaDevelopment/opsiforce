export const FORM_ANSWER_LIMIT = 2 * 1024 * 1024;

export function bearerTokenOf(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}
