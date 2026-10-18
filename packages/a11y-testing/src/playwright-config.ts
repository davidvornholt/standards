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
      // Always start this app's own server. Reusing whatever already answers on
      // the port could scan a dev server or another app and pass. Give each app
      // a port that no dev server or other app's suite uses, because runs on
      // the host network share the host's ports.
      reuseExistingServer: false,
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
