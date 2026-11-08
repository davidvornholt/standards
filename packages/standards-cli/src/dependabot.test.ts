import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTUAL_UPSTREAM } from './cli-test-support';
import {
  DEPENDABOT_FILE,
  DEPENDABOT_LOCAL_MARKER,
  DEPENDABOT_SPLIT,
  inspectDependabot,
} from './dependabot';
import { splitManaged } from './own-part';
import { joinParts } from './split-file';

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

// One update block as a list item of `updates`, exactly as written.
const rawBlock = ([first, ...rest]: ReadonlyArray<string>): string =>
  [`  - ${first}`, ...rest.map((line) => `    ${line}`), ''].join('\n');

// One complete update block: a weekly schedule follows the given lines.
const block = (lines: ReadonlyArray<string>): string =>
  rawBlock([...lines, 'schedule:', '  interval: weekly']);

const NIX = block(['package-ecosystem: nix', 'directory: /infra']);

describe('Dependabot split', () => {
  it('splits after the marker line and keeps the exact bytes', () => {
    expect(splitManaged(DEPENDABOT_FILE, `${HEAD}${NIX}`)).toEqual({
      head: HEAD,
      tail: NIX,
    });
    const crlf = `${HEAD}${NIX}`.replaceAll('\n', '\r\n');
    expect(splitManaged(DEPENDABOT_FILE, crlf)).toEqual({
      head: HEAD.replaceAll('\n', '\r\n'),
      tail: NIX.replaceAll('\n', '\r\n'),
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

  it('starts the own part on its own line below a marker that ends the file', () => {
    const joined = joinParts(HEAD.trimEnd(), NIX);

    expect(joined).toBe(`${HEAD}${NIX}`);
    expect(inspectDependabot(joined)).toEqual([]);
    expect(joinParts(HEAD.trimEnd(), '')).toBe(HEAD);
    expect(joinParts(HEAD, NIX)).toBe(`${HEAD}${NIX}`);
  });

  it("keeps this repository's config split and valid", () => {
    const raw = readFileSync(join(ACTUAL_UPSTREAM, DEPENDABOT_FILE), 'utf8');
    expect(splitManaged(DEPENDABOT_FILE, raw)?.head).toContain(
      'package-ecosystem: "github-actions"',
    );
    expect(inspectDependabot(raw)).toEqual([]);
  });
});

describe('Dependabot shared blocks', () => {
  it.each([
    ['a key of the last shared block', '    open-pull-requests-limit: 0\n'],
    ['a key of its schedule', '      day: monday\n'],
    ['an ignore list', '    ignore:\n      - dependency-name: "*"\n'],
  ])('rejects own lines that change a shared block: %s', (_label, own) => {
    const raw = `${HEAD}${own}`;
    const changed = `${DEPENDABOT_FILE} changes shared update block 1 below "# Project-specific updates"`;

    expect(inspectDependabot(raw)).toEqual([expect.stringContaining(changed)]);
    expect(DEPENDABOT_SPLIT.verify?.(HEAD, raw)).toEqual([
      expect.stringContaining(changed),
    ]);
  });

  it('rejects a second marker line', () => {
    const raw = `${HEAD}${NIX}${DEPENDABOT_LOCAL_MARKER}\n`;

    expect(inspectDependabot(raw)).toEqual([
      `${DEPENDABOT_FILE} has more than one "# Project-specific updates" line; keep only the one below the shared update blocks`,
    ]);
    expect(DEPENDABOT_SPLIT.verify?.(HEAD, raw)).toHaveLength(1);
  });

  it('accepts own blocks that leave the shared ones as they are', () => {
    expect(DEPENDABOT_SPLIT.verify?.(HEAD, `${HEAD}${NIX}`)).toEqual([]);
    expect(DEPENDABOT_SPLIT.verify?.(HEAD, HEAD)).toEqual([]);
  });
});

const GROUP_HEAD = HEAD.replace(
  'updates:',
  'multi-ecosystem-groups:\n  infra:\n    schedule:\n      interval: weekly\nupdates:',
);

describe('Dependabot update blocks', () => {
  it.each([
    [
      'no package-ecosystem',
      rawBlock(['directory: /infra', 'schedule:', '  interval: weekly']),
      'update block 2 must set package-ecosystem',
    ],
    [
      'no directory',
      rawBlock(['package-ecosystem: nix', 'schedule:', '  interval: weekly']),
      'update block 2 must set directory or directories',
    ],
    [
      'no schedule',
      rawBlock(['package-ecosystem: bun', 'directory: /']),
      'update block 2 must set schedule.interval or join a multi-ecosystem group that sets it',
    ],
    [
      'a schedule without an interval',
      rawBlock(['package-ecosystem: nix', 'directory: /x', 'schedule: {}']),
      'update block 2 must set schedule.interval or join a multi-ecosystem group that sets it',
    ],
    ['a scalar', '  - nix\n', 'update block 2 must be a mapping'],
  ])('reports a block with %s', (_label, own, message) => {
    expect(inspectDependabot(`${HEAD}${own}`)).toEqual([
      `${DEPENDABOT_FILE} ${message}`,
    ]);
  });

  it('takes the schedule from the multi-ecosystem group a block joins', () => {
    const joining = (group: string): string =>
      `${GROUP_HEAD}${rawBlock([
        'package-ecosystem: nix',
        'directory: /infra',
        `multi-ecosystem-group: ${group}`,
        'patterns: ["*"]',
      ])}`;

    expect(inspectDependabot(joining('infra'))).toEqual([]);
    expect(inspectDependabot(joining('other'))).toEqual([
      `${DEPENDABOT_FILE} update block 2 must set schedule.interval or join a multi-ecosystem group that sets it`,
    ]);
  });
});

describe('Dependabot overlapping blocks', () => {
  it('accepts own blocks for other directories, ecosystems, and target branches', () => {
    const own = [
      NIX,
      block(['package-ecosystem: bun', 'directory: /', 'target-branch: next']),
      block(['package-ecosystem: npm', 'directories: ["/apps/*"]']),
      block(['package-ecosystem: bun', 'directory: /apps/web']),
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
    const problems = inspectDependabot(`${HEAD}${NIX}${block(lines)}`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('more than one update block for');
    expect(problems[0]).toContain(`directory "${shown}"`);
  });

  it.each(['/apps/*', '/apps/**', '/app?', '/{apps,tools}', '/[at]pps'])(
    'reports a glob %s next to a block for the same ecosystem and target branch',
    (glob) => {
      const own = block(['package-ecosystem: bun', `directories: ["${glob}"]`]);

      expect(inspectDependabot(`${HEAD}${own}`)).toEqual([
        `${DEPENDABOT_FILE} has more than one update block for package-ecosystem "bun", and one of them uses a directory glob; the CLI can't verify that globs don't overlap, so list this repository's directories explicitly`,
      ]);
    },
  );
});

describe('Dependabot config problems', () => {
  it.each([
    [
      'no marker',
      HEAD.replace(`${DEPENDABOT_LOCAL_MARKER}\n`, ''),
      `${DEPENDABOT_FILE} has no "# Project-specific updates" line; add that line, indented 2 spaces, at the end of the file, move this repository's own update blocks below it (sync replaces everything above it), then re-run`,
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
