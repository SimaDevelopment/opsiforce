import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { event, respondWithEventStream, startLinkedAccountProxy } from './harness.ts';
import type { RunningProxy } from './harness.ts';

const CREATED = { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } };

const IMAGE_CALL = {
  type: 'image_generation_call',
  id: 'ig_1',
  status: 'completed',
  result: 'iVBORw0KGgo=',
  revised_prompt: 'A small red circle',
  size: '1024x1024',
  quality: 'low',
  background: 'opaque',
  output_format: 'png',
};

const IMAGE_STREAM = [
  event(CREATED),
  event({ type: 'response.output_item.done', output_index: 0, item: IMAGE_CALL }),
  event({ type: 'response.completed', response: { ...CREATED.response, status: 'completed', output: [IMAGE_CALL] } }),
];

let proxy: RunningProxy;

beforeAll(async () => {
  proxy = await startLinkedAccountProxy({ maxBodyBytes: 64 * 1024 });
});

afterAll(async () => {
  await proxy.stop();
});

beforeEach(() => {
  proxy.upstream.requests.length = 0;
  proxy.upstream.respondWith(respondWithEventStream(IMAGE_STREAM));
});

const generate = (body: Record<string, unknown>) =>
  proxy.postLikeBifrost('/v1/images/generations', JSON.stringify(body));

describe('image generations', () => {
  it('asks ChatGPT for one forced image_generation tool call with the caller model and options', async () => {
    await (
      await generate({ model: 'gpt-image-2', prompt: 'A small red circle', size: '1024x1024', quality: 'low' })
    ).text();

    const body = proxy.upstream.requests[0]?.body;
    expect(body).toMatchObject({
      store: false,
      stream: true,
      tool_choice: { type: 'image_generation' },
      tools: [
        { type: 'image_generation', action: 'generate', model: 'gpt-image-2', size: '1024x1024', quality: 'low' },
      ],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'A small red circle' }] }],
    });
    expect(typeof body?.model).toBe('string');
    expect(body?.model).not.toBe('gpt-image-2');
  });

  it('answers in the Images API shape with each image as base64', async () => {
    const res = await generate({ model: 'gpt-image-2', prompt: 'A small red circle' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      created: expect.any(Number),
      data: [{ b64_json: 'iVBORw0KGgo=', revised_prompt: 'A small red circle' }],
      size: '1024x1024',
      quality: 'low',
      background: 'opaque',
      output_format: 'png',
    });
  });

  it('takes the image from the completed response when no item event carried it', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([
        event(CREATED),
        event({
          type: 'response.completed',
          response: { ...CREATED.response, status: 'completed', output: [IMAGE_CALL] },
        }),
      ])
    );
    const res = await generate({ model: 'gpt-image-2', prompt: 'A small red circle' });

    expect(await res.json()).toMatchObject({
      data: [{ b64_json: 'iVBORw0KGgo=', revised_prompt: 'A small red circle' }],
    });
  });

  it('answers 502 when ChatGPT completes without an image', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([
        event(CREATED),
        event({ type: 'response.output_text.delta', delta: 'I cannot draw that.' }),
        event({
          type: 'response.completed',
          response: { ...CREATED.response, status: 'completed', output: [], usage: {} },
        }),
      ])
    );
    const res = await generate({ model: 'gpt-image-2', prompt: 'A small red circle' });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { type: 'empty_upstream_response' } });
  });

  it('answers a usage limit before any output with 429, so the gateway can fail over', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([
        event(CREATED),
        event({
          type: 'response.failed',
          response: { error: { message: 'You have hit your usage limit.', code: 'usage_limit_reached' } },
        }),
      ])
    );

    expect((await generate({ model: 'gpt-image-2', prompt: 'A small red circle' })).status).toBe(429);
  });

  it('makes one ChatGPT call per requested image, since the tool draws one image a call', async () => {
    const res = await generate({ model: 'gpt-image-2', prompt: 'A small red circle', n: 3 });

    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(3);
    expect(proxy.upstream.requests).toHaveLength(3);
    for (const request of proxy.upstream.requests) {
      expect(request.body.tools).toEqual([expect.not.objectContaining({ n: expect.anything() })]);
    }
  });

  it('refuses an n outside 1 to 10, without calling ChatGPT', async () => {
    const tooMany = await generate({ model: 'gpt-image-2', prompt: 'A small red circle', n: 11 });
    const fractional = await generate({ model: 'gpt-image-2', prompt: 'A small red circle', n: 1.5 });

    expect(tooMany.status).toBe(400);
    expect(fractional.status).toBe(400);
    expect(proxy.upstream.requests).toHaveLength(0);
  });

  it('refuses a request without a prompt or model, without calling ChatGPT', async () => {
    const noPrompt = await generate({ model: 'gpt-image-2' });
    const noModel = await generate({ prompt: 'A small red circle' });

    expect(noPrompt.status).toBe(400);
    expect(noModel.status).toBe(400);
    expect(proxy.upstream.requests).toHaveLength(0);
  });
});

describe('image edits', () => {
  it('sends the uploaded images and mask as data URLs with an edit action', async () => {
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('prompt', 'Add a red scarf');
    form.append('image[]', new Blob([Buffer.from('first')], { type: 'image/png' }), 'first.png');
    form.append('image[]', new Blob([Buffer.from('second')], { type: 'image/jpeg' }), 'second.jpg');
    form.append('mask', new Blob([Buffer.from('mask')], { type: 'image/png' }), 'mask.png');
    form.append('n', '2');
    const res = await proxy.postLikeBifrost('/v1/images/edits', form);

    expect(res.status).toBe(200);
    expect(proxy.upstream.requests).toHaveLength(2);
    expect(proxy.upstream.requests[0]?.body).toMatchObject({
      tools: [
        {
          type: 'image_generation',
          action: 'edit',
          model: 'gpt-image-2',
          input_image_mask: { image_url: `data:image/png;base64,${Buffer.from('mask').toString('base64')}` },
        },
      ],
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Add a red scarf' },
            { type: 'input_image', image_url: `data:image/png;base64,${Buffer.from('first').toString('base64')}` },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${Buffer.from('second').toString('base64')}` },
          ],
        },
      ],
    });
  });

  it('refuses an edit without an image, without calling ChatGPT', async () => {
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('prompt', 'Add a red scarf');
    const res = await proxy.postLikeBifrost('/v1/images/edits', form);

    expect(res.status).toBe(400);
    expect(proxy.upstream.requests).toHaveLength(0);
  });
});
