import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { Popover, PopoverTrigger, PopoverContent } from '~/components/ui/popover';
import { Check, ChevronDown } from '~/components/icons';
import { cn } from '~/lib/cn';
import { dictationLanguageName, toDictationLanguages } from '~/lib/dictation-languages';

const STORAGE_KEY = 'dictation-language';

const [dictationLanguage, setDictationLanguageSignal] = createSignal<string | undefined>(
  localStorage.getItem(STORAGE_KEY) ?? undefined
);

export { dictationLanguage };

function setDictationLanguage(code: string | undefined) {
  setDictationLanguageSignal(code);
  if (code) localStorage.setItem(STORAGE_KEY, code);
  else localStorage.removeItem(STORAGE_KEY);
}

export function reconcileDictationLanguage(supportedCodes: readonly string[]) {
  const code = dictationLanguage();
  if (code && !supportedCodes.includes(code)) setDictationLanguage(undefined);
}

function selectionLabel(): string {
  const code = dictationLanguage();
  return code ? dictationLanguageName(code) : 'Auto';
}

function LanguageOption(props: { selected: boolean; onSelect: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      onClick={() => props.onSelect()}
      class="flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
    >
      <Check class={cn('h-3.5 w-3.5 shrink-0', !props.selected && 'invisible')} />
      {props.children}
    </button>
  );
}

export function DictationLanguageMenu(props: { languages: readonly string[] }) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const languages = createMemo(() => toDictationLanguages(props.languages));
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return languages();
    return languages().filter(
      (language) => language.name.toLowerCase().includes(needle) || language.code.includes(needle)
    );
  });

  const select = (code: string | undefined) => {
    setDictationLanguage(code);
    setOpen(false);
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  };

  return (
    <Popover placement="top-end" open={open()} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label="Dictation language"
        title={`Dictation language: ${selectionLabel()}`}
        class={cn(
          'flex h-8 min-w-4 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[expanded]:bg-accent data-[expanded]:text-foreground',
          dictationLanguage() ? 'ml-0.5' : '-ml-1'
        )}
      >
        <Show when={dictationLanguage()} fallback={<ChevronDown class="h-3 w-3" />}>
          {(code) => (
            <span class="rounded border border-border bg-muted px-1 py-px text-[0.625rem] font-semibold uppercase leading-3">
              {code()}
            </span>
          )}
        </Show>
      </PopoverTrigger>
      <PopoverContent class="w-56 p-1">
        <input
          type="text"
          aria-label="Search languages"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const first = filtered()[0];
            if (first) select(first.code);
          }}
          placeholder="Search languages"
          class="mb-1 flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div class="max-h-64 overflow-y-auto">
          <Show when={!query().trim()}>
            <LanguageOption selected={!dictationLanguage()} onSelect={() => select(undefined)}>
              Auto
            </LanguageOption>
          </Show>
          <For
            each={filtered()}
            fallback={<div class="px-2 py-1.5 text-xs text-muted-foreground">No languages found</div>}
          >
            {(language) => (
              <LanguageOption selected={dictationLanguage() === language.code} onSelect={() => select(language.code)}>
                {language.name}
              </LanguageOption>
            )}
          </For>
        </div>
      </PopoverContent>
    </Popover>
  );
}
