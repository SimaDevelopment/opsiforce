import { For, type JSX } from 'solid-js';
import type { ProjectAuthMode } from '~/api/client';
import { OptionCard, OptionCardGroup } from '~/components/ui/option-card';
import { Globe, KeyRound, Lock } from '~/components/icons';

interface ModeOption {
  value: ProjectAuthMode;
  title: string;
  description: string;
  icon: (props: { class?: string }) => JSX.Element;
}

const OPTIONS: ModeOption[] = [
  {
    value: 'public',
    title: 'Public',
    description: "Anyone can access this project's preview URL without signing in.",
    icon: Globe,
  },
  {
    value: 'provider',
    title: 'Sign-in provider',
    description: "Require sign-in with one of your organization's sign-in providers — no secrets to enter.",
    icon: KeyRound,
  },
  {
    value: 'manual',
    title: 'Manual',
    description: 'Require login via a custom auth provider before the preview loads.',
    icon: Lock,
  },
];

export interface AuthModeSelectorProps {
  value: ProjectAuthMode;
  onChange: (mode: ProjectAuthMode) => void;
  disabled?: boolean;
}

export function AuthModeSelector(props: AuthModeSelectorProps) {
  return (
    <OptionCardGroup label="Access" class="grid-cols-3">
      <For each={OPTIONS}>
        {(opt) => (
          <OptionCard
            selected={props.value === opt.value}
            disabled={props.disabled}
            onSelect={() => props.onChange(opt.value)}
          >
            <div class="flex items-center gap-1.5">
              <opt.icon class="w-3.5 h-3.5" />
              <span class="text-xs font-medium">{opt.title}</span>
            </div>
            <p class="text-xs text-muted-foreground leading-snug">{opt.description}</p>
          </OptionCard>
        )}
      </For>
    </OptionCardGroup>
  );
}
