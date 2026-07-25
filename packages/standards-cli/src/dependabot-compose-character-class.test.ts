import { describe, expect, it } from 'bun:test';
import { composeDependabot } from './dependabot-compose';

const composeTargets = (glob: string, concrete: string) =>
  composeDependabot(
    [
      'version: 2',
      'updates:',
      '  - package-ecosystem: bun',
      `    directories: ['${glob}']`,
      '    schedule: { interval: weekly }',
      '',
    ].join('\n'),
    [
      'updates:',
      '  - package-ecosystem: bun',
      `    directory: ${concrete}`,
      '    schedule: { interval: daily }',
      '',
    ].join('\n'),
  );

describe('Dependabot Ruby character-class compatibility', () => {
  it.each([
    ['/packages/[a\\-c]', '/packages/a', true],
    ['/packages/[a\\-c]', '/packages/-', true],
    ['/packages/[a\\-c]', '/packages/c', true],
    ['/packages/[a\\-c]', '/packages/b', false],
    ['/packages/[]]', '/packages/]', false],
    ['/packages/[c-a]', '/packages/c', true],
    ['/packages/[c-a]', '/packages/a', true],
    ['/packages/[c-a]', '/packages/b', false],
    ['/packages/[!]', '/packages/x', true],
    ['/packages/[^]', '/packages/x', true],
  ])('matches %s against %s like Dir.glob', (glob, concrete, expectedOverlap) => {
    const result = composeTargets(glob, concrete);
    expect(
      result.problems
        .join('\n')
        .includes('overlaps .github/dependabot.base.yml updates[0]'),
    ).toBe(expectedOverlap);
    expect(result.composed === null).toBe(expectedOverlap);
  });
});
