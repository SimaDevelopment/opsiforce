const PLATFORM_IGNORES = [
  '.config/',
  '.cache/',
  '.bun/',
  '.opencode/',
  '.opsiforce/',
  '.xdg/',
  'node_modules/',
  'data/',
  '/user_uploaded_files/',
  '/generated_files/',
  '**/.yarn/cache',
  '**/.yarn/unplugged',
  '**/.yarn/build-state.yml',
  '**/.yarn/install-state.gz',
  '**/.yarn/sdks',
  '**/.pnp.*',
];
export const CHAT_FILE_FOLDERS = ['user_uploaded_files', 'generated_files'];
const PLATFORM_IGNORES_MARKER = '# platform';

export const WORKSPACE_GITIGNORE = '.gitignore';

/** The same merge the image's init container applies to a workspace `.gitignore`. */
export function withPlatformIgnores(gitignore: string): string {
  const present = new Set(gitignore.split('\n').map((line) => line.trim()));
  const missing = PLATFORM_IGNORES.filter((line) => !present.has(line));
  if (missing.length === 0) return gitignore;
  const lines = present.has(PLATFORM_IGNORES_MARKER) ? missing : [PLATFORM_IGNORES_MARKER, ...missing];
  const separated = gitignore.length === 0 || gitignore.endsWith('\n') ? gitignore : `${gitignore}\n`;
  return `${separated}${lines.join('\n')}\n`;
}
