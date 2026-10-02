import { Show, createEffect, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { toast } from 'solid-sonner';
import {
  BASE_FORMAT_IDS,
  useModelProviderCreationRules,
  useReenterModelProviderKey,
  type BaseFormatId,
  type ModelProviderConnection,
  type ModelProviderKind,
  type ModelProviderScope,
} from '~/api/model-providers';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import {
  BaseUrlField,
  FixedValue,
  KeyField,
  KindChoice,
  RadioChoice,
  errorMessage,
  isHttpsUrl,
} from './connection-fields';
import { BASE_FORMAT_LABEL } from './traffic-split';

const OFFICIAL_KEY_ONLY: ModelProviderKind[] = ['official-api-key'];

function keyedKinds(kinds: ModelProviderKind[] | undefined): ModelProviderKind[] {
  return (kinds ?? []).filter((kind) => kind !== 'linked-account');
}

export function ReenterKeyDialog(props: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope?: ModelProviderScope;
  kindsByFormat?: Record<BaseFormatId, ModelProviderKind[]>;
  fixedFormat?: BaseFormatId;
}) {
  const rules = useModelProviderCreationRules(() => props.scope !== 'platform');
  const reenterKey = useReenterModelProviderKey(props.scope);
  const kindsByFormat = () => props.kindsByFormat ?? rules.data?.kindsByFormat;
  const [draft, setDraft] = createStore({
    baseFormat: 'openai' as BaseFormatId,
    kind: 'official-api-key' as ModelProviderKind,
    key: '',
    baseUrl: '',
  });
  const [error, setError] = createSignal<string | null>(null);
  const kinds = () => (props.fixedFormat ? OFFICIAL_KEY_ONLY : keyedKinds(kindsByFormat()?.[draft.baseFormat]));
  const needsBaseUrl = () => draft.kind === 'compatible-endpoint';
  const complete = () =>
    draft.key.trim() !== '' && kinds().includes(draft.kind) && (!needsBaseUrl() || isHttpsUrl(draft.baseUrl));

  createEffect(() => {
    if (props.open) {
      setDraft({ baseFormat: props.fixedFormat ?? 'openai', kind: 'official-api-key', key: '', baseUrl: '' });
      setError(null);
    }
  });

  function change(patch: Partial<typeof draft>) {
    setDraft(patch);
    setError(null);
  }

  function chooseFormat(baseFormat: BaseFormatId) {
    const available = keyedKinds(kindsByFormat()?.[baseFormat]);
    change({ baseFormat, kind: available.includes(draft.kind) ? draft.kind : (available[0] ?? draft.kind) });
  }

  function restore() {
    const connection: ModelProviderConnection = {
      baseFormat: draft.baseFormat,
      kind: draft.kind,
      key: draft.key,
      ...(needsBaseUrl() ? { baseUrl: draft.baseUrl.trim() } : {}),
    };
    reenterKey.mutate(
      { name: props.name, connection },
      {
        onSuccess: () => {
          toast.success(`${props.name} is back in the model gateway`);
          props.onOpenChange(false);
        },
        onError: (err) => setError(errorMessage(err, 'The model provider could not be restored')),
      }
    );
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-xl" align="top">
        <DialogTitle>Re-enter key</DialogTitle>
        <DialogDescription>
          The model gateway lost this model provider. Enter its connection again to restore it under the same name. It
          keeps its switch and weight, and it gets no requests until the test passes.
        </DialogDescription>
        <div class="mt-4 space-y-3">
          <FixedValue label="Name" value={props.name} mono />
          <Show
            when={!props.fixedFormat}
            fallback={<FixedValue label="Format" value={BASE_FORMAT_LABEL[draft.baseFormat]} />}
          >
            <RadioChoice
              label="Format"
              options={[...BASE_FORMAT_IDS]}
              selected={draft.baseFormat}
              onSelect={chooseFormat}
              title={(format) => BASE_FORMAT_LABEL[format]}
            />
            <KindChoice kinds={kinds()} selected={draft.kind} onSelect={(kind) => change({ kind })} />
          </Show>
          <Show when={needsBaseUrl()}>
            <BaseUrlField format={draft.baseFormat} value={draft.baseUrl} onInput={(baseUrl) => change({ baseUrl })} />
          </Show>
          <KeyField
            format={draft.baseFormat}
            value={draft.key}
            onInput={(key) => change({ key })}
            hint="Stored in the model gateway only; it is never shown again."
          />
          <Show when={error()}>
            <p class="break-words text-xs text-destructive" role="alert">
              {error()}
            </p>
          </Show>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!complete()} loading={reenterKey.isPending} onClick={restore}>
            Test and restore
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
