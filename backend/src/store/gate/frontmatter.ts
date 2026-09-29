export type FrontmatterEntry = {
  key: string;
  value: string;
  line: number;
  endLine: number;
  block: boolean;
};

export type ParsedFrontmatter = {
  present: boolean;
  malformed: boolean;
  entries: FrontmatterEntry[];
  closingLine: number;
  bodyStartLine: number;
};

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = splitLines(text);
  const empty: ParsedFrontmatter = {
    present: false,
    malformed: false,
    entries: [],
    closingLine: 0,
    bodyStartLine: 1,
  };
  if (lines.length === 0 || lines[0].trimEnd() !== '---') return empty;

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trimEnd();
    if (trimmed === '---' || trimmed === '...') {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    return { present: true, malformed: true, entries: [], closingLine: 0, bodyStartLine: lines.length + 1 };
  }

  const entries: FrontmatterEntry[] = [];
  let malformed = false;
  let current: FrontmatterEntry | null = null;
  const pending: string[] = [];

  const flush = (): void => {
    if (!current) return;
    if (pending.length > 0) {
      const joined = current.block
        ? dedent(pending).join('\n')
        : [current.value, ...pending.map((line) => line.trim())].filter((part) => part.length > 0).join(' ');
      current.value = joined;
    }
    current.value = unquote(current.value);
    entries.push(current);
    pending.length = 0;
    current = null;
  };

  for (let i = 1; i < closingIndex; i += 1) {
    const raw = lines[i];
    if (raw.trim().length === 0) {
      if (current && current.block) pending.push(raw);
      continue;
    }
    if (/^\s*#/.test(raw)) continue;

    if (/^\s/.test(raw) || raw.startsWith('-')) {
      if (!current) {
        malformed = true;
        continue;
      }
      current.endLine = i + 1;
      pending.push(raw);
      continue;
    }

    const match = KEY_LINE.exec(raw);
    if (!match) {
      malformed = true;
      continue;
    }
    flush();
    const scalar = (match[2] ?? '').trim();
    const block = scalar === '|' || scalar === '>' || scalar === '|-' || scalar === '>-';
    current = {
      key: match[1],
      value: block ? '' : scalar,
      line: i + 1,
      endLine: i + 1,
      block,
    };
  }
  flush();

  return {
    present: true,
    malformed,
    entries,
    closingLine: closingIndex + 1,
    bodyStartLine: closingIndex + 2,
  };
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => line.length - line.trimStart().length);
  const shift = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shift));
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  return value;
}
