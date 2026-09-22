import { For, Show, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import { usePermissions } from '~/api/permissions';
import { useImportSkill, useSkills, type Skill } from '~/api/skills';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { SettingsSection } from '~/components/settings/settings-section';
import {
  ArchivedBadge,
  EmptyState,
  ErrorState,
  FilterChips,
  OriginBadge,
  RowLink,
  RowList,
  SearchInput,
  UpdateBadge,
  VisibilityBadge,
} from '~/components/store/store-list';
import { ChevronRight, Files, Upload } from '~/components/icons';
import { Permission } from '~/constants/permissions';
import { createSearchDraft, filterOptions, type StoreListProps } from './store-filters';

export function SkillsListPage(props: StoreListProps) {
  const { hasPermission } = usePermissions();
  const canManage = () => hasPermission(Permission.manageSkills);
  const search = createSearchDraft(
    () => props.query,
    (query) => props.onQuery(query)
  );
  const skills = useSkills(
    () => props.filter,
    () => props.query
  );
  const narrowed = () => props.filter !== 'all' || props.query.trim().length > 0;

  return (
    <SettingsSection
      icon={Files}
      title="Skills"
      description="Published skill versions your agents can pin. Saving a skill publishes a new version — there are no drafts, and pins never move on their own."
      width="wide"
      action={
        <Show when={canManage()}>
          <ImportSkillButton />
        </Show>
      }
    >
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput value={search.draft()} onInput={search.onInput} label="Search skills" />
        <FilterChips
          label="Filter skills"
          options={filterOptions(canManage())}
          value={props.filter}
          onChange={props.onFilter}
        />
      </div>

      <Show when={!skills.isError} fallback={<ErrorState message="The skills could not be loaded." />}>
        <Show
          when={skills.data}
          fallback={
            <div class="flex justify-center py-10">
              <Spinner />
            </div>
          }
        >
          {(rows) => (
            <Show when={rows().length > 0} fallback={<SkillsEmptyState narrowed={narrowed()} />}>
              <RowList>
                <For each={rows()}>{(skill) => <SkillRow skill={skill} />}</For>
              </RowList>
            </Show>
          )}
        </Show>
      </Show>
    </SettingsSection>
  );
}

function SkillsEmptyState(props: { narrowed: boolean }) {
  return (
    <Show
      when={props.narrowed}
      fallback={<EmptyState icon={Files} title="No skills yet." hint="Import a .skill archive to add the first one." />}
    >
      <EmptyState icon={Files} title="No skills match." hint="Try another filter, or clear the search." />
    </Show>
  );
}

function SkillRow(props: { skill: Skill }) {
  const used = () => props.skill.usedByAgentCount;
  return (
    <RowLink href={`/store/skills/${props.skill.id}`} class="p-4">
      <Files class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="font-mono text-sm font-medium">{props.skill.name}</span>
          <Show when={props.skill.latestVersion}>
            {(version) => <span class="text-xs tabular-nums text-muted-foreground">v{version().version}</span>}
          </Show>
          <OriginBadge origin={props.skill.origin} />
          <Show when={props.skill.visibility === 'private'}>
            <VisibilityBadge visibility="private" />
          </Show>
          <Show when={props.skill.archived}>
            <ArchivedBadge />
          </Show>
          <Show when={props.skill.outdatedAgentCount > 0}>
            <UpdateBadge agentCount={props.skill.outdatedAgentCount} />
          </Show>
        </div>
        <Show when={props.skill.description}>
          <div class="mt-0.5 truncate text-xs text-muted-foreground">{props.skill.description}</div>
        </Show>
        <div class="mt-1 text-xs tabular-nums text-muted-foreground">
          On {used()} agent{used() === 1 ? '' : 's'}
        </div>
      </div>
      <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
    </RowLink>
  );
}

function ImportSkillButton() {
  const importSkill = useImportSkill();
  const [input, setInput] = createSignal<HTMLInputElement>();

  const onFile = async (event: { currentTarget: HTMLInputElement }) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const skill = await importSkill.mutateAsync(file);
      toast.success(`Imported ${skill.name}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The import failed.');
    }
  };

  return (
    <>
      <input
        ref={setInput}
        type="file"
        accept=".skill,.zip"
        class="sr-only"
        aria-label="Skill archive to import"
        onChange={onFile}
      />
      <Button size="sm" variant="outline" disabled={importSkill.isPending} onClick={() => input()?.click()}>
        <Upload class="h-4 w-4" aria-hidden="true" />
        Import .skill
      </Button>
    </>
  );
}
