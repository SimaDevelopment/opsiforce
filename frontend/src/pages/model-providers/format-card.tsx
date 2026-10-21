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
import {
  AUDIENCE_LABEL,
  routingOf,
  sameRouting,
  splitRowOf,
  withAudienceSwitch,
  type Audience,
  type DirtyAudiences,
  type Routing,
} from './audience';
import { BuiltInPlatformDetails, BuiltInPlatformPills, BuiltInRowMenu } from './built-in-row';
import { TIPS } from './copy';
import { CustomProviderMenu } from './custom-provider-menu';
import { LinkedAccountSignIn, LinkedAccountStatus } from './linked-account-sign-in';
import { useWithoutAccessHere } from './tenant-access';
import {
  BuiltInPill,
  isCustomRow,
  LabelWithTip,
  InfoTip,
  OnOffSwitch,
  ProviderPill,
  RetryNote,
  ShareText,
  StatusBadge,
  WeightInput,
} from './provider-widgets';
import { SwitchOffWarningDialog } from './switch-off-warning-dialog';
import { BASE_FORMAT_LABEL, carriesTraffic, retryTargetsOf, splitError, type SplitRow } from './traffic-split';

type Draft = Record<string, Routing>;

export interface FormatCardProps {
  format: BaseFormatId;
  audience: Audience;
  rows: TenantModelProvider[];
  builtIns: PlatformModelProvider[];
  canSwitch: boolean;
  managesPlatform: boolean;
  onDirtyChange: (dirty: DirtyAudiences) => void;
}

export function FormatCard(props: FormatCardProps) {
  const [draft, setDraft] = createStore<Draft>({});
  const saveFormat = useSaveBaseFormat();
  const [affectedAgents, setAffectedAgents] = createSignal<AffectedAgent[] | null>(null);
  const label = () => BASE_FORMAT_LABEL[props.format];

  const routing = (row: TenantModelProvider): Routing => draft[row.name] ?? routingOf(row);
  const draftedFor = (row: TenantModelProvider, audience: Audience): SplitRow =>
    splitRowOf(row, routing(row), audience);
  const drafted = (row: TenantModelProvider): SplitRow => draftedFor(row, props.audience);
  const draftedRowsFor = (audience: Audience) => props.rows.map((row) => draftedFor(row, audience));
  const draftedRows = () => draftedRowsFor(props.audience);
  const dirtyFor = (audience: Audience) =>
    props.rows.some((row) => {
      const before = splitRowOf(row, routingOf(row), audience);
      const after = draftedFor(row, audience);
      return before.enabled !== after.enabled || before.weight !== after.weight;
    });
  const dirty = () => props.rows.some((row) => !sameRouting(routing(row), routingOf(row)));
  const otherAudience = (): Audience => (props.audience === 'agents' ? 'apps' : 'agents');
  const error = () => {
    const own = splitError(draftedRows());
    if (own) return own;
    const other = splitError(draftedRowsFor(otherAudience()));
    return other ? `${AUDIENCE_LABEL[otherAudience()]}: ${other}` : null;
  };
  const noneInTraffic = () => props.canSwitch && !props.rows.some((row) => carriesTraffic(drafted(row)));
  const builtInOf = (name: string) => props.builtIns.find((builtIn) => builtIn.name === name);
  const builtInsWithoutRow = () =>
    props.builtIns.filter((builtIn) => !props.rows.some((row) => row.name === builtIn.name));

  const sortedRows = () =>
    [...props.rows].sort((a, b) => {
      const left = splitRowOf(a, routingOf(a), props.audience);
      const right = splitRowOf(b, routingOf(b), props.audience);
      return Number(right.enabled) - Number(left.enabled) || right.weight - left.weight || a.name.localeCompare(b.name);
    });

  const withoutAccessHere = useWithoutAccessHere(() => props.canSwitch && props.managesPlatform);

  const builtInsWithoutAccess = () => builtInsWithoutRow().filter((builtIn) => withoutAccessHere(builtIn.name));

  const empty = () => props.rows.length === 0 && builtInsWithoutRow().length === 0;
  const columnCount = () => (props.canSwitch ? 6 : 3);

  createEffect(() => props.onDirtyChange({ agents: dirtyFor('agents'), apps: dirtyFor('apps') }));
  onCleanup(() => props.onDirtyChange({ agents: false, apps: false }));

  function change(row: TenantModelProvider, next: Partial<Pick<SplitRow, 'enabled' | 'weight'>>) {
    setDraft(row.name, withAudienceSwitch(routing(row), props.audience, next));
  }

  function discard() {
    setDraft(reconcile({}));
  }

  function save(acknowledgeAffectedAgents = false) {
    saveFormat.mutate(
      {
        format: props.format,
        providers: props.rows.map((row) => ({ name: row.name, ...routing(row) })),
        acknowledgeAffectedAgents,
      },
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
        <h2 class="text-sm font-medium text-foreground">
          {label()}
          <Show when={props.canSwitch}>
            <span class="font-normal text-muted-foreground"> · {AUDIENCE_LABEL[props.audience]}</span>
          </Show>
        </h2>
        <span class="text-xs text-destructive" aria-live="polite">
          <Show when={noneInTraffic()}>
            <Show
              when={props.audience === 'apps'}
              fallback={
                <>· No model provider is taking Agent requests. Switch one on so Agents can use {label()} models.</>
              }
            >
              · No model provider is taking App requests. Switch one on so apps can use {label()} models.
            </Show>
          </Show>
        </span>
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
          <For each={sortedRows()}>
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
                  <Show when={drafted(row).enabled && row.status === 'failing'}>
                    <RetryNote targets={retryTargetsOf(drafted(row), draftedRows())} />
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
                    label={`${row.name} ${AUDIENCE_LABEL[props.audience]} weight`}
                    onChange={(weight) => change(row, { weight })}
                  />
                </TableCell>
                <TableCell class="align-top text-right">
                  <ShareText row={drafted(row)} rows={draftedRows()} />
                </TableCell>
                <TableCell class="align-top">
                  <OnOffSwitch
                    checked={drafted(row).enabled}
                    label={`${row.name} on for ${AUDIENCE_LABEL[props.audience]}`}
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
          <For each={builtInsWithoutRow().filter((builtIn) => !withoutAccessHere(builtIn.name))}>
            {(builtIn) => <BuiltInOnlyRow builtIn={builtIn} canSwitch={props.canSwitch} />}
          </For>
          <Show when={builtInsWithoutAccess().length > 0}>
            <TableRow class="hover:bg-transparent">
              <TableCell colSpan={columnCount()} class="bg-muted/40 py-1.5">
                <span class="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                  No access in this organization
                  <InfoTip content={TIPS.noAccessHere} label="About model providers without access" />
                </span>
              </TableCell>
            </TableRow>
            <For each={builtInsWithoutAccess()}>
              {(builtIn) => <BuiltInOnlyRow builtIn={builtIn} canSwitch={props.canSwitch} faded />}
            </For>
          </Show>
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

function BuiltInOnlyRow(props: { builtIn: PlatformModelProvider; canSwitch: boolean; faded?: boolean }) {
  return (
    <TableRow>
      <TableCell class={cn('align-top', props.faded && 'opacity-60')}>
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="break-all font-mono text-xs font-medium" translate="no">
            {props.builtIn.name}
          </span>
          <BuiltInPill />
          <BuiltInPlatformPills row={props.builtIn} />
        </div>
        <BuiltInPlatformDetails row={props.builtIn} editable />
      </TableCell>
      <TableCell class={cn('align-top', props.faded && 'opacity-60')}>
        <Show when={props.builtIn.linkedAccountVendor} fallback={<StatusBadge status={props.builtIn.status} />}>
          <LinkedAccountStatus scope="platform" name={props.builtIn.name} status={props.builtIn.status} editable />
        </Show>
      </TableCell>
      <Show when={props.canSwitch}>
        <TableCell />
        <TableCell />
        <TableCell />
      </Show>
      <TableCell class="align-top">
        <BuiltInRowMenu row={props.builtIn} />
      </TableCell>
    </TableRow>
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
