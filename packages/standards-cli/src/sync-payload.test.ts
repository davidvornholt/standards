import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTUAL_UPSTREAM,
  AGENTS_PARTS,
  cleanupTmpDirs,
  mkTmp,
  write,
  writeSyncManifest,
} from './cli-test-support';
import {
  composeAgents,
  loadManifest,
  parseManifest,
  splitAgents,
} from './sync-payload';

afterEach(cleanupTmpDirs);

const payload = (
  paths: ReadonlyArray<string>,
  seeds: ReadonlyArray<string>,
) => ({
  agents: 'agents-md/part.md',
  seeds,
  paths,
});
const manifestWith = (payloads: Record<string, unknown>): unknown => ({
  upstream: 'github:davidvornholt/standards',
  seedDir: 'template',
  payloads,
});

describe('sync manifest', () => {
  it('accepts the whole seed directory as a seed', () => {
    const manifest = parseManifest(
      manifestWith({ core: payload([], []), bun: payload([], ['.']) }),
    );
    expect(manifest.payloads.bun.seeds).toEqual(['.']);
  });

  it.each([
    [
      'a missing payload',
      manifestWith({ core: payload([], []) }),
      'requires "payloads" with exactly the keys core and bun',
    ],
    [
      'an unknown payload',
      manifestWith({
        core: payload([], []),
        bun: payload([], []),
        rust: payload([], []),
      }),
      'requires "payloads" with exactly the keys core and bun',
    ],
    [
      'a managed AGENTS.md',
      manifestWith({ core: payload(['AGENTS.md'], []), bun: payload([], []) }),
      'must not manage AGENTS.md',
    ],
    [
      'a path in both payloads',
      manifestWith({
        core: payload(['justfile'], []),
        bun: payload(['justfile'], []),
      }),
      'managed paths must be unique across payloads',
    ],
    [
      'the repository root as a managed path',
      manifestWith({ core: payload(['.'], []), bun: payload([], []) }),
      'must be a normalized repository-relative path: .',
    ],
    [
      'a top-level paths list',
      {
        upstream: 'github:davidvornholt/standards',
        seedDir: 'template',
        paths: [],
      },
      'requires "payloads"',
    ],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseManifest(raw)).toThrow(message);
  });
});

describe('AGENTS.md composition', () => {
  it('gives core consumers the core part and Bun consumers both', async () => {
    const up = mkTmp('agents-up-');
    writeSyncManifest(up, up, []);
    const manifest = await loadManifest(join(up, 'sync-standards.json'));

    const core = await composeAgents(up, manifest, 'core');
    const bun = await composeAgents(up, manifest, 'bun');

    expect(core.startsWith(`# AGENTS.md\n\n${AGENTS_PARTS.core}\n`)).toBe(true);
    expect(core).not.toContain(AGENTS_PARTS.bun);
    expect(bun).toContain(`${AGENTS_PARTS.core}\n${AGENTS_PARTS.bun}`);
    for (const composed of [core, bun]) {
      expect(composed.endsWith('\n\n## Project-specific rules\n')).toBe(true);
    }
  });

  it("keeps this repository's AGENTS.md generated from its parts", async () => {
    const manifest = await loadManifest(
      join(ACTUAL_UPSTREAM, 'sync-standards.json'),
    );
    const actual = readFileSync(join(ACTUAL_UPSTREAM, 'AGENTS.md'), 'utf8');
    expect(splitAgents(actual)?.head).toBe(
      await composeAgents(ACTUAL_UPSTREAM, manifest, 'bun'),
    );
  });

  it('refuses a part that contains the local heading', async () => {
    const up = mkTmp('agents-up-');
    writeSyncManifest(up, up, []);
    write(up, 'agents-md/core.md', '## Project-specific rules\n');
    const manifest = await loadManifest(join(up, 'sync-standards.json'));

    await expect(composeAgents(up, manifest, 'core')).rejects.toThrow(
      'must not contain the line "## Project-specific rules"',
    );
  });

  it('splits after the first local heading and puts the halves back together', () => {
    const text = '# AGENTS.md\n\n## Project-specific rules\n\n### Own\n';
    expect(splitAgents(text)).toEqual({
      head: '# AGENTS.md\n\n## Project-specific rules\n',
      tail: '\n### Own\n',
    });
    expect(splitAgents('# AGENTS.md\n')).toBeNull();
  });

  it('keeps the exact line endings and recognizes only the whole heading line', () => {
    expect(splitAgents('# A\r\n## Project-specific rules\r\nown\r\n')).toEqual({
      head: '# A\r\n## Project-specific rules\r\n',
      tail: 'own\r\n',
    });
    expect(splitAgents('# A\n## Project-specific rules')).toEqual({
      head: '# A\n## Project-specific rules',
      tail: '',
    });
    expect(splitAgents('# A\n## Project-specific rules too\n')).toBeNull();
    expect(splitAgents('# A\nSee ## Project-specific rules\n')).toBeNull();
  });
});

describe('canonical core payload', () => {
  // A repository on the core payload has no Bun workspace, so everything the
  // weekly sync runs must arrive with core.
  it('carries what the weekly sync needs', async () => {
    const { payloads } = await loadManifest(
      join(ACTUAL_UPSTREAM, 'sync-standards.json'),
    );
    expect(payloads.core.paths).toEqual(
      expect.arrayContaining([
        'sync-standards.json',
        '.github/workflows/standards-sync.yml',
        '.github/actions/sops-secret',
        '.agents/skills/standards-sync',
      ]),
    );
    expect(payloads.core.seeds).toEqual([]);
  });
});
