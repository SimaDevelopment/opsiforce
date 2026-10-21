import { Show, createEffect, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { toast } from 'solid-sonner';
import {
  useEditModelProviderConnection,
  type BaseFormatId,
  type ModelProviderConnectionEdit,
  type ModelProviderKind,
  type ModelProviderScope,
} from '~/api/model-providers';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import {
  AZURE_KEY_PLACEHOLDER,
  BaseUrlField,
  EndpointField,
  FixedValue,
  KeyField,
  errorMessage,
  isAzureEndpoint,
  isHttpsUrl,
} from './connection-fields';
import { KIND_LABEL } from './copy';
import { BASE_FORMAT_LABEL } from './traffic-split';

export interface EditableConnection {
  name: string;
  baseFormat: BaseFormatId;
  kind?: ModelProviderKind | null;
  baseUrl?: string | null;
}

export function EditConnectionDialog(props: {
  row: EditableConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope?: ModelProviderScope;
  keyOnly?: boolean;
}) {
  const editConnection = useEditModelProviderConnection(props.scope);
  const [draft, setDraft] = createStore({ key: '', baseUrl: '', endpoint: '' });
  const [error, setError] = createSignal<string | null>(null);
  const isCompatibleEndpoint = () => !props.keyOnly && props.row.kind === 'compatible-endpoint';
  const azure = () => props.row.kind === 'azure-foundry';
  const complete = () =>
    draft.key.trim() !== '' &&
    (!isCompatibleEndpoint() || isHttpsUrl(draft.baseUrl)) &&
    (!azure() || isAzureEndpoint(draft.endpoint));

  createEffect(() => {
    if (props.open) {
      setDraft({
        key: '',
        baseUrl: azure() ? '' : (props.row.baseUrl ?? ''),
        endpoint: azure() ? (props.row.baseUrl ?? '') : '',
      });
      setError(null);
    }
  });

  function change(patch: Partial<typeof draft>) {
    setDraft(patch);
    setError(null);
  }

  function save() {
    const edit: ModelProviderConnectionEdit = {
      key: draft.key,
      ...(isCompatibleEndpoint() ? { baseUrl: draft.baseUrl.trim() } : {}),
      ...(azure() ? { endpoint: draft.endpoint.trim() } : {}),
    };
    editConnection.mutate(
      { name: props.row.name, edit },
      {
        onSuccess: () => {
          toast.success(`${props.row.name} is connected with the new details`);
          props.onOpenChange(false);
        },
        onError: (err) => setError(errorMessage(err, 'The connection could not be updated')),
      }
    );
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-lg" align="top">
        <DialogTitle>{props.keyOnly ? 'Replace key' : 'Edit connection'}</DialogTitle>
        <DialogDescription>
          We test the connection with the key you enter before saving anything. If the test fails, nothing changes. The
          models it serves stay as they are.
        </DialogDescription>
        <div class="mt-4 space-y-3">
          <div class={azure() ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3 sm:grid-cols-3'}>
            <FixedValue label="Name" value={props.row.name} mono />
            <Show when={!azure()}>
              <FixedValue label="Format" value={BASE_FORMAT_LABEL[props.row.baseFormat]} />
            </Show>
            <FixedValue label="Connected with" value={props.row.kind ? KIND_LABEL[props.row.kind] : 'Custom'} />
          </div>
          <Show when={isCompatibleEndpoint()}>
            <BaseUrlField
              format={props.row.baseFormat}
              value={draft.baseUrl}
              onInput={(baseUrl) => change({ baseUrl })}
            />
          </Show>
          <Show when={azure()}>
            <EndpointField value={draft.endpoint} onInput={(endpoint) => change({ endpoint })} />
          </Show>
          <KeyField
            format={props.row.baseFormat}
            value={draft.key}
            onInput={(key) => change({ key })}
            hint="The current key is never shown. The key you enter replaces it."
            placeholder={azure() ? AZURE_KEY_PLACEHOLDER : undefined}
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
          <Button size="sm" disabled={!complete()} loading={editConnection.isPending} onClick={save}>
            Test and save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
