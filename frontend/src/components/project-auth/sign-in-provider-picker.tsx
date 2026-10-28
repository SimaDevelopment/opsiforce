import { Show } from 'solid-js';
import { useSignInProviderOptions, type SignInProviderOption } from '~/api/sign-in-providers';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { FieldWithTooltip } from './field-with-tooltip';

export interface SignInProviderPickerProps {
  value: string | null;
  onChange: (id: string) => void;
  forwardAccessToken: boolean;
  onForwardAccessTokenChange: (forward: boolean) => void;
  disabled?: boolean;
}

export function SignInProviderPicker(props: SignInProviderPickerProps) {
  const options = useSignInProviderOptions();
  const selected = () => options.data?.find((option) => option.id === props.value) ?? null;

  return (
    <div class="space-y-3">
      <Show
        when={options.isPending || (options.data?.length ?? 0) > 0}
        fallback={
          <p class="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            Your organization has no sign-in providers yet. An admin adds them under Settings, Sign-in providers.
          </p>
        }
      >
        <FieldWithTooltip
          label="Sign-in provider"
          required
          tooltip="Visitors sign in with this provider before the app loads. Its credentials are managed by your organization's admins."
        >
          <Select<SignInProviderOption>
            options={options.data ?? []}
            optionValue="id"
            optionTextValue="name"
            value={selected()}
            disabled={props.disabled || options.isPending}
            placeholder="Choose a provider"
            onChange={(option) => {
              if (option) props.onChange(option.id);
            }}
            itemComponent={(itemProps) => <SelectItem item={itemProps.item}>{itemProps.item.rawValue.name}</SelectItem>}
          >
            <SelectTrigger>
              <SelectValue<SignInProviderOption>>{(state) => <span>{state.selectedOption()?.name}</span>}</SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </FieldWithTooltip>
      </Show>

      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={props.forwardAccessToken}
          disabled={props.disabled}
          onChange={(e) => props.onForwardAccessTokenChange(e.currentTarget.checked)}
        />
        <span>
          Forward the signed-in user's access token to this app's backend
          <span class="block text-xs text-muted-foreground">
            Allows the app to call APIs as the visitor with the provider's scopes. Enable only for trusted app code.
            Authentication bypass paths must be empty.
          </span>
        </span>
      </label>
    </div>
  );
}
