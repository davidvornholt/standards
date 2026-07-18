import { describe, expect, it } from 'bun:test';
import { parse } from 'yaml';
import { composeDependabot } from './dependabot-compose';

const baseWith = (updates: string, registries = ''): string =>
  `version: 2\n${registries}updates:\n${updates}`;

const BUN = [
  '  - package-ecosystem: bun',
  '    directory: /',
  '    schedule: { interval: weekly }',
  '',
].join('\n');

describe('Dependabot update target validation', () => {
  it.each([
    ['singular/plural', '    directory: /', '    directories: ["/"]'],
    [
      'reordered plural',
      '    directories: ["/", "/packages/a"]',
      '    directories: ["/packages/a", "/"]',
    ],
  ])('normalizes %s targets before merging', (_label, baseTarget, localTarget) => {
    const base = baseWith(BUN.replace('    directory: /', baseTarget));
    const local = [
      'updates:',
      '  - package-ecosystem: bun',
      localTarget,
      '    ignore:',
      '      - dependency-name: left-pad',
      '',
    ].join('\n');
    const result = composeDependabot(base, local);
    expect(result.problems).toEqual([]);
    expect(result.composed).toContain('dependency-name: "left-pad"');
  });

  it('rejects partially overlapping targets', () => {
    const base = baseWith(
      BUN.replace('    directory: /', '    directories: ["/", "/packages/a"]'),
    );
    const local = [
      'updates:',
      '  - package-ecosystem: bun',
      '    directories: ["/packages/a", "/packages/b"]',
      '    schedule: { interval: daily }',
      '',
    ].join('\n');
    expect(composeDependabot(base, local).problems.join('\n')).toContain(
      'overlaps .github/dependabot.base.yml updates[0]',
    );
  });

  it('rejects duplicate canonical targets', () => {
    const base = baseWith(
      `${BUN}${BUN.replace('directory: /', 'directories: ["/"]')}`,
    );
    expect(composeDependabot(base, null).problems.join('\n')).toContain(
      'updates[1] overlaps',
    );
  });

  it('rejects blocks that declare both singular and plural targets', () => {
    const base = baseWith(
      BUN.replace(
        '    directory: /',
        '    directory: /\n    directories: ["/"]',
      ),
    );
    expect(composeDependabot(base, null).problems.join('\n')).toContain(
      'must define exactly one of directory or directories',
    );
  });

  it('keeps identical directories on distinct target branches separate', () => {
    const local = [
      'updates:',
      '  - package-ecosystem: bun',
      '    directory: /',
      '    target-branch: release',
      '    schedule: { interval: weekly }',
      '',
    ].join('\n');
    const result = composeDependabot(baseWith(BUN), local);
    expect(result.problems).toEqual([]);
    const config = parse(result.composed ?? '') as { updates: Array<unknown> };
    expect(config.updates).toHaveLength(2);
  });
});

describe('Dependabot ignore validation', () => {
  it.each([
    ['mapping ignore', '    ignore: { dependency-name: left-pad }\n'],
    ['non-mapping entry', '    ignore: [left-pad]\n'],
    ['missing dependency', '    ignore: [{}]\n'],
    [
      'mapping versions',
      '    ignore:\n      - dependency-name: left-pad\n        versions: { min: 1 }\n',
    ],
    [
      'scalar update types',
      '    ignore:\n      - dependency-name: left-pad\n        update-types: version-update:semver-major\n',
    ],
  ])('rejects malformed canonical %s', (_label, ignore) => {
    const base = baseWith(
      `${BUN}${ignore}`.replace(`${BUN}`, `${BUN.trimEnd()}\n`),
    );
    expect(composeDependabot(base, null).composed).toBeNull();
  });

  it('does not replace malformed canonical policy with a local hold', () => {
    const base = baseWith(
      BUN.replace('    schedule', '    ignore: {}\n    schedule'),
    );
    const local =
      'updates:\n  - package-ecosystem: bun\n    directory: /\n    ignore:\n      - dependency-name: left-pad\n';
    const result = composeDependabot(base, local);
    expect(result.composed).toBeNull();
    expect(result.problems.join('\n')).toContain(
      '.github/dependabot.base.yml updates[0].ignore must be a list',
    );
  });

  it('rejects malformed local ignore policy', () => {
    const local =
      'updates:\n  - package-ecosystem: bun\n    directory: /\n    ignore:\n      - dependency-name: ""\n';
    expect(
      composeDependabot(baseWith(BUN), local).problems.join('\n'),
    ).toContain('must define a non-empty dependency-name');
  });
});

describe('Dependabot private registry seam', () => {
  const registry =
    'registries:\n  private-npm:\n    type: npm-registry\n    url: https://npm.example.com\n';

  it('adds top-level registries and references on a canonical target', () => {
    const local = `${registry}updates:\n  - package-ecosystem: bun\n    directories: ["/"]\n    registries: [private-npm]\n`;
    const result = composeDependabot(baseWith(BUN), local);
    expect(result.problems).toEqual([]);
    expect(result.composed).toContain('private-npm:');
    expect(result.composed).toContain('registries:');
  });

  it.each([
    ['registry list', 'registries: private-npm'],
    ['registry definition', 'registries:\n  private-npm: nope'],
  ])('rejects a malformed %s', (_label, fragment) => {
    const local = fragment.startsWith('registries: private')
      ? `updates:\n  - package-ecosystem: bun\n    directory: /\n    ${fragment}\n`
      : `${fragment}\nupdates: []\n`;
    expect(composeDependabot(baseWith(BUN), local).composed).toBeNull();
  });

  it('rejects canonical registry name collisions', () => {
    const local = `${registry}updates: []\n`;
    const result = composeDependabot(baseWith(BUN, registry), local);
    expect(result.problems.join('\n')).toContain(
      'registries collide with canonical registries: private-npm',
    );
  });

  it.each([
    'labels',
    'groups',
    'cooldown',
    'open-pull-requests-limit',
  ])('keeps rejecting %s on matching canonical blocks', (key) => {
    const local = `updates:\n  - package-ecosystem: bun\n    directory: /\n    ${key}: {}\n`;
    expect(
      composeDependabot(baseWith(BUN), local).problems.join('\n'),
    ).toContain(`remove: ${key}`);
  });
});

describe('strict Dependabot YAML parsing', () => {
  it.each([
    ['base top-level', 'version: 2\nversion: 2\nupdates: []\n', null],
    [
      'base nested',
      `${baseWith(BUN)}  - package-ecosystem: github-actions\n    directory: /\n    directory: /actions\n`,
      null,
    ],
    ['local top-level', baseWith(BUN), 'updates: []\nupdates: []\n'],
    [
      'local nested',
      baseWith(BUN),
      'updates:\n  - package-ecosystem: bun\n    directory: /\n    ignore: []\n    ignore: []\n',
    ],
  ])('rejects duplicate mapping keys in %s', (_label, base, local) => {
    const result = composeDependabot(base, local);
    expect(result.composed).toBeNull();
    expect(result.problems.join('\n')).toContain('unique mapping keys');
  });
});
