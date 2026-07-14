import { describe, expect, it } from 'bun:test';
import {
  captureLinuxProcessIdentity,
  inspectLegacyProcess,
  inspectLinuxProcessIdentity,
  type ProcessIdentityReader,
  parseLinuxProcStatStartTime,
  parseStoredLinuxProcessIdentity,
} from './sync-process-identity';

const bootId = '11111111-1111-4111-8111-111111111111';
const pid = 42;
const startTime = '98765';
const stat = (statPid: number, statStartTime: string): string =>
  `${statPid} (worker ) command) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${statStartTime}`;

const reader =
  (
    readerPid: number,
    readerStartTime: string,
    boot = bootId,
  ): ProcessIdentityReader =>
  (path) =>
    path.endsWith('/stat') ? stat(readerPid, readerStartTime) : `${boot}\n`;

describe('Linux process identity', () => {
  it('parses start time after a parenthesized command containing spaces', () => {
    expect(parseLinuxProcStatStartTime(stat(pid, startTime), pid)).toBe(
      startTime,
    );
  });

  it('captures and recognizes a stable process identity', () => {
    const identity = captureLinuxProcessIdentity(pid, reader(pid, startTime));
    expect(identity).toEqual({ bootId, startTime });
    expect(
      inspectLinuxProcessIdentity(pid, identity, reader(pid, startTime)),
    ).toBe('active');
  });

  it('treats a reused PID or changed boot as a dead original writer', () => {
    const identity = { bootId, startTime };
    expect(inspectLinuxProcessIdentity(pid, identity, reader(pid, '123'))).toBe(
      'dead',
    );
    expect(
      inspectLinuxProcessIdentity(
        pid,
        identity,
        reader(pid, startTime, '22222222-2222-4222-8222-222222222222'),
      ),
    ).toBe('dead');
  });

  it('fails closed on an indeterminate process read', () => {
    const identity = { bootId, startTime };
    const denied: ProcessIdentityReader = (path) => {
      if (path.endsWith('/stat')) {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }
      return bootId;
    };
    expect(inspectLinuxProcessIdentity(pid, identity, denied)).toBe(
      'indeterminate',
    );
  });

  it('distinguishes missing and indeterminate legacy owners', () => {
    expect(inspectLegacyProcess(pid, () => undefined)).toBe('active');
    expect(
      inspectLegacyProcess(pid, () => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }),
    ).toBe('dead');
    expect(
      inspectLegacyProcess(pid, () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }),
    ).toBe('indeterminate');
  });

  it('rejects malformed stored identities', () => {
    expect(() =>
      parseStoredLinuxProcessIdentity({ bootId, startTime: '1', extra: true }),
    ).toThrow('ownerProcess is invalid');
  });
});
