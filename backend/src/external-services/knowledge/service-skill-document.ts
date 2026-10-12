import { serviceSkillName } from '../../delivery/service-skill-source';
import type { RegisteredService } from '../registry/service-registry';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const YAML_NEEDS_QUOTES = /:\s|\s#|^[\s'"[\]{}>|*&!%@`,?-]/;

function yamlScalar(text: string): string {
  return YAML_NEEDS_QUOTES.test(text) ? JSON.stringify(text) : text;
}

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${yamlScalar(description)}\n---\n`;
}

function minimalBody(service: RegisteredService): string {
  const { displayName, description } = service.manifest;
  return `${frontmatter(serviceSkillName(service.slug), `${displayName} — ${description}`)}\n# ${displayName}\n\n${description}\n`;
}

function namedAuthored(authored: string, service: RegisteredService): string {
  const name = serviceSkillName(service.slug);
  const normalized = authored.replace(/\r\n/g, '\n');
  const match = FRONTMATTER.exec(normalized);
  if (!match) {
    const { displayName, description } = service.manifest;
    return `${frontmatter(name, `${displayName} — ${description}`)}\n${normalized}`;
  }
  const lines = match[1].split('\n').filter((line) => !line.startsWith('name:'));
  return `---\nname: ${name}\n${lines.join('\n')}\n---\n${normalized.slice(match[0].length)}`;
}

function callingSection(slug: string): string {
  return [
    '## Calling it',
    '',
    `Call \`${slug}\` the way the \`platform\` skill's External Services section describes:`,
    '',
    `- \`GET $EXTERNAL_SERVICES_URL/${slug}\` — which Operations are on in this environment, and its Project configuration`,
    `- \`GET $EXTERNAL_SERVICES_URL/${slug}/openapi.json\` — every Operation with its input`,
    `- \`POST $EXTERNAL_SERVICES_URL/${slug}/<operation>\` — call one`,
    `- \`GET $EXTERNAL_SERVICES_URL/${slug}/calls?limit=50\` — this environment's recent Calls, to find out why one failed`,
  ].join('\n');
}

export function serviceSkillDocument(service: RegisteredService): string {
  const body = service.serviceSkill ? namedAuthored(service.serviceSkill, service) : minimalBody(service);
  return `${body.trimEnd()}\n\n${callingSection(service.slug)}\n`;
}
