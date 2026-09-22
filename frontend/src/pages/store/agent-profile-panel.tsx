import { Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import { useBlocker } from '@tanstack/solid-router';
import { toast } from 'solid-sonner';
import {
  useAgentModels,
  useUpdateAgentProfile,
  type AgentDetail,
  type AgentProfile,
  type CatalogModel,
} from '~/api/agents';
import { ApiError } from '~/api/client';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectSection, SelectTrigger, SelectValue } from '~/components/ui/select';
import { Textarea } from '~/components/ui/textarea';
import { Plus } from '~/components/icons';
import { SectionTitle } from '~/components/store/store-list';
import { formatDate } from '~/lib/format-date';
import { cn } from '~/lib/cn';
import { AgentSkillList } from './agent-skills';

function modelLabel(profile: AgentProfile): string {
  if (!profile.model) return '—';
  return profile.variant ? `${profile.model} · ${profile.variant}` : profile.model;
}

/** Every environment but Development: the same fields, rendered as what was published there. */
export function ReadOnlyPanel(props: {
  agent: AgentDetail;
  profile: AgentProfile;
  environmentName: string;
  canManage: boolean;
}) {
  return (
    <div class="space-y-6">
      <p class="text-xs text-muted-foreground">
        {props.environmentName} is read-only. It changes only when Development is published onto it.
      </p>
      <div>
        <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-medium text-muted-foreground">Prompt</span>
          <span class="font-mono text-[11px] text-muted-foreground">{modelLabel(props.profile)}</span>
        </div>
        <Textarea
          readOnly
          aria-readonly="true"
          aria-label={`Prompt published to ${props.environmentName}`}
          value={props.profile.promptBody ?? ''}
          class="min-h-28 resize-y bg-muted/30 p-3 font-mono text-xs leading-relaxed text-muted-foreground"
        />
        <Show when={props.profile.updatedAt}>
          {(updatedAt) => (
            <p class="mt-1.5 text-xs text-muted-foreground">Published {formatDate(updatedAt())}</p>
          )}
        </Show>
      </div>
      <div>
        <SectionTitle>Skills</SectionTitle>
        <AgentSkillList agent={props.agent} skills={props.profile.skills ?? []} editable={false} />
      </div>
    </div>
  );
}

export function DevelopmentPanel(props: {
  agent: AgentDetail;
  profile: AgentProfile;
  canManage: boolean;
  onAdd: () => void;
}) {
  const catalog = useAgentModels();
  const save = useUpdateAgentProfile(() => props.agent.id);

  const [promptDraft, setPromptDraft] = createSignal(props.profile.promptBody ?? '');
  const [model, setModel] = createSignal(props.profile.model);
  const [variant, setVariant] = createSignal(props.profile.variant);
  const [modelError, setModelError] = createSignal<{ part: string; message: string } | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  /** The saved profile is the source of truth: a save, or switching agent, re-seeds the drafts. */
  createEffect(
    on(
      () => [props.profile.environmentId, props.profile.updatedAt, props.agent.id] as const,
      () => {
        setPromptDraft(props.profile.promptBody ?? '');
        setModel(props.profile.model);
        setVariant(props.profile.variant);
        setModelError(null);
        setSaveError(null);
      }
    )
  );

  const models = createMemo(() => catalog.data ?? []);
  const flatModels = createMemo(() => models().flatMap((provider) => provider.models));
  const chosenModel = createMemo(() => flatModels().find((entry) => entry.id === model()) ?? null);
  const efforts = () => chosenModel()?.efforts ?? [];

  const dirty = () =>
    promptDraft() !== (props.profile.promptBody ?? '') ||
    model() !== props.profile.model ||
    variant() !== props.profile.variant;

  const pickModel = (entry: CatalogModel) => {
    setModel(entry.id);
    setModelError(null);
    const current = variant();
    if (entry.efforts.length === 0) setVariant(null);
    else if (!current || !entry.efforts.includes(current))
      setVariant(entry.efforts[Math.floor(entry.efforts.length / 2)]);
  };

  const submit = async () => {
    const chosen = model();
    if (!chosen) {
      setSaveError('Choose a model first.');
      return;
    }
    setModelError(null);
    setSaveError(null);
    try {
      await save.mutateAsync({ promptBody: promptDraft(), model: chosen, variant: variant() });
      toast.success('Development saved');
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'model_unknown') {
        setModelError({ part: String(caught.details.part ?? 'model'), message: caught.message });
        return;
      }
      setSaveError(caught instanceof ApiError ? caught.message : 'The definition could not be saved.');
    }
  };

  return (
    <div class="space-y-6">
      <UnsavedChangesGuard dirty={() => props.canManage && dirty()} />

      <Show when={props.canManage}>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <div>
            <label for="agent-model" class="mb-1.5 block text-xs font-medium text-muted-foreground">
              Model
            </label>
            <Select<CatalogModel, { id: string; name: string; models: CatalogModel[] }>
              options={models()}
              optionValue="id"
              optionTextValue="name"
              optionGroupChildren="models"
              value={chosenModel()}
              onChange={(option) => option && pickModel(option)}
              itemComponent={(itemProps) => (
                <SelectItem item={itemProps.item}>
                  <span class="flex flex-col">
                    <span>{itemProps.item.rawValue.name}</span>
                    <span class="font-mono text-[10px] text-muted-foreground">{itemProps.item.rawValue.id}</span>
                  </span>
                </SelectItem>
              )}
              sectionComponent={(sectionProps) => (
                <SelectSection>{sectionProps.section.rawValue.name}</SelectSection>
              )}
            >
              <SelectTrigger id="agent-model" aria-label="Model" class="h-9">
                <SelectValue<CatalogModel>>
                  {(state) => <span class="truncate">{state.selectedOption()?.name ?? model() ?? 'Choose a model'}</span>}
                </SelectValue>
              </SelectTrigger>
              <SelectContent />
            </Select>
            <Show when={modelError()?.part === 'provider' || modelError()?.part === 'model'}>
              <p class="mt-1 text-xs text-destructive" role="alert">
                {modelError()?.message}
              </p>
            </Show>
          </div>
          <div>
            <label for="agent-effort" class="mb-1.5 block text-xs font-medium text-muted-foreground">
              Effort
            </label>
            <Select<string>
              options={efforts()}
              value={variant()}
              disabled={efforts().length === 0}
              onChange={(value) => {
                setVariant(value);
                setModelError(null);
              }}
              itemComponent={(itemProps) => <SelectItem item={itemProps.item}>{itemProps.item.rawValue}</SelectItem>}
            >
              <SelectTrigger id="agent-effort" aria-label="Effort" class="h-9">
                <SelectValue<string>>
                  {(state) => (
                    <span>{state.selectedOption() ?? (efforts().length === 0 ? 'Not configurable' : 'Effort')}</span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent />
            </Select>
            <Show when={modelError()?.part === 'variant'}>
              <p class="mt-1 text-xs text-destructive" role="alert">
                {modelError()?.message}
              </p>
            </Show>
          </div>
        </div>
      </Show>

      <div>
        <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <label for="agent-prompt" class="text-xs font-medium text-muted-foreground">
            Prompt
          </label>
          <Show when={!props.canManage}>
            <span class="font-mono text-[11px] text-muted-foreground">{modelLabel(props.profile)}</span>
          </Show>
        </div>
        <Textarea
          id="agent-prompt"
          readOnly={!props.canManage}
          aria-readonly={!props.canManage}
          value={promptDraft()}
          onInput={(event) => setPromptDraft(event.currentTarget.value)}
          class={cn(
            'min-h-28 resize-y p-3 font-mono text-xs leading-relaxed',
            !props.canManage && 'bg-muted/30 text-muted-foreground'
          )}
        />
        <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-muted-foreground">
            <Show when={dirty()} fallback={props.profile.updatedAt ? `Saved ${formatDate(props.profile.updatedAt)}` : ''}>
              Unsaved changes
            </Show>
          </p>
          <Show when={props.canManage}>
            <Button size="sm" disabled={!dirty() || save.isPending} onClick={() => void submit()}>
              Save
            </Button>
          </Show>
        </div>
        <Show when={saveError()}>
          <p class="mt-1 text-xs text-destructive" role="alert">
            {saveError()}
          </p>
        </Show>
      </div>

      <div>
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
          skills={props.profile.skills ?? []}
          editable={props.canManage}
          onAdd={props.onAdd}
        />
      </div>
    </div>
  );
}

/** Router navigation and a browser reload are both held back while the prompt has unsaved edits. */
function UnsavedChangesGuard(props: { dirty: () => boolean }) {
  const blocker = useBlocker({
    shouldBlockFn: () => props.dirty(),
    enableBeforeUnload: () => props.dirty(),
    withResolver: true,
  });

  return (
    <ConfirmDialog
      open={blocker().status === 'blocked'}
      onOpenChange={(open) => !open && blocker().reset?.()}
      title="Leave without saving?"
      description="The prompt, model and effort you changed here have not been saved. Leaving discards them."
      confirmLabel="Discard changes"
      cancelLabel="Keep editing"
      variant="destructive"
      onConfirm={() => blocker().proceed?.()}
    />
  );
}
