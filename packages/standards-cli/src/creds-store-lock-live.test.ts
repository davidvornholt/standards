import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { withBrokerLock } from './creds-store-lock';

const SCALED_STALE_MS = 10;
const SCALED = {
  timeoutMs: 500,
  retryMs: 2,
  staleMs: SCALED_STALE_MS,
};
const dirs: Array<string> = [];

const mkStorePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-lock-live-'));
  dirs.push(dir);
  return join(dir, 'broker.yaml');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('broker store live-lock ownership', () => {
  it('keeps delayed SOPS, same-owner replacement, and another contender exclusive past staleness', async () => {
    const path = mkStorePath();
    const events: Array<string> = [];
    let active = 0;
    let maximumActive = 0;
    let releaseSops = (): void => undefined;
    let markSopsStarted = (): void => undefined;
    const sopsStarted = new Promise<void>((resolve) => {
      markSopsStarted = resolve;
    });
    const sopsRelease = new Promise<void>((resolve) => {
      releaseSops = resolve;
    });
    const operation = (
      name: string,
      wait: Promise<void> | null = null,
    ): Promise<void> =>
      withBrokerLock(
        path,
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          events.push(`${name}-start`);
          if (name === 'sops') {
            markSopsStarted();
          }
          if (wait !== null) {
            await wait;
          }
          events.push(`${name}-end`);
          active -= 1;
        },
        SCALED,
      );
    const sops = operation('sops', sopsRelease);
    await sopsStarted;
    await new Promise((resolve) => setTimeout(resolve, SCALED_STALE_MS * 2));
    const replacement = operation('same-owner-replacement');
    const contender = operation('other-contender');
    await new Promise((resolve) => setTimeout(resolve, SCALED_STALE_MS * 2));

    expect(events).toEqual(['sops-start']);
    expect(maximumActive).toBe(1);
    releaseSops();
    await Promise.all([sops, replacement, contender]);

    expect(maximumActive).toBe(1);
    expect(events.slice(0, 2)).toEqual(['sops-start', 'sops-end']);
    expect(new Set(events.slice(2))).toEqual(
      new Set([
        'same-owner-replacement-start',
        'same-owner-replacement-end',
        'other-contender-start',
        'other-contender-end',
      ]),
    );
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('does not remove a replacement lock generation during release', async () => {
    const path = mkStorePath();
    const lock = `${path}.lock`;
    const replacement = join(lock, 'holder-replacement.json');
    await withBrokerLock(
      path,
      () => {
        const [ownHolder] = readdirSync(lock);
        if (ownHolder === undefined) {
          throw new Error('expected holder token');
        }
        unlinkSync(join(lock, ownHolder));
        rmdirSync(lock);
        mkdirSync(lock);
        writeFileSync(replacement, JSON.stringify({ pid: process.pid }));
        return Promise.resolve();
      },
      SCALED,
    );

    expect(readdirSync(lock)).toEqual(['holder-replacement.json']);
  });
});
