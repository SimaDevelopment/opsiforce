import { For, Show, type JSX } from 'solid-js';
import type { ProjectAuthMode } from '~/api/client';
import type { SignInProviderOption } from '~/api/sign-in-providers';
import { OptionCard, OptionCardGroup } from '~/components/ui/option-card';
import { Globe, KeyRound, Lock, Users } from '~/components/icons';

export interface AuthSelection {
  mode: ProjectAuthMode;
  signInProviderId: string | null;
}

interface AccessOption {
  key: string;
  selection: AuthSelection;
  title: string;
  description: string;
  icon: (props: { class?: string }) => JSX.Element;
}

function accessOptions(providers: SignInProviderOption[]): AccessOption[] {
  return [
    {
      key: 'public',
      selection: { mode: 'public', signInProviderId: null },
      title: 'Public',
      description: "Anyone can access this project's preview URL without signing in.",
      icon: Globe,
    },
    {
      key: 'app_users',
      selection: { mode: 'app_users', signInProviderId: null },
      title: 'App Users',
      description: 'Visitors sign in with an email and password you give them in this project.',
      icon: Users,
    },
    ...providers.map(
      (provider): AccessOption => ({
        key: `provider:${provider.id}`,
        selection: { mode: 'provider', signInProviderId: provider.id },
        title: provider.name,
        description: `Require sign-in with ${provider.name} before the preview loads.`,
        icon: KeyRound,
      })
    ),
    {
      key: 'manual',
      selection: { mode: 'manual', signInProviderId: null },
      title: 'Manual',
      description: 'Require login via a custom auth provider before the preview loads.',
      icon: Lock,
    },
  ];
}

function isSelected(option: AuthSelection, value: AuthSelection): boolean {
  if (option.mode !== value.mode) return false;
  return option.mode !== 'provider' || option.signInProviderId === value.signInProviderId;
}

export interface AuthModeSelectorProps {
  value: AuthSelection;
  providers: SignInProviderOption[];
  onChange: (selection: AuthSelection) => void;
  disabled?: boolean;
}

export function AuthModeSelector(props: AuthModeSelectorProps) {
  const options = () => accessOptions(props.providers);
  return (
    <div class="space-y-2">
      <OptionCardGroup label="Access" class="grid-cols-1 sm:grid-cols-3">
        <For each={options()}>
          {(opt) => (
            <OptionCard
              selected={isSelected(opt.selection, props.value)}
              disabled={props.disabled}
              onSelect={() => props.onChange(opt.selection)}
            >
              <div class="flex items-center gap-1.5 min-w-0">
                <opt.icon class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span class="text-xs font-medium truncate">{opt.title}</span>
              </div>
              <p class="text-xs text-muted-foreground leading-snug">{opt.description}</p>
            </OptionCard>
          )}
        </For>
      </OptionCardGroup>
      <Show when={props.providers.length === 0}>
        <p class="text-xs text-muted-foreground">
          An admin can add your organization's sign-in providers under Settings, Sign-in providers.
        </p>
      </Show>
    </div>
  );
}
