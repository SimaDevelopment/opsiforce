import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import {
  AGENTS_AFFECTED_CODE,
  useSaveBaseFormat,
  type AffectedAgent,
  type BaseFormatId,
  type PlatformModelProvider,
  type TenantModelProvider,
} from '~/api/model-providers';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { cn } from '~/lib/cn';
import { AddProviderButton } from './add-provider-dialog';
import { BuiltInPlatformDetails, BuiltInPlatformPills, BuiltInRowMenu } from './built-in-row';
import { TIPS } from './copy';
import { CustomProviderMenu } from './custom-provider-menu';
import { LinkedAccountSignIn, LinkedAccountStatus } from './linked-account-sign-in';
import {
  BuiltInPill,
  InfoTip,
  isCustomRow,
  LabelWithTip,
  OnOffSwitch,
  ProviderPill,
  RetryNote,
  ShareText,
  StatusBadge,
  WeightInput,
} from './provider-widgets';
import { SwitchOffWarningDialog } from './switch-off-warning-dialog';
import { BASE_FORMAT_LABEL, carriesTraffic, retryTargetsOf, splitError, type SplitRow } from './traffic-split';

type Draft = Record<string, { enabled: boolean; weight: number }>;

export interface FormatCardProps {
  format: BaseFormatId;
  rows: TenantModelProvider[];
  builtIns: PlatformModelProvider[];
  canSwitch: boolean;
  managesPlatform: boolean;
  onDirtyChange: (dirty: boolean) => void;
}

export function FormatCard(props: FormatCardProps) {
  const [draft, setDraft] = createStore<Draft>({});
  const saveFormat = useSaveBaseFormat();
  const [affectedAgents, setAffectedAgents] = createSignal<AffectedAgent[] | null>(null);
  const label = () => BASE_FORMAT_LABEL[props.format];

  const drafted = (row: TenantModelProvider): SplitRow => ({
    name: row.name,
    status: row.status,
    enabled: (draft[row.name] ?? row).enabled,
    weight: (draft[row.name] ?? row).weight,
  });
  const draftedRows = () => props.rows.map(drafted);
  const dirty = () =>
    props.rows.some((row) => {
      const next = drafted(row);
      return next.enabled !== row.enabled || next.weight !== row.weight;
    });
  const error = () => splitError(draftedRows());
  const noneInTraffic = () => props.canSwitch && !props.rows.some(carriesTraffic);
  const builtInOf = (name: string) => props.builtIns.find((builtIn) => builtIn.name === name);
  const builtInsWithoutRow = () =>
    props.builtIns.filter((builtIn) => !props.rows.some((row) => row.name === builtIn.name));

  const empty = () => props.rows.length === 0 && builtInsWithoutRow().length === 0;
  const columnCount = () => (props.canSwitch ? 6 : 3);

  createEffect(() => props.onDirtyChange(dirty()));
  onCleanup(() => props.onDirtyChange(false));

  function change(row: TenantModelProvider, next: Partial<SplitRow>) {
    setDraft(row.name, { ...drafted(row), ...next });
  }

  function discard() {
    setDraft(reconcile({}));
  }

  function save(acknowledgeAffectedAgents = false) {
    saveFormat.mutate(
      { format: props.format, providers: draftedRows(), acknowledgeAffectedAgents },
      {
        onSuccess: () => {
          discard();
          toast.success(`${label()} model providers saved`);
        },
        onError: (err) => {
          const affected = affectedAgentsOf(err);
          if (affected) {
            setAffectedAgents(affected);
            return;
          }
          toast.error(err instanceof ApiError ? err.message : `The ${label()} model providers could not be saved`);
        },
      }
    );
  }

  return (
    <div class="space-y-3 rounded-lg border border-border p-4">
      <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <h2 class="text-sm font-medium text-foreground">{label()}</h2>
        <InfoTip content={TIPS.format(label())} label={`How ${label()} requests are split`} />
        <Show when={noneInTraffic()}>
          <span class="text-xs text-destructive">
            · No model provider is taking requests, so {label()} models can’t be used
          </span>
        </Show>
        <AddProviderButton format={props.format} canAddCustom={props.canSwitch} canAddGlobal={props.managesPlatform} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model provider</TableHead>
            <TableHead>Status</TableHead>
            <Show when={props.canSwitch}>
              <TableHead class="w-20">
                <LabelWithTip label="Weight" tip={TIPS.weight} />
              </TableHead>
              <TableHead class="w-20 text-right">
                <LabelWithTip label="Share" tip={TIPS.share} />
              </TableHead>
              <TableHead class="w-14">On</TableHead>
            </Show>
            <TableHead class="w-10">
              <span class="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <Show when={empty()}>
            <TableRow>
              <TableCell colSpan={columnCount()} class="py-6 text-center text-xs text-muted-foreground">
                No {label()} model providers yet. Add one to send {label()} requests.
              </TableCell>
            </TableRow>
          </Show>
          <For each={props.rows}>
            {(row) => (
              <TableRow class={cn(!drafted(row).enabled && 'text-muted-foreground')}>
                <TableCell class="align-top">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="break-all font-mono text-xs font-medium" translate="no">
                      {row.name}
                    </span>
                    <ProviderPill row={row} />
                    <Show when={builtInOf(row.name)}>{(builtIn) => <BuiltInPlatformPills row={builtIn()} />}</Show>
                  </div>
                  <Show when={builtInOf(row.name)}>
                    {(builtIn) => <BuiltInPlatformDetails row={builtIn()} editable />}
                  </Show>
                  <Show when={row.kind === 'linked-account'}>
                    <div class="mt-1.5">
                      <LinkedAccountSignIn scope="tenant" name={row.name} editable linked />
                    </div>
                  </Show>
                  <Show when={row.baseUrl}>
                    {(baseUrl) => (
                      <p class="mt-0.5 break-all font-mono text-[11px] text-muted-foreground" translate="no">
                        {baseUrl()}
                      </p>
                    )}
                  </Show>
                  <Show when={row.enabled && row.status === 'failing'}>
                    <RetryNote targets={retryTargetsOf(row, draftedRows())} />
                  </Show>
                </TableCell>
                <TableCell class="align-top">
                  <Show
                    when={row.kind === 'linked-account'}
                    fallback={
                      <Show
                        when={builtInOf(row.name)?.linkedAccountVendor && builtInOf(row.name)}
                        fallback={<StatusBadge status={row.status} />}
                      >
                        {(builtIn) => (
                          <LinkedAccountStatus scope="platform" name={builtIn().name} status={row.status} editable />
                        )}
                      </Show>
                    }
                  >
                    <LinkedAccountStatus scope="tenant" name={row.name} status={row.status} editable />
                  </Show>
                </TableCell>
                <TableCell class="align-top">
                  <WeightInput
                    value={drafted(row).weight}
                    disabled={!drafted(row).enabled}
                    label={`${row.name} weight`}
                    onChange={(weight) => change(row, { weight })}
                  />
                </TableCell>
                <TableCell class="align-top text-right">
                  <ShareText row={drafted(row)} rows={draftedRows()} />
                </TableCell>
                <TableCell class="align-top">
                  <OnOffSwitch
                    checked={drafted(row).enabled}
                    label={`${row.name} on`}
                    onChange={(enabled) => change(row, { enabled })}
                  />
                </TableCell>
                <TableCell class="align-top">
                  <Show
                    when={isCustomRow(row)}
                    fallback={<Show when={builtInOf(row.name)}>{(builtIn) => <BuiltInRowMenu row={builtIn()} />}</Show>}
                  >
                    <CustomProviderMenu row={row} />
                  </Show>
                </TableCell>
              </TableRow>
            )}
          </For>
          <For each={builtInsWithoutRow()}>
            {(builtIn) => (
              <TableRow>
                <TableCell class="align-top">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="break-all font-mono text-xs font-medium" translate="no">
                      {builtIn.name}
                    </span>
                    <BuiltInPill />
                    <BuiltInPlatformPills row={builtIn} />
                  </div>
                  <BuiltInPlatformDetails row={builtIn} editable />
                </TableCell>
                <TableCell class="align-top">
                  <Show when={builtIn.linkedAccountVendor} fallback={<StatusBadge status={builtIn.status} />}>
                    <LinkedAccountStatus scope="platform" name={builtIn.name} status={builtIn.status} editable />
                  </Show>
                </TableCell>
                <Show when={props.canSwitch}>
                  <TableCell />
                  <TableCell />
                  <TableCell />
                </Show>
                <TableCell class="align-top">
                  <BuiltInRowMenu row={builtIn} />
                </TableCell>
              </TableRow>
            )}
          </For>
        </TableBody>
      </Table>
      <Show when={props.canSwitch}>
        <FormatCardFooter
          error={error()}
          dirty={dirty()}
          saving={saveFormat.isPending}
          onDiscard={discard}
          onSave={() => save()}
        />
      </Show>
      <SwitchOffWarningDialog
        formatLabel={label()}
        agents={affectedAgents()}
        onClose={() => setAffectedAgents(null)}
        onSaveAnyway={() => save(true)}
      />
    </div>
  );
}

function FormatCardFooter(props: {
  error: string | null;
  dirty: boolean;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <div class="flex items-center justify-end gap-2 pt-1">
      <span class="mr-auto text-xs text-destructive" aria-live="polite">
        {props.error}
      </span>
      <Show when={props.dirty}>
        <Button size="sm" variant="outline" disabled={props.saving} onClick={() => props.onDiscard()}>
          Discard
        </Button>
      </Show>
      <Button size="sm" disabled={!props.dirty || !!props.error} loading={props.saving} onClick={() => props.onSave()}>
        Save
      </Button>
    </div>
  );
}

function affectedAgentsOf(err: unknown): AffectedAgent[] | null {
  if (!(err instanceof ApiError) || err.code !== AGENTS_AFFECTED_CODE) return null;
  return Array.isArray(err.details.agents) ? (err.details.agents as AffectedAgent[]) : null;
}
