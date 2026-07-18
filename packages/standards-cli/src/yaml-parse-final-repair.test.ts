import { describe, expect, it } from 'bun:test';
import { composeDependabot } from './dependabot-compose';
import { parseYaml } from './yaml-parse';

const EMPTY_BASE = 'version: 2\nupdates: []\n';

describe('strict YAML merge-key final repair', () => {
  it('rejects repeated merge keys in the canonical base', () => {
    const result = composeDependabot(
      [
        'version: 2',
        'updates:',
        '  - <<: &target',
        '      package-ecosystem: bun',
        '      directory: /',
        '    <<: *target',
        '    schedule: { interval: weekly }',
        '',
      ].join('\n'),
      null,
    );
    expect(result.composed).toBeNull();
    expect(result.problems).toContain(
      '.github/dependabot.base.yml must contain valid YAML with unique mapping keys',
    );
  });

  it('rejects repeated merge keys in the local overlay', () => {
    const result = composeDependabot(
      EMPTY_BASE,
      [
        'updates:',
        '  - <<: &target',
        '      package-ecosystem: nix',
        '      directory: /',
        '    <<: *target',
        '    schedule: { interval: weekly }',
        '',
      ].join('\n'),
    );
    expect(result.composed).toBeNull();
    expect(result.problems).toContain(
      '.github/dependabot.local.yml must contain valid YAML with unique mapping keys',
    );
  });

  it('rejects repeated merge keys in nested mappings', () => {
    const result = composeDependabot(
      [
        'version: 2',
        'updates:',
        '  - package-ecosystem: bun',
        '    directory: /',
        '    schedule:',
        '      <<: &weekly { interval: weekly }',
        '      <<: *weekly',
        '',
      ].join('\n'),
      null,
    );
    expect(result.composed).toBeNull();
    expect(result.problems).toContain(
      '.github/dependabot.base.yml must contain valid YAML with unique mapping keys',
    );
  });

  it('preserves alias sequences and explicit overrides in one merge key', () => {
    const raw = [
      'first: &first',
      '  inherited: first',
      '  overridden: first',
      'second: &second',
      '  later: second',
      'target:',
      '  <<: [*first, *second]',
      '  overridden: explicit',
      '',
    ].join('\n');
    const result = parseYaml(raw, 'merge fixture');
    expect(result.problem).toBeNull();
    expect(result.value).toEqual({
      first: { inherited: 'first', overridden: 'first' },
      second: { later: 'second' },
      target: {
        inherited: 'first',
        later: 'second',
        overridden: 'explicit',
      },
    });
  });
});
