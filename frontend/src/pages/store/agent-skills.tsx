import { For, Show, createMemo, createSignal, type Accessor, type Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Link } from '@tanstack/solid-router';
import { toast } from '~/lib/toast';
import {
  useRemoveAgentSkill,
  useSetAgentSkill,
  type AgentDetail,
  type AgentProfileSkill,
  type ShippedSkill,
} from '~/api/agents';
import { ApiError } from '~/api/client';
import { useEnvironments } from '~/api/environments';
import { useSkills, type Skill } from '~/api/skills';
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
import {
  DisabledBadge,
  FilterChips,
  FOCUS_RING,
  KIND_ICONS,
  OriginBadge,
  PackageBadge,
  RetiredBadge,
  RowList,
  SearchInput,
  ServiceMark,
  VersionTag,
  VersionUpdateBadge,
  VisibilityBadge,
  type FilterChipOption,
} from '~/components/store/store-list';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { Check, CircleArrowUp, Files, Plus, SlidersHorizontal, Trash2 } from '~/components/icons';
import { cn } from '~/lib/cn';
import { ServiceSettingsDialog, serviceSettingsSummary } from './agent-service-settings-dialog';
import { DEFAULT_SKILL_FILE } from './skill-page';

function refusalMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The change could not be saved.';
}

type SkillKind = 'shipped' | 'built_in' | 'custom' | 'service';
type SkillKindFilter = 'all' | 'addons' | SkillKind;

interface Kinded {
  name: string;
  displayName: string | null;
  origin: string;
  externalServiceId: string | null;
  shipped?: boolean;
}

interface ShippedRow extends Kinded {
  shipped: true;
  skillId: string | null;
  version: number | null;
}

type ListedSkill = AgentProfileSkill | ShippedRow;

const SKILL_KINDS: { id: Exclude<SkillKind, 'shipped'>; label: string }[] = [
  { id: 'built_in', label: 'Built-in' },
  { id: 'custom', label: 'Custom' },
  { id: 'service', label: 'Service' },
];

const LIST_FILTER_FROM = 6;

function skillKindOf(skill: Kinded): SkillKind {
  if (skill.shipped) return 'shipped';
  if (skill.externalServiceId !== null) return 'service';
  return skill.origin === 'built_in' ? 'built_in' : 'custom';
}

function matchesKind(skill: Kinded, kind: SkillKindFilter): boolean {
  if (kind === 'all') return true;
  if (kind === 'addons') return !skill.shipped;
  return skillKindOf(skill) === kind;
}

function nameMatches(skill: Kinded, needle: string): boolean {
  return skill.name.toLowerCase().includes(needle) || (skill.displayName ?? '').toLowerCase().includes(needle);
}

interface SkillFilter<T> {
  query: Accessor<string>;
  setQuery: (query: string) => void;
  kind: Accessor<SkillKindFilter>;
  setKind: (kind: SkillKindFilter) => void;
  options: Accessor<FilterChipOption<SkillKindFilter>[]>;
  visible: Accessor<T[]>;
  reset: () => void;
}

function useSkillFilter<T extends Kinded>(
  skills: () => T[],
  matches: (skill: T, needle: string) => boolean
): SkillFilter<T> {
  const [query, setQuery] = createSignal('');
  const [kind, setKind] = createSignal<SkillKindFilter>('all');
  const options = createMemo(() => {
    const counts = new Map<SkillKind, number>();
    for (const skill of skills()) counts.set(skillKindOf(skill), (counts.get(skillKindOf(skill)) ?? 0) + 1);
    const shipped = counts.get('shipped') ?? 0;
    const addons = skills().length - shipped;
    return [
      { id: 'all' as SkillKindFilter, label: 'All', icon: KIND_ICONS.all, count: skills().length },
      ...(shipped > 0
        ? [{ id: 'shipped' as SkillKindFilter, label: 'Package', icon: KIND_ICONS.shipped, count: shipped }]
        : []),
      ...(shipped > 0 && addons > 0
        ? [{ id: 'addons' as SkillKindFilter, label: 'Add-ons', icon: KIND_ICONS.addons, count: addons }]
        : []),
      ...SKILL_KINDS.flatMap(({ id, label }) => {
        const count = counts.get(id);
        return count ? [{ id: id as SkillKindFilter, label, icon: KIND_ICONS[id], count }] : [];
      }),
    ];
  });
  const activeKind = () => (options().some((option) => option.id === kind()) ? kind() : 'all');
  const visible = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return skills().filter((skill) => matchesKind(skill, activeKind()) && (!needle || matches(skill, needle)));
  });
  const reset = () => {
    setQuery('');
    setKind('all');
  };
  return { query, setQuery, kind: activeKind, setKind, options, visible, reset };
}

function SkillFilterBar<T>(props: { filter: SkillFilter<T>; class?: string }) {
  return (
    <div class={cn('space-y-2', props.class)}>
      <SearchInput value={props.filter.query()} onInput={props.filter.setQuery} label="Search skills" />
      <FilterChips
        label="Kind of skill"
        options={props.filter.options()}
        value={props.filter.kind()}
        onChange={props.filter.setKind}
      />
    </div>
  );
}

function IconAction(props: {
  label: string;
  icon: Component<{ class?: string }>;
  onClick: () => void;
  disabled?: boolean;
  class?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        as={Button}
        variant="ghost"
        size="icon"
        class={cn('h-7 w-7 text-muted-foreground hover:text-foreground', props.class)}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        <Dynamic component={props.icon} class="h-3.5 w-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}

function UpgradeButton(props: { from: number; to: number; disabled: boolean; onUpgrade: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        as="button"
        type="button"
        disabled={props.disabled}
        onClick={props.onUpgrade}
        aria-label={`Upgrade to v${props.to}`}
        class={cn(
          'of-tone of-tone-needs-you of-hair inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium shadow-sm transition-colors hover:[--tone-hair:60%] disabled:cursor-default disabled:opacity-60',
          FOCUS_RING
        )}
      >
        <CircleArrowUp class="h-3.5 w-3.5" aria-hidden="true" />
        Upgrade
        <span class="font-mono text-[0.6875rem] tabular-nums opacity-80">
          v{props.from} → <strong class="font-semibold">v{props.to}</strong>
        </span>
      </TooltipTrigger>
      <TooltipContent>Upgrade to v{props.to}</TooltipContent>
    </Tooltip>
  );
}

function SkillName(props: { name: string; displayName: string | null }) {
  return (
    <Show
      when={props.displayName}
      fallback={<span class="truncate font-mono text-sm text-foreground">{props.name}</span>}
    >
      {(displayName) => (
        <>
          <span class="truncate text-sm text-foreground">{displayName()}</span>
          <span class="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">{props.name}</span>
        </>
      )}
    </Show>
  );
}

const ROW_CLASS =
  'relative flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/40 has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-ring';

const ROW_LINK_CLASS = 'flex min-w-0 flex-1 items-center gap-2 after:absolute after:inset-0 focus-visible:outline-none';

function ShippedSkillRow(props: { agentId: string; skill: ShippedRow }) {
  const content = () => (
    <>
      <Files class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        <SkillName name={props.skill.name} displayName={props.skill.displayName} />
        <Show when={props.skill.version}>{(version) => <VersionTag version={version()} />}</Show>
        <PackageBadge />
      </span>
    </>
  );
  return (
    <div class={ROW_CLASS}>
      <Show
        when={props.skill.skillId}
        fallback={<span class="flex min-w-0 flex-1 items-center gap-2">{content()}</span>}
      >
        {(skillId) => (
          <Link
            to="/store/skills/$id"
            params={{ id: skillId() }}
            search={{ file: DEFAULT_SKILL_FILE, agent: props.agentId }}
            class={ROW_LINK_CLASS}
          >
            {content()}
          </Link>
        )}
      </Show>
    </div>
  );
}

type PendingChange = { action: 'upgrade' | 'remove'; skill: AgentProfileSkill };

export function AgentSkillList(props: {
  agent: AgentDetail;
  skills: AgentProfileSkill[];
  shipped?: ShippedSkill[];
  editable: boolean;
  onAdd?: () => void;
}) {
  const setSkill = useSetAgentSkill(() => props.agent.id);
  const removeSkill = useRemoveAgentSkill(() => props.agent.id);
  const [settingsOf, setSettingsOf] = createSignal<AgentProfileSkill | null>(null);
  const [pending, setPending] = createSignal<PendingChange | null>(null);
  const shownChange = createMemo<PendingChange | null>((last) => pending() ?? last, null);
  const listed = createMemo<ListedSkill[]>(() =>
    [
      ...props.skills,
      ...(props.shipped ?? []).map(
        (skill): ShippedRow => ({
          skillId: skill.skillId,
          name: skill.name,
          displayName: skill.displayName,
          version: skill.version,
          origin: 'built_in',
          externalServiceId: null,
          shipped: true,
        })
      ),
    ].toSorted((left, right) => left.name.localeCompare(right.name))
  );
  const filter = useSkillFilter(() => listed(), nameMatches);
  const environments = useEnvironments();
  const agentName = () => props.agent.displayName ?? props.agent.name;
  const newProjectsEnvironment = () => {
    if (props.agent.origin !== 'custom') return undefined;
    const start = environments.data?.find(
      (environment) => environment.id === props.agent.settings.defaultEnvironmentId
    );
    return start && !start.isDefault ? start.name : undefined;
  };

  const upgrade = async (row: AgentProfileSkill) => {
    const skill = { name: row.name, skillId: row.skillId, latestVersion: row.latestVersion };
    try {
      await setSkill.mutateAsync({ skillId: skill.skillId });
      toast.success(`${skill.name} now pins v${skill.latestVersion}`);
    } catch (error) {
      toast.error(refusalMessage(error));
    }
  };

  const remove = async (row: AgentProfileSkill) => {
    const skill = { name: row.name, skillId: row.skillId, pinnedVersionId: row.pinnedVersionId };
    try {
      await removeSkill.mutateAsync(skill.skillId);
    } catch (error) {
      toast.error(refusalMessage(error));
      return;
    }
    toast.success(`Removed ${skill.name}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          void setSkill
            .mutateAsync({ skillId: skill.skillId, versionId: skill.pinnedVersionId })
            .catch((error: unknown) => toast.error(refusalMessage(error)));
        },
      },
    });
  };

  const confirmPending = () => {
    const change = pending();
    if (!change) return;
    void (change.action === 'upgrade' ? upgrade(change.skill) : remove(change.skill));
  };

  return (
    <Show
      when={listed().length > 0}
      fallback={
        <div class="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No skills yet.
          <Show when={props.editable && props.onAdd}>
            {' '}
            <button
              type="button"
              class={cn('rounded underline underline-offset-2 hover:text-foreground', FOCUS_RING)}
              onClick={props.onAdd}
            >
              Add one
            </button>
            .
          </Show>
        </div>
      }
    >
      <Show when={listed().length >= LIST_FILTER_FROM || filter.options().length > 2}>
        <SkillFilterBar filter={filter} class="mb-3" />
      </Show>
      <Show
        when={filter.visible().length > 0}
        fallback={<p class="px-2 py-6 text-center text-sm text-muted-foreground">No skills match.</p>}
      >
        <RowList>
          <For each={filter.visible()}>
            {(row) => (
              <Show
                when={'pinnedVersion' in row ? row : null}
                fallback={<ShippedSkillRow agentId={props.agent.id} skill={row as ShippedRow} />}
              >
                {(carried) => {
                  const skill = carried();
                  return (
                    <div class={ROW_CLASS}>
                      <Link
                        to="/store/skills/$id"
                        params={{ id: skill.skillId }}
                        search={{ v: skill.pinnedVersion, file: DEFAULT_SKILL_FILE, agent: props.agent.id }}
                        class={ROW_LINK_CLASS}
                      >
                        <Files class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span class="min-w-0 flex-1 space-y-0.5">
                          <span class="flex min-w-0 flex-wrap items-center gap-1.5">
                            <SkillName name={skill.name} displayName={skill.displayName} />
                            <VersionTag version={skill.pinnedVersion} />
                            <OriginBadge origin={skill.origin} />
                            <ServiceMark externalServiceId={skill.externalServiceId} available />
                            <Show when={skill.visibility === 'private'}>
                              <VisibilityBadge visibility="private" />
                            </Show>
                            <Show when={skill.retired}>
                              <RetiredBadge />
                            </Show>
                          </span>
                          <Show when={skill.externalServiceId !== null}>
                            <span class="block truncate text-xs text-muted-foreground">
                              {serviceSettingsSummary(skill)}
                            </span>
                          </Show>
                        </span>
                      </Link>
                      <div class="relative flex shrink-0 items-center gap-1">
                        <Show when={skill.updateAvailable ? skill.latestVersion : null}>
                          {(latest) => (
                            <Show
                              when={props.editable}
                              fallback={<VersionUpdateBadge from={skill.pinnedVersion} to={latest()} />}
                            >
                              <UpgradeButton
                                from={skill.pinnedVersion}
                                to={latest()}
                                disabled={setSkill.isPending}
                                onUpgrade={() => setPending({ action: 'upgrade', skill })}
                              />
                            </Show>
                          )}
                        </Show>
                        <Show when={skill.externalServiceId !== null && props.editable}>
                          <IconAction
                            label="Service settings"
                            icon={SlidersHorizontal}
                            onClick={() => setSettingsOf(skill)}
                          />
                        </Show>
                        <Show when={props.editable}>
                          <IconAction
                            label="Remove from this agent"
                            icon={Trash2}
                            class="hover:text-destructive"
                            onClick={() => setPending({ action: 'remove', skill })}
                          />
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </Show>
            )}
          </For>
        </RowList>
      </Show>
      <ConfirmDialog
        open={pending() !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          shownChange()?.action === 'upgrade'
            ? `Upgrade ${shownChange()?.skill.name} to v${shownChange()?.skill.latestVersion}?`
            : `Remove ${shownChange()?.skill.name}?`
        }
        description={
          shownChange()?.action === 'upgrade'
            ? `${agentName()} moves from v${shownChange()?.skill.pinnedVersion} to v${shownChange()?.skill.latestVersion}.`
            : `${agentName()} stops carrying it. You can undo this right after.`
        }
        confirmLabel={shownChange()?.action === 'upgrade' ? 'Upgrade' : 'Remove'}
        variant={shownChange()?.action === 'upgrade' ? 'default' : 'destructive'}
        onConfirm={confirmPending}
      />
      <ServiceSettingsDialog
        agentId={props.agent.id}
        skillId={settingsOf()?.skillId ?? null}
        newProjectsEnvironment={newProjectsEnvironment()}
        onClose={() => setSettingsOf(null)}
      />
    </Show>
  );
}

interface Verdict {
  ok: boolean;
  reason?: string;
  onAgent?: boolean;
}

export function skillAddable(agent: AgentDetail, carried: AgentProfileSkill[], skill: Skill): Verdict {
  if (agent.shippedSkills.some((shipped) => shipped.name === skill.name))
    return { ok: false, reason: 'Ships with this agent', onAgent: true };
  if (skill.disabled) return { ok: false, reason: 'Disabled' };
  if (!skill.latestVersion) return { ok: false, reason: 'No published version' };
  if (carried.some((pinned) => pinned.skillId === skill.id))
    return { ok: false, reason: 'Already on this agent', onAgent: true };
  if (carried.some((pinned) => pinned.name === skill.name))
    return { ok: false, reason: 'Another skill with this name is already on this agent' };
  if (skill.visibility === 'private' && agent.origin === 'built_in')
    return { ok: false, reason: 'A private skill cannot go on a built-in agent' };
  if (skill.visibility === 'private' && agent.visibility === 'public')
    return { ok: false, reason: 'A private skill cannot go on a public agent' };
  return { ok: true };
}

export function AddSkillsDialog(props: {
  agent: AgentDetail;
  carried: AgentProfileSkill[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [picked, setPicked] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const setSkill = useSetAgentSkill(() => props.agent.id);
  const skills = useSkills(
    () => 'all' as const,
    () => ''
  );

  const filter = useSkillFilter(
    () => (skills.data ?? []).filter((skill) => !(skill.externalServiceId && !skill.available)),
    (skill, needle) => nameMatches(skill, needle) || (skill.description ?? '').toLowerCase().includes(needle)
  );

  const close = () => {
    props.onOpenChange(false);
    setPicked([]);
    filter.reset();
    setError(null);
  };

  const toggle = (id: string) =>
    setPicked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  const add = async () => {
    setError(null);
    const chosen = picked();
    try {
      for (const skillId of chosen) await setSkill.mutateAsync({ skillId });
    } catch (caught) {
      setError(refusalMessage(caught));
      return;
    }
    close();
    toast.success(chosen.length === 1 ? 'Skill added' : `${chosen.length} skills added`);
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && close()}>
      <DialogContent class="max-h-[85vh] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add skills to {props.agent.displayName ?? props.agent.name}</DialogTitle>
          <DialogDescription>
            Each skill is pinned at its latest version. You upgrade pins yourself later — nothing auto-updates.
          </DialogDescription>
        </DialogHeader>

        <div class="mt-4 space-y-3">
          <SkillFilterBar filter={filter} />
          <div
            class="-mx-1 max-h-[45vh] space-y-1 overflow-y-auto overscroll-contain px-1 py-1"
            role="group"
            aria-label="Skills to add"
          >
            <Show
              when={filter.visible().length > 0}
              fallback={<p class="px-2 py-6 text-center text-sm text-muted-foreground">No skills match.</p>}
            >
              <For each={filter.visible()}>
                {(skill) => {
                  const verdict = () => skillAddable(props.agent, props.carried, skill);
                  const on = () => picked().includes(skill.id);
                  const checked = () => on() || verdict().onAgent === true;
                  return (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked()}
                      disabled={!verdict().ok}
                      onClick={() => toggle(skill.id)}
                      class={cn(
                        'flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                        FOCUS_RING,
                        on() ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent',
                        !verdict().ok && 'cursor-not-allowed opacity-60'
                      )}
                    >
                      <span
                        class={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                          checked() ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background'
                        )}
                        aria-hidden="true"
                      >
                        <Show when={checked()}>
                          <Check class="h-3 w-3" />
                        </Show>
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="flex flex-wrap items-center gap-1.5">
                          <Show when={skill.displayName} fallback={<span class="font-mono text-sm">{skill.name}</span>}>
                            {(displayName) => (
                              <>
                                <span class="text-sm">{displayName()}</span>
                                <span class="font-mono text-[0.6875rem] text-muted-foreground">{skill.name}</span>
                              </>
                            )}
                          </Show>
                          <Show when={skill.latestVersion}>
                            {(version) => <VersionTag version={version().version} />}
                          </Show>
                          <OriginBadge origin={skill.origin} />
                          <ServiceMark externalServiceId={skill.externalServiceId} available={skill.available} />
                          <Show when={skill.visibility === 'private'}>
                            <VisibilityBadge visibility="private" />
                          </Show>
                          <Show when={skill.disabled}>
                            <DisabledBadge />
                          </Show>
                        </span>
                        <span class="mt-0.5 block truncate text-xs text-muted-foreground">
                          {verdict().ok ? (skill.description ?? '') : verdict().reason}
                        </span>
                      </span>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
          <Show when={error()}>
            <p class="text-xs text-destructive" role="alert">
              {error()}
            </p>
          </Show>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" disabled={picked().length === 0 || setSkill.isPending} onClick={() => void add()}>
            <Plus class="h-3.5 w-3.5" aria-hidden="true" />
            {picked().length <= 1 ? 'Add skill' : `Add ${picked().length} skills`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
