import { CopyButton } from '~/components/external-service-form/copy-button';

export function CopyValue(props: { value: string; label: string }) {
  return (
    <div class="flex items-center gap-2">
      <input
        readOnly
        value={props.value}
        spellcheck={false}
        class="flex h-8 w-full rounded-md border border-input bg-muted/40 px-2.5 py-1 font-mono text-xs text-muted-foreground focus-visible:outline-none"
      />
      <CopyButton text={props.value} label={props.label} />
    </div>
  );
}
