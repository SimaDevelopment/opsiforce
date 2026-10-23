import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Pager, createOffsetPages } from '~/components/pager';
import { usePermissions } from '~/api/permissions';
import { useProjectExternalServices, type ProjectEnvironmentRef } from '~/api/project-external-services';
import { isOn, useProjectSkills, useSwitchSkill, type EnvironmentSkill } from '~/api/project-skills';
import { STRIP_BUTTON_CLASS, STRIP_COUNT_CLASS } from '~/components/composer-strip';
import { ServiceIcon } from '~/components/external-service/service-marks';
import { AlertTriangle, ChevronDown, Files, LoaderCircle, Lock, Package } from '~/components/icons';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { Switch, SwitchControl, SwitchThumb } from '~/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn } from '~/lib/cn';

const NOT_CARRIED_WARNING =
  'The Agent no longer carries this Skill: once switched off, it can’t be switched back on here.';

function StateLine(props: { skill: EnvironmentSkill }) {
  return (
    <Show when={props.skill.state !== 'on'}>
      <span
        class={cn(
          'inline-flex items-center gap-1 text-[10px]',
          props.skill.state === 'retrying' ? 'text-amber-700' : 'text-muted-foreground'
        )}
      >
        <Show when={props.skill.state === 'switching-on'}>
          <LoaderCircle class="h-2.5 w-2.5 animate-spin" aria-hidden="true" /> switching on…
        </Show>
        <Show when={props.skill.state === 'retrying'}>
          <AlertTriangle class="h-2.5 w-2.5" aria-hidden="true" /> couldn’t be delivered — retrying
        </Show>
        <Show when={props.skill.state === 'switched-off'}>switched off</Show>
        <Show when={props.skill.state === 'always-on'}>always on</Show>
      </span>
    </Show>
  );
}

export function SkillsButton(props: { projectId: string; projectEnvironmentId: string; environmentName: string }) {
  const { hasPermission } = usePermissions();
  const environment = (): ProjectEnvironmentRef => ({
    projectId: props.projectId,
    projectEnvironmentId: props.projectEnvironmentId,
  });
  const list = useProjectSkills(environment);
  const services = useProjectExternalServices(environment);
  const switchSkill = useSwitchSkill(environment);
  const [popoverOpen, setPopoverOpen] = createSignal(false);
  const [confirming, setConfirming] = createSignal<EnvironmentSkill | null>(null);
  const skills = () => list.data?.skills ?? [];
  const skillPages = createOffsetPages(skills);
  const onCount = () => skills().filter(isOn).length;

  const canSwitch = (skill: EnvironmentSkill) =>
    skill.kind === 'platform'
      ? false
      : hasPermission(
          skill.kind === 'service' ? 'can_configure_project_external_services' : 'can_manage_project_skills'
        );
  const serviceOf = (slug: string | null) => services.data?.services.find((service) => service.slug === slug);
  const confirmationText = () => (confirming() ? NOT_CARRIED_WARNING : undefined);
  const packageLabel = () => `from ${list.data?.agentName ?? 'the Agent'}`;

  const flip = (skill: EnvironmentSkill, switchedOn: boolean) => {
    if (!switchedOn && !skill.carried) {
      setConfirming(skill);
      return;
    }
    switchSkill.mutate({ name: skill.name, on: switchedOn });
  };

  createEffect(
    on(
      () => props.projectEnvironmentId,
      () => {
        setPopoverOpen(false);
        setConfirming(null);
        switchSkill.reset();
      },
      { defer: true }
    )
  );

  return (
    <Show when={skills().length > 0}>
      <Popover placement="top-start" open={popoverOpen()} onOpenChange={setPopoverOpen}>
        <PopoverTrigger
          class={STRIP_BUTTON_CLASS}
          aria-label={`Skills, ${onCount()} of ${skills().length} on`}
          title={`${onCount()} of ${skills().length} Skills on`}
        >
          <Files class="h-3.5 w-3.5" aria-hidden="true" />
          <span>Skills</span>
          <span class={STRIP_COUNT_CLASS}>
            {onCount()}/{skills().length}
          </span>
          <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent class="w-96">
          <div class="border-b border-border px-3 py-2 text-[11px] font-medium text-muted-foreground">
            Skills for {props.environmentName}
          </div>
          <div class="max-h-[50vh] overflow-y-auto">
            <For each={skillPages.page()}>
              {(skill) => (
                <div class="flex items-center gap-2.5 px-3 py-2" title={skill.description ?? undefined}>
                  <Show
                    when={skill.kind === 'service' && serviceOf(skill.service)}
                    fallback={
                      <Dynamic
                        component={skill.kind === 'package' ? Package : skill.kind === 'platform' ? Lock : Files}
                        class="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    }
                  >
                    {(service) => (
                      <ServiceIcon icon={service().icon} name={service().displayName} class="h-3.5 w-3.5 shrink-0" />
                    )}
                  </Show>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5">
                      <span
                        class={cn(
                          'truncate font-mono text-xs',
                          skill.state === 'switched-off' && 'text-muted-foreground line-through'
                        )}
                      >
                        {skill.name}
                      </span>
                      <Show when={skill.kind === 'service' && serviceOf(skill.service)}>
                        {(service) => (
                          <span class="inline-flex shrink-0 items-center rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
                            {service().origin === 'built_in' ? 'Built-in' : 'Custom'}
                          </span>
                        )}
                      </Show>
                      <Show when={skill.kind === 'package'}>
                        <span class="shrink-0 text-[10px] text-muted-foreground">{packageLabel()}</span>
                      </Show>
                    </div>
                    <StateLine skill={skill} />
                  </div>
                  <Show
                    when={skill.kind !== 'platform'}
                    fallback={<Lock class="h-3.5 w-3.5 text-muted-foreground/60" aria-label="Always on" />}
                  >
                    <Tooltip>
                      <TooltipTrigger as="span">
                        <Switch
                          checked={isOn(skill)}
                          disabled={!canSwitch(skill) || skill.state === 'switching-on' || switchSkill.isPending}
                          onChange={(checked) => flip(skill, checked)}
                          aria-label={`Switch ${skill.name}`}
                        >
                          <SwitchControl>
                            <SwitchThumb />
                          </SwitchControl>
                        </Switch>
                      </TooltipTrigger>
                      <Show when={!canSwitch(skill)}>
                        <TooltipContent>
                          {skill.kind === 'service'
                            ? 'Needs “Configure project External Services”.'
                            : 'Needs “Manage project Skills”.'}
                        </TooltipContent>
                      </Show>
                    </Tooltip>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <Show when={skillPages.needsPager()}>
            <Pager {...skillPages.pagerProps()} />
          </Show>
          <Show when={switchSkill.error}>
            {(error) => <p class="border-t border-border px-3 py-2 text-[11px] text-destructive">{error().message}</p>}
          </Show>
          <p class="border-t border-border px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
            Applies from the next message; instructions already read stay in this conversation.
          </p>
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={confirming() !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Switch off ${confirming()?.name ?? ''}?`}
        description={confirmationText()}
        confirmLabel="Switch off"
        variant="destructive"
        onConfirm={() => {
          const skill = confirming();
          if (skill) switchSkill.mutate({ name: skill.name, on: false });
        }}
      />
    </Show>
  );
}
