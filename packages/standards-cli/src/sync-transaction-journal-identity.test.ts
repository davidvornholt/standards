import { expect, it } from 'bun:test';
import { parseJournal } from './sync-transaction-journal-parser';
import { expectedIdentity } from './sync-transaction-types';

const SHA256_LENGTH = 64;
const HASH = '0'.repeat(SHA256_LENGTH);
const UNSAFE_INTEGER = Number.MAX_SAFE_INTEGER + 1;
const HIGH_IDENTITY = '9007199254740992';
const ADJACENT_IDENTITY = '9007199254740993';
const currentJournal = {
  createdParents: [],
  id: '00000000-0000-4000-8000-000000000000',
  lockRel: 'sync-standards.lock',
  operations: [
    {
      backup: 'old-0',
      before: {
        dev: ADJACENT_IDENTITY,
        hash: HASH,
        ino: HIGH_IDENTITY,
        mode: 0o600,
      },
      desired: { hash: HASH, mode: 0o600 },
      kind: 'write',
      rel: 'sync-standards.lock',
      stage: 'new-0',
    },
  ],
  ownerPid: 1,
  ownerProcess: {
    bootId: '00000000-0000-0000-0000-000000000001',
    startTime: '1',
  },
  root: { dev: HIGH_IDENTITY, ino: ADJACENT_IDENTITY },
  version: 2,
};
const legacyJournal = {
  createdParents: [],
  id: '00000000-0000-4000-8000-000000000000',
  lockRel: 'sync-standards.lock',
  operations: [
    {
      backup: 'old-0',
      before: { dev: 1, hash: HASH, ino: 2, mode: 0o600 },
      desired: { hash: HASH, mode: 0o600 },
      kind: 'write',
      rel: 'sync-standards.lock',
      stage: 'new-0',
    },
  ],
  ownerPid: 1,
  root: { dev: 1, ino: Number.MAX_SAFE_INTEGER },
  version: 1,
};

it('preserves exact current journal identities through recovery decoding', () => {
  const parsed = parseJournal(JSON.stringify(currentJournal));
  const [operation] = parsed.operations;
  const rootIdentity = expectedIdentity({
    dev: parsed.root.dev,
    hash: HASH,
    ino: parsed.root.ino,
    mode: 0o600,
  });
  const beforeIdentity =
    operation === undefined ? null : expectedIdentity(operation.before);

  expect(parsed.root).toEqual({
    dev: HIGH_IDENTITY,
    ino: ADJACENT_IDENTITY,
  });
  expect(operation?.before).toEqual({
    dev: ADJACENT_IDENTITY,
    hash: HASH,
    ino: HIGH_IDENTITY,
    mode: 0o600,
  });
  expect(rootIdentity).toEqual({
    dev: 9_007_199_254_740_992n,
    ino: 9_007_199_254_740_993n,
  });
  expect(beforeIdentity).toEqual({
    dev: 9_007_199_254_740_993n,
    ino: 9_007_199_254_740_992n,
  });
  expect(rootIdentity).not.toEqual(beforeIdentity);
});

it('rejects numeric identities in a current journal', () => {
  const [operation] = currentJournal.operations;
  expect(() =>
    parseJournal(
      JSON.stringify({
        ...currentJournal,
        root: { ...currentJournal.root, dev: Number(HIGH_IDENTITY) },
      }),
    ),
  ).toThrow('canonical decimal filesystem identity');
  expect(() =>
    parseJournal(
      JSON.stringify({
        ...currentJournal,
        operations: [
          {
            ...operation,
            before: {
              ...operation.before,
              ino: Number(ADJACENT_IDENTITY),
            },
          },
        ],
      }),
    ),
  ).toThrow('canonical decimal filesystem identity');
});

it('normalizes only safe numeric identities in a legacy journal', () => {
  expect(parseJournal(JSON.stringify(legacyJournal)).root).toEqual({
    dev: '1',
    ino: String(Number.MAX_SAFE_INTEGER),
  });
  expect(() =>
    parseJournal(
      JSON.stringify({
        ...legacyJournal,
        root: { dev: 1, ino: UNSAFE_INTEGER },
      }),
    ),
  ).toThrow('canonical decimal filesystem identity');
  const [operation] = legacyJournal.operations;
  expect(() =>
    parseJournal(
      JSON.stringify({
        ...legacyJournal,
        operations: [
          {
            ...operation,
            before: { ...operation.before, ino: UNSAFE_INTEGER },
          },
        ],
      }),
    ),
  ).toThrow('canonical decimal filesystem identity');
});
