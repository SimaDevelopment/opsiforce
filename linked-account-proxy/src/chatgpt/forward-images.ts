import type { ServerResponse } from 'node:http';
import type { CallerAccess } from '../credentials.ts';
import { isRecord, sendJson } from '../http.ts';
import { generatedImageOf, imageToolRequestOf, imagesResponseOf } from '../images.ts';
import type { GeneratedImage, ImagesRequest } from '../images.ts';
import { answerFailedOpening, openCodexStream } from './codex.ts';
import type { FailedOpening } from './codex.ts';
import { IMAGE_DRIVER_MODEL } from './config.ts';
import { FAILURE_EVENT_TYPES, codexEventsOf, failureOf } from './sse.ts';

type ImagesOutcome = { kind: 'images'; images: GeneratedImage[] } | { kind: 'failed'; opening: FailedOpening };

const NO_IMAGE: FailedOpening = {
  kind: 'failure',
  status: 502,
  error: { message: 'ChatGPT answered without an image.', type: 'empty_upstream_response' },
};

async function collectGeneratedImages(stream: ReadableStream<Uint8Array>): Promise<ImagesOutcome> {
  const images: GeneratedImage[] = [];
  for await (const event of codexEventsOf(stream)) {
    if (FAILURE_EVENT_TYPES.has(event.type))
      return { kind: 'failed', opening: { kind: 'failure', ...failureOf(event) } };
    if (event.type === 'response.output_item.done') {
      const image = generatedImageOf(event.item);
      if (image) images.push(image);
    }
    if (event.type === 'response.completed' && images.length === 0 && isRecord(event.response)) {
      const output = Array.isArray(event.response.output) ? event.response.output : [];
      images.push(...output.map(generatedImageOf).filter((image) => image !== null));
    }
  }
  return images.length > 0 ? { kind: 'images', images } : { kind: 'failed', opening: NO_IMAGE };
}

async function generateImages(access: CallerAccess, request: ImagesRequest): Promise<ImagesOutcome> {
  const opening = await openCodexStream(access, imageToolRequestOf(request, IMAGE_DRIVER_MODEL));
  if (opening.kind !== 'output') return { kind: 'failed', opening };
  return collectGeneratedImages(opening.stream);
}

export async function forwardImagesToChatGpt(
  request: ImagesRequest,
  res: ServerResponse,
  access: CallerAccess
): Promise<void> {
  const outcomes = await Promise.all(Array.from({ length: request.count }, () => generateImages(access, request)));
  const failed = outcomes.find((outcome) => outcome.kind === 'failed');
  if (failed) {
    answerFailedOpening(res, failed.opening);
    return;
  }
  sendJson(
    res,
    200,
    imagesResponseOf(outcomes.flatMap((outcome) => (outcome.kind === 'images' ? outcome.images : [])))
  );
}
