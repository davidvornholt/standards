import { describe, expect, it } from 'bun:test';
import { parse } from 'yaml';
import { composeDependabot } from './dependabot-compose';

const BASE = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: bun',
  '    directory: /',
  '    schedule: { interval: weekly }',
  '',
].join('\n');

type Update = {
  readonly 'package-ecosystem': string;
  readonly registries?: '*' | ReadonlyArray<string>;
};

const updatesOf = (composed: string | null): ReadonlyArray<Update> =>
  (parse(composed ?? '') as { updates: ReadonlyArray<Update> }).updates;

describe('Dependabot registry wildcard repair', () => {
  it('accepts a canonical scalar wildcard', () => {
    const result = composeDependabot(
      BASE.replace('    schedule:', '    registries: "*"\n    schedule:'),
      null,
    );
    expect(result.problems).toEqual([]);
    expect(updatesOf(result.composed)[0]?.registries).toBe('*');
  });

  it('accepts a wildcard added to a matching canonical target', () => {
    const local =
      'updates:\n  - package-ecosystem: bun\n    directory: /\n    registries: "*"\n';
    const result = composeDependabot(BASE, local);
    expect(result.problems).toEqual([]);
    expect(updatesOf(result.composed)[0]?.registries).toBe('*');
  });

  it('accepts a wildcard on a new overlay ecosystem', () => {
    const local =
      'updates:\n  - package-ecosystem: nix\n    directory: /\n    registries: "*"\n    schedule: { interval: weekly }\n';
    const result = composeDependabot(BASE, local);
    expect(result.problems).toEqual([]);
    expect(updatesOf(result.composed)[1]?.registries).toBe('*');
  });

  it('unions named references without duplicating canonical names', () => {
    const base =
      'version: 2\nregistries:\n  first: {}\n  second: {}\nupdates:\n  - package-ecosystem: bun\n    directory: /\n    registries: [first]\n    schedule: { interval: weekly }\n';
    const local =
      'updates:\n  - package-ecosystem: bun\n    directories: ["/"]\n    registries: [first, second]\n';
    const result = composeDependabot(base, local);
    expect(result.problems).toEqual([]);
    expect(updatesOf(result.composed)[0]?.registries).toEqual([
      'first',
      'second',
    ]);
  });

  it('still rejects undefined names and unrelated matching-block keys', () => {
    const undefinedName = composeDependabot(
      BASE,
      'updates:\n  - package-ecosystem: bun\n    directory: /\n    registries: [missing]\n',
    );
    expect(undefinedName.problems.join('\n')).toContain(
      'references undefined registries: missing',
    );
    const unrelated = composeDependabot(
      BASE,
      'updates:\n  - package-ecosystem: bun\n    directory: /\n    registries: "*"\n    labels: [dependencies]\n',
    );
    expect(unrelated.problems.join('\n')).toContain('remove: labels');
  });
});

describe('strict YAML merge-key repair', () => {
  it('expands merge keys in both the canonical base and overlay', () => {
    const base = [
      'version: 2',
      'updates:',
      '  - <<: &bun-target',
      '      package-ecosystem: bun',
      '      directory: /',
      '    schedule: { interval: weekly }',
      '',
    ].join('\n');
    const local = [
      'updates:',
      '  - <<: &bun-target',
      '      package-ecosystem: bun',
      '      directory: /',
      '    ignore:',
      '      - dependency-name: left-pad',
      '',
    ].join('\n');
    const result = composeDependabot(base, local);
    expect(result.problems).toEqual([]);
    expect(result.composed).not.toContain('<<:');
    expect(result.composed).toContain('dependency-name: "left-pad"');
  });

  it('retains explicit duplicate-key rejection with merge processing', () => {
    const result = composeDependabot(
      'version: 2\nversion: 2\nupdates: []\n',
      null,
    );
    expect(result.composed).toBeNull();
    expect(result.problems.join('\n')).toContain('unique mapping keys');
  });
});
