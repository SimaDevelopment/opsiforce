import { JSX, Show } from 'solid-js';
import { Info } from '~/components/icons';
import { Tooltip, TooltipTrigger, TooltipContent } from '~/components/ui/tooltip';

export interface FieldWithTooltipProps {
  label: string;
  tooltip?: string;
  required?: boolean;
  children: JSX.Element;
}

export function FieldWithTooltip(props: FieldWithTooltipProps) {
  return (
    <div class="space-y-1">
      <div class="flex items-center gap-1">
        <label class="text-xs font-medium text-foreground">
          {props.label}
          <Show when={props.required}>
            <span class="text-destructive ml-0.5">*</span>
          </Show>
        </label>
        <Show when={props.tooltip}>
          <Tooltip>
            <TooltipTrigger
              type="button"
              class="text-muted-foreground hover:text-foreground"
              aria-label={`Help for ${props.label}`}
            >
              <Info class="w-3 h-3" />
            </TooltipTrigger>
            <TooltipContent class="max-w-xs text-xs">{props.tooltip}</TooltipContent>
          </Tooltip>
        </Show>
      </div>
      {props.children}
    </div>
  );
}

export function TextInput(props: {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'url' | 'email';
  disabled?: boolean;
}) {
  const autoComplete = () => (props.type === 'password' ? 'new-password' : 'off');
  return (
    <input
      type={props.type ?? 'text'}
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      placeholder={props.placeholder}
      disabled={props.disabled}
      autocomplete={autoComplete()}
      spellcheck={false}
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}
