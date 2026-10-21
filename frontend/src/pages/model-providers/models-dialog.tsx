import { Show, createEffect, createSignal, untrack } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  useModelProviderCreationRules,
  usePlatformModelProviderCreationRules,
  useSetModelProviderModels,
  type AzureConnection,
  type BaseFormatId,
  type ModelProviderKind,
  type ModelProviderScope,
} from '~/api/model-providers';
import { Info } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { ModelChoiceField, deploymentsToSend, errorMessage } from './connection-fields';
import { BASE_FORMAT_LABEL } from './traffic-split';

export interface ModelsTarget {
  name: string;
  baseFormat: BaseFormatId;
  kind?: ModelProviderKind | null;
  servedModels?: string[];
  connection?: AzureConnection;
  declaredInDeployment?: boolean;
}

function currentChoice(row: ModelsTarget): string[] | null {
  if (row.kind !== 'azure-foundry') return row.servedModels ? [...row.servedModels] : null;
  const models = row.connection?.models ?? [];
  return models.includes('*') ? null : [...models];
}

function sameModels(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((model) => b.includes(model));
}

function sameDeployments(a: Record<string, string>, b: Record<string, string>): boolean {
  const named = (entries: Record<string, string>) =>
    Object.entries(entries).filter(([model, deployment]) => deployment.trim() !== '' && deployment.trim() !== model);
  const left = named(a);
  const right = named(b);
  return left.length === right.length && left.every(([model, deployment]) => b[model]?.trim() === deployment.trim());
}

function savedMessage(name: string, models: string[] | null): string {
  if (!models) return `${name} now serves every model`;
  return models.length === 1 ? `${name} now serves 1 model` : `${name} now serves ${models.length} models`;
}

export function ModelsDialog(props: {
  row: ModelsTarget;
  scope: ModelProviderScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setModels = useSetModelProviderModels(props.scope);
  const rules = props.scope === 'platform' ? usePlatformModelProviderCreationRules() : useModelProviderCreationRules();
  const [selected, setSelected] = createSignal<string[] | null>(null);
  const [deployments, setDeployments] = createSignal<Record<string, string>>({});
  const [error, setError] = createSignal<string | null>(null);
  const azure = () => props.row.kind === 'azure-foundry';
  const catalog = () => {
    const every = rules.data?.catalogModels;
    if (!every) return undefined;
    return azure() ? every : { [props.row.baseFormat]: every[props.row.baseFormat] };
  };
  const valid = () => selected()?.length !== 0;
  const changed = () =>
    !sameModels(selected(), currentChoice(props.row)) ||
    !sameDeployments(deployments(), props.row.connection?.deployments ?? {});

  createEffect(() => {
    if (props.open) {
      setSelected(untrack(() => currentChoice(props.row)));
      setDeployments(untrack(() => ({ ...(props.row.connection?.deployments ?? {}) })));
      setError(null);
    }
  });

  function change(models: string[] | null, nextDeployments: Record<string, string>) {
    setSelected(models);
    setDeployments(nextDeployments);
    setError(null);
  }

  function save() {
    const models = selected();
    const choice = {
      models,
      ...(azure() && models ? { deployments: deploymentsToSend(models, deployments()) } : {}),
    };
    setModels.mutate(
      { name: props.row.name, choice },
      {
        onSuccess: () => {
          toast.success(savedMessage(props.row.name, models));
          props.onOpenChange(false);
        },
        onError: (err) => setError(errorMessage(err, 'The models could not be saved')),
      }
    );
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-lg" align="top">
        <DialogTitle>
          Models{' '}
          <span class="font-mono" translate="no">
            {props.row.name}
          </span>{' '}
          serves
        </DialogTitle>
        <DialogDescription>
          <Show
            when={azure()}
            fallback={
              <>
                Requests for {BASE_FORMAT_LABEL[props.row.baseFormat]} models it doesn’t serve go to the other model
                providers that are on.
              </>
            }
          >
            Requests for models it doesn’t serve go to the other model providers that are on.
          </Show>
          <Show when={props.scope === 'platform'}> This applies to every organization that uses it.</Show>
        </DialogDescription>
        <div class="mt-4 space-y-3">
          <Show when={props.row.declaredInDeployment}>
            <div class="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Info class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                This model provider is also set up in the deployment configuration. If someone changes it there, that
                setup replaces your choice.
              </span>
            </div>
          </Show>
          <Show when={catalog()}>
            {(models) => (
              <ModelChoiceField
                catalog={models()}
                selected={selected()}
                deployments={azure() ? deployments() : undefined}
                onChange={change}
              />
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
          <Button
            size="sm"
            disabled={!valid() || !changed() || !catalog()}
            loading={setModels.isPending}
            onClick={save}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
