import type { JSX } from 'solid-js';
import type { ResizablePanel } from '~/lib/create-resizable-panel';
import { cn } from '~/lib/cn';

const STEP = 16;
const BIG_STEP = 64;

export function ResizeHandle(props: {
  onPointerDown: (e: PointerEvent) => void;
  resizing: boolean;
  position: 'left' | 'right';
  panel?: ResizablePanel;
  label?: string;
  class?: string;
}): JSX.Element {
  const onKeyDown = (event: KeyboardEvent) => {
    const panel = props.panel;
    if (!panel) return;
    const step = event.shiftKey ? BIG_STEP : STEP;
    const widening = props.position === 'right' ? 'ArrowRight' : 'ArrowLeft';
    const narrowing = props.position === 'right' ? 'ArrowLeft' : 'ArrowRight';
    if (event.key === widening) panel.nudge(step);
    else if (event.key === narrowing) panel.nudge(-step);
    else if (event.key === 'Home') panel.setWidth(panel.minWidth());
    else if (event.key === 'End') panel.setWidth(panel.maxWidth());
    else if (event.key === 'Enter') panel.reset();
    else return;
    event.preventDefault();
  };

  return (
    <div
      onPointerDown={props.onPointerDown}
      onDblClick={() => props.panel?.reset()}
      onKeyDown={onKeyDown}
      role={props.panel ? 'separator' : undefined}
      aria-orientation={props.panel ? 'vertical' : undefined}
      aria-label={props.panel ? (props.label ?? 'Resize') : undefined}
      aria-valuenow={props.panel?.width()}
      aria-valuemin={props.panel?.minWidth()}
      aria-valuemax={props.panel?.maxWidth()}
      tabindex={props.panel ? 0 : undefined}
      class={cn(
        'group absolute top-0 h-full w-2 cursor-col-resize touch-none select-none z-10 outline-none',
        props.position === 'left' ? 'left-0' : 'right-0',
        props.class
      )}
      title={props.panel ? `Drag to resize (${props.panel.width()}px) · double-click to reset` : 'Drag to resize'}
    >
      <div
        class={cn(
          'absolute inset-y-0 w-px transition-colors group-hover:bg-primary/60 group-active:bg-primary group-focus-visible:bg-primary',
          props.position === 'left' ? 'left-0' : 'right-0',
          props.resizing && 'bg-primary'
        )}
      />
    </div>
  );
}
