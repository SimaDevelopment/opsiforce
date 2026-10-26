import { isRecord } from './http.ts';
import type { JsonRecord } from './http.ts';

export class UnsupportedImagesRequestError extends Error {}

const TOOL_OPTIONS = ['size', 'quality', 'background', 'output_format', 'output_compression', 'moderation'] as const;

const MAX_IMAGES = 10;

const VERBATIM_PROMPT =
  'Call the image_generation tool with the user prompt exactly as written: no rewording, additions, omissions or translation.';

export interface ImagesRequest {
  action: 'generate' | 'edit';
  prompt: string;
  model: string;
  inputImages: string[];
  mask?: string;
  count: number;
  options: JsonRecord;
}

type FormEntry = ReturnType<FormData['get']>;
type UploadedFile = Exclude<FormEntry, string | null>;

function numberOrString(value: FormEntry): number | string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return /^\d+$/.test(value) ? Number(value) : value;
}

async function dataUrlOf(file: UploadedFile): Promise<string> {
  const type = file.type || 'image/png';
  return `data:${type};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`;
}

function countOf(n: unknown): number {
  if (n === undefined || n === null || n === '') return 1;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_IMAGES) return n;
  throw new UnsupportedImagesRequestError(`n must be a whole number from 1 to ${MAX_IMAGES}.`);
}

function optionsOf(read: (name: (typeof TOOL_OPTIONS)[number]) => unknown): JsonRecord {
  const options: JsonRecord = {};
  for (const name of TOOL_OPTIONS) {
    const value = read(name);
    if (value !== undefined && value !== null && value !== '') options[name] = value;
  }
  return options;
}

export function generationRequestOf(body: JsonRecord): ImagesRequest {
  if (typeof body.prompt !== 'string' || !body.prompt.trim())
    throw new UnsupportedImagesRequestError('prompt is required.');
  if (typeof body.model !== 'string' || !body.model) throw new UnsupportedImagesRequestError('model is required.');
  return {
    action: 'generate',
    prompt: body.prompt,
    model: body.model,
    inputImages: [],
    count: countOf(body.n),
    options: optionsOf((name) => body[name]),
  };
}

export async function editRequestOf(form: FormData): Promise<ImagesRequest> {
  const prompt = form.get('prompt');
  const model = form.get('model');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new UnsupportedImagesRequestError('prompt is required.');
  if (typeof model !== 'string' || !model) throw new UnsupportedImagesRequestError('model is required.');
  const files = [...form.getAll('image'), ...form.getAll('image[]')].filter(
    (entry): entry is UploadedFile => typeof entry !== 'string'
  );
  if (files.length === 0) throw new UnsupportedImagesRequestError('At least one image is required.');
  const mask = form.get('mask');
  return {
    action: 'edit',
    prompt,
    model,
    inputImages: await Promise.all(files.map(dataUrlOf)),
    ...(mask && typeof mask !== 'string' ? { mask: await dataUrlOf(mask) } : {}),
    count: countOf(numberOrString(form.get('n'))),
    options: optionsOf((name) => numberOrString(form.get(name))),
  };
}

export function imageToolRequestOf(request: ImagesRequest, driverModel: string): JsonRecord {
  const tool: JsonRecord = {
    type: 'image_generation',
    action: request.action,
    model: request.model,
    ...request.options,
  };
  if (request.mask) tool.input_image_mask = { image_url: request.mask };
  return {
    model: driverModel,
    instructions: VERBATIM_PROMPT,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: request.prompt },
          ...request.inputImages.map((image) => ({ type: 'input_image', image_url: image })),
        ],
      },
    ],
    tools: [tool],
    tool_choice: { type: 'image_generation' },
    store: false,
    stream: true,
  };
}

export interface GeneratedImage {
  b64_json: string;
  revised_prompt?: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
}

export function generatedImageOf(item: unknown): GeneratedImage | null {
  if (!isRecord(item) || item.type !== 'image_generation_call' || typeof item.result !== 'string' || !item.result)
    return null;
  const image: GeneratedImage = { b64_json: item.result };
  for (const field of ['revised_prompt', 'size', 'quality', 'background', 'output_format'] as const) {
    if (typeof item[field] === 'string') image[field] = item[field];
  }
  return image;
}

export function imagesResponseOf(images: readonly GeneratedImage[]): JsonRecord {
  const first = images[0];
  return {
    created: Math.floor(Date.now() / 1000),
    data: images.map(({ b64_json, revised_prompt }) => ({ b64_json, ...(revised_prompt ? { revised_prompt } : {}) })),
    ...(first?.size ? { size: first.size } : {}),
    ...(first?.quality ? { quality: first.quality } : {}),
    ...(first?.background ? { background: first.background } : {}),
    ...(first?.output_format ? { output_format: first.output_format } : {}),
  };
}
