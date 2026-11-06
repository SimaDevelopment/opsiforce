import { BadRequestException } from '@nestjs/common';
import { InvalidPodClassSelection, type PodClassSelection, type PodSettings } from './pod-classes';
import { podSettingsForSelection, type PresetCatalog } from './resource-presets';

export function podSettingsFromRequest(selection: unknown, catalog: PresetCatalog): PodSettings {
  if (typeof selection !== 'object' || selection === null || !('presetId' in selection)) {
    throw invalidPodClass('A presetId is required, or null for Custom');
  }
  const presetId = (selection as { presetId: unknown }).presetId;
  if (presetId !== null && typeof presetId !== 'string') throw invalidPodClass('presetId must be a string or null');
  try {
    return podSettingsForSelection(selection as PodClassSelection, catalog);
  } catch (error) {
    if (error instanceof InvalidPodClassSelection) throw invalidPodClass(error.message);
    throw error;
  }
}

function invalidPodClass(message: string): BadRequestException {
  return new BadRequestException({ code: 'bad_request', message });
}
