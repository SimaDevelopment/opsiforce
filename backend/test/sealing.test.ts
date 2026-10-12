import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuration } from '../src/config/configuration';
import { SealingModule } from '../src/sealing/sealing.module';
import { SecretSealer, SecretUnreadableError } from '../src/sealing/secret-sealer';

const KEY = '0f'.repeat(32);

async function bootWithKey(key: string | undefined): Promise<SecretSealer> {
  const previous = process.env.EXTERNAL_SERVICES_ENCRYPTION_KEY;
  if (key === undefined) delete process.env.EXTERNAL_SERVICES_ENCRYPTION_KEY;
  else process.env.EXTERNAL_SERVICES_ENCRYPTION_KEY = key;
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }), SealingModule],
    }).compile();
    return moduleRef.get(SecretSealer);
  } finally {
    if (previous === undefined) delete process.env.EXTERNAL_SERVICES_ENCRYPTION_KEY;
    else process.env.EXTERNAL_SERVICES_ENCRYPTION_KEY = previous;
  }
}

describe('sealed secrets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('open in the place they were sealed for, and never carry the plaintext', async () => {
    const sealer = await bootWithKey(KEY);

    const sealed = sealer.seal({ token: 'trello-token-acme' }, 'trello|acme|workspaces.li_x.token');

    expect(JSON.stringify(sealed)).not.toContain('trello-token-acme');
    expect(sealer.open(sealed, 'trello|acme|workspaces.li_x.token')).toEqual({ token: 'trello-token-acme' });
  });

  it('copied into another place fail to open as secret-unreadable, and the place is logged', async () => {
    const sealer = await bootWithKey(KEY);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const sealed = sealer.seal('trello-token-acme', 'trello|acme|workspaces.li_x.token');

    const opening = () => sealer.open(sealed, 'trello|globex|workspaces.li_x.token');

    expect(opening).toThrow(SecretUnreadableError);
    expect(opening).toThrow(expect.objectContaining({ code: 'secret-unreadable' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trello|globex|workspaces.li_x.token'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('trello-token-acme');
  });

  it('sealed under one key do not open under another', async () => {
    const sealed = (await bootWithKey(KEY)).seal('value', 'whatsapp|platform|channels.li_a1.apiToken');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const otherKey = await bootWithKey('a1'.repeat(32));

    expect(() => otherKey.open(sealed, 'whatsapp|platform|channels.li_a1.apiToken')).toThrow(SecretUnreadableError);
  });

  it('refuse to boot without an encryption key, pointing at openssl rand -hex 32', async () => {
    await expect(bootWithKey(undefined)).rejects.toThrow(
      /EXTERNAL_SERVICES_ENCRYPTION_KEY is not set.*openssl rand -hex 32/
    );
    await expect(bootWithKey('  ')).rejects.toThrow(/EXTERNAL_SERVICES_ENCRYPTION_KEY is not set/);
  });

  it('refuse to boot on a key that is not 32 bytes of hex', async () => {
    for (const malformed of ['abc', 'zz'.repeat(32), '0f'.repeat(16), '0f'.repeat(33)]) {
      await expect(bootWithKey(malformed)).rejects.toThrow(
        /EXTERNAL_SERVICES_ENCRYPTION_KEY must be 64 hex characters.*openssl rand -hex 32/
      );
    }
  });
});
