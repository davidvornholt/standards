// Deterministic block-style YAML for JSON-shaped data. Bun ships a YAML
// serializer, but it emits flow style, and generated files must stay readable
// in consumer diffs. Like cli.ts, this module is zero-dependency so `bunx` can
// execute the published package.

import { isRecord } from './github-settings-parse';

const isScalar = (value: unknown): boolean =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const BARE_KEY = /^[A-Za-z0-9_-]+$/u;

const emitKey = (key: string): string =>
  BARE_KEY.test(key) ? key : JSON.stringify(key);

// Strings are always double-quoted; JSON string syntax is valid YAML.
const emitScalar = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value) : String(value);

const emitEntry = (
  key: string,
  value: unknown,
  indent: string,
): Array<string> => {
  if (isScalar(value)) {
    return [`${indent}${key}: ${emitScalar(value)}`];
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? [`${indent}${key}: []`]
      : [
          `${indent}${key}:`,
          ...value.flatMap((item) => emitItem(item, `${indent}  `)),
        ];
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0
      ? [`${indent}${key}: {}`]
      : [`${indent}${key}:`, ...emitEntries(value, `${indent}  `)];
  }
  throw new Error(`Unsupported YAML value under key "${key}"`);
};

const emitEntries = (
  record: Record<string, unknown>,
  indent: string,
): Array<string> =>
  Object.entries(record).flatMap(([key, value]) =>
    emitEntry(emitKey(key), value, indent),
  );

const emitItem = (item: unknown, indent: string): Array<string> => {
  if (isScalar(item)) {
    return [`${indent}- ${emitScalar(item)}`];
  }
  if (isRecord(item) && Object.keys(item).length > 0) {
    const lines = emitEntries(item, `${indent}  `);
    return [`${indent}- ${(lines[0] ?? '').trimStart()}`, ...lines.slice(1)];
  }
  throw new Error('Unsupported YAML sequence item');
};

export const emitYamlDocument = (document: Record<string, unknown>): string =>
  `${emitEntries(document, '').join('\n')}\n`;
