import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadScreenshotsConfig } from './screenshots-config';
import {
  cleanupScreenshots,
  initializeScreenshotsConsumer,
} from './screenshots-test-support';

const validConfig = `pair: assets:assets.screenshots_rw
bucket: assets
endpoint: https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/
publicBaseUrl: https://assets.example.com/
`;

afterEach(cleanupScreenshots);

describe('screenshots config loading', () => {
  it('reports an absent config file as publishing not being enabled', () => {
    const consumer = initializeScreenshotsConsumer({});
    expect(loadScreenshotsConfig(consumer)).toEqual({
      ok: false,
      problems: [
        'config/screenshots.yaml not found; screenshot publishing is not enabled for this repository',
      ],
    });
  });

  it('reports a config path that cannot be read as a file', () => {
    const consumer = initializeScreenshotsConsumer({});
    mkdirSync(join(consumer, 'config/screenshots.yaml'));

    const result = loadScreenshotsConfig(consumer);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      problems: [
        expect.stringContaining('could not read config/screenshots.yaml'),
      ],
    });
  });

  it('parses a valid config and strips trailing URL slashes', () => {
    const consumer = initializeScreenshotsConsumer({ config: validConfig });
    const result = loadScreenshotsConfig(consumer);
    expect(result).toEqual({
      ok: true,
      value: {
        pair: { target: 'assets', key: 'assets.screenshots_rw' },
        bucket: 'assets',
        endpoint:
          'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
        publicBaseUrl: 'https://assets.example.com',
      },
    });
  });

  it('rejects a config that is not a mapping', () => {
    const consumer = initializeScreenshotsConsumer({ config: '- a\n- b\n' });
    expect(loadScreenshotsConfig(consumer)).toEqual({
      ok: false,
      problems: [
        'config/screenshots.yaml must be a mapping with pair, bucket, endpoint, publicBaseUrl',
      ],
    });
  });

  it('gathers every field problem in one pass', () => {
    const consumer = initializeScreenshotsConsumer({
      config: `pair: no-colon-here
bucket: "NOT VALID"
endpoint: not-a-url
extra: value
`,
    });
    expect(loadScreenshotsConfig(consumer)).toEqual({
      ok: false,
      problems: [
        'config/screenshots.yaml has an unknown key "extra"',
        'config/screenshots.yaml pair must be "<target>:<dotted.key>", e.g. assets:assets.screenshots_rw',
        'config/screenshots.yaml bucket "NOT VALID" is not a valid bucket name',
        'config/screenshots.yaml endpoint must be a safe http(s) URL',
        'config/screenshots.yaml publicBaseUrl must be a non-empty string',
      ],
    });
  });

  it('rejects upload endpoints outside R2 or loopback development', () => {
    const consumer = initializeScreenshotsConsumer({
      config: validConfig.replace(
        'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/',
        'https://collector.example/upload',
      ),
    });

    expect(loadScreenshotsConfig(consumer)).toEqual({
      ok: false,
      problems: ['config/screenshots.yaml endpoint must be a safe http(s) URL'],
    });
  });

  it('rejects public base URLs with query or fragment components', () => {
    const consumer = initializeScreenshotsConsumer({
      config: validConfig.replace(
        'https://assets.example.com/',
        'https://assets.example.com/base?token=secret#latest',
      ),
    });

    expect(loadScreenshotsConfig(consumer)).toEqual({
      ok: false,
      problems: [
        'config/screenshots.yaml publicBaseUrl must be a safe http(s) URL',
      ],
    });
  });
});
