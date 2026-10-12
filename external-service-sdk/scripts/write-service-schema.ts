import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { serviceManifestJsonSchema } from '@opsiforce/external-service-sdk/platform';

const target = fileURLToPath(import.meta.resolve('@opsiforce/external-service-sdk/service.schema.json'));
writeFileSync(target, JSON.stringify(serviceManifestJsonSchema(), null, 2) + '\n');
process.stdout.write(`wrote ${target}\n`);
