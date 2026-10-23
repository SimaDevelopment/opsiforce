import { Show, createSignal } from 'solid-js';
import type { AgentProjectSettings, AgentProjectSettingsChoice } from '~/api/agents';
import { usePodClassCatalog } from '~/api/pod-classes';
import { OptionCard, OptionCardGroup } from '~/components/ui/option-card';
import { describePodSettings, describeReadyProjects } from '~/lib/pod-resources';
import { createResourcesDraft } from './resources-draft';
import { ResourcesSelector } from './resources-selector';
import { WarmPoolPicker } from './warm-pool-picker';

export type ProjectSettingsChoice = ReturnType<typeof createProjectSettingsChoice>;

export function createProjectSettingsChoice() {
  const [source, setSource] = createSignal<AgentProjectSettings | null>(null);
  const [maxWarmPoolSize, setMaxWarmPoolSize] = createSignal(0);
  const [changing, setChanging] = createSignal(false);
  const [warmPoolSize, setWarmPoolSize] = createSignal(0);
  const resources = createResourcesDraft();

  return {
    source,
    changing,
    setChanging,
    warmPoolSize,
    setWarmPoolSize,
    resources,
    maxWarmPoolSize,
    clear() {
      setSource(null);
      setChanging(false);
    },
    reset(carried: AgentProjectSettings, max: number) {
      setSource(carried);
      setMaxWarmPoolSize(max);
      setChanging(false);
      setWarmPoolSize(carried.warmPoolSize);
      resources.reset(carried.resources);
    },
    invalid: () => changing() && resources.limitError(),
    toChoice(): AgentProjectSettingsChoice {
      if (!changing()) return {};
      return { resources: resources.toDto(), warmPoolSize: warmPoolSize() };
    },
  };
}

export function isDefaultProjectSettings(settings: AgentProjectSettings): boolean {
  return settings.resources.podClass === 'small' && settings.warmPoolSize === 0;
}

export function describeProjectSettings(settings: AgentProjectSettings): string {
  return `${describePodSettings(settings.resources)} · ${describeReadyProjects(settings.warmPoolSize)}`;
}

export function ProjectSettingsChoiceField(props: {
  choice: ProjectSettingsChoice;
  sourceLabel: string;
  disabled?: boolean;
}) {
  const catalog = usePodClassCatalog(() => props.choice.changing());

  return (
    <Show when={props.choice.source()}>
      {(carried) => (
        <section class="space-y-2">
          <h3 class="text-xs font-medium text-foreground">Resources & Ready Projects for new Projects</h3>
          <OptionCardGroup label="Resources and Ready Projects" class="grid-cols-2">
            <OptionCard
              selected={!props.choice.changing()}
              disabled={props.disabled}
              onSelect={() => props.choice.setChanging(false)}
            >
              <span class="text-xs font-medium">Keep {props.sourceLabel.toLowerCase()}'s</span>
              <span class="text-xs text-muted-foreground tabular-nums">{describeProjectSettings(carried())}</span>
            </OptionCard>
            <OptionCard
              selected={props.choice.changing()}
              disabled={props.disabled}
              onSelect={() => props.choice.setChanging(true)}
            >
              <span class="text-xs font-medium">Change</span>
              <span class="text-xs text-muted-foreground">Pick other Resources or keep a different number ready.</span>
            </OptionCard>
          </OptionCardGroup>
          <Show when={props.choice.changing()}>
            <div class="space-y-3 rounded-lg border border-border p-3">
              <ResourcesSelector catalog={catalog.data} draft={props.choice.resources} disabled={props.disabled} />
              <WarmPoolPicker
                value={props.choice.warmPoolSize()}
                max={props.choice.maxWarmPoolSize()}
                onChange={props.choice.setWarmPoolSize}
                disabled={props.disabled}
              />
            </div>
          </Show>
        </section>
      )}
    </Show>
  );
}
