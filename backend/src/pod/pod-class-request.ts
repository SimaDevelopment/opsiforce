import { BadRequestException } from '@nestjs/common';
import {
  InvalidPodClassSelection,
  podSettingsForSelection,
  type PodClassSelection,
  type PodSettings,
} from './pod-classes';

export function podSettingsFromRequest(selection: unknown): PodSettings {
  if (typeof selection !== 'object' || selection === null || !('podClass' in selection)) {
    throw invalidPodClass('A podClass is required');
  }
  try {
    return podSettingsForSelection(selection as PodClassSelection);
  } catch (error) {
    if (error instanceof InvalidPodClassSelection) throw invalidPodClass(error.message);
    throw error;
  }
}

function invalidPodClass(message: string): BadRequestException {
  return new BadRequestException({ code: 'bad_request', message });
}
