import { For, Show } from 'solid-js';
import type { PodClassCatalog, PodResources } from '~/api/client';
import { OptionCard, OptionCardGroup } from '~/components/ui/option-card';
import type { ResourcesDraft } from './resources-draft';
import { SlidersHorizontal } from '~/components/icons';
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldIncrementTrigger,
  NumberFieldDecrementTrigger,
} from '~/components/ui/number-field';
import { formatCores, formatGib, mibToGib, millicoresToCores, trimNumber } from '~/lib/pod-resources';

const PRESET_META: Record<string, { title: string; description: string }> = {
  small: { title: 'Small', description: 'Light apps and prototypes.' },
  medium: { title: 'Medium', description: 'Heavier builds and dependencies.' },
  large: { title: 'Large', description: 'Demanding or memory-hungry workloads.' },
};

export interface ResourcesSelectorProps {
  catalog: PodClassCatalog | undefined;
  draft: ResourcesDraft;
  disabled?: boolean;
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

  return (
    <div class="space-y-3">
      <OptionCardGroup label="Resources" class="grid-cols-2">
        <For each={props.catalog?.presets ?? []}>
          {(preset) => {
            const meta = PRESET_META[preset.podClass];
            return (
              <OptionCard
                selected={props.draft.podClass() === preset.podClass}
                disabled={props.disabled}
                onSelect={() => props.draft.selectClass(preset.podClass)}
              >
                <span class="text-xs font-medium">{meta?.title ?? preset.podClass}</span>
                <span class="text-xs text-muted-foreground tabular-nums">
                  {formatCores(preset.resources.cpuMillicores)} · {formatGib(preset.resources.memoryRequestMib)} /{' '}
                  {formatGib(preset.resources.memoryLimitMib)}
                </span>
                <Show when={meta?.description}>
                  <p class="text-xs text-muted-foreground/70 leading-snug">{meta?.description}</p>
                </Show>
              </OptionCard>
            );
          }}
        </For>
        <OptionCard
          selected={props.draft.podClass() === 'custom'}
          disabled={props.disabled}
          onSelect={() => props.draft.selectClass('custom')}
        >
          <div class="flex items-center gap-1.5">
            <SlidersHorizontal class="w-3.5 h-3.5" />
            <span class="text-xs font-medium">Custom</span>
          </div>
          <p class="text-xs text-muted-foreground/70 leading-snug">Pick exact CPU and memory.</p>
        </OptionCard>
      </OptionCardGroup>

      <Show when={props.draft.podClass() === 'custom' && props.catalog}>
        {(catalog) => (
          <div class="rounded-lg border border-border p-3 space-y-2">
            <div class="grid grid-cols-3 gap-2">
              <For each={customInputs(catalog().customBounds)}>
                {(input) => (
                  <div class="space-y-1">
                    <div class="flex items-baseline justify-between gap-1">
                      <span class="text-xs text-muted-foreground">
                        {input.label} ({input.unit})
                      </span>
                    </div>
                    <NumberField
                      minValue={input.minValue}
                      maxValue={input.maxValue}
                      step={input.step}
                      value={input.value}
                      onChange={(v) => input.onChange(v)}
                      disabled={props.disabled}
                    >
                      <NumberFieldGroup>
                        <NumberFieldInput />
                        <NumberFieldIncrementTrigger />
                        <NumberFieldDecrementTrigger />
                      </NumberFieldGroup>
                    </NumberField>
                    <span class="text-xs text-muted-foreground/60 tabular-nums">{input.range}</span>
                  </div>
                )}
              </For>
            </div>
            <Show when={props.draft.limitError()}>
              <p class="text-xs text-destructive">Memory limit must be greater than or equal to memory request.</p>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
