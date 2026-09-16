export const PUBLIC_API_PREFIX = '/api/v1';

export function isPublicApiPath(url: string): boolean {
  if (!url.startsWith(PUBLIC_API_PREFIX)) return false;
  const next = url.charAt(PUBLIC_API_PREFIX.length);
  return next === '' || next === '/' || next === '?';
}
