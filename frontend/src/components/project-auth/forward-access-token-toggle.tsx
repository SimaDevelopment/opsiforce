export interface ForwardAccessTokenToggleProps {
  checked: boolean;
  onChange: (forward: boolean) => void;
  disabled?: boolean;
}

export function ForwardAccessTokenToggle(props: ForwardAccessTokenToggleProps) {
  return (
    <label class="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span>
        Forward the signed-in user's access token to this app's backend
        <span class="block text-xs text-muted-foreground">
          Allows the app to call APIs as the visitor with the provider's scopes. Enable only for trusted app code.
          Authentication bypass paths must be empty.
        </span>
      </span>
    </label>
  );
}
