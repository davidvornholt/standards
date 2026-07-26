import { describe, expect, it } from 'bun:test';
import { parseConversion } from './creds-login-github-manifest';

describe('GitHub App manifest conversion validation', () => {
  it.each([
    ['non-integer App id', { id: 7.5 }],
    ['empty owner', { owner: { login: '' } }],
    ['empty slug', { slug: '' }],
    // biome-ignore lint/style/useNamingConvention: GitHub's manifest conversion wire contract uses snake_case.
    ['empty URL', { html_url: '' }],
    // biome-ignore lint/style/useNamingConvention: GitHub's manifest conversion wire contract uses snake_case.
    ['empty client id', { client_id: '' }],
    ['empty private key', { pem: '' }],
  ])('rejects a %s', (_, replacement) => {
    expect(
      parseConversion({
        id: 7,
        slug: 'standards-broker',
        // biome-ignore lint/style/useNamingConvention: GitHub's manifest conversion wire contract uses snake_case.
        html_url: 'https://github.com/apps/standards-broker',
        // biome-ignore lint/style/useNamingConvention: GitHub's manifest conversion wire contract uses snake_case.
        client_id: 'Iv1.abc',
        pem: 'private-key',
        owner: { login: 'davidvornholt' },
        ...replacement,
      }),
    ).toBeNull();
  });
});
