import { For, Match, Show, Switch as SolidSwitch, type JSX } from 'solid-js';
import type { ModelProviderKind, ModelProviderStatus, TenantModelProvider } from '~/api/model-providers';
import { Info } from '~/components/icons';
import { Badge } from '~/components/ui/badge';
import { Switch, SwitchControl, SwitchThumb } from '~/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn } from '~/lib/cn';
import { KIND_LABEL, STATUS_LABEL, TIPS } from './copy';
import { MAX_WEIGHT, MIN_WEIGHT, carriesTraffic, formatShare, shareOf, type SplitRow } from './traffic-split';

const TIP_FOCUS_CLASS = 'rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function Tip(props: { content: JSX.Element; children: JSX.Element; class?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        as="span"
        tabIndex={0}
        class={cn('inline-flex cursor-help items-center', TIP_FOCUS_CLASS, props.class)}
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent>{props.content}</TooltipContent>
    </Tooltip>
  );
}

export function InfoTip(props: { content: JSX.Element; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={props.label}
        class={cn(
          "relative inline-flex cursor-help items-center text-muted-foreground after:absolute after:-inset-1.5 after:content-[''] hover:text-foreground",
          TIP_FOCUS_CLASS
        )}
      >
        <Info class="h-3 w-3" />
      </TooltipTrigger>
      <TooltipContent>{props.content}</TooltipContent>
    </Tooltip>
  );
}

export function LabelWithTip(props: { label: string; tip: string }) {
  return (
    <span class="inline-flex items-center gap-1">
      {props.label} <InfoTip content={props.tip} label={`About ${props.label.toLowerCase()}`} />
    </span>
  );
}

export function BuiltInPill() {
  return (
    <Tip content={TIPS.builtIn}>
      <span class="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Built-in
      </span>
    </Tip>
  );
}

export function KindChip(props: { kind: ModelProviderKind | null }) {
  return (
    <Tip content={TIPS.custom}>
      <span class="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        {props.kind ? KIND_LABEL[props.kind] : 'Custom'}
      </span>
    </Tip>
  );
}

export function isCustomRow(row: TenantModelProvider): boolean {
  return row.kind !== undefined;
}

export function ProviderPill(props: { row: TenantModelProvider }) {
  return (
    <Show when={isCustomRow(props.row)} fallback={<BuiltInPill />}>
      <KindChip kind={props.row.kind ?? null} />
    </Show>
  );
}

const STATUS_VARIANT: Record<ModelProviderStatus, 'success' | 'destructive' | 'warning' | 'secondary'> = {
  working: 'success',
  failing: 'destructive',
  'not-signed-in': 'secondary',
  'needs-sign-in': 'destructive',
  missing: 'warning',
  unknown: 'secondary',
};

export function StatusBadge(props: { status: ModelProviderStatus }) {
  return (
    <Tip content={TIPS.status[props.status]}>
      <Badge variant={STATUS_VARIANT[props.status]} class="h-5 whitespace-nowrap px-1.5 text-[10px] font-medium">
        {STATUS_LABEL[props.status]}
      </Badge>
    </Tip>
  );
}

export function ShareText(props: { row: SplitRow; rows: SplitRow[] }) {
  return (
    <SolidSwitch>
      <Match when={!props.row.enabled}>
        <Tip content={TIPS.off} class="text-xs text-muted-foreground">
          Off
        </Tip>
      </Match>
      <Match when={!carriesTraffic(props.row)}>
        <Tip content={TIPS.notInTraffic} class="text-xs text-muted-foreground">
          None
        </Tip>
      </Match>
      <Match when={props.row.weight === 0 && shareOf(props.row, props.rows) === 1}>
        <Tip content={TIPS.onlyInTraffic} class="text-xs tabular-nums">
          {formatShare(1)}
        </Tip>
      </Match>
      <Match when={props.row.weight === 0}>
        <Tip content={TIPS.backup} class="text-xs text-muted-foreground underline decoration-dotted underline-offset-2">
          Backup
        </Tip>
      </Match>
      <Match when={true}>
        <Tip content={TIPS.share} class="text-xs tabular-nums">
          {formatShare(shareOf(props.row, props.rows))}
        </Tip>
      </Match>
    </SolidSwitch>
  );
}

export function RetryNote(props: { targets: string[] }) {
  return (
    <p class="mt-0.5 text-xs text-muted-foreground">
      Failed requests are retried on{' '}
      <Show when={props.targets.length > 0} fallback="nothing: no other provider of this format is on">
        <For each={props.targets}>
          {(name, index) => (
            <>
              <span class="font-mono" translate="no">
                {name}
              </span>
              {index() < props.targets.length - 1 ? ', ' : ''}
            </>
          )}
        </For>
      </Show>
      .
    </p>
  );
}

export function OnOffSwitch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Switch checked={props.checked} onChange={props.onChange} disabled={props.disabled} aria-label={props.label}>
      <SwitchControl>
        <SwitchThumb />
      </SwitchControl>
    </Switch>
  );
}

export function WeightInput(props: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      inputmode="numeric"
      name="weight"
      autocomplete="off"
      min={MIN_WEIGHT}
      max={MAX_WEIGHT}
      step={1}
      aria-label={props.label}
      disabled={props.disabled}
      value={props.value}
      onInput={(event) => props.onChange(event.currentTarget.valueAsNumber)}
      class="h-7 w-16 rounded-md border border-input bg-background px-2 py-1 text-xs tabular-nums shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}
