import { readFileSync } from 'node:fs';
import process from 'node:process';

const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const BOOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DECIMAL = /^\d+$/u;
const WHITESPACE = /\s+/u;
const START_TIME_INDEX = 19;

export type LinuxProcessIdentity = {
  readonly bootId: string;
  readonly startTime: string;
};

export type ProcessIdentityStatus = 'active' | 'dead' | 'indeterminate';

export type ProcessIdentityReader = (path: string) => string;

const defaultReader: ProcessIdentityReader = (path) =>
  readFileSync(path, 'utf8');

const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;

export const parseLinuxBootId = (contents: string): string => {
  const bootId = contents.trim();
  if (!BOOT_ID.test(bootId)) {
    throw new Error('Linux boot ID is invalid');
  }
  return bootId;
};

export const parseLinuxProcStatStartTime = (
  contents: string,
  expectedPid: number,
): string => {
  const commandStart = contents.indexOf(' (');
  const commandEnd = contents.lastIndexOf(') ');
  if (
    commandStart <= 0 ||
    commandEnd <= commandStart ||
    contents.slice(0, commandStart) !== String(expectedPid)
  ) {
    throw new Error('Linux process stat identity is invalid');
  }
  const fields = contents
    .slice(commandEnd + 2)
    .trim()
    .split(WHITESPACE);
  const [state] = fields;
  const startTime = fields[START_TIME_INDEX];
  if (
    state === undefined ||
    state.length !== 1 ||
    startTime === undefined ||
    !DECIMAL.test(startTime)
  ) {
    throw new Error('Linux process stat identity is invalid');
  }
  return startTime;
};

export const parseStoredLinuxProcessIdentity = (
  value: unknown,
): LinuxProcessIdentity => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('transaction journal ownerProcess is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'bootId,startTime' ||
    typeof record.bootId !== 'string' ||
    !BOOT_ID.test(record.bootId) ||
    typeof record.startTime !== 'string' ||
    !DECIMAL.test(record.startTime)
  ) {
    throw new Error('transaction journal ownerProcess is invalid');
  }
  return { bootId: record.bootId, startTime: record.startTime };
};

export const captureLinuxProcessIdentity = (
  pid = process.pid,
  read: ProcessIdentityReader = defaultReader,
): LinuxProcessIdentity => ({
  bootId: parseLinuxBootId(read(BOOT_ID_PATH)),
  startTime: parseLinuxProcStatStartTime(read(`/proc/${pid}/stat`), pid),
});

export const inspectLinuxProcessIdentity = (
  pid: number,
  expected: LinuxProcessIdentity,
  read: ProcessIdentityReader = defaultReader,
): ProcessIdentityStatus => {
  let bootId: string;
  try {
    bootId = parseLinuxBootId(read(BOOT_ID_PATH));
  } catch {
    return 'indeterminate';
  }
  if (bootId !== expected.bootId) {
    return 'dead';
  }
  let startTime: string;
  try {
    startTime = parseLinuxProcStatStartTime(read(`/proc/${pid}/stat`), pid);
  } catch (error) {
    return errorCode(error) === 'ENOENT' || errorCode(error) === 'ESRCH'
      ? 'dead'
      : 'indeterminate';
  }
  return startTime === expected.startTime ? 'active' : 'dead';
};

export const inspectLegacyProcess = (
  pid: number,
  signal: (pid: number, signal: 0) => void = process.kill,
): ProcessIdentityStatus => {
  try {
    signal(pid, 0);
    return 'active';
  } catch (error) {
    return errorCode(error) === 'ESRCH' ? 'dead' : 'indeterminate';
  }
};
