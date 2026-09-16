import { createSignal } from 'solid-js';
import { Check, Copy, ExternalLink } from '~/components/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn } from '~/lib/cn';

export interface EnvAppLinkButtonsProps {
  appUrl: string;
  enabled: boolean;
  disabledReason: string;
}

export function EnvAppLinkButtons(props: EnvAppLinkButtonsProps) {
  const [copied, setCopied] = createSignal(false);

  const buttonClass = (extra?: string) =>
    cn(
      'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
      props.enabled ? 'hover:bg-accent hover:text-foreground' : 'cursor-default opacity-40',
      extra
    );

  const openApp = () => {
    if (!props.enabled) return;
    window.open(props.appUrl, '_blank', 'noopener,noreferrer');
  };

  const copyUrl = () => {
    if (!props.enabled) return;
    navigator.clipboard.writeText(props.appUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span class="flex items-center">
      <Tooltip>
        <TooltipTrigger class={buttonClass()} aria-disabled={!props.enabled} aria-label="Open app" onClick={openApp}>
          <ExternalLink class="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent>{props.enabled ? 'Open app' : props.disabledReason}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          class={buttonClass()}
          aria-disabled={!props.enabled}
          aria-label="Copy app URL"
          onClick={copyUrl}
        >
          {copied() ? <Check class="h-3.5 w-3.5 text-emerald-500" /> : <Copy class="h-3.5 w-3.5" />}
        </TooltipTrigger>
        <TooltipContent>
          {props.enabled ? (copied() ? 'Copied!' : 'Copy app URL') : props.disabledReason}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
