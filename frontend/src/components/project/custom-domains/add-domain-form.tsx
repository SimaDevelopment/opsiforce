import { Show, createSignal } from 'solid-js';
import { ApiError } from '~/api/client';
import { useAddCustomDomain, type EnvironmentRef } from '~/api/custom-domains';
import { Button } from '~/components/ui/button';
import { TextField, TextFieldDescription, TextFieldErrorMessage, TextFieldInput } from '~/components/ui/text-field';

const EMPTY_REFUSAL = 'Enter a domain, like app.example-org.com.';
const FALLBACK_REFUSAL = "Couldn't add the domain. Try again in a moment.";

function saysWhatToDo(status: number): boolean {
  return status < 500 || status === 503;
}

function refusalOf(err: unknown): string {
  return err instanceof ApiError && saysWhatToDo(err.status) && err.message ? err.message : FALLBACK_REFUSAL;
}

function afterTheDialogFocusesItsFirstControl(run: () => void): void {
  setTimeout(() => setTimeout(run, 0), 0);
}

function focusWithFinePointer(input: HTMLInputElement): void {
  if (window.matchMedia('(pointer: fine)').matches) afterTheDialogFocusesItsFirstControl(() => input.focus());
}

export function AddDomainForm(props: { environment: EnvironmentRef; onAdded: () => void; onCancel?: () => void }) {
  const addDomain = useAddCustomDomain();
  const [hostname, setHostname] = createSignal('');
  const [refusal, setRefusal] = createSignal<string | null>(null);

  const submit = async () => {
    if (hostname().trim() === '') {
      setRefusal(EMPTY_REFUSAL);
      return;
    }
    try {
      await addDomain.mutateAsync({ ...props.environment, hostname: hostname() });
      setHostname('');
      props.onAdded();
    } catch (err) {
      setRefusal(refusalOf(err));
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextField
        value={hostname()}
        onChange={(value) => {
          setHostname(value);
          setRefusal(null);
        }}
        validationState={refusal() === null ? 'valid' : 'invalid'}
        class="gap-1.5"
      >
        <div class="flex items-center gap-2">
          <TextFieldInput
            ref={focusWithFinePointer}
            name="hostname"
            aria-label="Domain"
            placeholder="app.example-org.com"
            inputmode="url"
            autocapitalize="none"
            autocorrect="off"
            spellcheck={false}
            autocomplete="off"
            class="min-w-0 flex-1 font-mono"
          />
          <Button size="sm" type="submit" loading={addDomain.isPending}>
            Add
          </Button>
          <Show when={props.onCancel}>
            {(cancel) => (
              <Button size="sm" variant="ghost" type="button" onClick={() => cancel()()}>
                Cancel
              </Button>
            )}
          </Show>
        </div>
        <Show when={refusal() === null}>
          <TextFieldDescription>
            For example app.example-org.com, or example-org.com, which also connects www.example-org.com.
          </TextFieldDescription>
        </Show>
        <TextFieldErrorMessage>{refusal()}</TextFieldErrorMessage>
      </TextField>
    </form>
  );
}
