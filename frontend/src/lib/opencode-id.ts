const ID_LENGTH = 26;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let lastTimestamp = 0;
let counter = 0;

export function opencodeMessageId(): string {
  const timestamp = Date.now();
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter += 1;

  const value = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, '0')
  ).join('');
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH - 12));

  return `msg_${time}${Array.from(bytes, (byte) => CHARS[byte % 62]).join('')}`;
}
