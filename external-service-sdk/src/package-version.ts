import { readFileSync } from 'node:fs';

export const sdkPackageVersion: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
