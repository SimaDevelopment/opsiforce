import { For, Show, createMemo, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  usePublishAgent,
  useUpdateAgentSettings,
  type AgentDetail,
  type AgentProfile,
  type TemplateComparison,
} from '~/api/agents';
import { ApiError } from '~/api/client';
import type { Environment } from '~/api/environments';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { DefaultEnvironmentSetting, PublishPreviewCard, PublishTargetList } from '~/components/publish-environments';
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

const TEMPLATE_LABELS: Record<Exclude<TemplateComparison, 'none'>, string> = {
  same: 'Same',
  changed: 'Changed',
  added: 'Added',
  removed: 'Removed',
};

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
          <PublishTargetList
            targets={props.targets}
            chosen={chosen()}
            onPick={(environmentId) => {
              setPicked(environmentId);
              setError(null);
            }}
            status={(environment) => driftText(props.development, props.profileFor(environment.id))}
            stale={(environment) =>
              isPublished(props.profileFor(environment.id)) &&
              driftText(props.development, props.profileFor(environment.id)) !== 'Same as Development'
            }
          />

          <Show when={ready()}>
            {(shown) => {
              const development = () => shown().development;
              const changes = () => shown().changes;
              const shownTemplate = () => {
                const template = changes().template;
                return template === 'none' ? undefined : template;
              };
              return (
                <div class="space-y-3">
                  <PublishPreviewCard
                    title={replaces() ? `What changes in ${targetName()}` : `What ${targetName()} will receive`}
                  >
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
                          <For each={changes().serviceSettingsChanged}>
                            {(skill) => (
                              <Badge variant="warning" class="font-mono font-normal">
                                {skill.name} service settings
                              </Badge>
                            )}
                          </For>
                        </span>
                      </Show>
                    </DiffLine>
                    <Show when={shownTemplate()}>
                      {(template) => (
                        <DiffLine label="Template" changed={changes().templateChanged}>
                          {TEMPLATE_LABELS[template()]}
                        </DiffLine>
                      )}
                    </Show>
                  </PublishPreviewCard>

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

          <NewProjectsSetting
            agent={props.agent}
            environments={props.environments}
            choices={props.targets}
            profileFor={props.profileFor}
          />
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
  choices: Environment[];
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
    <DefaultEnvironmentSetting
      id="agent-default-environment"
      label="New projects start from"
      description="A project copies this environment's definition once, when it is created, and keeps it."
      choices={props.choices}
      value={chosen()}
      onChange={(environment) => void choose(environment)}
      notice={
        offered()
          ? undefined
          : `Not offered when creating a project — nothing is published to ${chosen()?.name ?? 'it'} yet.`
      }
    />
  );
}
