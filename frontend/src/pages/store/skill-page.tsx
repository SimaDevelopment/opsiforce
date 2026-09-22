import { For, Show, createMemo, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import { usePermissions } from '~/api/permissions';
import {
  skillExportUrl,
  useDeleteSkill,
  useDuplicateSkill,
  useSetSkillArchived,
  useSetSkillVisibility,
  useSkill,
  useSkillAgents,
  useSkillFiles,
  useSkillVersions,
  type Skill,
  type SkillAgentUsage,
  type SkillFlags,
  type SkillVersion,
} from '~/api/skills';
import { Badge } from '~/components/ui/badge';
import { Button, buttonVariants } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Spinner } from '~/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { SkillContent } from '~/components/store/skill-content';
import { EditWithBuilderButton } from '~/components/store/edit-with-builder-button';
import {
  ArchivedBadge,
  EmptyState,
  ErrorState,
  FOCUS_RING,
  OriginBadge,
  RowLink,
  RowList,
  SectionTitle,
  VersionUpdateBadge,
  VisibilityBadge,
} from '~/components/store/store-list';
import { StorePageHeader } from '~/components/store/store-page';
import {
  AlertTriangle,
  Bot,
  Copy,
  Download,
  EllipsisVertical,
  Files,
  Globe,
  MessageSquare,
  Terminal,
} from '~/components/icons';
import { Permission } from '~/constants/permissions';
import { cn } from '~/lib/cn';
import { formatDate } from '~/lib/format-date';

export const DEFAULT_SKILL_FILE = 'SKILL.md';

export interface SkillPageProps {
  skillId: string;
  /** The Version picked in the URL; undefined falls back to the latest. */
  version: number | undefined;
  file: string;
  onVersion: (version: number | undefined) => void;
  onFile: (file: string) => void;
}

const CREATED_VIA_LABELS: Record<string, string> = {
  form: 'Created in the app',
  builder: 'Built in a chat',
  import: 'Imported',
  duplicate: 'Duplicated',
  reconciler: 'From the agent image',
};

export function SkillPage(props: SkillPageProps) {
  const { hasPermission } = usePermissions();
  const canManage = () => hasPermission(Permission.manageSkills);
  const skillId = () => props.skillId;

  const skill = useSkill(skillId);
  const versions = useSkillVersions(skillId);
  const agents = useSkillAgents(skillId);

  const latestVersion = () => skill.data?.latestVersion?.version ?? 0;
  /** The URL is trusted until the version list can contradict it, so the files load once. */
  const selectedVersion = () => {
    const picked = props.version;
    if (!picked) return latestVersion();
    if (!versions.data) return picked;
    return versions.data.some((version) => version.version === picked) ? picked : latestVersion();
  };
  const files = useSkillFiles(skillId, selectedVersion);
  /** The badges describe the version being read, not whichever one happens to be latest. */
  const flagsOfSelected = () =>
    versions.data?.find((version) => version.version === selectedVersion())?.flags ??
    skill.data?.latestVersion?.flags;
  const isCustom = () => skill.data?.origin === 'custom';

  return (
    <div class="h-full overflow-y-auto bg-background">
      <div class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <Show when={!skill.isError} fallback={<NotVisible />}>
          <Show
            when={skill.data}
            fallback={
              <div class="flex justify-center py-16">
                <Spinner />
              </div>
            }
          >
            {(loaded) => (
              <>
                <SkillHeader
                  skill={loaded()}
                  version={selectedVersion()}
                  flags={flagsOfSelected()}
                  canManage={canManage()}
                  agents={agents.data ?? []}
                />

                <Show when={loaded().origin === 'built_in' && !loaded().available}>
                  <div class="mb-6 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      This skill is no longer in the agent image. Agents that already pin a version keep it; no new
                      version will arrive.
                    </span>
                  </div>
                </Show>

                <div class="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
                  <div class="min-w-0 space-y-6">
                    <section>
                      <SectionTitle>Contents · v{selectedVersion()}</SectionTitle>
                      <Show
                        when={!files.isError}
                        fallback={<ErrorState message="This version's files could not be loaded." />}
                      >
                        <Show
                          when={files.data}
                          fallback={
                            <div class="flex justify-center py-8">
                              <Spinner />
                            </div>
                          }
                        >
                          {(tree) => <SkillContent files={tree()} selected={props.file} onSelect={props.onFile} />}
                        </Show>
                      </Show>
                    </section>

                    <section>
                      <SectionTitle>Versions</SectionTitle>
                      <Show when={versions.data}>
                        {(rows) => (
                          <VersionList
                            versions={rows()}
                            selected={selectedVersion()}
                            latest={latestVersion()}
                            onSelect={(version) => props.onVersion(version === latestVersion() ? undefined : version)}
                          />
                        )}
                      </Show>
                      <Show when={isCustom()}>
                        <p class="mt-2 text-xs text-muted-foreground">
                          Every save publishes the next version. Agents stay on the version they pinned until someone
                          upgrades them.
                        </p>
                      </Show>
                    </section>
                  </div>

                  <aside class="space-y-6">
                    <section>
                      <SectionTitle>On agents</SectionTitle>
                      <OnAgents agents={agents.data ?? []} latest={latestVersion()} />
                    </section>
                    <section>
                      <SectionTitle>Origin</SectionTitle>
                      <Origin skill={loaded()} />
                    </section>
                  </aside>
                </div>
              </>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}

function NotVisible() {
  return (
    <EmptyState
      icon={Files}
      title="This skill isn't visible to you."
      hint="It may be private to its creator, or it was deleted."
    />
  );
}

function SkillHeader(props: {
  skill: Skill;
  version: number;
  flags: SkillFlags | undefined;
  canManage: boolean;
  agents: SkillAgentUsage[];
}) {
  const isCustom = () => props.skill.origin === 'custom';
  const flags = () => props.flags;

  return (
    <StorePageHeader
      backTo="/store/skills"
      backLabel="Skills"
      icon={Files}
      title={props.skill.name}
      mono
      description={props.skill.description}
      badges={
        <>
          <Show when={props.skill.latestVersion}>
            {(version) => <span class="text-sm tabular-nums text-muted-foreground">v{version().version}</span>}
          </Show>
          <OriginBadge origin={props.skill.origin} />
          <VisibilityBadge visibility={props.skill.visibility} />
          <Show when={props.skill.archived}>
            <ArchivedBadge />
          </Show>
          <Show when={flags()?.has_executables}>
            <Tooltip>
              <TooltipTrigger as="span">
                <Badge variant="warning" class="gap-1 font-medium">
                  <Terminal class="h-3 w-3" aria-hidden="true" />
                  Executables
                </Badge>
              </TooltipTrigger>
              <TooltipContent>This skill ships files the agent can run.</TooltipContent>
            </Tooltip>
          </Show>
        </>
      }
      actions={
        <>
          <Show when={props.version > 0}>
            <a
              href={skillExportUrl(props.skill.id, props.version)}
              download=""
              class={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-2')}
            >
              <Download class="h-4 w-4" aria-hidden="true" />
              Export .skill
            </a>
          </Show>
          <Show when={isCustom()}>
            <EditWithBuilderButton seed={{ skillId: props.skill.id }} />
          </Show>
          <Show when={props.canManage}>
            <SkillActionsMenu skill={props.skill} agents={props.agents} />
          </Show>
        </>
      }
    />
  );
}

/** Built-in skills are owned by the agent image, so only Duplicate is offered on them. */
function SkillActionsMenu(props: { skill: Skill; agents: SkillAgentUsage[] }) {
  const isCustom = () => props.skill.origin === 'custom';
  const [duplicating, setDuplicating] = createSignal(false);
  const [widening, setWidening] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);

  const setArchived = useSetSkillArchived(() => props.skill.id);

  const toggleArchived = async (archived: boolean) => {
    try {
      await setArchived.mutateAsync(archived);
      toast.success(archived ? `Archived ${props.skill.name}` : `Restored ${props.skill.name}`, {
        action: { label: 'Undo', onClick: () => void setArchived.mutateAsync(!archived) },
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The change could not be saved.');
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger as={Button} variant="outline" size="icon" class="h-9 w-9" aria-label="More actions">
          <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="min-w-48">
          <DropdownMenuItem onSelect={() => setDuplicating(true)}>
            <Copy class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Duplicate
          </DropdownMenuItem>
          <Show when={isCustom()}>
            <Show when={props.skill.visibility === 'private'}>
              <DropdownMenuItem onSelect={() => setWidening(true)}>
                <Globe class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                Make public…
              </DropdownMenuItem>
            </Show>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void toggleArchived(!props.skill.archived)}>
              {props.skill.archived ? 'Restore' : 'Archive'}
            </DropdownMenuItem>
            <DropdownMenuItem class="text-destructive" onSelect={() => setDeleting(true)}>
              Delete…
            </DropdownMenuItem>
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>

      <DuplicateSkillDialog skill={props.skill} open={duplicating()} onOpenChange={setDuplicating} />
      <MakePublicDialog skill={props.skill} open={widening()} onOpenChange={setWidening} />
      <DeleteSkillDialog skill={props.skill} agents={props.agents} open={deleting()} onOpenChange={setDeleting} />
    </>
  );
}

function DuplicateSkillDialog(props: { skill: Skill; open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const duplicate = useDuplicateSkill(() => props.skill.id);
  const [name, setName] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);

  const close = () => {
    setName('');
    setError(null);
    props.onOpenChange(false);
  };

  const save = async () => {
    const value = name().trim();
    if (!value) return;
    setError(null);
    try {
      const copy = await duplicate.mutateAsync({ name: value });
      close();
      toast.success(`Duplicated as ${copy.name}`);
      navigate({ to: `/store/skills/${copy.id}` });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The skill could not be duplicated.');
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <DialogContent>
        <DialogTitle>Duplicate {props.skill.name}</DialogTitle>
        <DialogDescription>
          The copy starts private, at version 1, with the contents of the latest version. Names are unique, so the copy
          needs its own.
        </DialogDescription>
        <div class="mt-4">
          <label for="duplicate-skill-name" class="mb-1 block text-xs text-muted-foreground">
            Name
          </label>
          <input
            id="duplicate-skill-name"
            type="text"
            value={name()}
            onInput={(event) => {
              setName(event.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && name().trim()) void save();
            }}
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={`${props.skill.name}-copy`}
            autofocus
          />
          <Show when={error()}>
            <p class="mt-2 text-xs text-destructive">{error()}</p>
          </Show>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={!name().trim() || duplicate.isPending}>
            Duplicate
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MakePublicDialog(props: { skill: Skill; open: boolean; onOpenChange: (open: boolean) => void }) {
  const setVisibility = useSetSkillVisibility(() => props.skill.id);

  const confirm = async () => {
    try {
      await setVisibility.mutateAsync('public');
      toast.success(`${props.skill.name} is public`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The skill could not be made public.');
    }
  };

  return (
    <ConfirmDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={`Make ${props.skill.name} public?`}
      description="Every member of the organization will see it, and anyone with can_manage_skills can publish a version, archive or delete it. It stops being only yours."
      confirmLabel="Make public"
      onConfirm={() => void confirm()}
    >
      <div class="mt-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>This can't be undone. Public never goes back to private — the way back is a private copy.</span>
      </div>
    </ConfirmDialog>
  );
}

function DeleteSkillDialog(props: {
  skill: Skill;
  agents: SkillAgentUsage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const remove = useDeleteSkill(() => props.skill.id);
  const setArchived = useSetSkillArchived(() => props.skill.id);
  const [refusedInUse, setRefusedInUse] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const blockers = createMemo(() =>
    props.agents.map((agent) => ({ id: agent.id, label: agent.displayName ?? agent.name }))
  );
  const inUse = () => blockers().length > 0 || refusedInUse();
  const blocked = () => inUse() || !props.skill.archived;

  const close = () => {
    setRefusedInUse(false);
    setError(null);
    props.onOpenChange(false);
  };

  const confirm = async () => {
    setError(null);
    try {
      await remove.mutateAsync();
      close();
      toast.success(`Deleted ${props.skill.name}`);
      navigate({ to: '/store/skills', search: { filter: 'all', q: '' } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'skill_in_use') {
        setRefusedInUse(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'The skill could not be deleted.');
    }
  };

  const archiveInstead = async () => {
    try {
      await setArchived.mutateAsync(true);
      close();
      toast.success(`Archived ${props.skill.name}`, {
        action: { label: 'Undo', onClick: () => void setArchived.mutateAsync(false) },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The skill could not be archived.');
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <DialogContent>
        <DialogTitle>Delete {props.skill.name}?</DialogTitle>
        <DialogDescription>
          <Show when={inUse()} fallback={<NotArchivedYet archived={props.skill.archived} />}>
            <Show
              when={blockers().length > 0}
              fallback="It can't be deleted while an agent still pins it, and the agent holding it isn't one you can open. Archive it instead."
            >
              It can't be deleted while agents still pin it. Remove it from these agents first, or archive it instead.
            </Show>
          </Show>
        </DialogDescription>

        <Show when={blockers().length > 0}>
          <RowList>
            <For each={blockers()}>
              {(agent) => (
                <RowLink href={`/store/agents/${agent.id}`} class="px-3 py-2 text-sm">
                  <Bot class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate">{agent.label}</span>
                </RowLink>
              )}
            </For>
          </RowList>
        </Show>

        <Show when={error()}>
          <p class="text-xs text-destructive">{error()}</p>
        </Show>

        <div class="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Show when={blocked() && !props.skill.archived}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void archiveInstead()}
              disabled={setArchived.isPending}
            >
              Archive instead
            </Button>
          </Show>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => void confirm()}
            disabled={blocked() || remove.isPending}
          >
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NotArchivedYet(props: { archived: boolean }) {
  return (
    <Show
      when={props.archived}
      fallback="Archive it first — a live skill is never deleted outright, so the step is deliberate."
    >
      Every version is removed. Projects that already received it keep their files.
    </Show>
  );
}

function VersionList(props: {
  versions: SkillVersion[];
  selected: number;
  latest: number;
  onSelect: (version: number) => void;
}) {
  return (
    <RowList>
      <For each={props.versions}>
        {(version) => {
          const selected = () => version.version === props.selected;
          return (
            <button
              type="button"
              aria-pressed={selected()}
              onClick={() => props.onSelect(version.version)}
              class={cn(
                'flex w-full flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-left text-sm transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/40',
                FOCUS_RING,
                selected() && 'bg-accent/40'
              )}
            >
              <span class="flex items-center gap-2">
                <span class="font-medium tabular-nums">v{version.version}</span>
                <Show when={version.version === props.latest}>
                  <Badge variant="success">Latest</Badge>
                </Show>
                <Show when={version.lints.length > 0}>
                  <Badge variant="outline" class="tabular-nums text-muted-foreground">
                    {version.lints.length} lint{version.lints.length === 1 ? '' : 's'}
                  </Badge>
                </Show>
              </span>
              <span class="text-xs text-muted-foreground">
                {formatDate(version.createdAt)} · {CREATED_VIA_LABELS[version.createdVia] ?? version.createdVia}
              </span>
            </button>
          );
        }}
      </For>
    </RowList>
  );
}

function OmittedBadge(props: { count: number }) {
  return (
    <Tooltip>
      <TooltipTrigger as="span">
        <Badge variant="warning" class="gap-1 font-medium">
          <AlertTriangle class="h-3 w-3" aria-hidden="true" />
          Not applied
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        A skill of this name ships with the agent image, so it was dropped in {props.count}{' '}
        {props.count === 1 ? 'environment' : 'environments'}. Rename this skill to have it delivered again.
      </TooltipContent>
    </Tooltip>
  );
}

function OnAgents(props: { agents: SkillAgentUsage[]; latest: number }) {
  return (
    <Show
      when={props.agents.length > 0}
      fallback={
        <div class="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No agent carries this skill.
        </div>
      }
    >
      <RowList>
        <For each={props.agents}>
          {(agent) => {
            /** Several pins mean several Environments, so the list is spelled out rather than collapsed. */
            const split = () => agent.pinnedVersions.length > 1;
            return (
              <RowLink href={`/store/agents/${agent.id}`} class="px-3 py-2.5 text-sm">
                <Bot class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate">{agent.displayName ?? agent.name}</span>
                <Show when={split() || !agent.outdated}>
                  <span class="text-xs tabular-nums text-muted-foreground">
                    {agent.pinnedVersions.map((version) => `v${version}`).join(' · ')}
                  </span>
                </Show>
                <Show when={agent.outdated}>
                  <VersionUpdateBadge from={Math.min(...agent.pinnedVersions)} to={props.latest} />
                </Show>
                <Show when={agent.omittedIn > 0}>
                  <OmittedBadge count={agent.omittedIn} />
                </Show>
              </RowLink>
            );
          }}
        </For>
      </RowList>
    </Show>
  );
}

function Origin(props: { skill: Skill }) {
  return (
    <RowList>
      <div class="px-3 py-2.5 text-xs">
        <div class="text-muted-foreground">Created by</div>
        <div class="mt-0.5 text-sm font-medium">
          {props.skill.origin === 'built_in' ? 'Built-in' : (props.skill.createdByName ?? 'Someone who has left')}
        </div>
      </div>
      <div class="px-3 py-2.5 text-xs">
        <div class="text-muted-foreground">Created</div>
        <div class="mt-0.5 text-sm font-medium">{formatDate(props.skill.createdAt)}</div>
      </div>
      <Show when={props.skill.createdInChatProjectId}>
        {(chatId) => (
          <RowLink href={`/store/builder/${chatId()}`} class="px-3 py-2.5 text-xs">
            <MessageSquare class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              <span class="block text-muted-foreground">Made in the chat</span>
              <span class="block truncate text-sm font-medium text-foreground">Open the chat</span>
            </span>
          </RowLink>
        )}
      </Show>
    </RowList>
  );
}
