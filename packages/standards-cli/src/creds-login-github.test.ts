import { describe, expect, it } from 'bun:test';
import {
  buildAppManifest,
  createManifestState,
  manifestFormHtml,
  parseConversion,
} from './creds-login-github';

const MANIFEST_STATE_HEX_LENGTH = 64;

describe('GitHub App manifest flow', () => {
  it('builds a manifest with an inactive webhook and the localhost redirect', () => {
    const manifest = buildAppManifest(
      'standards-broker',
      'http://127.0.0.1:4242/callback',
    );
    expect(manifest.name).toBe('standards-broker');
    expect(manifest.redirect_url).toBe('http://127.0.0.1:4242/callback');
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes).toEqual({
      url: 'https://example.invalid/unused',
      active: false,
    });
    expect(manifest.default_permissions).toMatchObject({
      contents: 'write',
      secrets: 'write',
    });
  });

  it('escapes the manifest JSON for the hidden form field', () => {
    const html = manifestFormHtml(
      'https://github.com/settings/apps/new',
      '{"name":"a","url":"https://x?y=1&z=2"}',
      'one-time-state',
    );
    expect(html).toContain('&quot;name&quot;');
    expect(html).toContain('&amp;z=2');
    expect(html).toContain(
      'action="https://github.com/settings/apps/new?state=one-time-state"',
    );
    expect(html).not.toContain('value="{"');
  });

  it('accepts only the matching manifest state once', () => {
    const state = createManifestState();
    const other = createManifestState();
    expect(state.value).not.toBe(other.value);
    expect(state.value).toHaveLength(MANIFEST_STATE_HEX_LENGTH);
    expect(state.accept(null)).toBe(false);
    expect(state.accept('')).toBe(false);
    expect(state.accept(other.value)).toBe(false);
    expect(state.accept(state.value)).toBe(true);
    expect(state.accept(state.value)).toBe(false);
  });

  it('parses a manifest conversion into broker app credentials', () => {
    expect(
      parseConversion({
        id: 7,
        slug: 'standards-broker',
        html_url: 'https://github.com/apps/standards-broker',
        client_id: 'Iv1.abc',
        pem: '-----BEGIN RSA PRIVATE KEY-----\n...',
        webhook_secret: null,
      }),
    ).toEqual({
      appId: 7,
      slug: 'standards-broker',
      htmlUrl: 'https://github.com/apps/standards-broker',
      clientId: 'Iv1.abc',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\n...',
    });
  });

  it('rejects conversion responses missing credentials', () => {
    expect(parseConversion({ id: 7, slug: 'x' })).toBeNull();
    expect(parseConversion('nope')).toBeNull();
  });
});
