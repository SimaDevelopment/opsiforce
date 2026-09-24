import {
  createRoot,
  createSignal,
  createEffect,
  onCleanup,
  Show,
  splitProps,
  type ParentProps,
  type Accessor,
} from 'solid-js';
import { cn } from '~/lib/cn';
import { createResizablePanel, type ResizablePanel } from '~/lib/create-resizable-panel';
import { createPersistedSignal } from '~/lib/persisted-signal';
import { ResizeHandle } from './resize-handle';
import { Button } from './button';
import { PanelLeft } from '~/components/icons';

type SidebarState = 'expanded' | 'collapsed';

interface SidebarStore {
  state: Accessor<SidebarState>;
  open: Accessor<boolean>;
  setOpen: (open: boolean) => void;
  openMobile: Accessor<boolean>;
  setOpenMobile: (open: boolean) => void;
  isMobile: Accessor<boolean>;
  toggleSidebar: () => void;
  sidebarResize: ResizablePanel;
}

function createIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = createSignal(typeof window !== 'undefined' ? window.innerWidth < breakpoint : false);
  createEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    onCleanup(() => mql.removeEventListener('change', handler));
  });
  return isMobile;
}

let _store: SidebarStore | null = null;

function initStore(): SidebarStore {
  return createRoot(() => {
    const isMobile = createIsMobile();
    const [openMobile, setOpenMobile] = createSignal(false);

    const [_open, _setOpen] = createPersistedSignal<boolean>('sidebar:state', true, {
      serialize: (v) => String(v),
      deserialize: (raw) => raw === 'true',
    });

    const state = (): SidebarState => (_open() ? 'expanded' : 'collapsed');

    const toggleSidebar = () => {
      if (isMobile()) setOpenMobile(!openMobile());
      else _setOpen(!_open());
    };

    const sidebarResize = createResizablePanel({
      storageKey: 'opsiforce:sidebar-width',
      minWidth: 200,
      defaultWidth: 256,
      maxWidth: () => Math.round(window.innerWidth * 0.5),
      direction: 'right',
    });

    createEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'b' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          toggleSidebar();
        }
      };
      window.addEventListener('keydown', handler);
      onCleanup(() => window.removeEventListener('keydown', handler));
    });

    return { state, open: _open, setOpen: _setOpen, openMobile, setOpenMobile, isMobile, toggleSidebar, sidebarResize };
  });
}

export function useSidebar(): SidebarStore {
  if (!_store) _store = initStore();
  return _store;
}

export function Sidebar(
  props: ParentProps<{
    collapsible?: 'icon' | 'offcanvas' | 'none';
    class?: string;
  }>
) {
  const [local] = splitProps(props, ['collapsible', 'class', 'children']);
  const { isMobile, state, openMobile, setOpenMobile, sidebarResize } = useSidebar();
  const collapsible = () => local.collapsible ?? 'icon';

  const sidebarWidth = () =>
    !isMobile() && state() === 'collapsed' && collapsible() === 'icon'
      ? 'var(--sidebar-width-icon)'
      : 'var(--sidebar-width)';

  const showResizeHandle = () => !isMobile() && state() === 'expanded';

  return (
    <>
      <Show when={isMobile()}>
        <div
          class={cn(
            'fixed inset-0 z-50 bg-black/60 transition-opacity duration-200',
            openMobile() ? 'opacity-100' : 'opacity-0 pointer-events-none'
          )}
          onClick={() => setOpenMobile(false)}
        />
      </Show>

      <aside
        class={cn(
          'group/sidebar relative flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border overflow-hidden',
          isMobile()
            ? cn(
                'fixed inset-y-0 left-0 z-50 shadow-xl transition-transform duration-200 ease-in-out',
                openMobile() ? 'translate-x-0' : '-translate-x-full'
              )
            : sidebarResize.resizing()
              ? 'shrink-0'
              : 'shrink-0 transition-[width] duration-200 ease-linear',
          local.class
        )}
        style={{ width: isMobile() ? 'var(--sidebar-width)' : sidebarWidth() }}
        data-state={isMobile() ? 'expanded' : state()}
        data-collapsible={!isMobile() && state() === 'collapsed' ? collapsible() : ''}
      >
        {local.children}
        <Show when={showResizeHandle()}>
          <ResizeHandle
            onPointerDown={sidebarResize.startResize}
            resizing={sidebarResize.resizing()}
            position="right"
          />
        </Show>
      </aside>
    </>
  );
}

export function SidebarHeader(props: ParentProps<{ class?: string }>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <div class={cn('flex flex-col gap-2 p-2 shrink-0', local.class)} {...rest}>
      {local.children}
    </div>
  );
}

export function SidebarContent(props: ParentProps<{ class?: string }>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <div class={cn('flex-1 overflow-y-auto overflow-x-hidden sidebar-scroll', local.class)} {...rest}>
      {local.children}
    </div>
  );
}

export function SidebarFooter(props: ParentProps<{ class?: string }>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <div class={cn('flex flex-col gap-2 p-2 shrink-0', local.class)} {...rest}>
      {local.children}
    </div>
  );
}

export function SidebarSeparator(props: { class?: string }) {
  return <div class={cn('mx-2 h-px bg-sidebar-border shrink-0', props.class)} />;
}

export function SidebarGroup(props: ParentProps<{ class?: string }>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <div class={cn('flex flex-col gap-1 px-2 py-2', local.class)} {...rest}>
      {local.children}
    </div>
  );
}

export function SidebarGroupLabel(props: ParentProps<{ class?: string }>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <div
      class={cn(
        'flex items-center justify-between px-2 text-xs font-medium text-sidebar-muted-foreground',
        'group-data-[collapsible=icon]/sidebar:hidden',
        local.class
      )}
      {...rest}
    >
      {local.children}
    </div>
  );
}

export function SidebarGroupAction(
  props: ParentProps<{
    class?: string;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
  }>
) {
  const [local, rest] = splitProps(props, ['class', 'children', 'onClick', 'disabled', 'title']);
  return (
    <button
      class={cn(
        'inline-flex items-center justify-center rounded-md h-5 w-5 text-sidebar-muted-foreground transition-colors',
        'hover:text-sidebar-foreground hover:bg-sidebar-accent',
        'disabled:pointer-events-none disabled:opacity-50',
        local.class
      )}
      onClick={local.onClick}
      disabled={local.disabled}
      title={local.title}
      {...rest}
    >
      {local.children}
    </button>
  );
}

export function SidebarGroupContent(props: ParentProps<{ class?: string }>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <div class={cn('flex flex-col gap-0.5', local.class)} {...rest}>
      {local.children}
    </div>
  );
}

export function SidebarMenu(props: ParentProps<{ class?: string }>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <ul class={cn('flex flex-col gap-0.5', local.class)} {...rest}>
      {local.children}
    </ul>
  );
}

export function SidebarMenuItem(props: ParentProps<{ class?: string }>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <li class={cn('list-none', local.class)} {...rest}>
      {local.children}
    </li>
  );
}

export function SidebarMenuButton(
  props: ParentProps<{
    class?: string;
    isActive?: boolean;
    onClick?: (e: MouseEvent) => void;
    disabled?: boolean;
    title?: string;
  }>
) {
  const [local, rest] = splitProps(props, ['class', 'children', 'isActive', 'onClick', 'disabled']);
  return (
    <button
      class={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        'focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        'group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:px-2 group-data-[collapsible=icon]/sidebar:py-2',
        local.isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium' : 'text-sidebar-foreground',
        local.class
      )}
      onClick={local.onClick}
      disabled={local.disabled}
      {...rest}
    >
      {local.children}
    </button>
  );
}

export function SidebarTrigger(props: { class?: string }) {
  const { toggleSidebar } = useSidebar();
  return (
    <Button variant="ghost" size="icon" class={cn('h-7 w-7', props.class)} onClick={toggleSidebar}>
      <PanelLeft class="h-4 w-4" />
      <span class="sr-only">Toggle sidebar</span>
    </Button>
  );
}
