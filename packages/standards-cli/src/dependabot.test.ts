import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTUAL_UPSTREAM } from './cli-test-support';
import { inspectDependabot } from './dependabot';
import {
  DEPENDABOT_FILE,
  DEPENDABOT_LOCAL_MARKER,
  splitManaged,
} from './sync-payload';

const HEAD = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: bun',
  '    directory: /',
  '    schedule:',
  '      interval: weekly',
  DEPENDABOT_LOCAL_MARKER,
  '',
].join('\n');

// One update block as a list item of `updates`.
const block = ([first, ...rest]: ReadonlyArray<string>): string =>
  [`  - ${first}`, ...rest.map((line) => `    ${line}`), ''].join('\n');

describe('Dependabot split', () => {
  it('splits after the marker line and keeps the exact bytes', () => {
    const own = block(['package-ecosystem: nix', 'directory: /infra']);
    expect(splitManaged(DEPENDABOT_FILE, `${HEAD}${own}`)).toEqual({
      head: HEAD,
      tail: own,
    });
    const crlf = `${HEAD}${own}`.replaceAll('\n', '\r\n');
    expect(splitManaged(DEPENDABOT_FILE, crlf)).toEqual({
      head: HEAD.replaceAll('\n', '\r\n'),
      tail: own.replaceAll('\n', '\r\n'),
    });
    expect(splitManaged(DEPENDABOT_FILE, HEAD.trimEnd())).toEqual({
      head: HEAD.trimEnd(),
      tail: '',
    });
  });

  it.each([
    ['at column zero', '# Project-specific updates'],
    ['indented four spaces', '    # Project-specific updates'],
    ['with trailing text', '  # Project-specific updates too'],
    ['inside another comment', '  # See # Project-specific updates'],
  ])('recognizes only the exact marker line, not one %s', (_label, line) => {
    expect(
      splitManaged(
        DEPENDABOT_FILE,
        HEAD.replace(DEPENDABOT_LOCAL_MARKER, line),
      ),
    ).toBeNull();
  });

  it("keeps this repository's config split and valid", () => {
    const raw = readFileSync(join(ACTUAL_UPSTREAM, DEPENDABOT_FILE), 'utf8');
    expect(splitManaged(DEPENDABOT_FILE, raw)?.head).toContain(
      'package-ecosystem: "github-actions"',
    );
    expect(inspectDependabot(raw)).toEqual([]);
  });
});

describe('Dependabot inspection', () => {
  it('accepts own blocks for other directories and target branches', () => {
    const own = [
      block(['package-ecosystem: nix', 'directory: /infra']),
      block(['package-ecosystem: bun', 'directory: /', 'target-branch: next']),
      block(['package-ecosystem: bun', 'directories: ["/apps/*"]']),
    ].join('');
    expect(inspectDependabot(`${HEAD}${own}`)).toEqual([]);
  });

  it.each([
    ['an empty directory', ['package-ecosystem: bun', 'directory: ""'], '/'],
    ['a dot segment', ['package-ecosystem: bun', 'directory: /./'], '/'],
    [
      'a directories entry',
      ['package-ecosystem: nix', 'directories: [/apps, infra/]'],
      '/infra',
    ],
  ])('reports a repeated target written with %s', (_label, lines, shown) => {
    const own = `${block(['package-ecosystem: nix', 'directory: /infra'])}${block(lines)}`;
    const problems = inspectDependabot(`${HEAD}${own}`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('more than one update block for');
    expect(problems[0]).toContain(`directory "${shown}"`);
  });

  it.each([
    [
      'no marker',
      HEAD.replace(`${DEPENDABOT_LOCAL_MARKER}\n`, ''),
      `has no "${DEPENDABOT_LOCAL_MARKER}" line`,
    ],
    [
      'invalid YAML',
      `${HEAD}  - package-ecosystem: [\n`,
      'must contain valid YAML',
    ],
    [
      'no updates list',
      `version: 2\nupdates:\n${DEPENDABOT_LOCAL_MARKER}\n`,
      'must define an updates list',
    ],
  ])('reports %s', (_label, raw, message) => {
    expect(inspectDependabot(raw)).toEqual([expect.stringContaining(message)]);
  });
});
