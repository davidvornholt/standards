import { afterEach, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runPollerCommand } from './poller-commands';

const originalGhToken = process.env.GH_TOKEN;
const originalPath = process.env.PATH;
const dirs: Array<string> = [];
const restoreMocks: Array<() => void> = [];

afterEach(() => {
  for (const restore of restoreMocks.splice(0)) {
    restore();
  }
  process.env.GH_TOKEN = originalGhToken;
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('fails before discovery when gh is unavailable to Codex', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poller-command-'));
  dirs.push(dir);
  const configPath = join(dir, 'poller.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      repos: ['owner/repo'],
      model: 'gpt-test',
      reasoningEffort: 'high',
    }),
  );
  process.env.GH_TOKEN = 'test-token';
  process.env.PATH = dir;
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
  restoreMocks.push(() => error.mockRestore());

  expect(
    await runPollerCommand({
      configPath,
      printUnits: false,
      acknowledgeOnly: false,
    }),
  ).toBeFalse();
  expect(error).toHaveBeenCalledWith(
    'standards poller: gh is required on PATH for authenticated Codex GitHub access',
  );
});
