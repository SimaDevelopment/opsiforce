import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { checkServiceManifest, formatProblemPath, type ManifestCheck, type ManifestProblem } from './check-manifest.ts';
import { manifestLimits } from './manifest.ts';

export const manifestFileName = 'service.json';

const unsafeSvgContent: [RegExp, string][] = [
  [/<script\b/i, 'contains a <script> element'],
  [/<foreignObject\b/i, 'contains a <foreignObject> element'],
  [/<!(DOCTYPE|ENTITY)\b/i, 'contains a DOCTYPE or ENTITY declaration'],
  [/\son[a-z]+\s*=/i, 'contains an event handler attribute (on…)'],
  [/javascript:/i, 'contains a javascript: URL'],
  [/\bhref\s*=\s*(?!["']?\s*#)/i, 'links outside the icon (only #fragment hrefs are allowed)'],
  [/url\(\s*(?!["']?\s*#)/i, 'loads an outside resource through url()'],
  [/@import\b/i, 'contains an @import'],
];

export function svgIconProblems(svg: string): string[] {
  const problems: string[] = [];
  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[^]*?-->\s*)*<svg[\s>]/i.test(svg)) problems.push('is not an SVG document');
  for (const [pattern, problem] of unsafeSvgContent) {
    if (pattern.test(svg)) problems.push(problem);
  }
  return problems;
}

export interface ServiceFolderRead {
  json: unknown;
  check: ManifestCheck;
}

interface FolderCheck {
  ok: boolean;
  manifest?: { icon?: string };
  problems: ManifestProblem[];
}

export async function readServiceFolder(folder: string): Promise<ServiceFolderRead> {
  return readManifestFolder(folder, checkServiceManifest);
}

export async function checkServiceFolder(folder: string): Promise<ManifestCheck> {
  return (await readServiceFolder(folder)).check;
}

async function readManifestFolder<Check extends FolderCheck>(
  folder: string,
  check: (json: unknown) => Check
): Promise<{ json: unknown; check: Check }> {
  const manifestPath = join(folder, manifestFileName);
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    return refused(`${manifestFileName} not found in ${folder}`);
  }
  const bytes = Buffer.byteLength(raw);
  if (bytes > manifestLimits.maxManifestBytes) {
    return refused(`${manifestFileName} is ${bytes} bytes; the limit is ${manifestLimits.maxManifestBytes}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return refused(`${manifestFileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const checked = check(json);
  const icon = checked.manifest?.icon;
  if (icon === undefined) return { json, check: checked };

  const iconProblems = await checkIcon(join(folder, icon));
  const problems: ManifestProblem[] = [
    ...checked.problems,
    ...iconProblems.map((message) => ({ severity: 'error' as const, path: formatProblemPath(['icon']), message })),
  ];
  return { json, check: { ...checked, ok: checked.ok && iconProblems.length === 0, problems } };
}

async function checkIcon(iconPath: string): Promise<string[]> {
  let size: number;
  try {
    size = (await stat(iconPath)).size;
  } catch {
    return [`icon file ${iconPath} not found`];
  }
  if (size > manifestLimits.maxIconBytes) {
    return [`icon is ${size} bytes; the limit is ${manifestLimits.maxIconBytes}`];
  }
  return svgIconProblems(await readFile(iconPath, 'utf8')).map((problem) => `icon ${problem}`);
}

function refused<Check extends FolderCheck>(message: string): { json: unknown; check: Check } {
  return { json: undefined, check: { ok: false, problems: [{ severity: 'error', path: '', message }] } as Check };
}
