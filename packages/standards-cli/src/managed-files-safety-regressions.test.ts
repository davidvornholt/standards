import { afterEach, expect, it } from 'bun:test';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, write } from './cli-test-support';
import {
  buildUpstream,
  engineFor,
  LINK,
  SKILL,
} from './managed-files-symlink-test-support';

const { initConsumer, run } = engineFor({ ...process.env });
afterEach(cleanupTmpDirs);

it('refuses a link-to-directory downgrade before changing canonical content', () => {
  const { consumer } = initConsumer(buildUpstream());
  const old = buildUpstream({ claudeSkills: 'directory' });
  write(old, `${LINK}/probe/SKILL.md`, 'different duplicate\n');
  const original = readFileSync(join(consumer, SKILL), 'utf8');
  for (const extra of [['--dry-run'], []]) {
    const result = run(consumer, [
      'sync',
      '--from',
      old,
      '--dir',
      consumer,
      ...extra,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`below the symlink ${LINK}`);
    expect(readFileSync(join(consumer, SKILL), 'utf8')).toBe(original);
  }
});

it('rejects a non-file Dependabot overlay seed before initialization writes', () => {
  const up = buildUpstream();
  rmSync(join(up, 'template/.github/dependabot.local.yml'), { force: true });
  write(up, 'template/.github/overlay.yml', '# overlay\n');
  symlinkSync('overlay.yml', join(up, 'template/.github/dependabot.local.yml'));
  const { result } = initConsumer(up);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    'dependabot.local.yml must be a regular file',
  );
});

it('counts already absent lock entries as a real lock change', () => {
  const legacy = 'docs/legacy.md';
  const { consumer } = initConsumer(buildUpstream({ extra: [legacy] }));
  rmSync(join(consumer, legacy));
  const up = buildUpstream();
  const result = run(consumer, [
    'sync',
    '--from',
    up,
    '--dir',
    consumer,
    '--dry-run',
  ]);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('already in sync');
  expect(result.stdout).toContain('1 to drop from the lock without deleting');
});

it('never advises deleting a directory receiving canonical descendants', () => {
  const legacy = 'docs/legacy.md';
  const { consumer } = initConsumer(buildUpstream({ extra: [legacy] }));
  rmSync(join(consumer, legacy));
  write(consumer, `${legacy}/notes.md`, 'local notes\n');
  const up = buildUpstream({ extra: [`${legacy}/canonical.md`] });
  for (const extra of [['--dry-run'], []]) {
    const result = run(consumer, [
      'sync',
      '--from',
      up,
      '--dir',
      consumer,
      ...extra,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('keep those managed descendants');
    expect(result.stdout).not.toContain('delete it yourself');
  }
});

it('reports removals below a planned plain file without calling it a symlink', () => {
  const legacy = 'docs/legacy.md';
  const { consumer } = initConsumer(
    buildUpstream({ extra: [`${legacy}/child.md`] }),
  );
  const up = buildUpstream({ extra: [legacy] });
  for (const extra of [['--dry-run'], []]) {
    const result = run(consumer, [
      'sync',
      '--from',
      up,
      '--dir',
      consumer,
      ...extra,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${legacy}/child.md (removed upstream)`);
    expect(result.stdout).not.toContain(`below the symlink ${legacy}`);
  }
});

it('refuses an upstream link whose target is absent from the managed payload', () => {
  const up = buildUpstream({ target: '../.agents/unmanaged' });
  write(up, '.agents/unmanaged/SKILL.md', 'not in payload\n');
  const { result } = initConsumer(up);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('missing from the managed payload');
});

it('checks that a locked symlink still has a delivered target', () => {
  const { consumer } = initConsumer(buildUpstream());
  rmSync(join(consumer, SKILL));
  const result = run(consumer, ['check', '--dir', consumer]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('missing from the managed payload');
});
