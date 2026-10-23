import { createSignal } from 'solid-js';
import type { PodClass, PodSettings, UpdatePodClassDto } from '~/api/client';
import { coresToMillicores, gibToMib, mibToGib, millicoresToCores, trimNumber } from '~/lib/pod-resources';

export type ResourcesDraft = ReturnType<typeof createResourcesDraft>;

export function createResourcesDraft() {
  const [podClass, setPodClass] = createSignal<PodClass>('small');
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
    podClass,
    cpuCores,
    memRequestGib,
    memLimitGib,
    dirty,
    selectClass: edited(setPodClass),
    setCpuCores: edited(setCpuCores),
    setMemRequestGib: edited(setMemRequestGib),
    setMemLimitGib: edited(setMemLimitGib),
    limitError: () => podClass() === 'custom' && (parseFloat(memLimitGib()) || 0) < (parseFloat(memRequestGib()) || 0),
    reset(saved: PodSettings) {
      setPodClass(saved.podClass);
      setCpuCores(trimNumber(millicoresToCores(saved.cpuMillicores)));
      setMemRequestGib(trimNumber(mibToGib(saved.memoryRequestMib)));
      setMemLimitGib(trimNumber(mibToGib(saved.memoryLimitMib)));
      setDirty(false);
    },
    toDto(): UpdatePodClassDto {
      if (podClass() !== 'custom') return { podClass: podClass() };
      return {
        podClass: 'custom',
        cpuMillicores: coresToMillicores(parseFloat(cpuCores()) || 0),
        memoryRequestMib: gibToMib(parseFloat(memRequestGib()) || 0),
        memoryLimitMib: gibToMib(parseFloat(memLimitGib()) || 0),
      };
    },
  };
}
