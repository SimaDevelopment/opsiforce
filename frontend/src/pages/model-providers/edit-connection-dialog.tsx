import { Show, createEffect, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { toast } from 'solid-sonner';
import {
  useEditModelProviderConnection,
  useModelProviderCreationRules,
  usePlatformModelProviderCreationRules,
  type AzureConnection,
  type BaseFormatId,
  type ModelProviderConnectionEdit,
  type ModelProviderKind,
  type ModelProviderScope,
} from '~/api/model-providers';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import {
  AZURE_KEY_PLACEHOLDER,
  AzureModelsField,
  BaseUrlField,
  EndpointField,
  FixedValue,
  KeyField,
  ModelsField,
  deploymentsToSend,
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
  servedModels?: string[];
  connection?: AzureConnection;
}

const CHOOSES_MODELS: ModelProviderKind[] = ['official-api-key', 'compatible-endpoint'];

export function EditConnectionDialog(props: {
  row: EditableConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope?: ModelProviderScope;
  keyOnly?: boolean;
}) {
  const editConnection = useEditModelProviderConnection(props.scope);
  const rules = props.scope === 'platform' ? usePlatformModelProviderCreationRules() : useModelProviderCreationRules();
  const [draft, setDraft] = createStore({
    key: '',
    baseUrl: '',
    endpoint: '',
    models: null as string[] | null,
    deployments: {} as Record<string, string>,
  });
  const [error, setError] = createSignal<string | null>(null);
  const isCompatibleEndpoint = () => !props.keyOnly && props.row.kind === 'compatible-endpoint';
  const azure = () => props.row.kind === 'azure-foundry';
  const choosesModels = () => !props.keyOnly && !!props.row.kind && CHOOSES_MODELS.includes(props.row.kind);
  const catalog = () => rules.data?.catalogModels;
  const complete = () =>
    draft.key.trim() !== '' &&
    (!isCompatibleEndpoint() || isHttpsUrl(draft.baseUrl)) &&
    (!azure() || (isAzureEndpoint(draft.endpoint) && (draft.models?.length ?? 0) > 0)) &&
    (draft.models === null || draft.models.length > 0);

  createEffect(() => {
    if (props.open) {
      setDraft({
        key: '',
        baseUrl: props.row.baseUrl ?? '',
        endpoint: azure() ? (props.row.baseUrl ?? '') : '',
        models: azure() ? [...(props.row.connection?.models ?? [])] : (props.row.servedModels ?? null),
        deployments: { ...(props.row.connection?.deployments ?? {}) },
      });
      setError(null);
    }
  });

  function modelsToSend(): Partial<ModelProviderConnectionEdit> {
    if (azure()) {
      const models = draft.models ?? [];
      return { endpoint: draft.endpoint.trim(), models, deployments: deploymentsToSend(models, draft.deployments) };
    }
    const every = catalog()?.[props.row.baseFormat];
    if (!choosesModels() || !every) return {};
    return { models: draft.models ?? every };
  }

  function change(patch: Partial<typeof draft>) {
    setDraft(patch);
    setError(null);
  }

  function save() {
    const edit: ModelProviderConnectionEdit = {
      key: draft.key,
      ...(isCompatibleEndpoint() ? { baseUrl: draft.baseUrl.trim() } : {}),
      ...modelsToSend(),
    };
    editConnection.mutate(
      { name: props.row.name, edit },
      {
        onSuccess: () => {
          toast.success(`${props.row.name} updated`);
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
          The connection is tested with the key you enter before anything changes. If the test fails, the current
          connection stays as it is.
        </DialogDescription>
        <div class="mt-4 space-y-3">
          <div class="grid gap-3 sm:grid-cols-3">
            <FixedValue label="Name" value={props.row.name} mono />
            <FixedValue label="Format" value={BASE_FORMAT_LABEL[props.row.baseFormat]} />
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
            hint="The current key is never shown. Enter the key to test with; it replaces the current one."
            placeholder={azure() ? AZURE_KEY_PLACEHOLDER : undefined}
          />
          <Show when={catalog()}>
            {(models) => (
              <Show
                when={azure()}
                fallback={
                  <Show when={choosesModels()}>
                    <ModelsField
                      format={props.row.baseFormat}
                      catalog={models()[props.row.baseFormat]}
                      selected={draft.models}
                      onChange={(chosen) => change({ models: chosen })}
                    />
                  </Show>
                }
              >
                <AzureModelsField
                  catalog={models()}
                  selected={draft.models ?? []}
                  deployments={draft.deployments}
                  onChange={(chosen, deployments) => change({ models: chosen, deployments })}
                />
              </Show>
            )}
          </Show>
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
