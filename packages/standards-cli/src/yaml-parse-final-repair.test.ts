import { describe, expect, it } from 'bun:test';
import { parseYaml } from './yaml-parse';

const PROBLEM = 'config must contain valid YAML with unique mapping keys';

describe('strict YAML merge-key final repair', () => {
  it('rejects repeated merge keys in a list item', () => {
    const result = parseYaml(
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
      'config',
    );
    expect(result).toEqual({ value: null, problem: PROBLEM });
  });

  it('rejects repeated merge keys in nested mappings', () => {
    const result = parseYaml(
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
      'config',
    );
    expect(result).toEqual({ value: null, problem: PROBLEM });
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
