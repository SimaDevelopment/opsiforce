import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { NotFoundException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { skills } from '../../db/schema';
import {
  assertSkillVisibleToUser,
  canEditSkill,
  visibleSkillsWhere,
  type SkillRow,
} from '../../src/store/skill-visibility';
import { createTenantRow, createUserRow } from '../support/org-fixtures';

let tenantA: string;
let tenantB: string;
let author: string;
let colleague: string;

let builtIn: string;
let ownPrivate: string;
let otherPrivate: string;
let tenantPublic: string;
let foreignPublic: string;
let archived: string;

beforeAll(async () => {
  tenantA = await createTenantRow();
  tenantB = await createTenantRow();
  author = await createUserRow();
  colleague = await createUserRow();

  builtIn = await createSkill({ name: `built-in-${randomUUID()}`, origin: 'built_in', visibility: 'public' });
  ownPrivate = await createSkill({ tenantId: tenantA, createdBy: author, visibility: 'private' });
  otherPrivate = await createSkill({ tenantId: tenantA, createdBy: colleague, visibility: 'private' });
  tenantPublic = await createSkill({ tenantId: tenantA, createdBy: colleague, visibility: 'public' });
  foreignPublic = await createSkill({ tenantId: tenantB, createdBy: author, visibility: 'public' });
  archived = await createSkill({ tenantId: tenantA, createdBy: author, visibility: 'public', archived: true });
});

async function createSkill(overrides: Partial<typeof skills.$inferInsert>): Promise<string> {
  const id = randomUUID();
  await db.insert(skills).values({
    id,
    name: overrides.name ?? `skill-${id}`,
    origin: overrides.origin ?? 'custom',
    ...overrides,
  });
  return id;
}

async function visibleIds(tenantId: string, userId: string, includeArchived = false): Promise<string[]> {
  const rows = await db
    .select({ id: skills.id })
    .from(skills)
    .where(visibleSkillsWhere(tenantId, userId, { includeArchived }));
  return rows.map((row) => row.id);
}

async function skillRow(id: string): Promise<SkillRow> {
  const [row] = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
  return row;
}

describe('visibleSkillsWhere', () => {
  it('shows a private row to its creator only', async () => {
    expect(await visibleIds(tenantA, author)).toContain(ownPrivate);
    expect(await visibleIds(tenantA, colleague)).not.toContain(ownPrivate);
  });

  it('shows a public row to every member of its Organization', async () => {
    expect(await visibleIds(tenantA, author)).toContain(tenantPublic);
    expect(await visibleIds(tenantA, colleague)).toContain(tenantPublic);
  });

  it('shows a built-in row to members of any Organization', async () => {
    expect(await visibleIds(tenantA, author)).toContain(builtIn);
    expect(await visibleIds(tenantB, colleague)).toContain(builtIn);
  });

  it('hides an archived row unless includeArchived is set', async () => {
    expect(await visibleIds(tenantA, author)).not.toContain(archived);
    expect(await visibleIds(tenantA, author, true)).toContain(archived);
  });

  it('hides a public row belonging to another Organization', async () => {
    expect(await visibleIds(tenantA, author)).not.toContain(foreignPublic);
  });
});

describe('assertSkillVisibleToUser', () => {
  it('returns the row a member may see', async () => {
    await expect(assertSkillVisibleToUser(tenantA, colleague, tenantPublic)).resolves.toMatchObject({
      id: tenantPublic,
    });
  });

  it('throws NotFound, never Forbidden, for a row the member may not see', async () => {
    await expect(assertSkillVisibleToUser(tenantA, author, otherPrivate)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('canEditSkill', () => {
  it('refuses a built-in row', async () => {
    expect(canEditSkill(await skillRow(builtIn), author)).toBe(false);
  });

  it('allows the creator of a private row and no one else', async () => {
    const row = await skillRow(ownPrivate);
    expect(canEditSkill(row, author)).toBe(true);
    expect(canEditSkill(row, colleague)).toBe(false);
  });

  it('allows any holder once the row is public', async () => {
    const row = await skillRow(tenantPublic);
    expect(canEditSkill(row, author)).toBe(true);
    expect(canEditSkill(row, colleague)).toBe(true);
  });
});

describe('the archived flag', () => {
  it('leaves the row readable through the assert helper', async () => {
    const rows = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.id, archived), visibleSkillsWhere(tenantA, author, { includeArchived: true })));
    expect(rows).toHaveLength(1);
  });
});
