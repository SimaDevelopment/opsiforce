import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedDoorbell {
  path: string;
  authorization: string | undefined;
  body: { service?: string; eventIds?: number[]; rowIds?: number[] } & Record<string, unknown>;
}

export interface FakeApp {
  port: number;
  received: ReceivedDoorbell[];
  answer(status: number): void;
  answerNext(...statuses: number[]): void;
  close(): Promise<void>;
}

async function bodyOf(request: IncomingMessage): Promise<ReceivedDoorbell['body']> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as ReceivedDoorbell['body']);
}

export async function startFakeApp(): Promise<FakeApp> {
  const received: ReceivedDoorbell[] = [];
  const nextStatuses: number[] = [];
  let status = 200;

  const answer = async (request: IncomingMessage, response: ServerResponse) => {
    const body = await bodyOf(request);
    received.push({ path: request.url ?? '', authorization: request.headers.authorization, body });
    const answered = nextStatuses.shift() ?? status;
    response.writeHead(answered, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answered < 300 ? { ok: true } : { error: `fake app answered ${answered}` }));
  };
  const server = createServer((request, response) => void answer(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    received,
    answer: (next) => {
      status = next;
    },
    answerNext: (...statuses) => {
      nextStatuses.push(...statuses);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
