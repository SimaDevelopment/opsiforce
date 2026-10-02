export const TRANSCRIPTION_PROVIDER = 'openai';
export const TRANSCRIPTION_MODEL = `${TRANSCRIPTION_PROVIDER}/gpt-4o-mini-transcribe`;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 16 * 1024;
export const TRANSCRIPTION_TIMEOUT_MS = 60_000;
export const AVAILABILITY_CACHE_MS = 5 * 60_000;
export const AVAILABILITY_ERROR_CACHE_MS = 30_000;

const AUDIO_EXTENSIONS = new Map([
  ['audio/webm', 'webm'],
  ['audio/mp4', 'mp4'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/ogg', 'ogg'],
  ['audio/flac', 'flac'],
  ['audio/x-flac', 'flac'],
  ['audio/m4a', 'm4a'],
  ['audio/x-m4a', 'm4a'],
]);

export function audioExtensionFor(mimeType: string): string | undefined {
  const baseType = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return AUDIO_EXTENSIONS.get(baseType);
}

export const TRANSCRIPTION_LANGUAGES = [
  'af',
  'ar',
  'az',
  'be',
  'bg',
  'bs',
  'ca',
  'cs',
  'cy',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'fa',
  'fi',
  'fr',
  'gl',
  'he',
  'hi',
  'hr',
  'hu',
  'hy',
  'id',
  'is',
  'it',
  'ja',
  'kk',
  'kn',
  'ko',
  'lt',
  'lv',
  'mi',
  'mk',
  'mr',
  'ms',
  'ne',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'sw',
  'ta',
  'th',
  'tl',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh',
] as const;

export type TranscriptionLanguage = (typeof TRANSCRIPTION_LANGUAGES)[number];

const languageSet: ReadonlySet<string> = new Set(TRANSCRIPTION_LANGUAGES);

export function isTranscriptionLanguage(value: string): value is TranscriptionLanguage {
  return languageSet.has(value);
}
