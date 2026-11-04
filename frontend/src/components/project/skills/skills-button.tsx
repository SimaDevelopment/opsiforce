import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { Link } from '@tanstack/solid-router';
import { Pager, createOffsetPages } from '~/components/pager';
import { usePermissions } from '~/api/permissions';
import type { ProjectEnvironmentRef } from '~/api/project-external-services';
import { isOn, useProjectSkills, useSwitchSkill, type EnvironmentSkill } from '~/api/project-skills';
import { STRIP_BUTTON_CLASS, STRIP_COUNT_CLASS } from '~/components/composer-strip';
import { FOCUS_RING, OriginBadge, PackageBadge, ServiceBadge } from '~/components/store/store-list';
import { DEFAULT_SKILL_FILE } from '~/pages/store/skill-page';
import { AlertTriangle, ChevronDown, Files, LoaderCircle } from '~/components/icons';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { Switch, SwitchControl, SwitchThumb } from '~/components/ui/switch';
import { InfoTip } from '~/components/ui/info-tip';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn } from '~/lib/cn';

const NOT_CARRIED_WARNING =
  'The Agent no longer carries this Skill: once switched off, it can’t be switched back on here.';

function nameClass(skill: EnvironmentSkill): string {
  return cn('truncate font-mono text-xs', skill.state === 'switched-off' && 'text-muted-foreground line-through');
}

function switchBlockedReason(skill: EnvironmentSkill): string {
  if (skill.kind === 'platform') return 'Always on: every agent needs the platform skill.';
  return skill.kind === 'service' ? 'Needs “Configure project External Services”.' : 'Needs “Manage project Skills”.';
}

function StateLine(props: { skill: EnvironmentSkill }) {
  return (
    <Show when={props.skill.state !== 'on' && props.skill.state !== 'always-on'}>
      <span
        class={cn(
          'inline-flex items-center gap-1 text-[0.625rem]',
          props.skill.state === 'retrying' ? 'of-ink of-tone-needs-you' : 'text-muted-foreground'
        )}
      >
        <Show when={props.skill.state === 'switching-on'}>
          <LoaderCircle class="h-2.5 w-2.5 animate-spin" aria-hidden="true" /> switching on…
        </Show>
        <Show when={props.skill.state === 'retrying'}>
          <AlertTriangle class="h-2.5 w-2.5" aria-hidden="true" /> couldn’t be delivered — retrying
        </Show>
        <Show when={props.skill.state === 'switched-off'}>switched off</Show>
      </span>
    </Show>
  );
}

export function SkillsButton(props: { projectId: string; projectEnvironmentId: string }) {
  const { hasPermission } = usePermissions();
  const environment = (): ProjectEnvironmentRef => ({
    projectId: props.projectId,
    projectEnvironmentId: props.projectEnvironmentId,
  });
  const list = useProjectSkills(environment);
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
  const confirmationText = () => (confirming() ? NOT_CARRIED_WARNING : undefined);

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
        <PopoverTrigger class={STRIP_BUTTON_CLASS} aria-label={`Skills, ${onCount()} of ${skills().length} on`}>
          <Files class="h-3.5 w-3.5" aria-hidden="true" />
          <span>Skills</span>
          <span class={STRIP_COUNT_CLASS}>
            {onCount()}/{skills().length}
          </span>
          <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent class="w-[26rem]" onOpenAutoFocus={(event) => event.preventDefault()}>
          <div class="max-h-[50vh] overflow-y-auto">
            <For each={skillPages.page()}>
              {(skill) => (
                <div class="flex items-center gap-2.5 px-3 py-2">
                  <Files class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <Show when={skill.skillId} fallback={<span class={nameClass(skill)}>{skill.name}</span>}>
                        {(skillId) => (
                          <Link
                            to="/store/skills/$id"
                            params={{ id: skillId() }}
                            search={{ file: DEFAULT_SKILL_FILE }}
                            class={cn(nameClass(skill), 'rounded hover:underline', FOCUS_RING)}
                            onClick={() => setPopoverOpen(false)}
                          >
                            {skill.name}
                          </Link>
                        )}
                      </Show>
                      <Show when={skill.description}>
                        {(description) => <InfoTip label={`About ${skill.name}`}>{description()}</InfoTip>}
                      </Show>
                      <Show when={skill.kind === 'package' || skill.kind === 'platform'}>
                        <PackageBadge />
                      </Show>
                      <Show when={skill.kind !== 'package' && skill.kind !== 'platform' && skill.origin}>
                        {(origin) => <OriginBadge origin={origin()} />}
                      </Show>
                      <Show when={skill.kind === 'service'}>
                        <ServiceBadge available />
                      </Show>
                    </div>
                    <StateLine skill={skill} />
                  </div>
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
                      <TooltipContent>{switchBlockedReason(skill)}</TooltipContent>
                    </Show>
                  </Tooltip>
                </div>
              )}
            </For>
          </div>
          <Show when={skillPages.needsPager()}>
            <Pager {...skillPages.pagerProps()} />
          </Show>
          <Show when={switchSkill.error}>
            {(error) => (
              <p class="border-t border-border px-3 py-2 text-[0.6875rem] text-destructive">{error().message}</p>
            )}
          </Show>
          <p class="border-t border-border px-3 py-2 text-[0.625rem] leading-relaxed text-muted-foreground">
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
