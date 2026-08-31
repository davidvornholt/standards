import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
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

const HTTP_FORBIDDEN = 403;
const HTTP_OK = 200;
const pngBytes = new TextEncoder().encode('not-a-real-png');
const digest = createHash('sha256').update(pngBytes).digest('hex');

afterEach(cleanupScreenshots);

describe('screenshots publish failures', () => {
  it('reports a pair missing from the SOPS target with the mint hint', async () => {
    const stub = startS3Stub();
    const consumer = initializeScreenshotsConsumer({
      config: configFor(stub.endpoint),
      target: 'assets',
      sopsJson: JSON.stringify({ assets: {} }),
    });
    const file = writeImage(consumer, 'home.png', pngBytes);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runScreenshotsPublish(consumer, [file])).toBe(false);

    const reported = error.mock.calls.flat().join('\n');
    expect(reported).toContain(
      'secrets/assets.yaml has no key "assets.screenshots_rw"',
    );
    expect(reported).toContain(
      'bun standards creds add cloudflare --s3 --dest assets:assets.screenshots_rw --bucket assets --permissions "Workers R2 Storage Bucket Item Write"',
    );
    expect(stub.uploads).toHaveLength(0);
  });

  it('surfaces upload failures without printing partial markdown', async () => {
    const stub = startS3Stub(HTTP_FORBIDDEN);
    const consumer = initializeScreenshotsConsumer({
      config: configFor(stub.endpoint),
      target: 'assets',
      sopsJson: PAIR_JSON,
    });
    const file = writeImage(consumer, 'home.png', pngBytes);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runScreenshotsPublish(consumer, [file])).toBe(false);

    const reported = error.mock.calls.flat().join('\n');
    expect(reported).toContain('standards screenshots: upload failed:');
    expect(log).not.toHaveBeenCalled();
  });

  it('cleans new uploads after a mixed upload failure', async () => {
    const failurePath = `/assets/screenshots/${digest}/failure.png`;
    const existingPath = `/assets/screenshots/${digest}/home.png`;
    const detailPath = `/assets/screenshots/${digest}/detail.png`;
    const stub = startS3Stub(HTTP_OK, {
      existing: [existingPath],
      failPath: failurePath,
    });
    const consumer = initializeScreenshotsConsumer({
      config: configFor(stub.endpoint),
      target: 'assets',
      sopsJson: PAIR_JSON,
    });
    const home = writeImage(consumer, 'home.png', pngBytes);
    const detail = writeImage(consumer, 'detail.png', pngBytes);
    const failure = writeImage(consumer, 'failure.png', pngBytes);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runScreenshotsPublish(consumer, [home, detail, failure])).toBe(
      false,
    );

    expect(stub.objects.has(existingPath)).toBe(true);
    expect(stub.objects.has(detailPath)).toBe(false);
    expect(stub.objects.has(failurePath)).toBe(false);
    expect(
      stub.uploads.some(
        (upload) =>
          upload.method === 'DELETE' && upload.pathname === detailPath,
      ),
    ).toBe(true);
    expect(error.mock.calls.flat().join('\n')).toContain(
      'standards screenshots: upload failed:',
    );
    expect(log).not.toHaveBeenCalled();
  });
});
