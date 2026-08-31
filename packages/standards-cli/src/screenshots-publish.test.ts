import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScreenshotsPublish } from './screenshots-publish';
import {
  cleanupScreenshots,
  initializeScreenshotsConsumer,
  startS3Stub,
  writeImage,
} from './screenshots-test-support';

const PAIR_JSON =
  '{"assets":{"screenshots_rw":{"access_key_id":"AKID","secret_access_key":"SECRET"}}}';

const configFor = (endpoint: string): string =>
  `pair: assets:assets.screenshots_rw
bucket: assets
endpoint: ${endpoint}
publicBaseUrl: https://assets.example.com
`;

const pngBytes = new TextEncoder().encode('not-a-real-png');
const digest = createHash('sha256').update(pngBytes).digest('hex');

afterEach(cleanupScreenshots);

describe('screenshots publish', () => {
  it('uploads each file content-addressed and prints markdown in input order', async () => {
    const stub = startS3Stub();
    const consumer = initializeScreenshotsConsumer({
      config: configFor(stub.endpoint),
      target: 'assets',
      sopsJson: PAIR_JSON,
    });
    const first = writeImage(consumer, 'home.png', pngBytes);
    const second = writeImage(consumer, 'detail.png', pngBytes);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runScreenshotsPublish(consumer, [first, second])).toBe(true);

    expect(log.mock.calls.flat()).toEqual([
      `![home](<https://assets.example.com/screenshots/${digest}/home.png>)`,
      `![detail](<https://assets.example.com/screenshots/${digest}/detail.png>)`,
    ]);
    expect(error).not.toHaveBeenCalled();
    const paths = stub.uploads.map((upload) => upload.pathname).sort();
    expect(paths).toEqual([
      `/assets/screenshots/${digest}/detail.png`,
      `/assets/screenshots/${digest}/home.png`,
    ]);
    for (const upload of stub.uploads) {
      expect(upload.method).toBe('PUT');
      expect(upload.contentType).toBe('image/png');
      expect(upload.size).toBe(pngBytes.byteLength);
    }
  });

  it('gathers config and file problems together before any upload', async () => {
    const consumer = initializeScreenshotsConsumer({});
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(
      await runScreenshotsPublish(consumer, ['missing.pdf', 'bad name.png']),
    ).toBe(false);

    const reported = error.mock.calls.flat().join('\n');
    expect(reported).toContain('standards screenshots: 5 problem(s):');
    expect(reported).toContain(
      'config/screenshots.yaml not found; screenshot publishing is not enabled for this repository',
    );
    expect(reported).toContain('missing.pdf is not a readable file');
    expect(reported).toContain('missing.pdf has an unsupported extension');
    expect(reported).toContain('bad name.png is not a readable file');
    expect(reported).toContain('bad name.png has a name unsafe for URLs');
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects an empty file and requires at least one operand', async () => {
    const stub = startS3Stub();
    const consumer = initializeScreenshotsConsumer({
      config: configFor(stub.endpoint),
    });
    const empty = writeImage(consumer, 'empty.png', new Uint8Array());
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runScreenshotsPublish(consumer, [empty])).toBe(false);
    expect(await runScreenshotsPublish(consumer, [])).toBe(false);

    const reported = error.mock.calls.flat().join('\n');
    expect(reported).toContain(`${empty} is empty`);
    expect(reported).toContain(
      'standards screenshots: publish requires at least one image file',
    );
    expect(stub.uploads).toHaveLength(0);
  });
});

describe('screenshots publish safety', () => {
  it('rejects symlinked image inputs before upload', async () => {
    const stub = startS3Stub();
    const consumer = initializeScreenshotsConsumer({
      config: configFor(stub.endpoint),
    });
    const secret = join(consumer, '..', 'outside-secret.txt');
    const link = join(consumer, 'captured.png');
    writeFileSync(secret, 'private data');
    symlinkSync(secret, link);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runScreenshotsPublish(consumer, [link])).toBe(false);

    expect(error.mock.calls.flat().join('\n')).toContain(
      `${link} is not a readable file`,
    );
    expect(stub.uploads).toHaveLength(0);
  });

  it('rejects a non-R2 endpoint before decrypting or uploading', async () => {
    const stub = startS3Stub();
    const consumer = initializeScreenshotsConsumer({
      config: configFor('https://collector.example/upload'),
      target: 'assets',
      sopsJson: PAIR_JSON,
    });
    const file = writeImage(consumer, 'home.png', pngBytes);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runScreenshotsPublish(consumer, [file])).toBe(false);

    expect(error.mock.calls.flat().join('\n')).toContain(
      'config/screenshots.yaml endpoint must be a safe http(s) URL',
    );
    expect(stub.uploads).toHaveLength(0);
  });

  it('keeps a punctuation-heavy public URL in one Markdown destination', async () => {
    const stub = startS3Stub();
    const consumer = initializeScreenshotsConsumer({
      config: configFor(stub.endpoint).replace(
        'https://assets.example.com',
        'https://assets.example/)(![evil](https://attacker.example/x',
      ),
      target: 'assets',
      sopsJson: PAIR_JSON,
    });
    const file = writeImage(consumer, 'home.png', pngBytes);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runScreenshotsPublish(consumer, [file])).toBe(true);

    expect(log.mock.calls.flat()).toEqual([
      `![home](<https://assets.example/)(![evil](https://attacker.example/x/screenshots/${digest}/home.png>)`,
    ]);
  });
});
