import { Show, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { ApiError } from '~/api/client';
import { useCreateAgent } from '~/api/agents';
import { useCreateSkill } from '~/api/skills';
import { builderPath, type BuilderSubjectType } from '~/api/builder';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { slugify } from '~/lib/app-url';

const SLUG_MAX_LENGTH = { agent: 60, skill: 64 } as const;

const COPY = {
  agent: {
    title: 'New agent',
    description:
      'Name it, then tell the Builder what it should do. The Builder writes its prompt, picks its skills and tries it in a test project. It starts private, in Development.',
    placeholder: 'e.g. Release Notes Writer…',
  },
  skill: {
    title: 'New skill',
    description:
      'Name it, then work it out with the Builder, which writes the skill and saves its first version. It starts private.',
    placeholder: 'e.g. Release Notes…',
  },
} as const;

export function CreateEntryDialog(props: {
  type: BuilderSubjectType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const createAgent = useCreateAgent();
  const createSkill = useCreateSkill();
  const [name, setName] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);

  const trimmed = () => name().trim();
  const slug = () => slugify(trimmed(), SLUG_MAX_LENGTH[props.type]);
  const pending = () => createAgent.isPending || createSkill.isPending;
  const canSubmit = () => slug().length > 0 && !pending();

  const close = () => {
    setName('');
    setError(null);
    props.onOpenChange(false);
  };

  const create = async (): Promise<string> => {
    if (props.type === 'agent') return (await createAgent.mutateAsync({ displayName: trimmed() })).id;
    return (await createSkill.mutateAsync({ name: slug(), displayName: trimmed() })).id;
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit()) return;
    setError(null);
    try {
      const id = await create();
      close();
      void navigate({ to: builderPath({ type: props.type, id }) });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : `The ${props.type} could not be created.`);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{COPY[props.type].title}</DialogTitle>
            <DialogDescription>{COPY[props.type].description}</DialogDescription>
          </DialogHeader>

          <div class="mt-4">
            <label for={`new-${props.type}-name`} class="mb-1 block text-xs font-medium text-muted-foreground">
              Name
            </label>
            <input
              id={`new-${props.type}-name`}
              name="name"
              type="text"
              autocomplete="off"
              maxLength={80}
              value={name()}
              onInput={(event) => {
                setName(event.currentTarget.value);
                setError(null);
              }}
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={COPY[props.type].placeholder}
              aria-describedby={`new-${props.type}-slug`}
              autofocus
            />
            <p id={`new-${props.type}-slug`} class="mt-1.5 min-h-4 text-xs text-muted-foreground" aria-live="polite">
              <Show
                when={slug()}
                fallback={
                  <Show when={trimmed()}>
                    <span class="text-destructive">Use at least one letter or digit.</span>
                  </Show>
                }
              >
                {(value) => (
                  <>
                    Slug <span class="font-mono text-foreground">{value()}</span> — fixed once created.
                  </>
                )}
              </Show>
            </p>
            <Show when={error()}>
              <p class="mt-2 text-xs text-destructive" role="alert">
                {error()}
              </p>
            </Show>
          </div>

          <DialogFooter class="mt-4">
            <Button type="button" size="sm" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit()} loading={pending()}>
              Create and open Builder
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
