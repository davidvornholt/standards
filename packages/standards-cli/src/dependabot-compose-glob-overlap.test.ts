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
      'canonical recursive glob',
      '    directories: ["/packages/**"]',
      '    directory: /packages/a/nested',
    ],
    [
      'local recursive glob',
      '    directory: /packages/a/nested',
      '    directories: ["/packages/**"]',
    ],
  ])('rejects %s overlapping a concrete target', (_label, baseTarget, localTarget) => {
    const result = composeDependabot(
      baseWithTarget(baseTarget),
      localWithTarget(localTarget),
    );
    expect(result.problems.join('\n')).toContain(
      'overlaps .github/dependabot.base.yml updates[0]',
    );
  });

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
