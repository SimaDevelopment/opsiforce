import { Show, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import {
  useDeleteModelProvider,
  usePlatformModelProviderCreationRules,
  type BaseFormatId,
  type PlatformModelProvider,
} from '~/api/model-providers';
import { Boxes, EllipsisVertical, KeyRound, Lock, Pencil, Trash2, Users } from '~/components/icons';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { TIPS } from './copy';
import { EditConnectionDialog } from './edit-connection-dialog';
import {
  DisconnectDialog,
  LinkedAccountMenuItems,
  LinkedAccountSignIn,
  useLinkedAccountActions,
} from './linked-account-sign-in';
import { ModelsDialog, type ModelsTarget } from './models-dialog';
import { InfoTip, Tip } from './provider-widgets';
import { OrganizationAccessDialog, OrganizationAccessPill } from './organization-access';
import { ReenterKeyDialog } from './reenter-key-dialog';

export const MENU_TRIGGER_CLASS =
  'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50';

type ManagedBuiltIn = PlatformModelProvider & { baseFormat: BaseFormatId };

export function builtInFormatOf(row: PlatformModelProvider): BaseFormatId | null {
  return row.baseFormat ?? (row.linkedAccountVendor ? 'openai' : null);
}

function isLinkedAccountRow(row: PlatformModelProvider): boolean {
  return row.linkedAccountVendor !== undefined && row.kind === 'linked-account';
}

function managedRow(row: PlatformModelProvider): ManagedBuiltIn | null {
  const { baseFormat } = row;
  return (row.fixed || row.notMetered || row.kind === 'azure-foundry') && baseFormat !== null
    ? { ...row, baseFormat }
    : null;
}

function NotMeteredPill() {
  return (
    <Tip content={TIPS.notMetered}>
      <span class="inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
        Not metered
      </span>
    </Tip>
  );
}

export function BuiltInPlatformPills(props: { row: PlatformModelProvider }) {
  return (
    <>
      <Show when={props.row.fixed}>
        <InfoTip content={TIPS.fixedBuiltIn} label={`Why ${props.row.name} can’t be deleted`} />
      </Show>
      <Show when={props.row.notMetered}>
        <NotMeteredPill />
      </Show>
      <Show when={props.row.deploymentManaged}>
        <Tip content={TIPS.deploymentConfig}>
          <span class="inline-flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-800">
            <Lock class="h-2.5 w-2.5" aria-hidden="true" />
            Deployment config
          </span>
        </Tip>
      </Show>
    </>
  );
}

export function ServedModelsNote(props: { models: string[] | undefined }) {
  return (
    <Show when={props.models}>
      {(models) => (
        <p class="mt-0.5 text-[11px] text-muted-foreground">
          <Show when={models().length > 0} fallback="Serves none of this format’s models">
            Serves only{' '}
            <span class="font-mono" translate="no">
              {models().join(', ')}
            </span>
            ; requests for other models skip it.
          </Show>
        </p>
      )}
    </Show>
  );
}

export function BuiltInPlatformDetails(props: { row: PlatformModelProvider; editable: boolean }) {
  return (
    <>
      <ServedModelsNote models={props.row.servedModels} />
      <Show when={props.row.url}>
        {(url) => (
          <p class="mt-0.5 break-all font-mono text-[11px] text-muted-foreground" translate="no">
            {url()}
          </p>
        )}
      </Show>
      <Show when={props.row.linkedAccountVendor}>
        <div class="mt-1.5">
          <LinkedAccountSignIn
            scope="platform"
            name={props.row.name}
            editable={props.editable}
            linked={props.row.kind === 'linked-account'}
          />
        </div>
      </Show>
      <div>
        <OrganizationAccessPill name={props.row.name} />
      </div>
    </>
  );
}

function OrganizationAccessItem(props: { onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={() => props.onSelect()}>
      <Users class="h-3.5 w-3.5" />
      Organization access
    </DropdownMenuItem>
  );
}

export function ModelsItem(props: { onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={() => props.onSelect()}>
      <Boxes class="h-3.5 w-3.5" />
      Models it serves
    </DropdownMenuItem>
  );
}

function modelsTargetOf(row: PlatformModelProvider, baseFormat: BaseFormatId): ModelsTarget {
  return {
    name: row.name,
    baseFormat,
    kind: row.kind,
    servedModels: row.servedModels,
    connection: row.connection,
    declaredInDeployment: row.fixed || row.deploymentManaged,
  };
}

function PlatformModelsDialog(props: {
  row: PlatformModelProvider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Show when={builtInFormatOf(props.row)}>
      {(baseFormat) => (
        <ModelsDialog
          row={modelsTargetOf(props.row, baseFormat())}
          scope="platform"
          open={props.open}
          onOpenChange={props.onOpenChange}
        />
      )}
    </Show>
  );
}

function DeploymentManagedMenu(props: { row: PlatformModelProvider }) {
  const [accessOpen, setAccessOpen] = createSignal(false);
  const [modelsOpen, setModelsOpen] = createSignal(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger class={MENU_TRIGGER_CLASS} aria-label={`${props.row.name} actions`}>
          <EllipsisVertical class="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <Show when={props.row.status !== 'missing'}>
            <ModelsItem onSelect={() => setModelsOpen(true)} />
          </Show>
          <OrganizationAccessItem onSelect={() => setAccessOpen(true)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <PlatformModelsDialog row={props.row} open={modelsOpen()} onOpenChange={setModelsOpen} />
      <OrganizationAccessDialog name={props.row.name} open={accessOpen()} onOpenChange={setAccessOpen} />
    </>
  );
}

export function BuiltInRowMenu(props: { row: PlatformModelProvider }) {
  return (
    <Show when={!props.row.deploymentManaged} fallback={<DeploymentManagedMenu row={props.row} />}>
      <ManagedOrLinkedMenu row={props.row} />
    </Show>
  );
}

function ManagedOrLinkedMenu(props: { row: PlatformModelProvider }) {
  return (
    <Show
      when={managedRow(props.row)}
      fallback={
        <Show when={isLinkedAccountRow(props.row)}>
          <LinkedAccountOnlyMenu row={props.row} />
        </Show>
      }
    >
      {(managed) => <ManagedBuiltInMenu row={managed()} />}
    </Show>
  );
}

function LinkedAccountOnlyMenu(props: { row: PlatformModelProvider }) {
  const name = () => props.row.name;
  const actions = useLinkedAccountActions('platform', name);
  const [accessOpen, setAccessOpen] = createSignal(false);
  const [modelsOpen, setModelsOpen] = createSignal(false);
  return (
    <Show when={actions.connected() || !actions.signingIn()}>
      <DropdownMenu>
        <DropdownMenuTrigger class={MENU_TRIGGER_CLASS} disabled={actions.busy()} aria-label={`${name()} actions`}>
          <EllipsisVertical class="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <LinkedAccountMenuItems actions={actions} />
          <Show when={actions.connected()}>
            <ModelsItem onSelect={() => setModelsOpen(true)} />
          </Show>
          <OrganizationAccessItem onSelect={() => setAccessOpen(true)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DisconnectDialog scope="platform" name={name()} actions={actions} />
      <PlatformModelsDialog row={props.row} open={modelsOpen()} onOpenChange={setModelsOpen} />
      <OrganizationAccessDialog name={name()} open={accessOpen()} onOpenChange={setAccessOpen} />
    </Show>
  );
}

function ManagedBuiltInMenu(props: { row: ManagedBuiltIn }) {
  const [confirming, setConfirming] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [reentering, setReentering] = createSignal(false);
  const [accessOpen, setAccessOpen] = createSignal(false);
  const [modelsOpen, setModelsOpen] = createSignal(false);
  const rules = usePlatformModelProviderCreationRules();
  const deleteProvider = useDeleteModelProvider('platform');
  const name = () => props.row.name;
  const linked = () => isLinkedAccountRow(props.row);
  const reentersKey = () => props.row.status === 'missing' && !linked() && props.row.kind !== 'azure-foundry';
  const linkedAccount = useLinkedAccountActions('platform', name, linked);

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
          <LinkedAccountMenuItems actions={linkedAccount} linked={linked()} />
          <Show when={!linked()}>
            <Show
              when={!reentersKey()}
              fallback={
                <DropdownMenuItem onSelect={() => setReentering(true)}>
                  <KeyRound class="h-3.5 w-3.5" />
                  Re-enter key
                </DropdownMenuItem>
              }
            >
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Show when={props.row.fixed} fallback={<Pencil class="h-3.5 w-3.5" />}>
                  <KeyRound class="h-3.5 w-3.5" />
                </Show>
                {props.row.fixed ? 'Replace key' : 'Edit connection'}
              </DropdownMenuItem>
            </Show>
          </Show>
          <Show when={props.row.status !== 'missing'}>
            <ModelsItem onSelect={() => setModelsOpen(true)} />
          </Show>
          <OrganizationAccessItem onSelect={() => setAccessOpen(true)} />
          <Show when={!props.row.fixed}>
            <DropdownMenuItem
              class="text-destructive data-[highlighted]:text-destructive"
              onSelect={() => setConfirming(true)}
            >
              <Trash2 class="h-3.5 w-3.5 text-destructive" />
              Delete
            </DropdownMenuItem>
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming()}
        onOpenChange={setConfirming}
        title={`Delete ${name()}`}
        description="It is removed at once from every organization, including those that have it on, and its key is removed from the model gateway. This can’t be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={remove}
      />
      <EditConnectionDialog
        row={{ name: name(), baseFormat: props.row.baseFormat, kind: props.row.kind, baseUrl: props.row.url }}
        open={editing()}
        onOpenChange={setEditing}
        scope="platform"
        keyOnly={props.row.fixed}
      />
      <ReenterKeyDialog
        name={name()}
        open={reentering()}
        onOpenChange={setReentering}
        scope="platform"
        kindsByFormat={rules.data?.kindsByFormat}
        fixedFormat={props.row.fixed ? props.row.baseFormat : undefined}
      />
      <DisconnectDialog scope="platform" name={name()} actions={linkedAccount} />
      <PlatformModelsDialog row={props.row} open={modelsOpen()} onOpenChange={setModelsOpen} />
      <OrganizationAccessDialog name={name()} open={accessOpen()} onOpenChange={setAccessOpen} />
    </>
  );
}
