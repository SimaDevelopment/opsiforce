import { createSignal } from 'solid-js';
import type { PodSettings, UpdatePodClassDto } from '~/api/client';
import { coresToMillicores, gibToMib, mibToGib, millicoresToCores, trimNumber } from '~/lib/pod-resources';

export const INHERIT = 'inherit';
export const CUSTOM = 'custom';

export type ResourcesDraft = ReturnType<typeof createResourcesDraft>;

/** The picked option: a preset id, Custom, or the inherited choice where one is offered. */
export function createResourcesDraft() {
  const [selected, setSelected] = createSignal<string>(CUSTOM);
  const [cpuCores, setCpuCores] = createSignal('');
  const [memRequestGib, setMemRequestGib] = createSignal('');
  const [memLimitGib, setMemLimitGib] = createSignal('');
  const [dirty, setDirty] = createSignal(false);

  const edited =
    <T>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setDirty(true);
    };

  return {
    selected,
    cpuCores,
    memRequestGib,
    memLimitGib,
    dirty,
    select: edited(setSelected),
    setCpuCores: edited(setCpuCores),
    setMemRequestGib: edited(setMemRequestGib),
    setMemLimitGib: edited(setMemLimitGib),
    inherits: () => selected() === INHERIT,
    limitError: () => selected() === CUSTOM && (parseFloat(memLimitGib()) || 0) < (parseFloat(memRequestGib()) || 0),
    reset(saved: PodSettings, inherits = false) {
      setSelected(inherits ? INHERIT : (saved.presetId ?? CUSTOM));
      setCpuCores(trimNumber(millicoresToCores(saved.cpuMillicores)));
      setMemRequestGib(trimNumber(mibToGib(saved.memoryRequestMib)));
      setMemLimitGib(trimNumber(mibToGib(saved.memoryLimitMib)));
      setDirty(false);
    },
    toDto(): UpdatePodClassDto {
      if (selected() !== CUSTOM) return { presetId: selected() };
      return {
        presetId: null,
        cpuMillicores: coresToMillicores(parseFloat(cpuCores()) || 0),
        memoryRequestMib: gibToMib(parseFloat(memRequestGib()) || 0),
        memoryLimitMib: gibToMib(parseFloat(memLimitGib()) || 0),
      };
    },
  };
}
