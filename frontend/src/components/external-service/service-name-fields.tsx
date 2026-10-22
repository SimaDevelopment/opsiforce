import { Show, createSignal, type JSX } from 'solid-js';
import { ApiError } from '~/api/client';
import { RESERVED_SERVICE_SLUGS, SERVICE_SLUG_MAX_LENGTH, SERVICE_SLUG_PATTERN } from '~/api/external-service-views';
import { slugify } from '~/lib/app-url';

const INPUT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

const SLUG_REFUSALS = new Set(['invalid-slug', 'slug-taken']);

function slugProblem(slug: string): string | null {
  if (!slug) return null;
  if (!SERVICE_SLUG_PATTERN.test(slug)) {
    return 'Use 2 to 31 lowercase letters, digits and hyphens, starting with a letter.';
  }
  if (RESERVED_SERVICE_SLUGS.includes(slug)) return `${slug} is reserved by the platform.`;
  return null;
}

export interface ServiceNaming {
  name: () => string;
  slug: () => string;
  slugMessage: () => string | null;
  valid: () => boolean;
  setName: (name: string) => void;
  setSlug: (slug: string | null) => void;
  reset: (name?: string, slug?: string | null) => void;
  placeSlugRefusal: (caught: unknown) => boolean;
}

export function createServiceNaming(initialName = '', initialSlug: string | null = null): ServiceNaming {
  const [name, setName] = createSignal(initialName);
  const [suggestedSlug, setSuggestedSlug] = createSignal<string | null>(initialSlug);
  const [typedSlug, setTypedSlug] = createSignal<string | null>(null);
  const [refusal, setRefusal] = createSignal<{ slug: string; message: string } | null>(null);

  const slug = () => typedSlug() ?? suggestedSlug() ?? slugify(name(), SERVICE_SLUG_MAX_LENGTH);
  const slugMessage = () => {
    const refused = refusal();
    if (refused && refused.slug === slug()) return refused.message;
    return slugProblem(slug());
  };

  return {
    name,
    slug,
    slugMessage,
    valid: () => name().trim().length > 0 && slug().length > 0 && slugMessage() === null,
    setName: (nextName) => {
      setName(nextName);
      setSuggestedSlug(null);
    },
    setSlug: setTypedSlug,
    reset: (nextName = '', nextSlug = null) => {
      setName(nextName);
      setSuggestedSlug(nextSlug);
      setTypedSlug(null);
      setRefusal(null);
    },
    placeSlugRefusal: (caught) => {
      if (!(caught instanceof ApiError) || caught.code === null || !SLUG_REFUSALS.has(caught.code)) return false;
      setRefusal({ slug: slug(), message: caught.message });
      return true;
    },
  };
}

export function ServiceNameFields(props: {
  id: string;
  naming: ServiceNaming;
  disabled?: boolean;
  onEdit?: () => void;
  slugHint?: JSX.Element;
}) {
  return (
    <>
      <div>
        <label for={`${props.id}-name`} class="mb-1 block text-xs font-medium text-muted-foreground">
          Name
        </label>
        <input
          id={`${props.id}-name`}
          name="name"
          type="text"
          autocomplete="off"
          maxLength={80}
          disabled={props.disabled}
          value={props.naming.name()}
          onInput={(event) => {
            props.naming.setName(event.currentTarget.value);
            props.onEdit?.();
          }}
          class={INPUT_CLASS}
          placeholder="e.g. Helpdesk…"
          autofocus
        />
      </div>
      <div>
        <label for={`${props.id}-slug`} class="mb-1 block text-xs font-medium text-muted-foreground">
          Slug
        </label>
        <input
          id={`${props.id}-slug`}
          name="slug"
          type="text"
          autocomplete="off"
          spellcheck={false}
          maxLength={SERVICE_SLUG_MAX_LENGTH}
          disabled={props.disabled}
          value={props.naming.slug()}
          onInput={(event) => {
            props.naming.setSlug(event.currentTarget.value);
            props.onEdit?.();
          }}
          class={`${INPUT_CLASS} font-mono`}
          placeholder="e.g. helpdesk…"
          aria-describedby={`${props.id}-slug-hint`}
          aria-invalid={props.naming.slugMessage() !== null}
        />
        <p id={`${props.id}-slug-hint`} class="mt-1.5 min-h-4 text-xs text-muted-foreground" aria-live="polite">
          <Show
            when={props.naming.slugMessage()}
            fallback={
              props.slugHint ?? <>Agents and Apps call it by this name. You can change it until the first publish.</>
            }
          >
            {(message) => <span class="text-destructive">{message()}</span>}
          </Show>
        </p>
      </div>
    </>
  );
}
