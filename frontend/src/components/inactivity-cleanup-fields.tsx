import { For, Show, createSignal } from 'solid-js';
import { NumberField as KobalteNumberField } from '@kobalte/core/number-field';
import { KobalteSwitch } from '~/components/ui/switch/switch';
import { SwitchControl, SwitchThumb } from '~/components/ui/switch';
import type { InactivityCleanup } from '~/api/client';
import { NumberField, NumberFieldGroup, NumberFieldInput, NumberFieldLabel } from '~/components/ui/number-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import {
  CLEANUP_STEPS,
  CLEANUP_UNITS,
  DAY_MS,
  HOUR_MS,
  MAX_INACTIVITY_MS,
  MIN_INACTIVITY_MS,
  NEVER_CLEANED_UP,
  describeCleanup,
  formatDuration,
  perStep,
  type CleanupStep,
} from '~/lib/inactivity-cleanup';
import { OptionCard, OptionCardGroup } from '~/components/ui/option-card';
import { cn } from '~/lib/cn';

const SUGGESTED_GAP_MS = 30 * DAY_MS;

export type InactivityCleanupDraft = ReturnType<typeof createInactivityCleanupDraft>;
type CleanupRule = ReturnType<typeof createRule>;

const unitMs = (unit: string) => CLEANUP_UNITS.find((option) => option.value === unit)?.multiplier ?? DAY_MS;
const validDuration = (value: number | null): value is number =>
  value !== null && Number.isInteger(value) && value >= MIN_INACTIVITY_MS && value <= MAX_INACTIVITY_MS;
const clampDuration = (value: number) => Math.min(MAX_INACTIVITY_MS, Math.max(MIN_INACTIVITY_MS, value));

const earlier = (step: CleanupStep) => CLEANUP_STEPS.slice(0, CLEANUP_STEPS.indexOf(step)).toReversed();
const later = (step: CleanupStep) => CLEANUP_STEPS.slice(CLEANUP_STEPS.indexOf(step) + 1);

function createRule() {
  const [on, setOn] = createSignal(false);
  const [amount, setAmount] = createSignal('');
  const [unit, setUnit] = createSignal('days');
  function show(value: number | null) {
    const inDays = value !== null && value % DAY_MS === 0;
    setUnit(value === null || inDays ? 'days' : 'hours');
    setAmount(value === null ? '' : String(value / (inDays ? DAY_MS : HOUR_MS)));
  }
  return {
    on,
    setOn,
    amount,
    setAmount,
    unit,
    setUnit,
    show,
    value: (): number | null => {
      if (!on()) return null;
      return amount().trim() === '' ? Number.NaN : Math.round(Number(amount()) * unitMs(unit()));
    },
    load(value: number | null) {
      setOn(value !== null);
      show(value);
    },
  };
}

export function createInactivityCleanupDraft() {
  const rules = perStep(() => createRule());
  const [saved, setSaved] = createSignal<InactivityCleanup>(NEVER_CLEANED_UP);
  const [errorsShown, setErrorsShown] = createSignal(false);

  const rule = (step: CleanupStep) => rules[step.field];
  const toCleanup = (): InactivityCleanup => perStep((step) => rule(step).value());
  const firstValid = (steps: CleanupStep[]) => steps.find((other) => validDuration(rule(other).value()));

  function error(step: CleanupStep): string | null {
    const value = rule(step).value();
    if (value === null) return null;
    if (!validDuration(value)) return 'Enter a whole number of hours or days, from 1 hour to 3650 days.';
    const before = firstValid(earlier(step));
    const beforeValue = before ? rule(before).value() : null;
    if (!before || beforeValue === null || value > beforeValue) return null;
    return `Must be longer than ${before.label} (${formatDuration(beforeValue)}).`;
  }

  function load(cleanup: InactivityCleanup) {
    for (const step of CLEANUP_STEPS) rule(step).load(cleanup[step.field]);
  }

  return {
    rule,
    toCleanup,
    error: (step: CleanupStep) => (errorsShown() ? error(step) : null),
    invalid: () => CLEANUP_STEPS.some((step) => error(step) !== null),
    anyOn: () => CLEANUP_STEPS.some((step) => rule(step).on()),
    showErrors: () => setErrorsShown(true),
    dirty: () => CLEANUP_STEPS.some((step) => toCleanup()[step.field] !== saved()[step.field]),
    turnOn(step: CleanupStep) {
      if (rule(step).amount() === '') {
        const before = firstValid(earlier(step));
        const after = firstValid(later(step));
        const beforeValue = before ? (rule(before).value() ?? 0) : SUGGESTED_GAP_MS * CLEANUP_STEPS.indexOf(step);
        let suggested = beforeValue + SUGGESTED_GAP_MS;
        const afterValue = after ? rule(after).value() : null;
        if (afterValue !== null && suggested >= afterValue) {
          suggested = afterValue - (afterValue > DAY_MS ? DAY_MS : HOUR_MS);
        }
        rule(step).show(clampDuration(suggested));
      }
      rule(step).setOn(true);
    },
    fill: load,
    reset(cleanup: InactivityCleanup) {
      setSaved(cleanup);
      setErrorsShown(false);
      load(cleanup);
    },
  };
}

export type InactivityCleanupChoice = ReturnType<typeof createInactivityCleanupChoice>;

export function createInactivityCleanupChoice() {
  const draft = createInactivityCleanupDraft();
  const [custom, setCustom] = createSignal(false);
  const [savedCustom, setSavedCustom] = createSignal(false);
  return {
    draft,
    custom,
    savedCustom,
    value: (): InactivityCleanup | null => (custom() ? draft.toCleanup() : null),
    dirty: () => custom() !== savedCustom() || (custom() && draft.dirty()),
    invalid: () => custom() && draft.invalid(),
    chooseInherited: () => setCustom(false),
    chooseCustom(start: InactivityCleanup) {
      if (!custom() && !draft.anyOn()) draft.fill(start);
      setCustom(true);
    },
    reset(own: InactivityCleanup | null) {
      setCustom(own !== null);
      setSavedCustom(own !== null);
      draft.reset(own ?? NEVER_CLEANED_UP);
    },
  };
}

export function InactivityCleanupChoiceField(props: {
  choice: InactivityCleanupChoice;
  label: string;
  inheritedLabel: string;
  inherited: InactivityCleanup;
  inheritedDescription?: string;
  customDescription: string;
  disabled?: boolean;
  inheritLocked?: boolean;
  customLocked?: boolean;
  locked?: (step: CleanupStep) => boolean;
}) {
  return (
    <div class="space-y-2">
      <OptionCardGroup label={props.label} class="sm:grid-cols-2">
        <OptionCard
          selected={!props.choice.custom()}
          onSelect={props.choice.chooseInherited}
          disabled={props.disabled || props.inheritLocked}
        >
          <span class="text-xs font-medium text-foreground">{props.inheritedLabel}</span>
          <span class="text-xs text-muted-foreground text-pretty">
            {props.inheritedDescription ?? describeCleanup(props.inherited)}
          </span>
        </OptionCard>
        <OptionCard
          selected={props.choice.custom()}
          onSelect={() => props.choice.chooseCustom(props.inherited)}
          disabled={props.disabled || props.customLocked}
        >
          <span class="text-xs font-medium text-foreground">Custom</span>
          <span class="text-xs text-muted-foreground text-pretty">{props.customDescription}</span>
        </OptionCard>
      </OptionCardGroup>
      <Show when={props.choice.custom()}>
        <InactivityCleanupFields draft={props.choice.draft} disabled={props.disabled} locked={props.locked} />
      </Show>
    </div>
  );
}

export function InactivityCleanupFields(props: {
  draft: InactivityCleanupDraft;
  disabled?: boolean;
  locked?: (step: CleanupStep) => boolean;
}) {
  return (
    <div class="space-y-2">
      <For each={CLEANUP_STEPS}>
        {(step) => (
          <CleanupRuleRow
            step={step}
            rule={props.draft.rule(step)}
            error={props.draft.error(step)}
            disabled={props.disabled}
            locked={props.locked?.(step) ?? false}
            onTurnOn={() => props.draft.turnOn(step)}
            onBlur={props.draft.showErrors}
          />
        )}
      </For>
      <p class="text-xs text-muted-foreground/70 text-pretty">
        Anything that wakes the Project counts as activity: chat, the editor, visits to its App, scheduled runs,
        webhooks and incoming email. Checked every hour.
      </p>
    </div>
  );
}

function CleanupRuleRow(props: {
  step: CleanupStep;
  rule: CleanupRule;
  error: string | null;
  disabled?: boolean;
  locked: boolean;
  onTurnOn: () => void;
  onBlur: () => void;
}) {
  const disabled = () => props.disabled || props.locked;
  return (
    <div
      class={cn(
        'rounded-lg border p-3 space-y-2.5 transition-colors',
        props.step.destructive && props.rule.on() ? 'of-hair of-tone-failed' : 'border-border'
      )}
    >
      <KobalteSwitch
        checked={props.rule.on()}
        disabled={disabled()}
        onChange={(on) => (on ? props.onTurnOn() : props.rule.setOn(false))}
        class="flex items-start justify-between gap-3"
      >
        <div class="min-w-0 space-y-0.5">
          <KobalteSwitch.Label class="block text-xs font-medium text-foreground">
            {props.step.title}
          </KobalteSwitch.Label>
          <KobalteSwitch.Description class="block text-xs text-muted-foreground text-pretty">
            {props.step.description}
            <Show when={props.step.warning}>
              {(warning) => <span class="of-ink of-tone-failed font-medium"> {warning()}</span>}
            </Show>
          </KobalteSwitch.Description>
          <Show when={props.locked}>
            <p class="text-xs text-muted-foreground/70">
              Changing this needs permission to {props.step.action} Projects.
            </p>
          </Show>
        </div>
        <SwitchControl class="mt-0.5">
          <SwitchThumb />
        </SwitchControl>
      </KobalteSwitch>
      <Show when={props.rule.on()}>
        <NumberField
          class="gap-1.5"
          minValue={1}
          step={1}
          formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
          value={props.rule.amount()}
          onChange={props.rule.setAmount}
          validationState={props.error ? 'invalid' : 'valid'}
          disabled={disabled()}
        >
          <NumberFieldLabel class="sr-only">{`${props.step.title}: time without activity`}</NumberFieldLabel>
          <div class="flex items-center gap-2">
            <NumberFieldGroup class="w-24">
              <NumberFieldInput
                name={props.step.field}
                autocomplete="off"
                inputMode="numeric"
                class="pr-2.5 aria-[invalid=true]:border-destructive"
                onBlur={props.onBlur}
              />
            </NumberFieldGroup>
            <div class="w-28">
              <Select
                options={CLEANUP_UNITS}
                optionValue="value"
                optionTextValue="label"
                value={CLEANUP_UNITS.find((unit) => unit.value === props.rule.unit()) ?? null}
                disabled={disabled()}
                onChange={(option) => {
                  if (option) props.rule.setUnit(option.value);
                }}
                itemComponent={(itemProps) => (
                  <SelectItem item={itemProps.item}>{itemProps.item.rawValue.label}</SelectItem>
                )}
              >
                <SelectTrigger aria-label={`${props.step.title}: unit`}>
                  <SelectValue<(typeof CLEANUP_UNITS)[number]>>
                    {(state) => <span>{state.selectedOption()?.label}</span>}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent />
              </Select>
            </div>
            <span class="text-xs text-muted-foreground">without activity</span>
          </div>
          <KobalteNumberField.ErrorMessage class="text-xs text-destructive">
            {props.error}
          </KobalteNumberField.ErrorMessage>
        </NumberField>
      </Show>
    </div>
  );
}
