import { readFile } from 'node:fs/promises';
import { isRecord } from './github-settings-parse';

export const readJsonFile = async (
  path: string,
): Promise<Record<string, unknown> | null> => {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
