import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';

const AVAILABILITY_STALE_MS = 5 * 60 * 1000;

export const transcriptionAvailabilityKey = ['transcription-availability'] as const;

export interface TranscriptionAvailability {
  available: boolean;
  languages: string[];
}

export function useTranscriptionAvailability() {
  return createAppQuery(() => ({
    queryKey: transcriptionAvailabilityKey,
    queryFn: () => api.get<TranscriptionAvailability>('/transcription/availability'),
    staleTime: AVAILABILITY_STALE_MS,
  }));
}
