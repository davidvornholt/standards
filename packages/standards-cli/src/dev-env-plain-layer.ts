// Reads one plain (unencrypted) dev env layer from disk, distinguishing a
// missing optional file from an unreadable or unparsable one.

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml-parse';

export type DevEnvPlainInput = { readonly raw: unknown } | null;

export type PlainLayerRead = {
  readonly input: DevEnvPlainInput;
  readonly present: boolean;
  readonly problems: ReadonlyArray<string>;
};

const isMissingPathError = (error: unknown): boolean =>
  (error as { readonly code?: unknown } | null)?.code === 'ENOENT';

export const readPlainLayer = (
  consumer: string,
  rel: string,
): PlainLayerRead => {
  const path = join(consumer, rel);
  try {
    lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { input: null, present: false, problems: [] };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      input: null,
      present: true,
      problems: [`could not inspect ${rel}: ${detail}`],
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      input: null,
      present: true,
      problems: [`could not read ${rel}: ${detail}`],
    };
  }
  const parsed = parseYaml(raw, rel);
  if (parsed.problem !== null) {
    return { input: null, present: true, problems: [parsed.problem] };
  }
  return { input: { raw: parsed.value ?? {} }, present: true, problems: [] };
};
