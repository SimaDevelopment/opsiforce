import { createAppQuery } from '~/lib/create-app-query';
import { podClassApi } from './client';

export function usePodClassCatalog(enabled: () => boolean = () => true) {
  return createAppQuery(() => ({
    queryKey: ['pod-classes'],
    queryFn: () => podClassApi.catalog(),
    enabled: enabled(),
  }));
}
