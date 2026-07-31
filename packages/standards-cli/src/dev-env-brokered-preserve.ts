import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevEnvValue } from './dev-env-document';
import { preserveRenderedDotenvValues, renderDotenv } from './dev-env-dotenv';

export type DevEnvRunOptions = {
  readonly preservedBrokeredReferences: ReadonlySet<string>;
};

type RenderInput = {
  readonly consumer: string;
  readonly rel: string;
  readonly sourcePath: string;
  readonly sources: ReadonlyArray<string>;
  readonly resolvedEnv: Readonly<Record<string, string>>;
  readonly composedEnv: Readonly<Record<string, DevEnvValue>>;
  readonly preservedReferences: ReadonlySet<string>;
};

type RenderResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly problem: string };

const preservedKeys = (
  env: Readonly<Record<string, DevEnvValue>>,
  references: ReadonlySet<string>,
): ReadonlyArray<string> =>
  Object.entries(env).flatMap(([key, value]) =>
    typeof value !== 'string' &&
    references.has(`${value.brokeredS3}:${value.key}`)
      ? [key]
      : [],
  );

export const renderDevEnvPreservingUnsafeReferences = (
  input: RenderInput,
): RenderResult => {
  const rendered = renderDotenv(
    input.sourcePath,
    input.sources,
    input.resolvedEnv,
  );
  const keys = preservedKeys(input.composedEnv, input.preservedReferences);
  if (keys.length === 0) {
    return { ok: true, content: rendered };
  }
  let previous: string;
  try {
    const path = join(input.consumer, input.rel);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('not a regular file');
    }
    previous = readFileSync(path, 'utf8');
  } catch {
    return {
      ok: false,
      problem: `${input.rel} has no readable prior generated values for unsafe brokered references`,
    };
  }
  const preserved = preserveRenderedDotenvValues(previous, rendered, keys);
  return preserved.ok
    ? preserved
    : { ok: false, problem: `${input.rel}: ${preserved.problem}` };
};
