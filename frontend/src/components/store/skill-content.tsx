import { For, Show, createMemo } from 'solid-js';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { SkillFile } from '~/api/skills';
import { cn } from '~/lib/cn';
import { FOCUS_RING } from './store-list';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface Manifest {
  frontmatter: string | null;
  body: string;
}

function splitFrontmatter(text: string): Manifest {
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function SkillContent(props: { files: SkillFile[]; selected: string; onSelect: (path: string) => void }) {
  const ordered = createMemo(() =>
    props.files.toSorted((left, right) => {
      if (left.path === 'SKILL.md') return -1;
      if (right.path === 'SKILL.md') return 1;
      return left.path.localeCompare(right.path);
    })
  );
  const open = createMemo(() => ordered().find((file) => file.path === props.selected) ?? ordered()[0]);

  return (
    <div class="space-y-2">
      <fieldset class="flex flex-wrap gap-1 border-0 p-0">
        <legend class="sr-only">Files in this version</legend>
        <For each={ordered()}>
          {(file) => {
            const selected = () => open()?.path === file.path;
            return (
              <button
                type="button"
                aria-pressed={selected()}
                onClick={() => props.onSelect(file.path)}
                class={cn(
                  'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                  FOCUS_RING,
                  selected()
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-accent'
                )}
              >
                {file.path}
              </button>
            );
          }}
        </For>
      </fieldset>
      <Show when={open()} fallback={<EmptyTree />}>
        {(file) => <FileBody file={file()} />}
      </Show>
    </div>
  );
}

function EmptyTree() {
  return (
    <div class="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      This version has no files.
    </div>
  );
}

function FileBody(props: { file: SkillFile }) {
  const isMarkdown = () => props.file.path.toLowerCase().endsWith('.md');
  return (
    <Show when={!props.file.isBinary} fallback={<BinaryFile size={props.file.size} />}>
      <Show when={isMarkdown()} fallback={<CodeFile content={props.file.content} />}>
        <MarkdownFile content={props.file.content} />
      </Show>
    </Show>
  );
}

function BinaryFile(props: { size: number }) {
  return (
    <div class="rounded-md border border-border bg-muted/40 px-4 py-6 text-center text-sm text-muted-foreground">
      Binary, {kilobytes(props.size)}. Export the skill to read it.
    </div>
  );
}

function CodeFile(props: { content: string }) {
  return (
    <pre class="max-h-[32rem] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
      {props.content}
    </pre>
  );
}

function MarkdownFile(props: { content: string }) {
  const parts = createMemo(() => splitFrontmatter(props.content));
  return (
    <div class="max-h-[32rem] overflow-auto rounded-md border border-border bg-card p-4">
      <Show when={parts().frontmatter}>
        {(frontmatter) => (
          <pre class="mb-4 overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {frontmatter()}
          </pre>
        )}
      </Show>
      {/* oxlint-disable-next-line solid/no-innerhtml -- DOMPurify output, never raw file text */}
      <div class="skill-markdown" innerHTML={renderMarkdown(parts().body)} />
    </div>
  );
}
