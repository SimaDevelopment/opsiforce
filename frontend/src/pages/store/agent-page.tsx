import { For, Show, createMemo, createSignal } from 'solid-js';
import { Link, useNavigate } from '@tanstack/solid-router';
import { toast } from 'solid-sonner';
import {
  downloadAgentExport,
  useAgent,
  useAgentDelivery,
  useAgentExportPreview,
  useDeleteAgent,
  useDuplicateAgent,
  useSetAgentDisabled,
  useSetAgentVisibility,
  useUpdateAgent,
  type AgentDeliverySummary,
  type AgentDetail,
  type AgentProfile,
  type ShippedSkill,
} from '~/api/agents';
import { ApiError } from '~/api/client';
import { useEnvironments, type Environment } from '~/api/environments';
import { useSkill } from '~/api/skills';
import { usePermissions } from '~/api/permissions';
import { useUsers } from '~/api/users';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { DropdownMenuSeparator } from '~/components/ui/dropdown-menu';
import { ActionsMenu, ActionsMenuItem } from '~/components/actions-menu';
import { Spinner } from '~/components/ui/spinner';
import { EnvironmentBadge } from '~/components/environment-badge';
import {
  DefaultEnvironmentMark,
  DisabledBadge,
  EmptyState,
  ErrorState,
  FOCUS_RING,
  OriginBadge,
  RowLink,
  RowList,
  SectionTitle,
  VisibilityBadge,
} from '~/components/store/store-list';
import { ENTRY_SLUG_MAX_LENGTH, EntryNameField, isNameUnavailable } from '~/components/store/entry-name-field';
import { InlineEdit } from '~/components/store/inline-edit';
import { OpenBuilderButton } from '~/components/store/open-builder-button';
import {
  AlertTriangle,
  Ban,
  Bot,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Copy,
  Download,
  Files,
  Globe,
  Plus,
  Rocket,
  Trash2,
} from '~/components/icons';
import { Permission } from '~/constants/permissions';
import { slugify } from '~/lib/app-url';
import { cn } from '~/lib/cn';
import { driftText, isPublished } from './agent-drift';
import { DevelopmentPanel, ReadOnlyPanel } from './agent-profile-panel';
import { PublishAgentDialog } from './agent-publish-dialog';
import { AddSkillsDialog, AgentSkillList } from './agent-skills';

export interface AgentPageProps {
  agentId: string;
  env: string;
  fromSkillId?: string;
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
  const fromSkill = useSkill(
    () => props.fromSkillId ?? '',
    () => !!props.fromSkillId
  );
  const back = () =>
    props.fromSkillId
      ? { to: `/store/skills/${props.fromSkillId}`, label: fromSkill.data?.name ?? 'Skill' }
      : { to: '/store/agents', label: 'Agents' };
  const selectedId = () => {
    const known = (environments.data ?? []).some((environment) => environment.id === props.env);
    return known ? props.env : (development()?.id ?? '');
  };

  return (
    <div class="h-full overflow-y-auto bg-background">
      <div class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          to={back().to}
          class={cn(
            '-ml-1 mb-3 inline-flex max-w-full items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
            FOCUS_RING
          )}
        >
          <ChevronLeft class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span class="truncate">{back().label}</span>
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
  const isDefaultSelected = () => props.selectedId === props.development?.id;

  return (
    <>
      <AgentHeader
        agent={props.agent}
        canManage={props.canManage}
        publishedBeyondDevelopment={targets().some((environment) => isPublished(profileFor(environment.id)))}
        env={props.selectedId}
        onPublish={() => setPublishing(isDefaultSelected() ? {} : { preselect: props.selectedId })}
      />

      <Show when={isBuiltIn()}>
        <BuiltInBody agent={props.agent} skills={carried()} canManage={props.canManage} onAdd={() => setAdding(true)} />
      </Show>

      <Show when={!isBuiltIn()}>
        <div class="grid grid-cols-[minmax(0,1fr)_16rem] gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8">
          <EnvironmentPanel
            agent={props.agent}
            environments={props.environments}
            selectedId={props.selectedId}
            profileFor={profileFor}
            canManage={props.canManage}
            onAdd={() => setAdding(true)}
          />
          <aside class="sticky top-4 self-start">
            <SectionTitle>Environments</SectionTitle>
            <EnvironmentList
              agent={props.agent}
              environments={props.environments}
              development={developmentProfile()}
              selectedId={props.selectedId}
              profileFor={profileFor}
              onEnv={props.onEnv}
            />
          </aside>
        </div>
      </Show>

      <Show when={publishing()}>
        {(state) => (
          <PublishAgentDialog
            agent={props.agent}
            environments={props.environments}
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

function AgentHeader(props: {
  agent: AgentDetail;
  canManage: boolean;
  publishedBeyondDevelopment: boolean;
  env: string;
  onPublish: () => void;
}) {
  const { hasPermission } = usePermissions();
  const users = useUsers(() => hasPermission(Permission.manageWorkspaces) && props.agent.createdBy !== null);
  const update = useUpdateAgent(() => props.agent.id);
  const creator = () =>
    (users.data ?? []).find((user) => user.id === props.agent.createdBy)?.displayName ??
    (users.data ?? []).find((user) => user.id === props.agent.createdBy)?.email ??
    null;
  const editable = () => props.canManage && props.agent.origin === 'custom';
  const name = () => props.agent.displayName ?? props.agent.name;

  const save = async (patch: { displayName?: string; description?: string | null }) => {
    try {
      await update.mutateAsync(patch);
    } catch (error) {
      toast.error(refusal(error, 'The change could not be saved.'));
      throw error;
    }
  };

  return (
    <header class="mb-6">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <Bot class="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h1 class="min-w-0 text-balance text-xl font-semibold tracking-tight text-foreground">
              <Show when={editable()} fallback={name()}>
                <InlineEdit
                  value={name()}
                  label="Name"
                  placeholder="Name"
                  required
                  maxLength={80}
                  onSave={(displayName) => save({ displayName })}
                />
              </Show>
            </h1>
            <OriginBadge origin={props.agent.origin} />
            <VisibilityBadge visibility={props.agent.visibility} />
            <Show when={props.agent.disabled}>
              <DisabledBadge />
            </Show>
          </div>
          <div class="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            <Show
              when={editable()}
              fallback={
                <Show when={props.agent.description}>
                  <p class="text-pretty">{props.agent.description}</p>
                </Show>
              }
            >
              <InlineEdit
                value={props.agent.description}
                label="Description"
                placeholder="Add a description — what this agent is for…"
                multiline
                flushLeft
                maxLength={500}
                onSave={(description) => save({ description: description || null })}
              />
            </Show>
          </div>
          <div class="mt-1.5 text-xs text-muted-foreground">
            <span class="font-mono" title="The slug is fixed once the agent exists">
              {props.agent.name}
            </span>
            <Show when={creator()}>{(creatorName) => <span> · created by {creatorName()}</span>}</Show>
          </div>
        </div>
        <Show when={props.canManage}>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <Show when={props.agent.origin === 'custom'}>
              <OpenBuilderButton
                subject={{ type: 'agent', id: props.agent.id }}
                returnEnv={props.env}
                disabled={props.agent.disabled}
              />
              <Button size="sm" onClick={props.onPublish}>
                <Rocket class="h-4 w-4" aria-hidden="true" />
                Publish
              </Button>
            </Show>
            <AgentActionsMenu agent={props.agent} publishedBeyondDevelopment={props.publishedBeyondDevelopment} />
          </div>
        </Show>
      </div>
      <div class="mt-4 h-px bg-border" />
    </header>
  );
}

function AgentActionsMenu(props: { agent: AgentDetail; publishedBeyondDevelopment: boolean }) {
  const [duplicating, setDuplicating] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  const [widening, setWidening] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const setDisabled = useSetAgentDisabled(() => props.agent.id);
  const setVisibility = useSetAgentVisibility(() => props.agent.id);

  const toggleDisabled = async (disabled: boolean) => {
    try {
      await setDisabled.mutateAsync(disabled);
    } catch (error) {
      toast.error(refusal(error, 'The agent could not be updated.'));
      return;
    }
    toast.success(disabled ? 'Agent disabled' : 'Agent enabled', {
      action: {
        label: 'Undo',
        onClick: () => {
          void setDisabled
            .mutateAsync(!disabled)
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

  return (
    <>
      <ActionsMenu label="Agent actions" variant="outline">
        <Show when={props.agent.duplicable}>
          <ActionsMenuItem icon={Copy} onSelect={() => setDuplicating(true)}>
            Duplicate
          </ActionsMenuItem>
        </Show>
        <Show when={props.agent.origin === 'custom'}>
          <ActionsMenuItem icon={Download} onSelect={() => setExporting(true)}>
            Export
          </ActionsMenuItem>
        </Show>
        <Show when={props.agent.origin === 'custom' && props.agent.visibility === 'private'}>
          <ActionsMenuItem icon={Globe} onSelect={() => setWidening(true)}>
            Make public
          </ActionsMenuItem>
        </Show>
        <Show when={props.agent.disableable}>
          <Show
            when={props.agent.disabled}
            fallback={
              <ActionsMenuItem icon={Ban} onSelect={() => void toggleDisabled(true)}>
                Disable
              </ActionsMenuItem>
            }
          >
            <ActionsMenuItem icon={CirclePlay} onSelect={() => void toggleDisabled(false)}>
              Enable
            </ActionsMenuItem>
          </Show>
        </Show>
        <Show when={props.agent.origin === 'custom'}>
          <DropdownMenuSeparator />
          <ActionsMenuItem icon={Trash2} destructive onSelect={() => setDeleting(true)}>
            Delete
          </ActionsMenuItem>
        </Show>
      </ActionsMenu>

      <DuplicateAgentDialog agent={props.agent} open={duplicating()} onOpenChange={setDuplicating} />
      <Show when={exporting()}>
        <ExportAgentDialog agent={props.agent} open onOpenChange={setExporting} />
      </Show>

      <ConfirmDialog
        open={widening()}
        onOpenChange={setWidening}
        title={`Make ${props.agent.displayName ?? props.agent.name} public?`}
        description="Every member of the organization will see and use it, and anyone with can_manage_agents can edit, publish, disable or delete it. It stops being only yours."
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

      <DeleteAgentDialog
        agent={props.agent}
        publishedBeyondDevelopment={props.publishedBeyondDevelopment}
        open={deleting()}
        onOpenChange={setDeleting}
        onDisable={() => void toggleDisabled(true)}
      />
    </>
  );
}

function DeleteAgentDialog(props: {
  agent: AgentDetail;
  publishedBeyondDevelopment: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisable: () => void;
}) {
  const navigate = useNavigate();
  const remove = useDeleteAgent(() => props.agent.id);
  const inUse = () => props.agent.projectCount > 0;
  const needsDisable = () => props.publishedBeyondDevelopment && !props.agent.disabled;
  const name = () => props.agent.displayName ?? props.agent.name;

  const reason = () => {
    if (inUse()) {
      const count = props.agent.projectCount;
      return `${count} ${count === 1 ? 'project runs' : 'projects run'} on it, so it can't be deleted. Disable it to stop new projects from starting on it.`;
    }
    if (needsDisable()) return "It's published beyond Development. Disable it first, then delete it.";
    return "Its definitions in every environment, its Builder conversation and any test project running it are removed. This can't be undone.";
  };

  const destroy = async () => {
    try {
      await remove.mutateAsync();
    } catch (error) {
      toast.error(refusal(error, 'The agent could not be deleted.'));
      return;
    }
    props.onOpenChange(false);
    toast.success(`Deleted ${name()}`);
    void navigate({ to: '/store/agents' });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {name()}?</DialogTitle>
          <DialogDescription>{reason()}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Show
            when={!inUse() && !needsDisable()}
            fallback={
              <Show when={!props.agent.disabled}>
                <Button
                  size="sm"
                  onClick={() => {
                    props.onDisable();
                    props.onOpenChange(false);
                  }}
                >
                  Disable
                </Button>
              </Show>
            }
          >
            <Button variant="destructive" size="sm" loading={remove.isPending} onClick={() => void destroy()}>
              Delete
            </Button>
          </Show>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DuplicateAgentDialog(props: { agent: AgentDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const duplicate = useDuplicateAgent(() => props.agent.id);
  const sourceName = () => props.agent.displayName ?? props.agent.name;
  const [displayName, setDisplayName] = createSignal(`${sourceName()} copy`);
  const [error, setError] = createSignal<string | null>(null);
  const [unavailableSlug, setUnavailableSlug] = createSignal<string | null>(null);

  const slug = () => slugify(displayName().trim(), ENTRY_SLUG_MAX_LENGTH.agent);
  const unavailable = () => unavailableSlug() === slug();
  const canSubmit = () => slug().length > 0 && !unavailable() && !duplicate.isPending;

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit()) return;
    setError(null);
    try {
      const copy = await duplicate.mutateAsync(displayName().trim());
      props.onOpenChange(false);
      toast.success(`Created ${copy.displayName ?? copy.name}`);
      void navigate({ to: '/store/agents/$id', params: { id: copy.id } });
    } catch (caught) {
      if (isNameUnavailable(caught)) {
        setUnavailableSlug(slug());
        return;
      }
      setError(refusal(caught, 'The agent could not be duplicated.'));
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle>Duplicate {sourceName()}</DialogTitle>
            <DialogDescription>
              The private copy gets this agent's description, Development prompt, model, skills and Template, but not
              its Builder chat or test project.
            </DialogDescription>
          </DialogHeader>
          <div class="mt-4">
            <EntryNameField
              id="duplicate-agent-name"
              label="Name"
              value={displayName()}
              slug={slug()}
              unavailable={unavailable()}
              onInput={(value) => {
                setDisplayName(value);
                setError(null);
              }}
            />
            <Show when={error()}>
              <p class="mt-2 text-xs text-destructive" role="alert">
                {error()}
              </p>
            </Show>
          </div>
          <DialogFooter class="mt-4 gap-2 sm:items-center sm:justify-between">
            <p class="text-xs text-muted-foreground">New projects can pick it after its first publish.</p>
            <div class="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit()} loading={duplicate.isPending}>
                Duplicate
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExportAgentDialog(props: { agent: AgentDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const preview = useAgentExportPreview(
    () => props.agent.id,
    () => props.open
  );
  const name = () => props.agent.displayName ?? props.agent.name;
  const hits = () => {
    const data = preview.data;
    if (!data) return [];
    return [
      ...data.template.map((hit) => ({ where: `Template: ${hit.path}`, reason: hit.reason })),
      ...data.skills.flatMap((skill) =>
        skill.hits.map((hit) => ({ where: `Skill ${skill.name}: ${hit.path}`, reason: hit.reason }))
      ),
    ];
  };

  const download = () => {
    downloadAgentExport(props.agent.id, props.agent.name);
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export {name()}</DialogTitle>
          <DialogDescription>
            The file carries this agent's Development prompt, model, skills and Template, to import into another
            organization or deployment. Its Builder chat and test project stay here.
          </DialogDescription>
        </DialogHeader>
        <div class="mt-4">
          <Show
            when={!preview.isPending}
            fallback={
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner size="sm" /> Checking for key-like strings…
              </div>
            }
          >
            <Show
              when={!preview.error}
              fallback={
                <p class="text-xs text-destructive" role="alert">
                  {refusal(preview.error, 'The agent could not be checked for export.')}
                </p>
              }
            >
              <Show when={hits().length > 0}>
                <div class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <div class="flex gap-2 font-medium">
                    <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>These look like keys or secrets. Check them before you share the file.</span>
                  </div>
                  <ul class="mt-2 space-y-1 pl-5">
                    <For each={hits()}>
                      {(hit) => (
                        <li>
                          <span class="font-mono">{hit.where}</span> — {hit.reason}
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            </Show>
          </Show>
        </div>
        <DialogFooter class="mt-4">
          <Button type="button" variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={preview.isPending || Boolean(preview.error)} onClick={download}>
            Download
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
          Its prompt, template and the skills it ships come from the agent image and update with releases. Skills your
          organization adds reach <strong>every existing project</strong> on this agent, in every environment, as soon
          as you change them.
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
          Added by your organization
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

      <section>
        <SectionTitle>Ships with the agent</SectionTitle>
        <ShippedSkillList agentId={props.agent.id} skills={props.agent.shippedSkills} />
      </section>
    </div>
  );
}

function ShippedSkillList(props: { agentId: string; skills: ShippedSkill[] }) {
  return (
    <Show
      when={props.skills.length > 0}
      fallback={
        <p class="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          This agent's package ships no skills of its own.
        </p>
      }
    >
      <RowList>
        <For each={props.skills}>
          {(skill) => (
            <Show
              when={skill.skillId}
              fallback={
                <div class="flex items-center gap-3 px-4 py-2.5">
                  <Files class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span class="font-mono text-sm">{skill.name}</span>
                </div>
              }
            >
              {(skillId) => (
                <RowLink
                  href={`/store/skills/${skillId()}?${new URLSearchParams({ agent: props.agentId })}`}
                  class="px-4 py-2.5"
                >
                  <Files class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate font-mono text-sm">{skill.name}</span>
                  <Show when={skill.version}>
                    {(version) => <span class="text-xs tabular-nums text-muted-foreground">v{version()}</span>}
                  </Show>
                </RowLink>
              )}
            </Show>
          )}
        </For>
      </RowList>
    </Show>
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

function EnvironmentList(props: {
  agent: AgentDetail;
  environments: Environment[];
  development: AgentProfile | undefined;
  selectedId: string;
  profileFor: (environmentId: string) => AgentProfile | undefined;
  onEnv: (environmentId: string) => void;
}) {
  return (
    <RowList>
      <For each={props.environments}>
        {(environment) => {
          const selected = () => environment.id === props.selectedId;
          const status = () =>
            environment.isDefault ? 'Where you edit' : driftText(props.development, props.profileFor(environment.id));
          const stale = () =>
            !environment.isDefault &&
            isPublished(props.profileFor(environment.id)) &&
            status() !== 'Same as Development';
          return (
            <button
              type="button"
              aria-pressed={selected()}
              onClick={() => props.onEnv(environment.id)}
              class={cn(
                'group flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/60',
                FOCUS_RING,
                selected() && 'bg-accent'
              )}
            >
              <span class="min-w-0 flex-1 space-y-0.5">
                <span class="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <EnvironmentBadge environment={environment} />
                  <span class="truncate">{environment.name}</span>
                  <Show when={props.agent.settings.defaultEnvironmentId === environment.id}>
                    <DefaultEnvironmentMark environmentName={environment.name} plain />
                  </Show>
                </span>
                <span class={cn('block truncate text-xs', stale() ? 'text-amber-700' : 'text-muted-foreground')}>
                  {status()}
                </span>
              </span>
              <ChevronRight
                class={cn(
                  'h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5',
                  selected() ? 'text-foreground' : 'text-muted-foreground'
                )}
                aria-hidden="true"
              />
            </button>
          );
        }}
      </For>
    </RowList>
  );
}

function EnvironmentPanel(props: {
  agent: AgentDetail;
  environments: Environment[];
  selectedId: string;
  profileFor: (environmentId: string) => AgentProfile | undefined;
  canManage: boolean;
  onAdd: () => void;
}) {
  const selected = () => props.environments.find((environment) => environment.id === props.selectedId);
  const isDevelopment = () => selected()?.isDefault === true;
  const profile = createMemo(() => {
    const found = props.profileFor(props.selectedId);
    return isPublished(found) ? found : undefined;
  });

  return (
    <section class="min-w-0 space-y-6" aria-label={selected()?.name}>
      <Show
        when={profile()}
        fallback={
          <EmptyState
            icon={Rocket}
            title={`Nothing published to ${selected()?.name ?? 'this environment'} yet.`}
            hint={
              props.canManage
                ? 'Publish, at the top of the page, copies Development here and offers it to new projects.'
                : 'Until Development is published here, new projects cannot start from it.'
            }
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
    </section>
  );
}
