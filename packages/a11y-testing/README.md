# @davidvornholt/a11y-testing

Shared Playwright and Axe helpers for the browser accessibility gate.

## Exports

### `@davidvornholt/a11y-testing/axe`

`scanWcag22AaViolations(page)` scans the current page state with Axe rules tagged for WCAG 2.0, 2.1, and 2.2 through Level AA. `wcag22AaTags` exposes the tag list.

```ts
import { expect, test } from '@playwright/test';
import { scanWcag22AaViolations } from '@davidvornholt/a11y-testing/axe';

test('home page has no automated WCAG violations', async ({ page }) => {
  await page.goto('/');
  expect(await scanWcag22AaViolations(page)).toEqual([]);
});
```

Axe covers only criteria with an automated rule. Semantic and interaction requirements still need intentional implementation and tests.

### `@davidvornholt/a11y-testing/playwright-config`

`createA11yPlaywrightConfig({ baseUrl, webServerCommand })` creates the shared accessibility-test configuration with the `a11y/` test directory, desktop and mobile Chromium projects, and a managed web server.

The run always starts its own web server and fails if something already answers at `baseUrl`, so it can never scan a dev server or another app by mistake. Give each app an accessibility port that no dev server or other app's suite uses, because runs on the host network share the host's ports.

```ts
import { createA11yPlaywrightConfig } from '@davidvornholt/a11y-testing/playwright-config';

export default createA11yPlaywrightConfig({
  baseUrl: 'http://127.0.0.1:3000',
  webServerCommand: 'bun run dev',
});
```

### `a11y-playwright`

The `a11y-playwright` command takes the same arguments as `playwright test` and passes through its output, exit code, and signals. On Linux hosts that allow unprivileged user namespaces, it runs Playwright, the web server, and the browser in a private network namespace that has only a loopback interface. There, a changing host address such as a renewed DHCPv6 address cannot make Chromium abort requests with `net::ERR_NETWORK_CHANGED`, and the run's ports cannot collide with servers on the host.

Elsewhere, the command prints one notice line to stderr and runs `playwright test` on the host network. This covers macOS, Windows, and Linux hosts that restrict unprivileged user namespaces, such as Ubuntu 24.04 with `kernel.apparmor_restrict_unprivileged_userns=1`, which includes GitHub's `ubuntu-24.04` runners.

Inside the namespace the run is root mapped to the calling user, so files keep their host owner. Chromium can only run there without its sandbox, which is Playwright's default, so do not set `chromiumSandbox: true`. The web server and the tests cannot reach the host network: no database or service on the host, no internet, and no package registry, so `bunx` must find an installed package. An app whose accessibility web server needs the host network keeps `playwright test`.

### `@davidvornholt/a11y-testing/network-isolation`

`networkIsolatedCommand(command)` wraps any command the way `a11y-playwright` wraps `playwright test` and returns it with the fallback notice, for tools that start Playwright themselves.

## Consumer requirements

The app declares `@playwright/test` because its specs import it, and `@axe-core/playwright` because the shared scanner loads it at runtime. Expose a `test:a11y` script that runs `a11y-playwright`, or `playwright test` when the web server needs the host network, with the shared configuration.

Keep app-local `a11y/*.a11y.ts` files as route and state coverage. Test every reachable route and meaningful interactive state.

## Environment

| Variable | Required | Effect |
| --- | --- | --- |
| `CI` | No | Enables `forbidOnly`, one retry, and the `dot` reporter. |

This package consumes no secrets.
