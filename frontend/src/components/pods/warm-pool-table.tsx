import { For, Show } from 'solid-js';
import { Link } from '@tanstack/solid-router';
import type { WarmPoolAgent, WarmPoolSlot } from '~/api/pods';
import { Bot, ExternalLink, Layers } from '~/components/icons';
import { Badge } from '~/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { formatDuration } from '~/lib/format-duration';
import { describePodSettings } from '~/lib/pod-resources';
import { cn } from '~/lib/cn';
import { statusVisual } from './pod-status-cell';

const PAUSE_LABELS: Record<NonNullable<WarmPoolAgent['paused']>, string> = {
  disabled: 'Paused: agent disabled',
  not_published: 'Paused: not published to its default environment',
};

function readyCount(agent: WarmPoolAgent): number {
  return agent.slots.filter((slot) => !slot.claiming && slot.status?.ready).length;
}

function slotVisual(slot: WarmPoolSlot) {
  if (slot.claiming) return { dot: 'bg-indigo-500', label: 'Being claimed' };
  if (!slot.status) return { dot: 'bg-muted-foreground/40', label: 'No pod' };
  return statusVisual(slot.status);
}

export function WarmPoolTable(props: { agents: WarmPoolAgent[] }) {
  return (
    <section class="mt-8">
      <div class="mb-1 flex items-center gap-3">
        <Layers class="h-4 w-4 text-muted-foreground" />
        <h2 class="text-sm font-semibold">Ready Projects</h2>
        <Badge variant="secondary" class="px-1.5 py-0 text-[10px]">
          {props.agents.reduce((sum, agent) => sum + agent.slots.length, 0)}
        </Badge>
      </div>
      <p class="mb-3 ml-7 text-xs text-muted-foreground">
        Projects your agents keep ready ahead of time. Each holds a pod at its agent's Resources until someone creates a
        Project from that agent.
      </p>

      <div class="overflow-hidden rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="min-w-48">Pod</TableHead>
              <TableHead class="w-44">Status</TableHead>
              <TableHead class="w-20">Age</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <For each={props.agents}>
              {(agent) => (
                <>
                  <TableRow class="border-b-0 hover:bg-transparent">
                    <TableCell colspan={3} class="bg-muted/40 py-2">
                      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <Bot class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span class="truncate text-sm font-medium">{agent.displayName ?? agent.agentName}</span>
                        <span class="text-xs tabular-nums text-muted-foreground">
                          {readyCount(agent)} of {agent.effectiveSize} up
                        </span>
                        <Badge variant="outline" class="text-[11px] font-normal tabular-nums">
                          {describePodSettings(agent.resources)}
                        </Badge>
                        <Show when={agent.paused}>
                          {(paused) => <span class="text-[11px] text-amber-600">{PAUSE_LABELS[paused()]}</span>}
                        </Show>
                        <Show when={!agent.paused && agent.effectiveSize < agent.warmPoolSize}>
                          <span class="text-[11px] text-muted-foreground">
                            Capped at {agent.effectiveSize} of {agent.warmPoolSize} by the platform
                          </span>
                        </Show>
                        <Tooltip>
                          <TooltipTrigger as="span" class="ml-auto shrink-0">
                            <Link
                              to="/store/agents/$id"
                              params={{ id: agent.agentId }}
                              class="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                              aria-label="Open agent"
                            >
                              <ExternalLink class="h-3.5 w-3.5" />
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent>Open agent</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                  <Show
                    when={agent.slots.length > 0}
                    fallback={
                      <TableRow class="hover:bg-transparent">
                        <TableCell colspan={3} class="text-xs text-muted-foreground">
                          {agent.paused ? 'None kept ready while paused.' : 'Starting Ready Projects…'}
                        </TableCell>
                      </TableRow>
                    }
                  >
                    <For each={agent.slots}>
                      {(slot) => {
                        const visual = () => slotVisual(slot);
                        return (
                          <TableRow>
                            <TableCell class="font-mono text-[11px] text-muted-foreground">{slot.podName}</TableCell>
                            <TableCell>
                              <span class="inline-flex items-center gap-1.5 text-xs">
                                <span class={cn('size-1.5 rounded-full', visual().dot)} />
                                {visual().label}
                              </span>
                            </TableCell>
                            <TableCell class="text-xs tabular-nums text-muted-foreground">
                              {slot.ageMs === null ? '—' : formatDuration(slot.ageMs)}
                            </TableCell>
                          </TableRow>
                        );
                      }}
                    </For>
                  </Show>
                </>
              )}
            </For>
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
