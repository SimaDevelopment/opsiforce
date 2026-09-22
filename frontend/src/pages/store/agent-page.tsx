import { For, Show, createMemo, createSignal } from 'solid-js';
import { Link, useNavigate } from '@tanstack/solid-router';
import { toast } from 'solid-sonner';
import {
  useAgent,
  useAgentDelivery,
  useDeleteAgent,
  useDuplicateAgent,
  useSetAgentArchived,
  useSetAgentVisibility,
  useUpdateAgentSettings,
  type AgentDeliverySummary,
  type AgentDetail,
  type AgentProfile,
} from '~/api/agents';
import { ApiError } from '~/api/client';
import { useEnvironments, type Environment } from '~/api/environments';
import { usePermissions } from '~/api/permissions';
import { useUsers } from '~/api/users';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { EnvironmentBadge } from '~/components/environment-badge';
import {
  ArchivedBadge,
  EmptyState,
  ErrorState,
  FOCUS_RING,
  OriginBadge,
  RowList,
  SectionTitle,
  VisibilityBadge,
} from '~/components/store/store-list';
import { EditWithBuilderButton } from '~/components/store/edit-with-builder-button';
import {
  AlertTriangle,
  Bot,
  ChevronLeft,
  Copy,
  EllipsisVertical,
  Globe,
  Plus,
  Rocket,
} from '~/components/icons';
import { Permission } from '~/constants/permissions';
import { cn } from '~/lib/cn';
import { driftText, isPublished } from './agent-drift';
import { DevelopmentPanel, ReadOnlyPanel } from './agent-profile-panel';
import { PublishAgentDialog } from './agent-publish-dialog';
import { AddSkillsDialog, AgentSkillList } from './agent-skills';

export interface AgentPageProps {
  agentId: string;
  env: string;
  onEnv: (environmentId: string) => void;
}

function refusal(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function AgentPage(props: AgentPageProps) {
  const agent = useAgent(() => props.agentId);
  const environments = useEnvironments();
  const { hasPermission } = usePermissions();
  const canManage = () => hasPermission(Permission.manageAgents);

  const development = () => (environments.data ?? []).find((environment) => environment.isDefault);
  const loaded = createMemo(() =>
    agent.data && environments.data ? { agent: agent.data, environments: environments.data } : undefined
  );
  const selectedId = () => {
    const known = (environments.data ?? []).some((environment) => environment.id === props.env);
    return known ? props.env : (development()?.id ?? '');
  };

  return (
    <div class="h-full overflow-y-auto bg-background">
      <div class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          to="/store/agents"
          class={cn(
            '-ml-1 mb-3 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
            FOCUS_RING
          )}
        >
          <ChevronLeft class="h-3.5 w-3.5" aria-hidden="true" />
          Agents
        </Link>

        <Show when={!agent.isError} fallback={<ErrorState message="This agent could not be loaded." />}>
          <Show
            when={loaded()}
            fallback={
              <div class="flex justify-center py-10">
                <Spinner />
              </div>
            }
          >
            {(ready) => (
              <AgentBody
                agent={ready().agent}
                environments={ready().environments}
                development={development()}
                selectedId={selectedId()}
                canManage={canManage()}
                onEnv={props.onEnv}
              />
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}

function AgentBody(props: {
  agent: AgentDetail;
  environments: Environment[];
  development: Environment | undefined;
  selectedId: string;
  canManage: boolean;
  onEnv: (environmentId: string) => void;
}) {
  const [publishing, setPublishing] = createSignal<{ preselect?: string } | null>(null);
  const [adding, setAdding] = createSignal(false);

  const isBuiltIn = () => props.agent.origin === 'built_in';
  const profileFor = (environmentId: string) =>
    props.agent.profiles.find((profile) => profile.environmentId === environmentId);
  const developmentProfile = () => (props.development ? profileFor(props.development.id) : undefined);
  const carried = () => developmentProfile()?.skills ?? [];
  const targets = createMemo(() => props.environments.filter((environment) => !environment.isDefault));

  return (
    <>
      <AgentHeader
        agent={props.agent}
        canManage={props.canManage}
        onPublish={() => setPublishing({})}
      />

      <Show when={isBuiltIn()}>
        <BuiltInBody agent={props.agent} skills={carried()} canManage={props.canManage} onAdd={() => setAdding(true)} />
      </Show>

      <Show when={!isBuiltIn()}>
        <div class="space-y-8">
          <EnvironmentSection
            agent={props.agent}
            environments={props.environments}
            development={props.development}
            selectedId={props.selectedId}
            profileFor={profileFor}
            canManage={props.canManage}
            onEnv={props.onEnv}
            onAdd={() => setAdding(true)}
            onPublish={(environmentId) => setPublishing({ preselect: environmentId })}
          />

          <PublishingStrip
            targets={targets()}
            development={developmentProfile()}
            profileFor={profileFor}
            canManage={props.canManage}
            onPublish={(environmentId) => setPublishing({ preselect: environmentId })}
          />

          <Show when={props.canManage}>
            <NewProjectsSection agent={props.agent} environments={props.environments} profileFor={profileFor} />
          </Show>
        </div>
      </Show>

      <Show when={publishing()}>
        {(state) => (
          <PublishAgentDialog
            agent={props.agent}
            development={developmentProfile()}
            targets={targets()}
            profileFor={profileFor}
            preselect={state().preselect}
            open
            onOpenChange={(open) => !open && setPublishing(null)}
          />
        )}
      </Show>

      <Show when={adding()}>
        <AddSkillsDialog agent={props.agent} carried={carried()} open onOpenChange={setAdding} />
      </Show>
    </>
  );
}

function AgentHeader(props: { agent: AgentDetail; canManage: boolean; onPublish: () => void }) {
  const { hasPermission } = usePermissions();
  const users = useUsers(() => hasPermission(Permission.manageWorkspaces) && props.agent.createdBy !== null);
  const creator = () =>
    (users.data ?? []).find((user) => user.id === props.agent.createdBy)?.displayName ??
    (users.data ?? []).find((user) => user.id === props.agent.createdBy)?.email ??
    null;

  return (
    <header class="mb-6">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <Bot class="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h1 class="text-balance text-xl font-semibold tracking-tight text-foreground">
              {props.agent.displayName ?? props.agent.name}
            </h1>
            <OriginBadge origin={props.agent.origin} />
            <VisibilityBadge visibility={props.agent.visibility} />
            <Show when={props.agent.archived}>
              <ArchivedBadge />
            </Show>
          </div>
          <Show when={props.agent.description}>
            <p class="mt-1.5 max-w-2xl text-pretty text-sm text-muted-foreground">{props.agent.description}</p>
          </Show>
          <div class="mt-1.5 text-xs text-muted-foreground">
            <span class="font-mono">{props.agent.name}</span>
            <Show when={creator()}>{(name) => <span> · created by {name()}</span>}</Show>
          </div>
        </div>
        <Show when={props.canManage}>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <Show when={props.agent.origin === 'custom'}>
              <EditWithBuilderButton seed={{ agentId: props.agent.id }} />
              <Button size="sm" onClick={props.onPublish}>
                <Rocket class="h-4 w-4" aria-hidden="true" />
                Publish
              </Button>
            </Show>
            <AgentActionsMenu agent={props.agent} />
          </div>
        </Show>
      </div>
      <div class="mt-4 h-px bg-border" />
    </header>
  );
}

function AgentActionsMenu(props: { agent: AgentDetail }) {
  const navigate = useNavigate();
  const [duplicating, setDuplicating] = createSignal(false);
  const [widening, setWidening] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const setArchived = useSetAgentArchived(() => props.agent.id);
  const setVisibility = useSetAgentVisibility(() => props.agent.id);
  const remove = useDeleteAgent(() => props.agent.id);

  const archive = async (archived: boolean) => {
    try {
      await setArchived.mutateAsync(archived);
    } catch (error) {
      toast.error(refusal(error, 'The agent could not be updated.'));
      return;
    }
    toast.success(archived ? 'Agent archived' : 'Agent restored', {
      action: {
        label: 'Undo',
        onClick: () => {
          void setArchived
            .mutateAsync(!archived)
            .catch((error: unknown) => toast.error(refusal(error, 'The agent could not be updated.')));
        },
      },
    });
  };

  const makePublic = async () => {
    try {
      await setVisibility.mutateAsync('public');
      toast.success('The agent is public');
    } catch (error) {
      toast.error(refusal(error, 'The agent could not be made public.'));
    }
  };

  const destroy = async () => {
    try {
      await remove.mutateAsync();
    } catch (error) {
      toast.error(refusal(error, 'The agent could not be deleted.'));
      return;
    }
    toast.success('Agent deleted');
    void navigate({ to: '/store/agents' });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger as={Button} variant="outline" size="icon" class="h-8 w-8" aria-label="More actions">
          <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="min-w-48">
          <DropdownMenuItem onSelect={() => setDuplicating(true)}>
            <Copy class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Duplicate as private copy
          </DropdownMenuItem>
          <Show when={props.agent.visibility === 'private' && props.agent.origin === 'custom'}>
            <DropdownMenuItem onSelect={() => setWidening(true)}>
              <Globe class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Make public…
            </DropdownMenuItem>
          </Show>
          <Show when={props.agent.origin === 'custom'}>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void archive(!props.agent.archived)}>
              {props.agent.archived ? 'Restore' : 'Archive'}
            </DropdownMenuItem>
            <Show when={props.agent.archived}>
              <DropdownMenuItem class="text-destructive" onSelect={() => setDeleting(true)}>
                Delete…
              </DropdownMenuItem>
            </Show>
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>

      <DuplicateAgentDialog agent={props.agent} open={duplicating()} onOpenChange={setDuplicating} />

      <ConfirmDialog
        open={widening()}
        onOpenChange={setWidening}
        title={`Make ${props.agent.displayName ?? props.agent.name} public?`}
        description="Every member of the organization will see and use it, and anyone with can_manage_agents can edit, publish, archive or delete it. It stops being only yours."
        confirmLabel="Make public"
        onConfirm={() => void makePublic()}
      >
        <div class="mt-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            This can't be undone. Public never goes back to private — the way back is a private copy via Duplicate.
          </span>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting()}
        onOpenChange={setDeleting}
        title={`Delete ${props.agent.displayName ?? props.agent.name}?`}
        description={
          props.agent.projectCount > 0
            ? `It still has ${props.agent.projectCount} project(s) and cannot be deleted. Leave it archived instead.`
            : 'Its definitions in every environment are removed. Projects that already received them keep what they have.'
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => void destroy()}
      />
    </>
  );
}

function DuplicateAgentDialog(props: { agent: AgentDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const duplicate = useDuplicateAgent(() => props.agent.id);
  const [displayName, setDisplayName] = createSignal(`${props.agent.displayName ?? props.agent.name} copy`);
  const [error, setError] = createSignal<string | null>(null);

  const save = async () => {
    const name = displayName().trim();
    if (!name) return;
    setError(null);
    try {
      const copy = await duplicate.mutateAsync(name);
      props.onOpenChange(false);
      toast.success(`Created ${copy.displayName ?? copy.name}`);
      void navigate({ to: '/store/agents/$id', params: { id: copy.id } });
    } catch (caught) {
      setError(refusal(caught, 'The agent could not be duplicated.'));
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate as private copy</DialogTitle>
          <DialogDescription>
            The copy starts private, with this agent's Development definition and its pinned skills.
          </DialogDescription>
        </DialogHeader>
        <div class="mt-4">
          <label for="duplicate-agent-name" class="mb-1 block text-xs text-muted-foreground">
            Display name
          </label>
          <input
            id="duplicate-agent-name"
            type="text"
            value={displayName()}
            onInput={(event) => {
              setDisplayName(event.currentTarget.value);
              setError(null);
            }}
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Show when={error()}>
            <p class="mt-2 text-xs text-destructive" role="alert">
              {error()}
            </p>
          </Show>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!displayName().trim() || duplicate.isPending} onClick={() => void save()}>
            Duplicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BuiltInBody(props: {
  agent: AgentDetail;
  skills: AgentDetail['profiles'][number]['skills'];
  canManage: boolean;
  onAdd: () => void;
}) {
  const delivery = useAgentDelivery(
    () => props.agent.id,
    () => true
  );
  const notApplied = () => {
    const summary = delivery.data;
    return summary ? Math.max(summary.total - summary.converged, 0) : null;
  };
  const omitted = () => delivery.data?.omitted ?? [];

  return (
    <div class="space-y-6">
      <div class="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        <div class="font-medium">Ships with the platform</div>
        <div class="mt-0.5 text-xs text-blue-900/80">
          Its prompt and template come from the agent image and update with releases. The skills below are your
          organization's — they reach <strong>every existing project</strong> on this agent, in every environment, as
          soon as you change them.
        </div>
      </div>

      <section>
        <SectionTitle
          action={
            <Show when={props.canManage}>
              <Button size="sm" variant="outline" class="h-7" onClick={props.onAdd}>
                <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                Add skills
              </Button>
            </Show>
          }
        >
          Skills
        </SectionTitle>
        <AgentSkillList
          agent={props.agent}
          skills={props.skills ?? []}
          editable={props.canManage}
          onAdd={props.onAdd}
        />
        <Show when={notApplied() !== null}>
          <p class="mt-2 text-xs text-muted-foreground">
            {notApplied() === 0
              ? 'Applied to every project on this agent.'
              : `Not applied to ${notApplied()} project(s) yet.`}
          </p>
        </Show>
        <OmittedSkills omitted={omitted()} />
      </section>
    </div>
  );
}

function OmittedSkills(props: { omitted: AgentDeliverySummary['omitted'] }) {
  return (
    <Show when={props.omitted.length > 0}>
      <div class="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <div class="flex items-center gap-1.5 font-medium">
          <AlertTriangle class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Dropped for a name the agent image owns
        </div>
        <ul class="mt-1 space-y-0.5 text-amber-900/80">
          <For each={props.omitted}>
            {(skill) => (
              <li>
                <span class="font-mono">{skill.name}</span> — the agent's own package ships a skill of this name, so
                yours is not delivered in {skill.environments}{' '}
                {skill.environments === 1 ? 'environment' : 'environments'}. Rename yours to have it delivered.
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}

function EnvironmentSection(props: {
  agent: AgentDetail;
  environments: Environment[];
  development: Environment | undefined;
  selectedId: string;
  profileFor: (environmentId: string) => AgentProfile | undefined;
  canManage: boolean;
  onEnv: (environmentId: string) => void;
  onAdd: () => void;
  onPublish: (environmentId: string) => void;
}) {
  const selected = () => props.environments.find((environment) => environment.id === props.selectedId);
  const isDevelopment = () => selected()?.isDefault === true;
  const profile = createMemo(() => {
    const found = props.profileFor(props.selectedId);
    return isPublished(found) ? found : undefined;
  });

  return (
    <section class="space-y-6">
      <Tabs value={props.selectedId} onChange={props.onEnv}>
        <TabsList class="w-full sm:w-auto" aria-label="Environment">
          <For each={props.environments}>
            {(environment) => (
              <TabsTrigger value={environment.id} class="flex-1 gap-1.5 sm:flex-none">
                <EnvironmentBadge environment={environment} />
                <span class="hidden sm:inline">{environment.name}</span>
                <span class="sr-only sm:hidden">{environment.name}</span>
                <Show when={props.agent.settings.defaultEnvironmentId === environment.id}>
                  <span
                    class="h-1.5 w-1.5 rounded-full bg-primary"
                    role="img"
                    aria-label="New projects start here"
                  />
                </Show>
              </TabsTrigger>
            )}
          </For>
        </TabsList>
      </Tabs>

      <Show
        when={profile()}
        fallback={
          <EmptyState
            icon={Rocket}
            title={`Nothing published to ${selected()?.name ?? 'this environment'} yet.`}
            hint="Publish Development here to make this environment available to new projects."
          />
        }
      >
        {(published) => (
          <Show
            when={isDevelopment()}
            fallback={
              <ReadOnlyPanel
                agent={props.agent}
                profile={published()}
                environmentName={selected()?.name ?? ''}
                canManage={props.canManage}
              />
            }
          >
            <DevelopmentPanel
              agent={props.agent}
              profile={published()}
              canManage={props.canManage}
              onAdd={props.onAdd}
            />
          </Show>
        )}
      </Show>

      <Show when={!profile() && props.canManage && !isDevelopment()}>
        <div class="flex justify-center">
          <Button size="sm" onClick={() => props.onPublish(props.selectedId)}>
            <Rocket class="h-3.5 w-3.5" aria-hidden="true" />
            Publish Development to {selected()?.name}
          </Button>
        </div>
      </Show>
    </section>
  );
}

function PublishingStrip(props: {
  targets: Environment[];
  development: AgentProfile | undefined;
  profileFor: (environmentId: string) => AgentProfile | undefined;
  canManage: boolean;
  onPublish: (environmentId: string) => void;
}) {
  return (
    <section>
      <SectionTitle>Publishing</SectionTitle>
      <Show
        when={props.targets.length > 0}
        fallback={
          <p class="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            This organization has only the Development environment.
          </p>
        }
      >
        <RowList>
          <For each={props.targets}>
            {(environment) => {
              const target = () => props.profileFor(environment.id);
              const published = () => isPublished(target());
              const text = () => driftText(props.development, target());
              const stale = () => published() && text() !== 'Same as Development';
              return (
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <span class="inline-flex min-w-32 items-center gap-1.5">
                    <EnvironmentBadge environment={environment} />
                    <span class="text-xs font-medium text-foreground">{environment.name}</span>
                  </span>
                  <span class={cn('min-w-0 flex-1 text-xs', stale() ? 'text-amber-700' : 'text-muted-foreground')}>
                    {text()}
                  </span>
                  <Show when={props.canManage}>
                    <Button
                      size="sm"
                      variant={!published() || stale() ? 'default' : 'outline'}
                      class="h-7"
                      onClick={() => props.onPublish(environment.id)}
                    >
                      <Rocket class="h-3.5 w-3.5" aria-hidden="true" />
                      {published() ? 'Publish update' : 'Publish'}
                    </Button>
                  </Show>
                </div>
              );
            }}
          </For>
        </RowList>
      </Show>
    </section>
  );
}

function NewProjectsSection(props: {
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
    } catch (error) {
      toast.error(refusal(error, 'The setting could not be saved.'));
    }
  };

  return (
    <section>
      <SectionTitle>New projects</SectionTitle>
      <RowList>
        <div class="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <label for="agent-default-environment" class="text-sm font-medium">
              Start new projects from
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
              <SelectTrigger id="agent-default-environment" aria-label="Start new projects from">
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
          <p class="px-4 py-2.5 text-xs text-amber-700">
            Not offered in the picker when creating a project — nothing is published to {chosen()?.name ?? 'it'} yet.
          </p>
        </Show>
      </RowList>
    </section>
  );
}
