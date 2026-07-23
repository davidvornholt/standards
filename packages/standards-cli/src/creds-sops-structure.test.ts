import { describe, expect, it } from 'bun:test';
import { listEncryptedKeys } from './creds-sops';

const encryptedDocument = (body: string): string =>
  `ci:\n${body}sops:\n  version: 3.9.0\n`;

describe('SOPS YAML key structure', () => {
  it.each([
    ['numeric', '  1: encrypted-number\n  "1": encrypted-string\n'],
    ['boolean', '  true: encrypted-boolean\n  "true": encrypted-string\n'],
    ['null', '  null: encrypted-null\n  "null": encrypted-string\n'],
    [
      'explicit tag',
      '  !!str tagged: encrypted-tagged\n  "tagged_sibling": encrypted-string\n',
    ],
  ])('rejects %s keys alongside quoted-string siblings', (_label, body) => {
    expect(listEncryptedKeys(encryptedDocument(body))).toMatchObject({
      ok: false,
      kind: 'unsupported-shape',
    });
  });

  it('allows unambiguous plain and quoted string keys', () => {
    const text = encryptedDocument(
      '  plain_key: encrypted\n  "double_key": encrypted\n  \'single_key\': encrypted\n',
    );
    expect(listEncryptedKeys(text)).toEqual({
      ok: true,
      keys: ['ci.plain_key', 'ci.double_key', 'ci.single_key'],
    });
  });

  it('still rejects arrays after AST validation', () => {
    expect(
      listEncryptedKeys(encryptedDocument('  tokens: [one, two]\n')),
    ).toMatchObject({
      ok: false,
      kind: 'unsupported-shape',
    });
  });
});
