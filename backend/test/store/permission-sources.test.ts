import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Perms } from '../../src/permission/permission.constants';

const STORE_PERMISSIONS = ['can_manage_skills', 'can_manage_agents'] as const;

const pulumiPermissions = readFileSync(
  resolve(__dirname, '../../../../infra/pulumi/keycloak-configurator/opsiforce/permissions.ts'),
  'utf8'
);
const helmValues = readFileSync(resolve(__dirname, '../../../helm/opsiforce-proxy/values.yaml'), 'utf8');
const frontendPermissions = readFileSync(resolve(__dirname, '../../../frontend/src/constants/permissions.ts'), 'utf8');

function listBetween(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  const end = source.indexOf('];', start);
  return [...source.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

describe('the two store permissions', () => {
  it.each(STORE_PERMISSIONS)('%s is a backend permission constant', (permission) => {
    expect(Object.values(Perms)).toContain(permission);
  });

  it.each(STORE_PERMISSIONS)('%s is a frontend permission constant', (permission) => {
    expect(frontendPermissions).toContain(`'${permission}'`);
  });

  it.each(STORE_PERMISSIONS)('%s is in the Pulumi permission list', (permission) => {
    expect(listBetween(pulumiPermissions, 'OPSIFORCE_ALL_PERMISSIONS')).toContain(`opsiforce_${permission}`);
  });

  it.each(STORE_PERMISSIONS)('%s is in the Pulumi admin bundle', (permission) => {
    expect(listBetween(pulumiPermissions, 'OPSIFORCE_ADMIN_GROUP_PERMISSIONS')).toContain(`opsiforce_${permission}`);
  });

  it.each(STORE_PERMISSIONS)('%s is in the Helm static-auth list', (permission) => {
    const entries = [...helmValues.matchAll(/^ {6}- (can_[a-z_]+)$/gm)].map((match) => match[1]);
    expect(entries).toContain(permission);
  });
});
