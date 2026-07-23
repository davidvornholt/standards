import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ACTUAL_UPSTREAM } from './cli-test-support';

export const DIGEST_LENGTH = 64;
export const SHA_LENGTH = 40;
export const DIGEST_A = `sha256:${'a'.repeat(DIGEST_LENGTH)}`;
export const DIGEST_B = `sha256:${'b'.repeat(DIGEST_LENGTH)}`;
export const DIGEST_C = `sha256:${'c'.repeat(DIGEST_LENGTH)}`;
export const SHA_A = 'a'.repeat(SHA_LENGTH);
export const SHA_B = 'b'.repeat(SHA_LENGTH);
export const SHA_C = 'c'.repeat(SHA_LENGTH);
const document = readFileSync(
  join(
    ACTUAL_UPSTREAM,
    '.agents/skills/declarative-infra/references/image-promotion.md',
  ),
  'utf8',
);

export const contract = (name: string, language: string): string => {
  const fence = '```';
  const pattern =
    `<!-- contract:${name} -->\\n${fence}${language}\\n` +
    `([\\s\\S]*?)\\n${fence}`;
  const content = document.match(new RegExp(pattern, 'u'))?.[1];
  if (content === undefined) {
    throw new Error(`missing ${name} contract`);
  }
  return content;
};

export const yamlContract = <T>(name: string): T =>
  parse(contract(name, 'yaml')) as T;

export const environment = (
  entries: ReadonlyArray<readonly [string, string | undefined]>,
): Readonly<Record<string, string | undefined>> => Object.fromEntries(entries);
