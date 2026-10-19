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

function serviceHostSection(slug: string): string {
  const serviceHost = `https://${slug}.$EXTERNAL_SERVICES_HOST`;
  return [
    '## Reaching it',
    '',
    `Reach \`${slug}\` at \`${serviceHost}\` the way the \`platform\` skill's External Services section describes.`,
    `Before you plan work with it, read \`${serviceHost}/.well-known/opsiforce\`: its routes and this Project's configuration.`,
  ].join('\n');
}

export function serviceSkillDocument(service: RegisteredService): string {
  const body = service.serviceSkill ? namedAuthored(service.serviceSkill, service) : minimalBody(service);
  return `${body.trimEnd()}\n\n${serviceHostSection(service.slug)}\n`;
}
