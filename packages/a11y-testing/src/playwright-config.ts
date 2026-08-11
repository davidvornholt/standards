import process from 'node:process';

const playwright = await import('@playwright/test');

const a11ySpecPattern = /.*\.a11y\.ts/u;

export const createA11yPlaywrightConfig = (options: {
  readonly baseUrl: string;
  readonly webServerCommand: string;
}) => {
  const isCi = process.env.CI !== undefined;

  return playwright.defineConfig({
    testDir: './a11y',
    testMatch: a11ySpecPattern,
    fullyParallel: true,
    forbidOnly: isCi,
    retries: isCi ? 1 : 0,
    reporter: isCi ? 'dot' : 'list',
    use: {
      baseURL: options.baseUrl,
    },
    webServer: {
      command: options.webServerCommand,
      url: options.baseUrl,
      reuseExistingServer: !isCi,
      timeout: 120_000,
    },
    projects: [
      {
        name: 'desktop-chromium',
        use: { ...playwright.devices['Desktop Chrome'] },
      },
      {
        name: 'mobile-chromium',
        use: { ...playwright.devices['Pixel 7'] },
      },
    ],
  });
};
