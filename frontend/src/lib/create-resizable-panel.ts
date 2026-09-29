import { createMemo, createSignal, onMount, onCleanup, type Accessor } from 'solid-js';

export interface ResizablePanelOptions {
  storageKey: string;
  minWidth: number | (() => number);
  defaultWidth: number | (() => number);
  maxWidth: () => number;
  direction: 'left' | 'right';
}

export interface ResizablePanel {
  width: Accessor<number>;
  resizing: Accessor<boolean>;
  startResize: (event: PointerEvent) => void;
  minWidth: Accessor<number>;
  maxWidth: Accessor<number>;
  nudge: (delta: number) => void;
  setWidth: (width: number) => void;
  reset: () => void;
}

const RESIZING_CLASS = 'panel-resizing';

function resolve(value: number | (() => number)): number {
  return typeof value === 'function' ? value() : value;
}

export function createResizablePanel(options: ResizablePanelOptions): ResizablePanel {
  function clamp(width: number) {
    const min = resolve(options.minWidth);
    return Math.min(Math.max(width, min), Math.max(min, options.maxWidth()));
  }

  function readStored(): number | null {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem(options.storageKey);
    const parsed = stored === null ? NaN : Number(stored);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const [chosen, setChosen] = createSignal<number | null>(readStored());
  const [viewport, setViewport] = createSignal(0);
  const [resizing, setResizing] = createSignal(false);

  const width = createMemo(() => {
    viewport();
    return clamp(chosen() ?? resolve(options.defaultWidth));
  });

  function startResize(event: PointerEvent) {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement | null;
    const pointerId = event.pointerId;
    try {
      target?.setPointerCapture?.(pointerId);
    } catch {}
    setResizing(true);
    document.documentElement.classList.add(RESIZING_CLASS);
    const startX = event.clientX;
    const rendered = target?.parentElement?.getBoundingClientRect().width;
    const startWidth = rendered ? clamp(Math.round(rendered)) : width();

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const delta = options.direction === 'left' ? startX - e.clientX : e.clientX - startX;
      setChosen(clamp(Math.round(startWidth + delta)));
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      setResizing(false);
      document.documentElement.classList.remove(RESIZING_CLASS);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (Math.abs(width() - startWidth) >= 1) window.localStorage.setItem(options.storageKey, String(width()));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  function persist(next: number) {
    setChosen(next);
    window.localStorage.setItem(options.storageKey, String(next));
  }

  const setWidth = (next: number) => persist(clamp(next));
  const nudge = (delta: number) => setWidth(width() + delta);
  const reset = () => {
    setChosen(null);
    window.localStorage.removeItem(options.storageKey);
  };
  const minWidth = () => resolve(options.minWidth);
  const maxWidth = () => Math.max(minWidth(), options.maxWidth());

  const onWindowResize = () => setViewport((tick) => tick + 1);
  onMount(() => window.addEventListener('resize', onWindowResize));
  onCleanup(() => window.removeEventListener('resize', onWindowResize));

  return { width, resizing, startResize, minWidth, maxWidth, nudge, setWidth, reset };
}
