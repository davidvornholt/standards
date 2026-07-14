import { expect, it } from 'bun:test';
import { mountIdForPath, parseMountInfo } from './sync-mount-identity';

const PARENT_MOUNT_ID = 11;
const FILE_MOUNT_ID = 12;

it('decodes mountinfo paths and selects the deepest file mount', () => {
  const entries = parseMountInfo(
    [
      '10 1 0:1 / / rw - rootfs rootfs rw',
      '11 10 0:2 / /repo\\040root rw - tmpfs tmpfs rw',
      '12 11 0:2 /source /repo\\040root/managed/a.txt rw - tmpfs tmpfs rw',
    ].join('\n'),
  );

  expect(mountIdForPath('/repo root/managed', entries)).toBe(PARENT_MOUNT_ID);
  expect(mountIdForPath('/repo root/managed/a.txt', entries)).toBe(
    FILE_MOUNT_ID,
  );
});

it('accepts root mount parents and unknown optional fields', () => {
  const entries = parseMountInfo(
    '10 0 0:1 /source\\040root /repo rw future:tag - rootfs rootfs rw',
  );

  expect(mountIdForPath('/repo/managed', entries)).toBe(10);
});

it('fails closed on malformed or truncated mountinfo records', () => {
  expect(() => parseMountInfo('1e2 bad bad bad /')).toThrow(
    'Linux mountinfo contains an invalid mount entry',
  );
  expect(() => parseMountInfo('10 1 0:1 / / rw rootfs rootfs rw')).toThrow(
    'Linux mountinfo contains an invalid mount entry',
  );
  expect(() =>
    parseMountInfo('10 1 0:1 / /bad\\999 rw - rootfs rootfs rw'),
  ).toThrow('Linux mountinfo contains an invalid path escape');
  expect(() =>
    parseMountInfo('10 1 0:1 /bad\\999 / rw - rootfs rootfs rw'),
  ).toThrow('Linux mountinfo contains an invalid path escape');
});
