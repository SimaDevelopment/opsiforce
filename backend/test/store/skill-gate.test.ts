import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  computeFlags,
  hashSkillTree,
  validateSkillTree,
  type GateFinding,
  type SkillTree,
} from '../../src/store/gate';
import {
  manifest,
  readSkillTree,
  skillFile,
  validDescription,
  validTree,
  vendoredSkillNames,
  vendoredSkillsDir,
} from './support/skill-fixtures';

function rules(findings: GateFinding[]): string[] {
  return findings.map((finding) => finding.rule);
}

describe('validateSkillTree on the vendored skills', () => {
  it('passes every shipped skill with zero errors', async () => {
    const names = await vendoredSkillNames();
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const tree = readSkillTree(join(vendoredSkillsDir, name));
      const result = validateSkillTree(tree, { expectedName: name });
      expect({ name, errors: result.errors }).toEqual({ name, errors: [] });
    }
  });

  it('validates the whole shipped set in under a second', async () => {
    const names = await vendoredSkillNames();
    const trees = names.map((name) => [name, readSkillTree(join(vendoredSkillsDir, name))] as const);

    const started = performance.now();
    for (const [name, tree] of trees) validateSkillTree(tree, { expectedName: name });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('validateSkillTree errors', () => {
  it('accepts a minimal well-formed skill', () => {
    const result = validateSkillTree(validTree('example'), { expectedName: 'example' });
    expect(result.errors).toEqual([]);
  });

  it('reports skill_md_missing when the manifest is not at the root', () => {
    const tree = [skillFile('nested/SKILL.md', manifest('name: example\ndescription: x'))];
    expect(rules(validateSkillTree(tree).errors)).toContain('skill_md_missing');
  });

  it('reports frontmatter_missing when SKILL.md has no frontmatter', () => {
    const tree = [skillFile('SKILL.md', '# No frontmatter here\n')];
    expect(rules(validateSkillTree(tree).errors)).toContain('frontmatter_missing');
  });

  it('reports frontmatter_unparsable when the block never closes', () => {
    const tree = [skillFile('SKILL.md', '---\nname: example\n')];
    expect(rules(validateSkillTree(tree).errors)).toContain('frontmatter_unparsable');
  });

  it('reports name_missing', () => {
    const tree = [skillFile('SKILL.md', manifest(`description: ${validDescription}`))];
    expect(rules(validateSkillTree(tree).errors)).toContain('name_missing');
  });

  it('reports name_format for a non-kebab-case name', () => {
    const tree = [skillFile('SKILL.md', manifest(`name: Example_Skill\ndescription: ${validDescription}`))];
    expect(rules(validateSkillTree(tree).errors)).toContain('name_format');
  });

  it('reports name_length over 64 characters', () => {
    const name = 'a'.repeat(65);
    const tree = [skillFile('SKILL.md', manifest(`name: ${name}\ndescription: ${validDescription}`))];
    expect(rules(validateSkillTree(tree).errors)).toContain('name_length');
  });

  it('reports name_mismatch against the expected name', () => {
    const result = validateSkillTree(validTree('example'), { expectedName: 'other' });
    expect(rules(result.errors)).toContain('name_mismatch');
  });

  it('reports name_reserved', () => {
    const result = validateSkillTree(validTree('platform'), { expectedName: 'platform', reservedNames: ['platform'] });
    expect(rules(result.errors)).toContain('name_reserved');
  });

  it('reports description_missing', () => {
    const tree = [skillFile('SKILL.md', manifest('name: example'))];
    expect(rules(validateSkillTree(tree).errors)).toContain('description_missing');
  });

  it('reports description_length over 1024 characters', () => {
    const description = 'word '.repeat(300);
    const tree = [skillFile('SKILL.md', manifest(`name: example\ndescription: ${description}`))];
    expect(rules(validateSkillTree(tree).errors)).toContain('description_length');
  });

  it('reports description_angle_brackets', () => {
    const tree = [skillFile('SKILL.md', manifest(`name: example\ndescription: ${validDescription} </description>`))];
    expect(rules(validateSkillTree(tree).errors)).toContain('description_angle_brackets');
  });

  it('reports frontmatter_unknown_key', () => {
    const tree = [
      skillFile('SKILL.md', manifest(`name: example\ndescription: ${validDescription}\ncompatibility: anything`)),
    ];
    const result = validateSkillTree(tree);
    expect(rules(result.errors)).toContain('frontmatter_unknown_key');
  });

  it('accepts every allowed frontmatter key', () => {
    const tree = [
      skillFile(
        'SKILL.md',
        manifest(
          `name: example\ndescription: ${validDescription}\nlicense: MIT\nmetadata:\n  author: someone\nallowed-tools: Read`
        )
      ),
    ];
    expect(rules(validateSkillTree(tree).errors)).toEqual([]);
  });

  it('reports duplicate_path when one path appears twice', () => {
    const tree = [
      skillFile('SKILL.md', manifest(`name: example\ndescription: ${validDescription}`)),
      skillFile('SKILL.md', manifest(`name: example\ndescription: ${validDescription}`)),
    ];
    expect(rules(validateSkillTree(tree, { expectedName: 'example' }).errors)).toContain('duplicate_path');
  });

  it('reports symlink_entry', () => {
    const tree: SkillTree = [
      ...validTree(),
      { path: 'link.md', content: Buffer.alloc(0), executable: false, symlink: true },
    ];
    expect(rules(validateSkillTree(tree).errors)).toContain('symlink_entry');
  });

  it.each(['../escape.md', '/etc/passwd', 'refs\\windows.md'])('reports path_traversal for %s', (path) => {
    const tree = [...validTree(), skillFile(path, 'x')];
    expect(rules(validateSkillTree(tree).errors)).toContain('path_traversal');
  });

  it.each([
    ['zero-width space', '​'],
    ['right-to-left override', '‮'],
    ['word joiner', '⁠'],
    ['unicode tag character', '\u{E0041}'],
  ])('reports invisible_unicode for a %s', (_label, character) => {
    const tree = [...validTree(), skillFile('references/notes.md', `hidden${character}text`)];
    expect(rules(validateSkillTree(tree).errors)).toContain('invisible_unicode');
  });

  it.each([
    ['aws', `AKIAA1B2C3D4E5F6G7H8`],
    ['github', `ghp_${'a'.repeat(36)}`],
    ['slack', 'xoxb-123456789012-abcdefghij'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ])('reports secret_detected for a %s credential', (_label, secret) => {
    const tree = [...validTree(), skillFile('references/notes.md', `token: ${secret}\n`)];
    expect(rules(validateSkillTree(tree).errors)).toContain('secret_detected');
  });

  it('does not scan binary files for secrets', () => {
    const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`AKIAA1B2C3D4E5F6G7H8`, 'utf8')]);
    const tree = [...validTree(), skillFile('assets/logo.bin', binary)];
    expect(rules(validateSkillTree(tree).errors)).toEqual([]);
  });

  it('reports size_file over the per-file cap', () => {
    const tree = [...validTree(), skillFile('assets/big.txt', 'a'.repeat(MAX_FILE_BYTES + 1))];
    expect(rules(validateSkillTree(tree).errors)).toContain('size_file');
  });

  it('reports size_total over the tree cap', () => {
    const chunk = 'a'.repeat(MAX_FILE_BYTES);
    const tree = [
      ...validTree(),
      ...Array.from({ length: 6 }, (_, index) => skillFile(`assets/part-${index}.txt`, chunk)),
    ];
    expect(rules(validateSkillTree(tree).errors)).toContain('size_total');
  });

  it('reports file_count over the file cap', () => {
    const tree = [
      ...validTree(),
      ...Array.from({ length: MAX_FILE_COUNT }, (_, index) => skillFile(`assets/f-${index}.txt`, 'x')),
    ];
    expect(rules(validateSkillTree(tree).errors)).toContain('file_count');
  });

  it('refuses a duplicated frontmatter key and validates the last value', () => {
    const tree = [
      skillFile(
        'SKILL.md',
        manifest(`name: example\ndescription: ${validDescription}\ndescription: ${validDescription} </description>`)
      ),
    ];
    const found = rules(validateSkillTree(tree).errors);

    expect(found).toContain('frontmatter_duplicate_key');
    expect(found).toContain('description_angle_brackets');
  });

  it('reports the file and line of a frontmatter error', () => {
    const tree = [skillFile('SKILL.md', manifest(`name: Example\ndescription: ${validDescription}`))];
    const found = validateSkillTree(tree).errors.find((error) => error.rule === 'name_format');
    expect(found).toMatchObject({ file: 'SKILL.md', line: 2 });
  });
});

describe('validateSkillTree lints', () => {
  it('reports body_too_long', () => {
    const body = 'line\n'.repeat(501);
    const tree = [skillFile('SKILL.md', manifest(`name: example\ndescription: ${validDescription}`, body))];
    expect(rules(validateSkillTree(tree).lints)).toContain('body_too_long');
  });

  it('reports description_too_short', () => {
    const tree = [skillFile('SKILL.md', manifest('name: example\ndescription: Does things with data.'))];
    expect(rules(validateSkillTree(tree).lints)).toContain('description_too_short');
  });

  it('reports link_unresolved for a relative path with no file behind it', () => {
    const tree = [
      skillFile(
        'SKILL.md',
        manifest(`name: example\ndescription: ${validDescription}`, 'Read references/missing.md for more.\n')
      ),
    ];
    expect(rules(validateSkillTree(tree).lints)).toContain('link_unresolved');
  });

  it('accepts a relative path that resolves inside the tree', () => {
    const tree = [
      skillFile(
        'SKILL.md',
        manifest(`name: example\ndescription: ${validDescription}`, 'Read [notes](references/notes.md) for more.\n')
      ),
      skillFile('references/notes.md', 'notes'),
    ];
    expect(rules(validateSkillTree(tree).lints)).toEqual([]);
  });

  it('ignores absolute urls and anchors', () => {
    const body = 'See [docs](https://example.com/a/b/c/d/e) and [top](#heading).\n';
    const tree = [skillFile('SKILL.md', manifest(`name: example\ndescription: ${validDescription}`, body))];
    expect(rules(validateSkillTree(tree).lints)).toEqual([]);
  });

  it('reports link_too_deep beyond three directories', () => {
    const body = 'Read [deep](references/a/b/c/notes.md).\n';
    const tree = [
      skillFile('SKILL.md', manifest(`name: example\ndescription: ${validDescription}`, body)),
      skillFile('references/a/b/c/notes.md', 'notes'),
    ];
    expect(rules(validateSkillTree(tree).lints)).toContain('link_too_deep');
  });

  it('reports allowed_tools_present and strips the key from normalizedTree', () => {
    const tree = [
      skillFile('SKILL.md', manifest(`name: example\ndescription: ${validDescription}\nallowed-tools: Read, Write`)),
    ];
    const result = validateSkillTree(tree);

    expect(rules(result.lints)).toContain('allowed_tools_present');
    const normalized = result.normalizedTree[0].content.toString('utf8');
    expect(normalized).not.toContain('allowed-tools');
    expect(normalized).toContain('name: example');
    expect(validateSkillTree(result.normalizedTree).lints.map((lint) => lint.rule)).not.toContain(
      'allowed_tools_present'
    );
  });

  it('leaves the tree untouched when allowed-tools is absent', () => {
    const tree = validTree();
    expect(validateSkillTree(tree).normalizedTree).toBe(tree);
  });
});

describe('validateSkillTree cost', () => {
  it('stays fast on a large file dense with secret matches', () => {
    const line = `AKIAA1B2C3D4E5F6G7H8\n`;
    const tree = [...validTree(), skillFile('references/dump.txt', line.repeat(20_000))];

    const started = performance.now();
    const result = validateSkillTree(tree);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(rules(result.errors)).toContain('secret_detected');
  });
});

describe('computeFlags', () => {
  it('flags the executable bit', () => {
    const tree = [...validTree(), skillFile('bin/run', '#!/bin/sh\n', true)];
    expect(computeFlags(tree).has_executables).toBe(true);
  });

  it('flags anything under scripts/ even without the bit', () => {
    const tree = [...validTree(), skillFile('scripts/run.py', 'print(1)')];
    expect(computeFlags(tree).has_executables).toBe(true);
  });

  it('says nothing about the hosts a tree mentions', () => {
    const body = 'See https://example.com/a and http://Example.com/b and https://other.dev/c.\n';
    const tree = [skillFile('SKILL.md', manifest(`name: example\ndescription: ${validDescription}`, body))];
    expect(computeFlags(tree)).toEqual({ has_executables: false });
  });

  it('reports no flags for a plain skill', () => {
    expect(computeFlags(validTree())).toEqual({ has_executables: false });
  });
});

describe('hashSkillTree', () => {
  it('is stable regardless of file order', () => {
    const a = [skillFile('SKILL.md', 'one'), skillFile('references/two.md', 'two')];
    expect(hashSkillTree(a)).toBe(hashSkillTree([...a].toReversed()));
  });

  it('changes when content changes', () => {
    expect(hashSkillTree([skillFile('SKILL.md', 'one')])).not.toBe(hashSkillTree([skillFile('SKILL.md', 'two')]));
  });

  it('changes when the executable bit changes', () => {
    expect(hashSkillTree([skillFile('scripts/run', 'x')])).not.toBe(
      hashSkillTree([skillFile('scripts/run', 'x', true)])
    );
  });

  it('changes when a path changes', () => {
    expect(hashSkillTree([skillFile('a.md', 'x')])).not.toBe(hashSkillTree([skillFile('b.md', 'x')]));
  });
});
