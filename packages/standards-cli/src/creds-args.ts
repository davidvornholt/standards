import { resolve } from 'node:path';
import process from 'node:process';
import {
  DEFAULT_R2_JURISDICTION,
  isR2Jurisdiction,
  type R2Jurisdiction,
} from './creds-r2';

const DAY_MS = 86_400_000;
const MAX_PROVIDER_EXPIRATION_MS = Date.parse('9999-12-31T23:59:59.999Z');
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

export type CredsFlags = {
  dir: string;
  dest: string | undefined;
  permissions: string | undefined;
  account: string | undefined;
  ttlDays: number | undefined;
  bucket: string | undefined;
  jurisdiction: R2Jurisdiction;
  s3: boolean;
  org: string | undefined;
  name: string | undefined;
  readonly words: Array<string>;
};

const flagValue = (argv: ReadonlyArray<string>, index: number): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${argv[index]} requires a value`);
  }
  return value;
};

export const parseTtlDays = (raw: string): number => {
  const ttlDays = Number(raw);
  if (
    !(POSITIVE_INTEGER.test(raw) && Number.isSafeInteger(ttlDays)) ||
    Date.now() + ttlDays * DAY_MS > MAX_PROVIDER_EXPIRATION_MS
  ) {
    throw new Error('--ttl-days must be a provider-safe positive integer');
  }
  return ttlDays;
};

export const parseCredsArgs = (argv: ReadonlyArray<string>): CredsFlags => {
  const flags: CredsFlags = {
    dir: process.cwd(),
    dest: undefined,
    permissions: undefined,
    account: undefined,
    ttlDays: undefined,
    bucket: undefined,
    jurisdiction: DEFAULT_R2_JURISDICTION,
    s3: false,
    org: undefined,
    name: undefined,
    words: [],
  };
  const setters: Readonly<Record<string, (value: string) => void>> = {
    '--dir': (value) => {
      flags.dir = value;
    },
    '--dest': (value) => {
      flags.dest = value;
    },
    '--permissions': (value) => {
      flags.permissions = value;
    },
    '--account': (value) => {
      flags.account = value;
    },
    '--ttl-days': (value) => {
      flags.ttlDays = parseTtlDays(value);
    },
    '--bucket': (value) => {
      flags.bucket = value;
    },
    '--jurisdiction': (value) => {
      if (!isR2Jurisdiction(value)) {
        throw new Error('--jurisdiction must be default or eu');
      }
      flags.jurisdiction = value;
    },
    '--org': (value) => {
      flags.org = value;
    },
    '--name': (value) => {
      flags.name = value;
    },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const setter = setters[arg];
    if (arg === '--s3') {
      flags.s3 = true;
    } else if (setter !== undefined) {
      setter(flagValue(argv, index));
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown creds option: ${arg}`);
    } else {
      flags.words.push(arg);
    }
  }
  flags.dir = resolve(flags.dir);
  return flags;
};
