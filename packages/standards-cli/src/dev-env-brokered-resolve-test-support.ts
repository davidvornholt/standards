import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ComposedDevEnvTarget } from './dev-env-compose';

const EXECUTABLE_MODE = 0o755;
export type BrokeredFixture = {
  readonly consumer: string;
  readonly bin: string;
  readonly root: string;
};

export const brokeredFixture = (
  documents: Readonly<Record<string, unknown>>,
): BrokeredFixture => {
  const root = mkdtempSync(join(tmpdir(), 'dev-env-brokered-'));
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  const responses: Array<string> = [];
  for (const [rel, value] of Object.entries(documents)) {
    mkdirSync(dirname(join(consumer, rel)), { recursive: true });
    writeFileSync(join(consumer, rel), 'encrypted\n');
    responses.push(
      `    ${JSON.stringify(rel)}) printf '%s' ${JSON.stringify(JSON.stringify(value))} ;;`,
    );
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'sops'),
    [
      '#!/bin/sh',
      `echo "$4" >> ${JSON.stringify(join(root, 'calls.log'))}`,
      'case "$4" in',
      ...responses,
      '    *) echo "unexpected file $4" >&2; exit 1 ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(join(bin, 'sops'), EXECUTABLE_MODE);
  return { consumer, bin, root };
};

export const brokeredTarget = (
  env: ComposedDevEnvTarget['env'],
): ComposedDevEnvTarget => ({
  group: 'apps',
  workspace: 'web',
  env,
  sources: ['config/dev.yaml'],
});

export const pairReference = (part: 'access_key_id' | 'secret_access_key') => ({
  brokeredS3: 'r2-dev',
  key: 'r2.dev_rw',
  part,
});

export const ALLOWED_PAIR = new Set(['r2-dev:r2.dev_rw']);

export const sopsCalls = (consumer: string): ReadonlyArray<string> => {
  const log = join(consumer, '../calls.log');
  return existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    : [];
};
