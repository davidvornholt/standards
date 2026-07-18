import { describe, expect, it } from 'bun:test';
import { inspectDependabot } from './dependabot-inspect';

const grouped = (updateFields: string): string =>
  [
    'version: 2',
    'multi-ecosystem-groups:',
    '  infrastructure:',
    '    schedule: { interval: weekly }',
    'updates:',
    '  - package-ecosystem: bun',
    '    directory: /',
    '    schedule: { interval: weekly }',
    '  - package-ecosystem: github-actions',
    '    directory: /',
    '    schedule: { interval: weekly }',
    '  - package-ecosystem: opentofu',
    '    directory: /infra',
    ...updateFields.split('\n'),
    '',
  ].join('\n');

describe('multi-ecosystem Dependabot inspection', () => {
  it('accepts a defined group with non-empty patterns', () => {
    expect(
      inspectDependabot(
        grouped(
          '    multi-ecosystem-group: infrastructure\n    patterns: ["*"]',
        ),
      ),
    ).toEqual([]);
  });

  it('rejects an undefined group even when the update has a schedule', () => {
    const problems = inspectDependabot(
      grouped(
        '    multi-ecosystem-group: missing\n    patterns: ["*"]\n    schedule: { interval: weekly }',
      ),
    );
    expect(problems.join('\n')).toContain(
      'must reference a scheduled multi-ecosystem group',
    );
  });

  it.each([
    '',
    '    patterns: []',
  ])('requires non-empty patterns on grouped updates', (patterns) => {
    const problems = inspectDependabot(
      grouped(`    multi-ecosystem-group: infrastructure\n${patterns}`),
    );
    expect(problems.join('\n')).toContain(
      'must define non-empty patterns when using a multi-ecosystem group',
    );
  });
});
