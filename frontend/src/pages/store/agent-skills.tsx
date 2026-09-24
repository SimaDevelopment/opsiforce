import { For, Show, createMemo, createSignal } from 'solid-js';
import { Link } from '@tanstack/solid-router';
import { toast } from 'solid-sonner';
import {
  useRemoveAgentSkill,
  useSetAgentSkill,
  type AgentDetail,
  type AgentProfileSkill,
} from '~/api/agents';
import { ApiError } from '~/api/client';
import { useSkills, type Skill } from '~/api/skills';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import {
  DisabledBadge,
  FOCUS_RING,
  OriginBadge,
  RowList,
  SearchInput,
  VisibilityBadge,
} from '~/components/store/store-list';
import { ArrowUp, Check, Files, Lock, Plus } from '~/components/icons';
import { cn } from '~/lib/cn';
import { DEFAULT_SKILL_FILE } from './skill-page';

function refusalMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The change could not be saved.';
}

function UpdateBadge(props: { from: number; to: number }) {
  return (
    <Badge variant="warning" class="gap-1 font-medium tabular-nums">
      <ArrowUp class="h-3 w-3" aria-hidden="true" />v{props.from} → v{props.to}
    </Badge>
  );
}

export function AgentSkillList(props: {
  agent: AgentDetail;
  skills: AgentProfileSkill[];
  editable: boolean;
  onAdd?: () => void;
}) {
  const setSkill = useSetAgentSkill(() => props.agent.id);
  const removeSkill = useRemoveAgentSkill(() => props.agent.id);

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

  return (
    <Show
      when={props.skills.length > 0}
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
      <RowList>
        <For each={props.skills}>
          {(skill) => (
            <div class="relative flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/40 has-[a:focus-visible]:ring-1 has-[a:focus-visible]:ring-ring">
              <Link
                to="/store/skills/$id"
                params={{ id: skill.skillId }}
                search={{ v: skill.pinnedVersion, file: DEFAULT_SKILL_FILE, agent: props.agent.id }}
                class="flex min-w-0 flex-1 items-center gap-2 after:absolute after:inset-0 focus-visible:outline-none"
              >
                <Files class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="truncate font-mono text-sm text-foreground">{skill.name}</span>
                <span class="shrink-0 text-xs tabular-nums text-muted-foreground">v{skill.pinnedVersion}</span>
                <Show when={skill.visibility === 'private'}>
                  <Lock class="h-3 w-3 shrink-0 text-amber-600" role="img" aria-label="Private" />
                </Show>
              </Link>
              <div class="relative flex shrink-0 items-center gap-2">
                <Show when={skill.updateAvailable ? skill.latestVersion : null}>
                  {(latest) => (
                    <>
                      <UpdateBadge from={skill.pinnedVersion} to={latest()} />
                      <Show when={props.editable}>
                        <Button size="sm" variant="outline" class="h-7" onClick={() => void upgrade(skill)}>
                          Upgrade
                        </Button>
                      </Show>
                    </>
                  )}
                </Show>
                <Show when={props.editable}>
                  <Button
                    size="sm"
                    variant="ghost"
                    class="h-7 text-muted-foreground"
                    onClick={() => void remove(skill)}
                  >
                    Remove
                  </Button>
                </Show>
              </div>
            </div>
          )}
        </For>
      </RowList>
    </Show>
  );
}

interface Verdict {
  ok: boolean;
  reason?: string;
}

export function skillAddable(agent: AgentDetail, carried: AgentProfileSkill[], skill: Skill): Verdict {
  if (skill.disabled) return { ok: false, reason: 'Disabled' };
  if (!skill.latestVersion) return { ok: false, reason: 'No published version' };
  if (carried.some((pinned) => pinned.skillId === skill.id)) return { ok: false, reason: 'Already on this agent' };
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
  const [query, setQuery] = createSignal('');
  const [picked, setPicked] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const setSkill = useSetAgentSkill(() => props.agent.id);
  const skills = useSkills(
    () => 'all' as const,
    () => ''
  );

  const candidates = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return (skills.data ?? []).filter(
      (skill) =>
        !needle ||
        skill.name.toLowerCase().includes(needle) ||
        (skill.description ?? '').toLowerCase().includes(needle)
    );
  });

  const close = () => {
    props.onOpenChange(false);
    setPicked([]);
    setQuery('');
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
          <SearchInput value={query()} onInput={setQuery} label="Search skills" />
          <div
            class="-mx-1 max-h-[45vh] space-y-1 overflow-y-auto overscroll-contain px-1 py-1"
            role="group"
            aria-label="Skills to add"
          >
            <Show
              when={candidates().length > 0}
              fallback={<p class="px-2 py-6 text-center text-sm text-muted-foreground">No skills match.</p>}
            >
              <For each={candidates()}>
                {(skill) => {
                  const verdict = () => skillAddable(props.agent, props.carried, skill);
                  const on = () => picked().includes(skill.id);
                  return (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on()}
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
                          on() ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background'
                        )}
                        aria-hidden="true"
                      >
                        <Show when={on()}>
                          <Check class="h-3 w-3" />
                        </Show>
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="flex flex-wrap items-center gap-1.5">
                          <span class="font-mono text-sm">{skill.name}</span>
                          <Show when={skill.latestVersion}>
                            {(version) => (
                              <span class="text-xs tabular-nums text-muted-foreground">v{version().version}</span>
                            )}
                          </Show>
                          <OriginBadge origin={skill.origin} />
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
