import { createMemo, For, Show } from 'solid-js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '~/components/ui/dropdown-menu';
import { Badge } from '~/components/ui/badge';
import { ChevronsUpDown } from '~/components/icons';
import { cn } from '~/lib/cn';
import { createRanges, isFull } from '../lib/part';
import { spreadOption } from '../lib/units';
import type { Unit } from '../lib/types';

interface Props {
  options: Unit;
  unitValues: number[];
  unitIndex: number;
  constructCronState: (val: { index: number; values: number[] }) => void;
}

export function MultiSelect(props: Props) {
  const allOptions = createMemo(() => spreadOption(props.options));

  const selectedValues = createMemo(() =>
    isFull(props.unitValues, props.options) ? [] : props.unitValues.map(String)
  );

  const isSelectAll = createMemo(() => selectedValues().length === 0);

  const toggleOption = (option: string) => {
    const current = selectedValues();
    const updated = current.includes(option) ? current.filter((c) => c !== option) : [...current, option];

    const values = updated.length === 0 ? allOptions().map(Number) : updated.map(Number);
    props.constructCronState({ index: props.unitIndex, values });
  };

  const handleSelectAll = () => {
    props.constructCronState({ index: props.unitIndex, values: allOptions().map(Number) });
  };

  const formatOption = (option: string) => {
    if (!props.options.alt) return option;
    if (props.options.name === 'month') return props.options.alt[Number(option) - 1];
    return props.options.alt[Number(option)];
  };

  const badges = createMemo(() => {
    const values = selectedValues();
    if (values.length === 0) return null;
    if (props.options.alt) {
      return [...values].toSorted((a, b) => Number(a) - Number(b)).map(formatOption);
    }
    return createRanges([...values].map(Number).toSorted((a, b) => a - b));
  });

  return (
    <div class="flex flex-col gap-1 min-w-0 flex-1">
      <div class="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">{props.options.name}(s)</div>
      <DropdownMenu>
        <DropdownMenuTrigger class="flex h-8 w-full items-center justify-between rounded-md border border-input bg-background px-2 py-1 text-xs transition-colors hover:bg-accent/50">
          <div class="flex items-center gap-1 flex-wrap overflow-hidden min-w-0">
            <Show when={badges()} fallback={<span class="text-xs text-muted-foreground">All</span>}>
              {(items) => (
                <For each={items()}>
                  {(item) => (
                    <Badge variant="secondary" class="text-[10px] px-1.5 py-0">
                      {item}
                    </Badge>
                  )}
                </For>
              )}
            </Show>
          </div>
          <ChevronsUpDown class="ml-1 w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="max-h-64 overflow-y-auto">
          <div class="grid grid-cols-4 gap-0.5 p-1 min-w-40">
            <For each={allOptions()}>
              {(option) => {
                const isActive = () => selectedValues().includes(option);
                return (
                  <DropdownMenuItem
                    closeOnSelect={false}
                    onSelect={() => toggleOption(option)}
                    class={cn(
                      'justify-center text-[11px] px-2 py-1',
                      isActive() && 'bg-accent text-accent-foreground font-medium'
                    )}
                  >
                    {formatOption(option)}
                  </DropdownMenuItem>
                );
              }}
            </For>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem closeOnSelect={false} onSelect={handleSelectAll} class="justify-center">
            <Show when={!isSelectAll()} fallback="All selected">
              Select All
            </Show>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
