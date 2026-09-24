import { For, Show, createMemo, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { usePublishAgent, useUpdateAgentSettings, type AgentDetail, type AgentProfile } from '~/api/agents';
import { ApiError } from '~/api/client';
import type { Environment } from '~/api/environments';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { EnvironmentBadge } from '~/components/environment-badge';
import { FOCUS_RING } from '~/components/store/store-list';
import { AlertTriangle, Rocket } from '~/components/icons';
import { cn } from '~/lib/cn';
import { driftText, isPublished, profileDiff } from './agent-drift';

function DiffLine(props: { label: string; changed: boolean; children: unknown }) {
  return (
    <div class="flex items-start gap-3 px-3 py-2 text-xs">
      <span
        class={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', props.changed ? 'bg-amber-500' : 'bg-emerald-500')}
        aria-hidden="true"
      />
      <span class="w-14 shrink-0 text-muted-foreground">{props.label}</span>
      <span class="min-w-0 flex-1 text-foreground">{props.children as never}</span>
    </div>
  );
}

function modelLabel(profile: AgentProfile): string {
  return profile.variant ? `${profile.model} · ${profile.variant}` : (profile.model ?? '—');
}

export function PublishAgentDialog(props: {
  agent: AgentDetail;
  environments: Environment[];
  development: AgentProfile | undefined;
  targets: Environment[];
  profileFor: (environmentId: string) => AgentProfile | undefined;
  preselect?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [picked, setPicked] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const publish = usePublishAgent(() => props.agent.id);

  const chosen = () => picked() ?? props.preselect ?? null;
  const target = createMemo(() => {
    const id = chosen();
    const found = id ? props.profileFor(id) : undefined;
    return isPublished(found) ? found : undefined;
  });
  const targetName = () => props.targets.find((environment) => environment.id === chosen())?.name ?? '';
  const diff = createMemo(() => (props.development ? profileDiff(props.development, target()) : undefined));
  const replaces = () => target() !== undefined;
  const identical = () => replaces() && (diff()?.empty ?? false);
  /** Both halves of the diff, or nothing while a target has not been picked. */
  const ready = createMemo(() => {
    const development = props.development;
    const changes = diff();
    return chosen() && development && changes ? { development, changes } : undefined;
  });

  const close = () => {
    props.onOpenChange(false);
    setPicked(null);
    setError(null);
  };

  const confirm = async () => {
    const environmentId = chosen();
    if (!environmentId) return;
    setError(null);
    try {
      await publish.mutateAsync(environmentId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The agent could not be published.');
      return;
    }
    const name = targetName();
    close();
    toast.success(`Published to ${name}`);
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && close()}>
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish {props.agent.displayName ?? props.agent.name}</DialogTitle>
          <DialogDescription>
            Pick an environment to copy the Development definition onto. Projects already created there keep what they
            have.
          </DialogDescription>
        </DialogHeader>

        <div class="mt-4 space-y-4">
          <Show when={props.targets.length === 0}>
            <p class="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              This organization has only the Development environment, so there is nowhere to publish to yet.
            </p>
          </Show>
          <div class="space-y-1.5" role="radiogroup" aria-label="Target environment">
            <For each={props.targets}>
              {(environment) => {
                const published = () => isPublished(props.profileFor(environment.id));
                const status = () => driftText(props.development, props.profileFor(environment.id));
                const stale = () => published() && status() !== 'Same as Development';
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={chosen() === environment.id}
                    onClick={() => {
                      setPicked(environment.id);
                      setError(null);
                    }}
                    class={cn(
                      'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                      FOCUS_RING,
                      chosen() === environment.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'
                    )}
                  >
                    <span class="inline-flex items-center gap-1.5">
                      <EnvironmentBadge environment={environment} />
                      <span class="text-xs font-medium text-foreground">{environment.name}</span>
                    </span>
                    <span class={cn('text-right text-xs', stale() ? 'text-amber-700' : 'text-muted-foreground')}>
                      {status()}
                    </span>
                  </button>
                );
              }}
            </For>
          </div>

          <Show when={ready()}>
            {(shown) => {
              const development = () => shown().development;
              const changes = () => shown().changes;
              return (
                <div class="space-y-3">
                  <div class="overflow-hidden rounded-lg border border-border">
                    <div class="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                      {replaces() ? `What changes in ${targetName()}` : `What ${targetName()} will receive`}
                    </div>
                    <div class="divide-y divide-border">
                      <DiffLine label="Prompt" changed={changes().promptChanged}>
                        <Show when={changes().promptChanged} fallback="Same">
                          {replaces()
                            ? 'Rewritten from Development'
                            : `${(development().promptBody ?? '').split('\n').length} lines`}
                        </Show>
                      </DiffLine>
                      <DiffLine label="Model" changed={changes().modelChanged}>
                        <Show when={changes().modelChanged} fallback="Same">
                          <Show when={target()} fallback={modelLabel(development())}>
                            {(previous) => (
                              <>
                                <span class="text-muted-foreground line-through">{modelLabel(previous())}</span> →{' '}
                                {modelLabel(development())}
                              </>
                            )}
                          </Show>
                        </Show>
                      </DiffLine>
                      <DiffLine label="Skills" changed={changes().skillsChanged}>
                        <Show when={changes().skillsChanged} fallback="Same">
                          <span class="flex flex-wrap gap-1">
                            <For each={changes().added}>
                              {(skill) => (
                                <Badge variant="success" class="font-mono font-normal">
                                  + {skill.name} v{skill.pinnedVersion}
                                </Badge>
                              )}
                            </For>
                            <For each={changes().removed}>
                              {(skill) => (
                                <Badge variant="destructive" class="font-mono font-normal">
                                  − {skill.name}
                                </Badge>
                              )}
                            </For>
                            <For each={changes().repinned}>
                              {(entry) => (
                                <Badge variant="warning" class="font-mono font-normal">
                                  {entry.skill.name} v{entry.fromVersion} → v{entry.toVersion}
                                </Badge>
                              )}
                            </For>
                          </span>
                        </Show>
                      </DiffLine>
                    </div>
                  </div>

                  <Show when={replaces() && !changes().empty}>
                    <p class="flex gap-2 text-xs text-muted-foreground">
                      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
                      No copy of the current {targetName()} definition is kept. To go back, you republish from
                      Development.
                    </p>
                  </Show>
                  <Show when={identical()}>
                    <p class="text-xs text-muted-foreground">
                      Already identical to Development — publishing changes nothing.
                    </p>
                  </Show>
                </div>
              );
            }}
          </Show>

          <Show when={error()}>
            <p class="text-xs text-destructive" role="alert">
              {error()}
            </p>
          </Show>

          <NewProjectsSetting agent={props.agent} environments={props.environments} profileFor={props.profileFor} />
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
            Close
          </Button>
          <Show when={props.targets.length > 0}>
            <Button size="sm" disabled={!chosen() || identical() || publish.isPending} onClick={() => void confirm()}>
              <Rocket class="h-3.5 w-3.5" aria-hidden="true" />
              {chosen() ? `Publish to ${targetName()}` : 'Publish'}
            </Button>
          </Show>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewProjectsSetting(props: {
  agent: AgentDetail;
  environments: Environment[];
  profileFor: (environmentId: string) => AgentProfile | undefined;
}) {
  const updateSettings = useUpdateAgentSettings(() => props.agent.id);
  const chosen = () =>
    props.environments.find((environment) => environment.id === props.agent.settings.defaultEnvironmentId) ?? null;
  const offered = () => isPublished(props.profileFor(props.agent.settings.defaultEnvironmentId ?? ''));

  const choose = async (environment: Environment) => {
    try {
      await updateSettings.mutateAsync(environment.id);
      toast.success(`New projects start from ${environment.name}`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'The setting could not be saved.');
    }
  };

  return (
    <div class="rounded-lg border border-border">
      <div class="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <label for="agent-default-environment" class="text-xs font-medium text-foreground">
            New projects start from
          </label>
          <div class="mt-0.5 text-xs text-muted-foreground">
            A project copies this environment's definition once, when it is created, and keeps it.
          </div>
        </div>
        <div class="w-full sm:w-44">
          <Select
            options={props.environments}
            optionValue="id"
            optionTextValue="name"
            value={chosen()}
            onChange={(option) => option && void choose(option)}
            itemComponent={(itemProps) => (
              <SelectItem item={itemProps.item}>
                <span class="flex items-center gap-1.5">
                  <EnvironmentBadge environment={itemProps.item.rawValue} />
                  {itemProps.item.rawValue.name}
                </span>
              </SelectItem>
            )}
          >
            <SelectTrigger id="agent-default-environment" aria-label="New projects start from" class="h-8">
              <SelectValue<Environment>>
                {(state) => (
                  <span class="flex items-center gap-1.5">
                    <Show when={state.selectedOption()}>
                      {(environment) => <EnvironmentBadge environment={environment()} />}
                    </Show>
                    {state.selectedOption()?.name ?? 'Select'}
                  </span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </div>
      </div>
      <Show when={!offered()}>
        <p class="border-t border-border px-3 py-2 text-xs text-amber-700">
          Not offered when creating a project — nothing is published to {chosen()?.name ?? 'it'} yet.
        </p>
      </Show>
    </div>
  );
}
