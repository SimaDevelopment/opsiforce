const PLACEHOLDER_SESSION_TITLE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function meaningfulTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (!trimmed || PLACEHOLDER_SESSION_TITLE.test(trimmed)) return null;
  return trimmed;
}
