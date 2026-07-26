// This repository's own instance of the managed-symlink shape. The suites
// beside this one cover the class; nothing else covers the canonical payload
// actually carrying the link, which is what every consumer receives.

import { describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ACTUAL_UPSTREAM } from './cli-test-support';

const LINK = '.claude/skills';
const TARGET = '../.agents/skills';

describe('canonical .claude/skills link', () => {
  it('is a symlink in the tree, not a regular file holding its target text', () => {
    const link = join(ACTUAL_UPSTREAM, LINK);

    // A checkout without `core.symlinks=true` produces a text file here, which
    // leaves the consumer permanently drifted; the payload itself must not.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(TARGET);
  });

  it('resolves to the tool-agnostic skills it exists to expose', () => {
    expect(
      existsSync(join(ACTUAL_UPSTREAM, LINK, 'standards-sync/SKILL.md')),
    ).toBe(true);
  });

  it('is declared as a managed path so consumers receive it', () => {
    const manifest = JSON.parse(
      readFileSync(join(ACTUAL_UPSTREAM, 'sync-standards.json'), 'utf8'),
    ) as { paths: ReadonlyArray<string> };

    expect(manifest.paths).toContain(LINK);
  });
});
