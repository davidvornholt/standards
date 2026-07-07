import { describe, expect, it } from 'bun:test';
import process from 'node:process';
import { createA11yPlaywrightConfig } from './playwright-config';

const expectedA11ySpecPattern = /.*\.a11y\.ts/u;
const originalCiValue = process.env.CI;

const restoreCi = () => {
  if (originalCiValue === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = originalCiValue;
  }
};

const withCi = <T>(ciValue: string | undefined, run: () => T): T => {
  if (ciValue === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = ciValue;
  }

  try {
    return run();
  } finally {
    restoreCi();
  }
};

describe('createA11yPlaywrightConfig', () => {
  it('configures the shared a11y test runner shape', () => {
    const config = withCi(undefined, () =>
      createA11yPlaywrightConfig({
        baseUrl: 'http://127.0.0.1:3000',
        webServerCommand: 'bun run start',
      }),
    );

    expect(config.testDir).toBe('./a11y');
    expect(config.testMatch).toEqual(expectedA11ySpecPattern);
    expect(config.fullyParallel).toBe(true);
    expect(config.forbidOnly).toBe(false);
    expect(config.retries).toBe(0);
    expect(config.reporter).toBe('list');
    expect(config.use).toEqual({
      baseURL: 'http://127.0.0.1:3000',
    });
    expect(config.webServer).toMatchObject({
      command: 'bun run start',
      url: 'http://127.0.0.1:3000',
      reuseExistingServer: true,
      timeout: 120_000,
    });
    expect(config.projects?.map((project) => project.name)).toEqual([
      'desktop-chromium',
      'mobile-chromium',
    ]);
  });

  it('uses stricter retry and reporting defaults in CI', () => {
    const config = withCi('true', () =>
      createA11yPlaywrightConfig({
        baseUrl: 'http://127.0.0.1:3000',
        webServerCommand: 'bun run start',
      }),
    );

    expect(config.forbidOnly).toBe(true);
    expect(config.retries).toBe(1);
    expect(config.reporter).toBe('dot');
    expect(config.webServer).toMatchObject({
      reuseExistingServer: false,
    });
  });
});
