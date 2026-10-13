import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const runner = join(import.meta.dir, 'a11y-playwright.ts');
const fallbackNotice =
  /^a11y-playwright: no private network namespace \(.+\); running on the host network\n$/u;
const scratchDirectories: Array<string> = [];

// Stand-ins for the host: `unshare` fails as it does where unprivileged user
// namespaces are restricted, so the runner takes its fallback path on any
// platform, and `playwright` reports what it received.
const startRunner = (playwright: string, args: ReadonlyArray<string> = []) => {
  const directory = mkdtempSync(join(tmpdir(), 'a11y-playwright-'));
  scratchDirectories.push(directory);
  const programs = {
    unshare:
      'echo "unshare: write failed /proc/self/uid_map: Operation not permitted" >&2\nexit 1',
    playwright,
  };
  for (const [name, script] of Object.entries(programs)) {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }
  return globalThis.Bun.spawn(['bun', runner, ...args], {
    cwd: directory,
    env: {
      ...process.env,
      ...Object.fromEntries([['PATH', `${directory}:${process.env.PATH}`]]),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
};

// Reads the output as it arrives. Each call reads until `enough` accepts the
// text so far or the output ends, and returns all text read until then.
const outputReader = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const readUntil = async (
    enough: (output: string) => boolean,
  ): Promise<string> => {
    if (enough(text)) {
      return text;
    }
    const chunk = await reader.read();
    if (chunk.done) {
      return text;
    }
    text += decoder.decode(chunk.value, { stream: true });
    return readUntil(enough);
  };
  return readUntil;
};

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('a11y-playwright', () => {
  it('passes arguments, stdin, working directory, and exit code through', async () => {
    const run = startRunner(
      'printf "%s\\n" "$(basename "$PWD")" "$@"; cat; exit 7',
      ['--repeat-each=5', 'a b', '$HOME'],
    );
    run.stdin.write('from stdin\n');
    await run.stdin.end();

    expect(await run.exited).toBe(7);
    const directory = scratchDirectories.at(-1) ?? '';
    expect(await new Response(run.stdout).text()).toBe(
      `${directory.split('/').at(-1)}\ntest\n--repeat-each=5\na b\n$HOME\nfrom stdin\n`,
    );
    expect(await new Response(run.stderr).text()).toMatch(fallbackNotice);
  });

  it('forwards SIGTERM to Playwright and waits for it to finish', async () => {
    const run = startRunner(
      'trap "echo stopping; exit 143" TERM\necho ready\nwhile :; do sleep 0.05; done',
    );
    const output = outputReader(run.stdout);
    await output((text) => text.includes('ready\n'));
    run.kill('SIGTERM');

    expect(await run.exited).toBe(143);
    expect(await output(() => false)).toBe('ready\nstopping\n');
  });

  it('ends with the signal that ended Playwright', async () => {
    const run = startRunner('kill -INT $$');
    await run.exited;

    expect(run.signalCode).toBe('SIGINT');
  });
});
