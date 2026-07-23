import { describe, expect, it, mock, spyOn } from 'bun:test';
import {
  buildAppManifest,
  createManifestState,
  githubInstallMessage,
  manifestFormHtml,
  parseConversion,
  startManifestLoginListener,
  waitForCode,
} from './creds-login-github';

const MANIFEST_STATE_HEX_LENGTH = 64;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const LISTENER_TIMEOUT_MS = 5000;
const STATE_QUERY = /[?&]state=(?<state>[a-f0-9]+)/u;

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
});

describe('GitHub App manifest listener', () => {
  it('keeps the form behind a separate one-time start capability', async () => {
    const listener = startManifestLoginListener(
      (port, state) =>
        manifestFormHtml(
          'https://github.com/settings/apps/new',
          JSON.stringify(
            buildAppManifest(
              'standards-broker',
              `http://127.0.0.1:${port}/callback`,
            ),
          ),
          state,
        ),
      LISTENER_TIMEOUT_MS,
    );
    const { origin } = new URL(listener.startUrl);
    try {
      const root = await fetch(`${origin}/`);
      const rootBody = await root.text();
      expect(root.status).toBe(HTTP_NOT_FOUND);
      const unknown = await fetch(`${origin}/unknown`);
      const unknownBody = await unknown.text();
      expect(unknown.status).toBe(HTTP_NOT_FOUND);

      const start = await fetch(listener.startUrl);
      const form = await start.text();
      expect(start.status).toBe(HTTP_OK);
      const state = form.match(STATE_QUERY)?.groups?.state ?? '';
      expect(state).toHaveLength(MANIFEST_STATE_HEX_LENGTH);
      expect(rootBody).not.toContain(state);
      expect(unknownBody).not.toContain(state);

      const consumedStart = await fetch(listener.startUrl);
      expect(consumedStart.status).toBe(HTTP_NOT_FOUND);
      expect(await consumedStart.text()).not.toContain(state);
      expect((await fetch(`${origin}/callback?code=missing`)).status).toBe(
        HTTP_BAD_REQUEST,
      );
      expect(
        (
          await fetch(
            `${origin}/callback?code=wrong&state=${'0'.repeat(MANIFEST_STATE_HEX_LENGTH)}`,
          )
        ).status,
      ).toBe(HTTP_BAD_REQUEST);
      const callback = `${origin}/callback?code=created&state=${state}`;
      expect((await fetch(callback)).status).toBe(HTTP_OK);
      expect((await fetch(callback)).status).toBe(HTTP_BAD_REQUEST);
      expect(await listener.code).toBe('created');
    } finally {
      listener.close();
    }
  });

  it('instructs installation only on selected repositories', () => {
    const output = githubInstallMessage('https://github.com/apps/broker');
    expect(output).toContain('selected repositories');
    expect(output).not.toContain('All repositories');
  });

  it('prints the exact manual start URL before a no-op opener', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const opener = mock((_url: string) => undefined);
    try {
      const code = waitForCode(
        (_port, state) =>
          manifestFormHtml(
            'https://github.com/settings/apps/new',
            '{"name":"standards-broker"}',
            state,
          ),
        opener,
      );
      const startUrl = opener.mock.calls[0]?.[0] ?? '';
      const start = await fetch(startUrl);
      const callbackState =
        (await start.text()).match(STATE_QUERY)?.groups?.state ?? '';
      const { origin } = new URL(startUrl);
      const callback = await fetch(
        `${origin}/callback?code=manual&state=${callbackState}`,
      );
      expect(await code).toBe('manual');
      expect(callback.status).toBe(HTTP_OK);
      expect(opener).toHaveBeenCalledWith(startUrl);
      expect(log).toHaveBeenCalledWith(
        `Open ${startUrl} to create the GitHub App.`,
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe('GitHub App manifest conversion', () => {
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
