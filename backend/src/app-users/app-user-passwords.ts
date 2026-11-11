import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_BYTES, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, { N: COST, r: BLOCK_SIZE, p: PARALLELISM });
  return ['scrypt', COST, BLOCK_SIZE, PARALLELISM, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, cost, blockSize, parallelism, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const key = await scrypt(password, Buffer.from(salt, 'base64'), {
    N: Number(cost),
    r: Number(blockSize),
    p: Number(parallelism),
  });
  const expectedKey = Buffer.from(expected, 'base64');
  return expectedKey.byteLength === key.byteLength && timingSafeEqual(expectedKey, key);
}

let nobodysHash: Promise<string> | undefined;

export async function verifyAgainstNobody(password: string): Promise<false> {
  nobodysHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await nobodysHash);
  return false;
}
