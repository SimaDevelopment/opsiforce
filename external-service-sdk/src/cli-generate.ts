import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { writeServiceFromOpenApi } from './openapi-folder.ts';

async function readDocument(source: string): Promise<unknown> {
  const text = /^https?:\/\//.test(source)
    ? await fetch(source).then(async (response) => {
        if (!response.ok) throw new Error(`${source} answered ${response.status}`);
        return response.text();
      })
    : await readFile(resolve(source), 'utf8');
  return JSON.parse(text);
}

export async function generate(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'from-openapi': { type: 'string' }, 'built-in': { type: 'boolean', default: false } },
  });
  const source = values['from-openapi'];
  if (source === undefined) {
    process.stderr.write('generate needs --from-openapi <file or URL>\n');
    return 2;
  }

  const result = await writeServiceFromOpenApi(resolve(positionals[0] ?? '.'), await readDocument(source), {
    origin: values['built-in'] ? 'built_in' : 'custom',
  });
  if (!result.ok) {
    process.stdout.write(result.output);
    return 1;
  }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  return 0;
}
