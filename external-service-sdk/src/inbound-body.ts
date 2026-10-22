import { DecodedBodyTooLarge, decodedBytes } from './upstream-forwarding.ts';

export class BodyTooLarge extends Error {
  constructor(limit: number) {
    super(`the request body is over ${limit} bytes`);
    this.name = 'BodyTooLarge';
  }
}

export class InboundBody {
  readonly #source: ReadableStream<Uint8Array> | null;
  readonly #limit: number;
  #buffered: Promise<Uint8Array> | undefined;
  tooLarge = false;

  constructor(source: ReadableStream<Uint8Array> | null, limit: number) {
    this.#source = source;
    this.#limit = limit;
  }

  get present(): boolean {
    return this.#source !== null;
  }

  get read(): boolean {
    return this.#buffered !== undefined;
  }

  raw(): Promise<Uint8Array> {
    this.#buffered ??= this.#collect();
    return this.#buffered;
  }

  async #collect(): Promise<Uint8Array> {
    if (this.#source === null) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = this.#source.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.#limit) {
        this.tooLarge = true;
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge(this.#limit);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async decoded(headers: Headers): Promise<Uint8Array> {
    try {
      return decodedBytes(await this.raw(), headers, this.#limit);
    } catch (error) {
      if (error instanceof DecodedBodyTooLarge) {
        this.tooLarge = true;
        throw new BodyTooLarge(this.#limit);
      }
      throw error;
    }
  }

  readerStream(headers: Headers): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            controller.enqueue(await this.decoded(headers));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      },
      { highWaterMark: 0 }
    );
  }

  async forwardable(): Promise<ReadableStream<Uint8Array> | Uint8Array | null> {
    if (this.#buffered !== undefined) return this.#buffered;
    return this.#source;
  }
}
