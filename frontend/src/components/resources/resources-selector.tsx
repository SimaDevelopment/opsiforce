import { For, Show } from 'solid-js';
import type { PodClassCatalog, PodResources, PodSettings } from '~/api/client';
import { OptionCard, OptionCardGroup } from '~/components/ui/option-card';
import { CUSTOM, INHERIT, type ResourcesDraft } from './resources-draft';
import { SlidersHorizontal } from '~/components/icons';
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldIncrementTrigger,
  NumberFieldDecrementTrigger,
  NumberFieldLabel,
} from '~/components/ui/number-field';
import { describeResources, mibToGib, millicoresToCores, presetTitle, trimNumber } from '~/lib/pod-resources';

export interface ResourcesSelectorProps {
  catalog: PodClassCatalog | undefined;
  draft: ResourcesDraft;
  disabled?: boolean;
  /** An extra first option that follows someone else's choice, such as the platform value. */
  inherited?: { label: string; settings: PodSettings };
  /** What the pod runs at now, shown when its preset has changed numbers since. */
  current?: PodSettings;
}

interface CustomInput {
  label: string;
  unit: string;
  range: string;
  step: number;
  minValue: number;
  maxValue: number;
  value: string;
  onChange: (value: string) => void;
}

export function ResourcesSelector(props: ResourcesSelectorProps) {
  const customInputs = (bounds: { min: PodResources; max: PodResources }): CustomInput[] => [
    {
      label: 'CPU',
      unit: 'vCPU',
      range: `${trimNumber(millicoresToCores(bounds.min.cpuMillicores))}–${trimNumber(millicoresToCores(bounds.max.cpuMillicores))}`,
      step: 0.25,
      minValue: millicoresToCores(bounds.min.cpuMillicores),
      maxValue: millicoresToCores(bounds.max.cpuMillicores),
      value: props.draft.cpuCores(),
      onChange: props.draft.setCpuCores,
    },
    {
      label: 'Memory request',
      unit: 'GiB',
      range: `${trimNumber(mibToGib(bounds.min.memoryRequestMib))}–${trimNumber(mibToGib(bounds.max.memoryRequestMib))}`,
      step: 0.5,
      minValue: mibToGib(bounds.min.memoryRequestMib),
      maxValue: mibToGib(bounds.max.memoryRequestMib),
      value: props.draft.memRequestGib(),
      onChange: props.draft.setMemRequestGib,
    },
    {
      label: 'Memory limit',
      unit: 'GiB',
      range: `${trimNumber(mibToGib(bounds.min.memoryLimitMib))}–${trimNumber(mibToGib(bounds.max.memoryLimitMib))}`,
      step: 0.5,
      minValue: mibToGib(bounds.min.memoryLimitMib),
      maxValue: mibToGib(bounds.max.memoryLimitMib),
      value: props.draft.memLimitGib(),
      onChange: props.draft.setMemLimitGib,
    },
  ];

  const staleNumbers = () => {
    const current = props.current;
    if (!current?.presetId || props.draft.selected() !== current.presetId || props.draft.dirty()) return null;
    const preset = props.catalog?.presets.find((entry) => entry.id === current.presetId);
    if (!preset) return null;
    const same =
      preset.resources.cpuMillicores === current.cpuMillicores &&
      preset.resources.memoryRequestMib === current.memoryRequestMib &&
      preset.resources.memoryLimitMib === current.memoryLimitMib;
    return same ? null : current;
  };

  return (
    <div class="space-y-3">
      <OptionCardGroup label="Resources" class="grid-cols-2">
        <Show when={props.inherited}>
          {(inherited) => (
            <OptionCard
              selected={props.draft.selected() === INHERIT}
              disabled={props.disabled}
              onSelect={() => props.draft.select(INHERIT)}
            >
              <span class="text-xs font-medium">{inherited().label}</span>
              <span class="text-xs text-muted-foreground tabular-nums">
                {presetTitle(inherited().settings)} · {describeResources(inherited().settings)}
              </span>
            </OptionCard>
          )}
        </Show>
        <For each={props.catalog?.presets ?? []}>
          {(preset) => (
            <OptionCard
              selected={props.draft.selected() === preset.id}
              disabled={props.disabled}
              onSelect={() => props.draft.select(preset.id)}
            >
              <span class="flex items-center gap-1.5 text-xs font-medium">
                {preset.name}
                <Show when={preset.id === props.catalog?.defaultPresetId}>
                  <span class="rounded border border-border px-1 text-[0.625rem] font-normal text-muted-foreground">
                    Default
                  </span>
                </Show>
              </span>
              <span class="text-xs text-muted-foreground tabular-nums">{describeResources(preset.resources)}</span>
            </OptionCard>
          )}
        </For>
        <OptionCard
          selected={props.draft.selected() === CUSTOM}
          disabled={props.disabled}
          onSelect={() => props.draft.select(CUSTOM)}
        >
          <div class="flex items-center gap-1.5">
            <SlidersHorizontal class="w-3.5 h-3.5" aria-hidden="true" />
            <span class="text-xs font-medium">Custom</span>
          </div>
          <p class="text-xs text-muted-foreground/70 leading-snug">Pick exact CPU and memory.</p>
        </OptionCard>
      </OptionCardGroup>

      <Show when={staleNumbers()}>
        {(current) => (
          <p class="text-xs text-muted-foreground">
            Runs at {describeResources(current())}. Pick {presetTitle(current())} again and save to move it to its
            current numbers.
          </p>
        )}
      </Show>

      <Show when={props.draft.selected() === CUSTOM && props.catalog}>
        {(catalog) => (
          <div class="rounded-lg border border-border p-3 space-y-2">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <For each={customInputs(catalog().customBounds)}>
                {(input) => (
                  <NumberField
                    class="space-y-1"
                    minValue={input.minValue}
                    maxValue={input.maxValue}
                    step={input.step}
                    value={input.value}
                    onChange={(v) => input.onChange(v)}
                    disabled={props.disabled}
                  >
                    <NumberFieldLabel class="text-xs text-muted-foreground">
                      {input.label} ({input.unit})
                    </NumberFieldLabel>
                    <NumberFieldGroup>
                      <NumberFieldInput />
                      <NumberFieldIncrementTrigger />
                      <NumberFieldDecrementTrigger />
                    </NumberFieldGroup>
                    <span class="block text-xs text-muted-foreground/60 tabular-nums">{input.range}</span>
                  </NumberField>
                )}
              </For>
            </div>
            <p class="text-xs text-destructive" aria-live="polite">
              {props.draft.limitError() ? 'Memory limit must be at least the request.' : ''}
            </p>
          </div>
        )}
      </Show>
    </div>
  );
}
