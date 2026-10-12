const JUNK_FOLDERS = new Set(['node_modules', '__MACOSX']);
const JUNK_YARN_FOLDERS = new Set(['cache', 'unplugged', 'sdks']);
const JUNK_YARN_FILES = new Set(['install-state.gz', 'build-state.yml']);

export function isWorkspaceJunk(path: string): boolean {
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';
  if (segments.some((segment) => JUNK_FOLDERS.has(segment))) return true;
  if (name.startsWith('._') || name.startsWith('.pnp.') || name === '.DS_Store') return true;
  return segments.some((segment, index) => {
    if (segment !== '.yarn') return false;
    const next = segments[index + 1] ?? '';
    return JUNK_YARN_FOLDERS.has(next) || (index + 2 === segments.length && JUNK_YARN_FILES.has(next));
  });
}
