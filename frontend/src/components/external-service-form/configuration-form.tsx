import { Show, createSignal, type Accessor } from 'solid-js';
import type { Field } from '@opsiforce/external-service-sdk/forms';
import { ApiError } from '~/api/client';
import {
  withRevealed,
  type ConfigurationIssue,
  type ConfigurationValues,
  type RevealedSecret,
  type RotateTarget,
} from '~/api/external-service-views';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/cn';
import { createFormDraft, type FormDraft } from './form-draft';
import { createLabelBook, type LabelBook, type ValueLabels } from './form-labels';

const INVALID_VALUES_MESSAGE = 'Some values need fixing before they can be saved.';

interface ConfigurationEditsOptions<View> {
  rotate: (target: RotateTarget) => Promise<View>;
  retry?: () => Promise<View>;
  discard?: () => Promise<View>;
}

export interface ConfigurationEdits<View> {
  base: Accessor<View>;
  saved: Accessor<View | null>;
  revealed: Accessor<ReadonlyMap<string, string>>;
  rebase: (next: View) => void;
  edited: () => void;
  rotate: (target: RotateTarget) => Promise<void>;
  retry: () => Promise<void>;
  discard: () => Promise<void>;
}

export function createConfigurationEdits<View extends { revealed?: readonly RevealedSecret[] }>(
  initial: View,
  options: ConfigurationEditsOptions<View>
): ConfigurationEdits<View> {
  const [base, setBase] = createSignal(initial);
  const [saved, setSaved] = createSignal<View | null>(null);
  const [revealed, setRevealed] = createSignal<ReadonlyMap<string, string>>(new Map());

  const rebase = (next: View) => {
    setRevealed((shown) => withRevealed(shown, next.revealed));
    setSaved(() => next);
    setBase(() => next);
  };

  const settlePendingHook = async (settle: (() => Promise<View>) | undefined) => {
    if (!settle) return;
    const next = await settle();
    setSaved(null);
    setBase(() => next);
  };

  return {
    base,
    saved,
    revealed,
    rebase,
    edited: () => setSaved(null),
    rotate: async (target) => rebase(await options.rotate(target)),
    retry: () => settlePendingHook(options.retry),
    discard: () => settlePendingHook(options.discard),
  };
}

interface SaveMutation<View> {
  mutateAsync: (values: ConfigurationValues) => Promise<View>;
  isPending: boolean;
}

interface ConfigurationFormOptions<View> {
  form: readonly Field[];
  initial: ConfigurationValues;
  missing: readonly string[];
  labels?: ValueLabels;
  save: SaveMutation<View>;
  submitted?: (formValues: ConfigurationValues, labels: LabelBook) => ConfigurationValues;
  onEdit: () => void;
  onSaved: (view: View) => void;
  saveFailedMessage: string;
}

export interface ConfigurationForm {
  draft: FormDraft;
  labels: LabelBook;
  failure: Accessor<string | null>;
  saving: () => boolean;
  draftValues: () => ConfigurationValues;
  edited: () => void;
  submit: () => Promise<void>;
}

export function useConfigurationForm<View>(options: ConfigurationFormOptions<View>): ConfigurationForm {
  const draft = createFormDraft(options.form, options.initial, options.missing);
  const labels = createLabelBook(options.form, options.labels ?? {});
  const [failure, setFailure] = createSignal<string | null>(null);
  const draftValues = () => JSON.parse(JSON.stringify(draft.values)) as ConfigurationValues;

  const edited = () => {
    options.onEdit();
    setFailure(null);
  };

  const submit = async () => {
    setFailure(null);
    if (!draft.isValid()) {
      draft.showAllErrors();
      setFailure(INVALID_VALUES_MESSAGE);
      return;
    }
    const formValues = draftValues();
    let next: View;
    try {
      next = await options.save.mutateAsync(options.submitted ? options.submitted(formValues, labels) : formValues);
    } catch (error) {
      const issues = error instanceof ApiError ? error.details.errors : undefined;
      if (Array.isArray(issues)) {
        draft.showServerIssues(issues as ConfigurationIssue[]);
        setFailure(INVALID_VALUES_MESSAGE);
        return;
      }
      setFailure((error instanceof Error && error.message) || options.saveFailedMessage);
      return;
    }
    options.onSaved(next);
  };

  return {
    draft: {
      ...draft,
      setAt: (path, value) => {
        edited();
        draft.setAt(path, value);
      },
    },
    labels,
    failure,
    saving: () => options.save.isPending,
    draftValues,
    edited,
    submit,
  };
}

export function ConfigurationFooter(props: {
  saving: boolean;
  failure: string | null;
  saved: string | null;
  hint?: string | null;
  compact?: boolean;
  canSave?: boolean;
  cancel?: { label: string; onClick: () => void };
}) {
  const textSize = () => (props.compact ? 'text-[11px]' : 'text-xs');
  const saveButton = () => (
    <Show when={props.canSave ?? true}>
      <Button size="sm" type="submit" class={props.compact ? 'h-7 text-xs' : undefined} loading={props.saving}>
        Save
      </Button>
    </Show>
  );

  return (
    <div
      class={cn('flex flex-wrap items-center border-t border-border', props.compact ? 'gap-2 pt-3' : 'mt-5 gap-3 pt-4')}
    >
      <Show when={!props.compact}>{saveButton()}</Show>
      <Show when={props.failure}>
        {(message) => (
          <span class={cn(textSize(), 'text-destructive')} role="alert">
            {message()}
          </span>
        )}
      </Show>
      <Show when={!props.failure && props.saved}>
        {(message) => (
          <span class={cn(textSize(), 'text-emerald-700')} role="status">
            {message()}
          </span>
        )}
      </Show>
      <Show when={!props.failure && !props.saved && props.hint}>
        {(message) => <span class={cn(textSize(), 'text-muted-foreground')}>{message()}</span>}
      </Show>
      <Show when={props.compact}>
        <div class="ml-auto flex items-center gap-2">
          <Show when={props.cancel}>
            {(cancel) => (
              <Button type="button" variant="outline" size="sm" class="h-7 text-xs" onClick={() => cancel().onClick()}>
                {cancel().label}
              </Button>
            )}
          </Show>
          {saveButton()}
        </div>
      </Show>
    </div>
  );
}
