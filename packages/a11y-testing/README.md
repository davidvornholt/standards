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

```ts
import { createA11yPlaywrightConfig } from '@davidvornholt/a11y-testing/playwright-config';

export default createA11yPlaywrightConfig({
  baseUrl: 'http://127.0.0.1:3000',
  webServerCommand: 'bun run dev',
});
```

## Consumer requirements

The app declares `@playwright/test` because its specs import it, and `@axe-core/playwright` because the shared scanner loads it at runtime. Expose a `test:a11y` script that runs Playwright with the shared configuration.

Keep app-local `a11y/*.a11y.ts` files as route and state coverage. Test every reachable route and meaningful interactive state.

## Environment

| Variable | Required | Effect |
| --- | --- | --- |
| `CI` | No | Enables `forbidOnly`, one retry, the `dot` reporter, and a fresh web server. |

This package consumes no secrets.
