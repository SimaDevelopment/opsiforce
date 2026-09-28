import { Show, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { ApiError } from '~/api/client';
import { useCreateAgent } from '~/api/agents';
import { useCreateSkill } from '~/api/skills';
import { builderPath, type BuilderSubjectType } from '~/api/builder';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { slugify } from '~/lib/app-url';
import { ENTRY_SLUG_MAX_LENGTH, EntryNameField, isNameUnavailable } from './entry-name-field';

const COPY = {
  agent: {
    title: 'New agent',
    description:
      'Name it, then tell the Builder what it should do. The Builder writes its prompt, picks its skills and tries it in a test project. It starts private, and new projects can pick it after its first publish.',
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
  const [unavailableSlug, setUnavailableSlug] = createSignal<string | null>(null);

  const trimmed = () => name().trim();
  const slug = () => slugify(trimmed(), ENTRY_SLUG_MAX_LENGTH[props.type]);
  const pending = () => createAgent.isPending || createSkill.isPending;
  const unavailable = () => unavailableSlug() === slug();
  const canSubmit = () => slug().length > 0 && !unavailable() && !pending();

  const close = () => {
    setName('');
    setError(null);
    setUnavailableSlug(null);
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
      if (isNameUnavailable(caught)) {
        setUnavailableSlug(slug());
        return;
      }
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
            <EntryNameField
              id={`new-${props.type}-name`}
              label="Name"
              value={name()}
              slug={slug()}
              unavailable={unavailable()}
              placeholder={COPY[props.type].placeholder}
              onInput={(value) => {
                setName(value);
                setError(null);
              }}
            />
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
