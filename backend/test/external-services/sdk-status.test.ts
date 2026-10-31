import { describe, expect, it } from 'vitest';
import { builtOnSdkOlderThan } from '../../src/external-services/publishing/sdk-status';

describe('builtOnSdkOlderThan', () => {
  it('is true only for a known vendored SDK below the version', () => {
    expect(builtOnSdkOlderThan('2.1.4', '2.2.0')).toBe(true);
    expect(builtOnSdkOlderThan('2.2.0', '2.2.0')).toBe(false);
    expect(builtOnSdkOlderThan('2.3.0', '2.2.0')).toBe(false);
    expect(builtOnSdkOlderThan(null, '2.2.0')).toBe(false);
    expect(builtOnSdkOlderThan('file:../sdk', '2.2.0')).toBe(false);
  });
});
