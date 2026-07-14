import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENT_CONTRACT = join(import.meta.dir, '../../../AGENTS.md');
const ZERO_INSTALL_EFFECT_BOUNDARIES = [
  '`.github/actions/standards-sync-preflight` action and its dependency-free generated helper closure',
  'published standalone `packages/standards-cli/src/cli.ts` executable and its built-in-only helper closure listed in the package `files` allowlist',
] as const;

describe('canonical Effect exception contract', () => {
  it('enumerates only synced and published zero-install boundaries', () => {
    const contract = readFileSync(AGENT_CONTRACT, 'utf8');
    expect(contract).toContain('complete canonical Effect exception boundary');
    expect(contract).toContain(
      'Source-repository-specific extensions belong in `AGENTS.local.md`',
    );
    for (const boundary of ZERO_INSTALL_EFFECT_BOUNDARIES) {
      expect(contract).toContain(boundary);
    }
    expect(contract).not.toContain('packages/standards-release');
  });
});
