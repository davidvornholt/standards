import { describe, expect, it } from 'bun:test';
import baseConfig from './base.json' with { type: 'json' };

describe('@davidvornholt/typescript-config/base', () => {
  it('keeps strict type checking enabled', () => {
    expect(baseConfig.compilerOptions.strict).toBe(true);
  });
});
