import { createMemo, createSignal, For, Show } from 'solid-js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui/select';
import { MultiSelect } from './multi-select';
import { getUnits } from '../lib/units';
import { determineDefaultSelector, updateCronString } from '../lib/utils';
import { type CronState, ScheduleSelector, type ScheduleSelectorObject, type ValuePayload } from '../lib/types';

interface Props {
  constructCronState: (val: ValuePayload) => void;
  cronState: CronState;
  selectorText: string;
  activeScheduleSelectors: ScheduleSelector[];
  updateCronState: (cron: string) => void;
}

const scheduleSelector: ScheduleSelectorObject[] = [
  { name: ScheduleSelector.year, prefix: 'on' },
  { name: ScheduleSelector.weekday, prefix: 'on' },
  { name: ScheduleSelector.month, prefix: 'on' },
  { name: ScheduleSelector.day, prefix: 'and' },
  { name: ScheduleSelector.hour, prefix: 'at' },
  { name: ScheduleSelector.minute, prefix: ':' },
];

const units = getUnits();

export function ScheduleSelectors(props: Props) {
  const activeOptions = createMemo(() =>
    scheduleSelector.filter((opt) => props.activeScheduleSelectors.includes(opt.name))
  );

  const [selectedSchedule, setSelectedSchedule] = createSignal<ScheduleSelector>(
    determineDefaultSelector(activeOptions(), props.cronState.expression)
  );

  const visibleSelectors = createMemo(() => {
    const index = scheduleSelector.findIndex((s) => s.name === selectedSchedule());
    return scheduleSelector
      .slice(index + 1)
      .map((opt) => {
        const unitIndex = units.findIndex((u) => u.name === opt.name);
        return unitIndex === -1 ? null : { ...opt, unit: units[unitIndex], unitIndex };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  });

  const handleChangeSelector = (option: ScheduleSelector | null) => {
    if (!option) return;
    setSelectedSchedule(option);
    props.updateCronState(updateCronString(props.cronState.expression, option, activeOptions()));
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-muted-foreground">{props.selectorText}</span>
        <Select<ScheduleSelector>
          value={selectedSchedule()}
          onChange={handleChangeSelector}
          options={activeOptions().map((o) => o.name)}
          itemComponent={(itemProps) => <SelectItem item={itemProps.item}>{itemProps.item.rawValue}</SelectItem>}
        >
          <SelectTrigger class="w-28">
            <SelectValue<ScheduleSelector>>{(state) => state.selectedOption()}</SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
      <Show when={visibleSelectors().length > 0}>
        <div class="flex gap-2 flex-wrap items-end">
          <For each={visibleSelectors()}>
            {(sel) => (
              <>
                <span class="text-xs text-muted-foreground pb-1.5">{sel.prefix}</span>
                <MultiSelect
                  options={sel.unit}
                  unitIndex={sel.unitIndex}
                  unitValues={props.cronState.array[sel.unitIndex] ?? []}
                  constructCronState={props.constructCronState}
                />
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
