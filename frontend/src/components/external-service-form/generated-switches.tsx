import { For, Show, type JSX } from 'solid-js';
import type { Field, ServiceManifest } from '@opsiforce/external-service-sdk/forms';
import { KindPill } from '~/components/external-service/service-marks';
import { fieldLabelOfPath } from '~/components/external-service-form/form-values';
import { Switch as Toggle, SwitchControl, SwitchThumb } from '~/components/ui/switch';
import { AlertTriangle } from '~/components/icons';

type Switches = Record<string, boolean>;

interface SwitchesProps {
  manifest: Pick<ServiceManifest, 'operations' | 'events'>;
  switches: Switches;
  newNames: readonly string[];
  readOnly: boolean;
  onChange: (name: string, on: boolean) => void;
}

function NewMarker() {
  return (
    <span class="inline-flex shrink-0 rounded bg-blue-50 px-1.5 py-px text-[10px] font-medium text-blue-700">
      new · off until you turn it on
    </span>
  );
}

function SwitchGroup(props: { title: string; subtitle: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline gap-2">
        <span class="text-xs font-medium">{props.title}</span>
        <span class="text-[11px] text-muted-foreground">{props.subtitle}</span>
      </div>
      <div class="divide-y divide-border rounded-md border border-border">{props.children}</div>
    </div>
  );
}

function SwitchRow(props: {
  label: string;
  on: boolean;
  readOnly: boolean;
  onChange: (on: boolean) => void;
  heading: JSX.Element;
  description: string;
}) {
  return (
    <div class="flex items-start gap-3 px-2.5 py-2">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">{props.heading}</div>
        <div class="text-[11px] text-muted-foreground">{props.description}</div>
      </div>
      <Toggle checked={props.on} onChange={props.onChange} disabled={props.readOnly} aria-label={props.label}>
        <SwitchControl>
          <SwitchThumb />
        </SwitchControl>
      </Toggle>
    </div>
  );
}

export function OperationSwitches(props: SwitchesProps) {
  const operations = () => Object.entries(props.manifest.operations ?? {});
  return (
    <Show when={operations().length > 0}>
      <SwitchGroup title="Operations" subtitle="what the agent and Apps may call">
        <For each={operations()}>
          {([name, operation]) => (
            <SwitchRow
              label={operation.title ?? name}
              on={props.switches[name] === true}
              readOnly={props.readOnly}
              onChange={(on) => props.onChange(name, on)}
              description={operation.description}
              heading={
                <>
                  <span class="text-xs font-medium">{operation.title ?? name}</span>
                  <Show when={operation.title}>
                    <span class="font-mono text-[10px] text-muted-foreground">{name}</span>
                  </Show>
                  <KindPill kind={operation.kind} />
                  <Show when={props.newNames.includes(name)}>
                    <NewMarker />
                  </Show>
                </>
              }
            />
          )}
        </For>
      </SwitchGroup>
    </Show>
  );
}

export function ReceiveSwitches(props: SwitchesProps) {
  const events = () => Object.entries(props.manifest.events ?? {});
  return (
    <Show when={events().length > 0}>
      <SwitchGroup title="Receive" subtitle="Events delivered to this environment's App">
        <For each={events()}>
          {([type, event]) => (
            <SwitchRow
              label={event.title}
              on={props.switches[type] === true}
              readOnly={props.readOnly}
              onChange={(on) => props.onChange(type, on)}
              description={event.description}
              heading={
                <>
                  <span class="text-xs font-medium">{event.title}</span>
                  <span class="font-mono text-[10px] text-muted-foreground">{type}</span>
                  <Show when={props.newNames.includes(type)}>
                    <NewMarker />
                  </Show>
                </>
              }
            />
          )}
        </For>
      </SwitchGroup>
    </Show>
  );
}

export function NeedsAttentionBanner(props: {
  serviceName: string;
  form: readonly Field[];
  missing: readonly string[];
}) {
  const labels = () => [...new Set(props.missing.map((path) => fieldLabelOfPath(props.form, path)))];
  return (
    <div
      role="alert"
      class="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-900"
    >
      <AlertTriangle class="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        <strong class="font-medium">Needs attention.</strong> {props.serviceName} needs{' '}
        {labels().length === 1 ? 'a value for a required field' : 'values for required fields'} here (
        {labels().join(', ')}). Until you save, every call from this environment answers{' '}
        <code class="font-mono">409 configuration-incomplete</code>.
      </span>
    </div>
  );
}
