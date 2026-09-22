import { createEffect, createSignal, Show } from 'solid-js';
import { format } from 'date-fns';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { Calendar, Code } from '~/components/icons';
import { arrayToString, stringToArray } from './lib/part';
import { Schedule } from './lib/schedule';
import { type CronState, ScheduleSelector, type ValuePayload } from './lib/types';
import { ScheduleSelectors } from './components/schedule-selectors';
import { ScheduleExplainer } from './components/schedule-explainer';

export const baseCron = '* * * * *';

interface Props {
  cronString: string;
  setCronString: (val: string) => void;
  disableInput?: boolean;
  disableSelectors?: boolean;
  disableExplainerText?: boolean;
  selectorText?: string;
  view?: 'simple' | 'advanced';
  activeScheduleSelectors?: ScheduleSelector[];
}

const DEFAULT_SELECTORS = [
  ScheduleSelector.year,
  ScheduleSelector.weekday,
  ScheduleSelector.month,
  ScheduleSelector.day,
  ScheduleSelector.hour,
];

function buildState(expression: string): CronState {
  try {
    const array = stringToArray(expression);
    const next = format(new Schedule(array).next(), 'PPPPpppp');
    return { expression, array, error: '', next };
  } catch (e) {
    return { expression, array: [[], [], [], [], []], error: (e as Error).message, next: '' };
  }
}

export function CronPicker(props: Props) {
  const [cronState, setCronState] = createSignal<CronState>(buildState(props.cronString || baseCron));

  createEffect(() => {
    props.setCronString(cronState().expression);
  });

  const setExpression = (expression: string) => {
    if (expression === cronState().expression) return;
    setCronState(buildState(expression));
  };

  const constructCronState = (payload: ValuePayload) => {
    const current = cronState();
    const newArray = [...current.array];
    newArray[payload.index] = payload.values;
    try {
      const expression = arrayToString(newArray);
      if (expression !== current.expression) setCronState(buildState(expression));
    } catch (e) {
      setCronState({ ...current, array: newArray, error: (e as Error).message });
    }
  };

  const activeSelectors = () => props.activeScheduleSelectors ?? DEFAULT_SELECTORS;
  const view = () => props.view ?? 'simple';
  const selectorText = () => props.selectorText ?? 'Run every';

  const builder = () => (
    <Show when={!props.disableSelectors}>
      <ScheduleSelectors
        constructCronState={constructCronState}
        cronState={cronState()}
        selectorText={selectorText()}
        activeScheduleSelectors={activeSelectors()}
        updateCronState={setExpression}
      />
    </Show>
  );

  return (
    <Show
      when={view() === 'advanced'}
      fallback={
        <div class="flex flex-col gap-3">
          {builder()}
          <ScheduleExplainer state={cronState()} disableExplainerText={props.disableExplainerText} />
        </div>
      }
    >
      <div class="flex flex-col gap-3">
        <Tabs defaultValue="builder">
          <TabsList>
            <TabsTrigger value="builder" class="gap-1.5">
              <Calendar class="w-3.5 h-3.5" />
              Schedule Builder
            </TabsTrigger>
            <TabsTrigger value="string" class="gap-1.5">
              <Code class="w-3.5 h-3.5" />
              Cron String
            </TabsTrigger>
          </TabsList>
          <TabsContent value="builder">{builder()}</TabsContent>
          <TabsContent value="string">
            <Show when={!props.disableInput}>
              <input
                type="text"
                class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                value={cronState().expression}
                onInput={(e) => setExpression(e.currentTarget.value)}
              />
            </Show>
          </TabsContent>
        </Tabs>
        <ScheduleExplainer state={cronState()} disableExplainerText={props.disableExplainerText} />
      </div>
    </Show>
  );
}
