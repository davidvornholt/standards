import { describe, expect, it } from 'bun:test';
import { composeDependabot } from './dependabot-compose';

const baseWithTarget = (target: string): string =>
  [
    'version: 2',
    'updates:',
    '  - package-ecosystem: bun',
    target,
    '    schedule: { interval: weekly }',
    '',
  ].join('\n');

const localWithTarget = (target: string, targetBranch?: string): string =>
  [
    'updates:',
    '  - package-ecosystem: bun',
    target,
    ...(targetBranch === undefined
      ? []
      : [`    target-branch: ${targetBranch}`]),
    '    schedule: { interval: daily }',
    '',
  ].join('\n');

describe('Dependabot directory glob overlap', () => {
  it.each([
    [
      'canonical single-segment glob',
      '    directories: ["/packages/*"]',
      '    directory: /packages/a',
    ],
    [
      'local single-segment glob',
      '    directory: /packages/a',
      '    directories: ["/packages/*"]',
    ],
    [
      'canonical recursive globstar',
      '    directories: ["/packages/**/*"]',
      '    directory: /packages/a/nested',
    ],
    [
      'local recursive globstar',
      '    directory: /packages/a/nested',
      '    directories: ["/packages/**/*"]',
    ],
    [
      'question mark glob',
      '    directories: ["/packages/?"]',
      '    directory: /packages/a',
    ],
    [
      'character range glob',
      '    directories: ["/packages/[a-c]"]',
      '    directory: /packages/b',
    ],
    [
      'negated character set glob',
      '    directories: ["/packages/[!ab]"]',
      '    directory: /packages/c',
    ],
  ])(
    'rejects %s overlapping a concrete target',
    (_label, baseTarget, localTarget) => {
      const result = composeDependabot(
        baseWithTarget(baseTarget),
        localWithTarget(localTarget),
      );
      expect(result.problems.join('\n')).toContain(
        'overlaps .github/dependabot.base.yml updates[0]',
      );
    },
  );

  it('rejects intersecting glob targets', () => {
    const result = composeDependabot(
      baseWithTarget('    directories: ["/packages/*"]'),
      localWithTarget('    directories: ["/packages/a*"]'),
    );
    expect(result.problems.join('\n')).toContain(
      'overlaps .github/dependabot.base.yml updates[0]',
    );
  });

  it('merges identical glob targets', () => {
    const result = composeDependabot(
      baseWithTarget('    directories: ["/packages/*"]'),
      [
        'updates:',
        '  - package-ecosystem: bun',
        '    directories: ["/packages/*"]',
        '    ignore:',
        '      - dependency-name: left-pad',
        '',
      ].join('\n'),
    );
    expect(result.problems).toEqual([]);
    expect(result.composed).toContain('dependency-name: "left-pad"');
  });

  it('keeps non-intersecting single-segment and nested targets separate', () => {
    const result = composeDependabot(
      baseWithTarget('    directories: ["/packages/*"]'),
      localWithTarget('    directory: /packages/a/nested'),
    );
    expect(result.problems).toEqual([]);
    expect(result.composed).not.toBeNull();
  });
});

describe('Dependabot Ruby glob compatibility', () => {
  it.each([
    ['/packages/**', '/packages/a/nested'],
    ['/packages/a**b', '/packages/a/x/b'],
  ])('keeps non-recursive %s separate from %s', (glob, concrete) => {
    const result = composeDependabot(
      baseWithTarget(`    directories: ["${glob}"]`),
      localWithTarget(`    directory: ${concrete}`),
    );
    expect(result.problems).toEqual([]);
    expect(result.composed).not.toBeNull();
  });

  it.each([
    ['/packages/**/nested', '/packages/nested'],
    ['/packages/**/nested', '/packages/a/nested'],
  ])('recognizes %s as intersecting %s', (glob, concrete) => {
    const result = composeDependabot(
      baseWithTarget(`    directories: ["${glob}"]`),
      localWithTarget(`    directory: ${concrete}`),
    );
    expect(result.problems.join('\n')).toContain(
      'overlaps .github/dependabot.base.yml updates[0]',
    );
  });

  it.each([
    ["    directories: ['/packages/\\*']", '    directory: /packages/*'],
    [
      "    directories: ['/packages/\\?']",
      '    directories: ["/packages/[?]"]',
    ],
  ])('honors escaped metacharacters', (baseTarget, localTarget) => {
    const result = composeDependabot(
      baseWithTarget(baseTarget),
      localWithTarget(localTarget),
    );
    expect(result.problems.join('\n')).toContain(
      'overlaps .github/dependabot.base.yml updates[0]',
    );
  });

  it.each([
    [
      '    directory: /packages/a',
      '    directory: packages/x/../a',
      'matches a canonical block',
    ],
    [
      '    directory: /packages//a/',
      '    directory: packages/a',
      'matches a canonical block',
    ],
    [
      '    directories: ["/packages//./*"]',
      '    directory: packages/a/',
      'overlaps .github/dependabot.base.yml updates[0]',
    ],
  ])(
    'compares normalized target spellings',
    (baseTarget, localTarget, expectedProblem) => {
      const result = composeDependabot(
        baseWithTarget(baseTarget),
        localWithTarget(localTarget),
      );
      expect(result.problems.join('\n')).toContain(expectedProblem);
    },
  );

  it('does not treat wildcard characters under directory as globs', () => {
    const result = composeDependabot(
      baseWithTarget('    directory: /packages/*'),
      localWithTarget('    directory: /packages/a'),
    );
    expect(result.problems).toEqual([]);
    expect(result.composed).not.toBeNull();
  });

  it('keeps overlapping glob targets on distinct target branches separate', () => {
    const result = composeDependabot(
      baseWithTarget('    directories: ["/packages/**"]'),
      localWithTarget('    directory: /packages/a', 'release'),
    );
    expect(result.problems).toEqual([]);
    expect(result.composed).not.toBeNull();
  });
});
