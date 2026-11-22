import process from 'node:process';

const playwright = await import('@playwright/test');

const a11ySpecPattern = /.*\.a11y\.ts/u;

const desktopDevice = playwright.devices['Desktop Chrome'];

// The phone every scan also covers. `scanWcag22AaViolations` narrows the page
// to this viewport for its second pass, and tests tagged `mobileDeviceTag` run
// on the full emulated device.
export const mobileDevice = playwright.devices['Pixel 7'];

// Tag a test whose result depends on the device or screen size, such as touch
// input, hover feedback, a responsive layout, or a branch on `isMobile`, so it
// also runs on the emulated phone. Untagged tests run on desktop only, because
// their scans already cover the phone's viewport.
export const mobileDeviceTag = '@mobile-device';

export const createA11yPlaywrightConfig = (options: {
  readonly baseUrl: string;
  readonly webServerCommand: string;
}) => {
  const isCi = process.env.CI !== undefined;

  return playwright.defineConfig({
    testDir: './a11y',
    testMatch: a11ySpecPattern,
    fullyParallel: true,
    // A CI runner exists only for the gate, so the suite takes every core.
    // Local runs keep Playwright's default and leave room for the developer's
    // other work.
    ...(isCi ? { workers: '100%' } : {}),
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
        use: { ...desktopDevice },
      },
      {
        name: 'mobile-chromium',
        grep: new RegExp(mobileDeviceTag, 'u'),
        use: { ...mobileDevice },
      },
    ],
  });
};
