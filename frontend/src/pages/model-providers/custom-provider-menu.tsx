import { Show, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import { useDeleteModelProvider, type BaseFormatId, type TenantModelProvider } from '~/api/model-providers';
import { EllipsisVertical, KeyRound, Pencil, Trash2 } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { MENU_TRIGGER_CLASS, ModelsItem } from './built-in-row';
import { EditConnectionDialog } from './edit-connection-dialog';
import { ModelsDialog } from './models-dialog';
import { DisconnectDialog, LinkedAccountMenuItems, useLinkedAccountActions } from './linked-account-sign-in';
import { ReenterKeyDialog } from './reenter-key-dialog';

function isEditable(row: TenantModelProvider): row is TenantModelProvider & { baseFormat: BaseFormatId } {
  return (row.status !== 'missing' || row.kind === 'azure-foundry') && row.baseFormat !== null;
}

function isLinkedAccount(row: TenantModelProvider): boolean {
  return row.kind === 'linked-account';
}

export function ReenterKeyButton(props: { name: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <Button size="sm" variant="outline" class="h-7" onClick={() => setOpen(true)}>
        <KeyRound class="h-3.5 w-3.5" /> Re-enter key
      </Button>
      <ReenterKeyDialog name={props.name} open={open()} onOpenChange={setOpen} />
    </>
  );
}

export function CustomProviderMenu(props: { row: TenantModelProvider }) {
  const [confirming, setConfirming] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [reentering, setReentering] = createSignal(false);
  const [modelsOpen, setModelsOpen] = createSignal(false);
  const deleteProvider = useDeleteModelProvider();
  const name = () => props.row.name;
  const linkedAccount = useLinkedAccountActions('tenant', name, () => isLinkedAccount(props.row));

  function remove() {
    deleteProvider.mutate(name(), {
      onSuccess: () => toast.success(`${name()} deleted`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `${name()} could not be deleted`),
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          class={MENU_TRIGGER_CLASS}
          disabled={deleteProvider.isPending || linkedAccount.busy()}
          aria-label={`${name()} actions`}
        >
          <EllipsisVertical class="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <LinkedAccountMenuItems actions={linkedAccount} linked={isLinkedAccount(props.row)} />
          <Show when={!isLinkedAccount(props.row)}>
            <Show
              when={isEditable(props.row)}
              fallback={
                <DropdownMenuItem onSelect={() => setReentering(true)}>
                  <KeyRound class="h-3.5 w-3.5" />
                  Re-enter key
                </DropdownMenuItem>
              }
            >
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil class="h-3.5 w-3.5" />
                Edit connection
              </DropdownMenuItem>
            </Show>
          </Show>
          <Show when={props.row.status !== 'missing' && props.row.baseFormat !== null}>
            <ModelsItem onSelect={() => setModelsOpen(true)} />
          </Show>
          <DropdownMenuItem
            class="text-destructive data-[highlighted]:text-destructive"
            onSelect={() => setConfirming(true)}
          >
            <Trash2 class="h-3.5 w-3.5 text-destructive" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming()}
        onOpenChange={setConfirming}
        title={`Delete ${name()}`}
        description={
          isLinkedAccount(props.row)
            ? 'It stops taking requests at once, and its ChatGPT sign-in is removed. This can’t be undone.'
            : 'It stops taking requests at once, and its key is removed from the model gateway. This can’t be undone.'
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={remove}
      />
      <Show when={isEditable(props.row) && props.row}>
        {(row) => <EditConnectionDialog row={row()} open={editing()} onOpenChange={setEditing} />}
      </Show>
      <Show when={props.row.baseFormat}>
        {(baseFormat) => (
          <ModelsDialog
            row={{ ...props.row, baseFormat: baseFormat() }}
            scope="tenant"
            open={modelsOpen()}
            onOpenChange={setModelsOpen}
          />
        )}
      </Show>
      <ReenterKeyDialog name={name()} open={reentering()} onOpenChange={setReentering} />
      <DisconnectDialog scope="tenant" name={name()} actions={linkedAccount} />
    </>
  );
}
