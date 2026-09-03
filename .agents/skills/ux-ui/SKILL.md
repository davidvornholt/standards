---
name: ux-ui
description: Use when creating or changing a user-facing interface. Applies the project's theme ownership and browser accessibility-test contracts.
---

# UX/UI

- Shared visual values live in each application's established theme. Components consume semantic tokens instead of raw palette values; author theme colors in `oklch(...)`.
- Browser-rendered apps use Playwright and `@davidvornholt/a11y-testing` for automated accessibility checks. Add or update coverage for routes and meaningful interaction states affected by the change.
