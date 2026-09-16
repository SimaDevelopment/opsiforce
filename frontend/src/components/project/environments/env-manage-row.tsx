import { Show } from 'solid-js';
import {
  Cable,
  Calendar,
  Check,
  EllipsisVertical,
  Rocket,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from '~/components/icons';
import { cn } from '~/lib/cn';
import { appPublicUrl } from '~/lib/app-url';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Button } from '~/components/ui/button';
import { EnvStatusDot } from './env-status-dot';
import { EnvAppLinkButtons } from './env-app-link-buttons';
import type { ProjectEnvironment } from '~/api/environments';

export interface EnvManageRowProps {
  environment: ProjectEnvironment;
  active: boolean;
  onSelect: () => void;
  hasApp: boolean;
  canManageAuth: boolean;
  canRestart: boolean;
  canDelete: boolean;
  canPublish: boolean;
  canManageVariables: boolean;
  canSchedules: boolean;
  canManageExternalServices: boolean;
  restarting: boolean;
  onAuth: () => void;
  onSchedules: () => void;
  onExternalServices: () => void;
  onRestart: () => void;
  onDelete: () => void;
  onPublish: () => void;
  onVariables: () => void;
}

export function EnvManageRow(props: EnvManageRowProps) {
  const env = () => props.environment;
  const isDevelopment = () => env().isDefault;
  const canDeleteEnv = () => props.canDelete && !isDevelopment();
  const canRestartEnv = () => props.canRestart && env().status !== 'disabled';
  const showPublish = () => props.canPublish && !isDevelopment() && props.hasApp;

  const appRunning = () => (isDevelopment() ? props.hasApp : env().deployedCommitSha !== null);
  const appUrl = () => appPublicUrl(env().id, env().slug);

  return (
    <div
      class={cn(
        'col-span-full grid cursor-pointer grid-cols-subgrid items-center rounded-md border border-transparent px-2.5 py-2 transition-colors hover:bg-accent/50',
        props.active && 'bg-accent/40'
      )}
      role="button"
      tabIndex={0}
      onClick={() => props.onSelect()}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') props.onSelect();
      }}
    >
      <span class="flex min-w-0 items-center gap-1.5">
        <Check class={cn('h-3.5 w-3.5 shrink-0 text-primary', !props.active && 'invisible')} />
        <span class="truncate text-xs font-semibold text-foreground" title={env().name}>
          {env().name}
        </span>
      </span>
      <span class="contents" onClick={(e) => e.stopPropagation()}>
        <EnvAppLinkButtons
          appUrl={appUrl()}
          enabled={appRunning()}
          disabledReason={isDevelopment() ? 'No app is running here yet' : 'Publish first — no app is running here yet'}
        />
      </span>
      <div class="flex min-w-0 items-center gap-2">
        <EnvStatusDot status={env().status} withLabel />
      </div>
      <div class="flex shrink-0 items-center gap-1.5 justify-self-end" onClick={(e) => e.stopPropagation()}>
        <Show when={showPublish()}>
          <Button size="sm" variant="outline" class="h-7 px-2.5" onClick={() => props.onPublish()}>
            <Rocket class="h-3.5 w-3.5" />
            {env().deployedCommitSha !== null ? 'Publish update' : 'Publish'}
          </Button>
        </Show>
        <DropdownMenu>
          <DropdownMenuTrigger
            class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={props.restarting}
            aria-label="Environment actions"
          >
            <EllipsisVertical class="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <Show when={props.canManageAuth}>
              <DropdownMenuItem onSelect={() => props.onAuth()}>
                <ShieldCheck class="h-3.5 w-3.5 text-muted-foreground" />
                Auth
              </DropdownMenuItem>
            </Show>
            <Show when={props.canManageVariables}>
              <DropdownMenuItem onSelect={() => props.onVariables()}>
                <SlidersHorizontal class="h-3.5 w-3.5 text-muted-foreground" />
                Environment variables
              </DropdownMenuItem>
            </Show>
            <Show when={props.canSchedules}>
              <DropdownMenuItem onSelect={() => props.onSchedules()}>
                <Calendar class="h-3.5 w-3.5 text-muted-foreground" />
                Schedules
              </DropdownMenuItem>
            </Show>
            <Show when={props.canManageExternalServices}>
              <DropdownMenuItem onSelect={() => props.onExternalServices()}>
                <Cable class="h-3.5 w-3.5 text-muted-foreground" />
                External services
              </DropdownMenuItem>
            </Show>
            <Show when={canRestartEnv()}>
              <DropdownMenuItem onSelect={() => props.onRestart()}>
                <RotateCcw class="h-3.5 w-3.5 text-muted-foreground" />
                Restart
              </DropdownMenuItem>
            </Show>
            <Show when={canDeleteEnv()}>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                class="text-destructive data-[highlighted]:text-destructive"
                onSelect={() => props.onDelete()}
              >
                <Trash2 class="h-3.5 w-3.5 text-destructive" />
                Delete
              </DropdownMenuItem>
            </Show>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
