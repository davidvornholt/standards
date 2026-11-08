import { availableParallelism } from 'node:os';
import process from 'node:process';

const playwright = await import('@playwright/test');

const a11ySpecPattern = /.*\.a11y\.ts/u;

// The tests are independent, so give every available core a worker.
// Playwright's default, half of `os.cpus()`, gives a four-core CI runner two
// workers and ignores CPU limits. `availableParallelism()` counts only the
// cores this process may use: its CPU affinity and, on Linux, the cgroup CPU
// quota of its container or systemd slice. Each worker runs its own browser,
// so stop at eight to bound memory on large machines.
const maximumWorkers = 8;

export const createA11yPlaywrightConfig = (options: {
  readonly baseUrl: string;
  readonly webServerCommand: string;
}) => {
  const isCi = process.env.CI !== undefined;

  return playwright.defineConfig({
    testDir: './a11y',
    testMatch: a11ySpecPattern,
    fullyParallel: true,
    workers: Math.min(availableParallelism(), maximumWorkers),
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
