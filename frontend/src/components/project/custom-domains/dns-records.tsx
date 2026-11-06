import { For, Show, type JSX } from 'solid-js';
import type { DnsRecord } from '~/api/custom-domains';
import { CopyButton } from '~/components/external-service-form/copy-button';
import { InfoTip } from '~/components/ui/info-tip';

const CHIP_CLASS =
  'inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] font-medium text-muted-foreground';

function Field(props: { label: string; value: string; copyLabel: string; children?: JSX.Element }) {
  return (
    <div class="flex items-start gap-2">
      <span class="w-16 shrink-0 py-1 leading-4 text-muted-foreground">{props.label}</span>
      <div class="min-w-0 flex-1">
        <div class="flex items-start gap-1">
          <span class="min-w-0 flex-1 break-all py-1 font-mono leading-4 text-foreground" translate="no">
            {props.value}
          </span>
          <CopyButton text={props.value} label={props.copyLabel} />
        </div>
        {props.children}
      </div>
    </div>
  );
}

function RecordBlock(props: { record: DnsRecord }) {
  return (
    <div class="space-y-1 rounded-md border border-border p-2.5 text-xs">
      <div class="flex items-center gap-1">
        <span class={CHIP_CLASS}>{props.record.type}</span>
        <Show when={props.record.type === 'ALIAS'}>
          <InfoTip label="About ALIAS records">
            A bare domain like example-org.com can’t hold a CNAME, so DNS providers offer ALIAS, ANAME or “CNAME
            flattening” for it instead.
          </InfoTip>
        </Show>
      </div>
      <Field label="Host" value={props.record.host} copyLabel={`Copy ${props.record.type} host`}>
        <p class="break-all font-mono text-[0.6875rem] text-muted-foreground" translate="no">
          = {props.record.name}
        </p>
      </Field>
      <Field label="Points to" value={props.record.value} copyLabel={`Copy ${props.record.type} value`} />
    </div>
  );
}

export function DnsRecords(props: { records: DnsRecord[] }) {
  return (
    <div class="space-y-1.5">
      <For each={props.records}>{(record) => <RecordBlock record={record} />}</For>
      <p class="text-xs text-muted-foreground">
        In the Host field, enter only the part shown. Some providers add your domain to it automatically. If your
        provider offers to proxy the record, turn that off.
      </p>
    </div>
  );
}
