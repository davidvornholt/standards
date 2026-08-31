import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { runScreenshotsCommand } from './screenshots-commands';

afterEach(() => {
  mock.restore();
});

describe('screenshots command routing', () => {
  it('prints usage for help and succeeds, but fails on a bare invocation', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runScreenshotsCommand(['help'])).toBe(true);
    expect(await runScreenshotsCommand([])).toBe(false);

    const printed = log.mock.calls.flat().join('\n');
    expect(printed).toContain('Usage: standards screenshots <command>');
    expect(printed).toContain('publish <files...>');
    expect(printed).toContain('--dir <path>');
  });

  it('rejects unknown commands with usage on stderr', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runScreenshotsCommand(['upload', 'home.png'])).toBe(false);

    const reported = error.mock.calls.flat().join('\n');
    expect(reported).toContain(
      'standards screenshots: unknown command: upload',
    );
    expect(reported).toContain('Usage: standards screenshots <command>');
  });

  it('rejects unknown options and a --dir flag without a value', () => {
    expect(() => runScreenshotsCommand(['publish', '--force'])).toThrow(
      'Unknown screenshots option: --force',
    );
    expect(() => runScreenshotsCommand(['publish', '--dir'])).toThrow(
      '--dir requires a value',
    );
  });

  it('requires at least one file operand for publish', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runScreenshotsCommand(['publish'])).toBe(false);

    expect(error.mock.calls.flat().join('\n')).toContain(
      'publish requires at least one image file',
    );
  });
});
