import { For, Index, Match, Switch, type JSX } from 'solid-js';
import { cn } from '~/lib/cn';

type HelpPiece =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^)\s]+\))/g;
const LINK_PATTERN = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/;

function piecesOf(line: string): HelpPiece[] {
  return line
    .split(INLINE_PATTERN)
    .filter((part) => part !== '')
    .map((part): HelpPiece => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        return { kind: 'bold', text: part.slice(2, -2) };
      }
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
        return { kind: 'code', text: part.slice(1, -1) };
      const link = LINK_PATTERN.exec(part);
      if (link) return { kind: 'link', text: link[1] ?? '', href: link[2] ?? '' };
      return { kind: 'text', text: part };
    });
}

function HelpPieceView(props: { piece: HelpPiece }): JSX.Element {
  const link = () => (props.piece.kind === 'link' ? props.piece : undefined);
  return (
    <Switch fallback={props.piece.text}>
      <Match when={props.piece.kind === 'bold'}>
        <strong class="font-medium text-foreground">{props.piece.text}</strong>
      </Match>
      <Match when={props.piece.kind === 'code'}>
        <code class="rounded bg-muted px-1 font-mono text-[10px]">{props.piece.text}</code>
      </Match>
      <Match when={link()}>
        {(anchor) => (
          <a
            href={anchor().href}
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary underline-offset-2 hover:underline"
          >
            {anchor().text}
          </a>
        )}
      </Match>
    </Switch>
  );
}

export function HelpText(props: { text: string; class?: string }) {
  const lines = () => props.text.split('\n');
  return (
    <span class={cn('text-[11px] leading-relaxed text-muted-foreground', props.class)}>
      <Index each={lines()}>
        {(line, index) => (
          <>
            {index > 0 && <br />}
            <For each={piecesOf(line())}>{(piece) => <HelpPieceView piece={piece} />}</For>
          </>
        )}
      </Index>
    </span>
  );
}
