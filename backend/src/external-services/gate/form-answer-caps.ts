import { maxOptionsPerCall } from '@opsiforce/external-service-sdk/server';

export const FORM_IMAGE_LIMIT = 1024 * 1024;

function startsWith(bytes: Buffer, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

const imageSignatures: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  'image/gif': (bytes) => startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a')),
  'image/webp': (bytes) => startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8),
};

interface ImageAnswer {
  image: { mimeType: string; base64: string };
}

function isImageAnswer(answer: unknown): answer is ImageAnswer {
  return typeof answer === 'object' && answer !== null && 'image' in answer;
}

function reencodedImage(answer: ImageAnswer): ImageAnswer | null {
  const mimeType = answer.image.mimeType.toLowerCase();
  const bytes = Buffer.from(answer.image.base64, 'base64');
  const matches = imageSignatures[mimeType];
  if (!matches || bytes.byteLength > FORM_IMAGE_LIMIT || !matches(bytes)) return null;
  return { ...answer, image: { mimeType, base64: bytes.toString('base64') } };
}

export function cappedFormAnswer(route: 'options' | 'info' | 'buttons', answer: unknown): unknown {
  if (route === 'options') return (answer as unknown[]).slice(0, maxOptionsPerCall);
  if (route === 'buttons' && isImageAnswer(answer)) return reencodedImage(answer);
  return answer;
}
