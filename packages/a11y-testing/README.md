# @davidvornholt/a11y-testing

Shared Playwright + Axe accessibility-testing helpers. App workspaces keep
their `a11y/*.a11y.ts` specs as thin lists of routes and interaction states;
the scan helper and the Playwright config factory live here so every app
asserts the same gate.

## Public API

- `@davidvornholt/a11y-testing/axe` — `scanWcag22AaViolations(page)` runs Axe against
  the current page state for the full WCAG 2.2 AA tag set (`wcag2a`,
  `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, exported as `wcag22AaTags`)
  and returns the mapped violations. Specs assert
  `expect(await scanWcag22AaViolations(page)).toEqual([])` so every test
  carries its own visible zero-violation assertion.
- `@davidvornholt/a11y-testing/playwright-config` — `createA11yPlaywrightConfig({
  baseUrl, webServerCommand })` returns the Playwright config used by app
  `test:a11y` scripts: `a11y/` test dir, desktop and mobile Chromium projects,
  and a managed web server.

## Configuration

| Value | Required | Behavior |
| --- | --- | --- |
| `CI` (environment) | no | When set, the config factory enables `forbidOnly`, one retry, the `dot` reporter, and always starts a fresh web server instead of reusing a running one. |

This workspace consumes no secrets.

Consuming apps must declare `@playwright/test` because their specs import it
directly, and must declare `@axe-core/playwright` because their Playwright
runtime loads the shared Axe helper. Each browser-rendered app exposes a
`test:a11y` script that runs Playwright with this shared config.
