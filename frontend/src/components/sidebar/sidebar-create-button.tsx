import { type JSX } from 'solid-js';
import { Plus } from '~/components/icons';

const REVEAL_CLASS = {
  workspace:
    'opacity-0 group-hover/wsrow:opacity-100 pointer-coarse:opacity-100 data-[expanded]:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded-sm hover:bg-accent',
  folder:
    'opacity-0 group-hover/folderrow:opacity-100 pointer-coarse:opacity-100 data-[expanded]:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded-sm hover:bg-accent',
} as const;

export function SidebarCreateButton(props: {
  title: string;
  variant?: keyof typeof REVEAL_CLASS;
  renderCreate: (renderTrigger: (triggerProps: Record<string, unknown>) => JSX.Element) => JSX.Element;
}) {
  return (
    <span class="contents" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {props.renderCreate((triggerProps) => (
        <button {...triggerProps} class={REVEAL_CLASS[props.variant ?? 'workspace']} title={props.title}>
          <Plus class="w-3.5 h-3.5" />
        </button>
      ))}
    </span>
  );
}
