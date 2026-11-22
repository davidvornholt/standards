---
name: ux-ui
description: Use when creating or changing a user-facing interface.
---

# UX/UI

Style with Tailwind utilities in the markup. When UI repeats, share it as a component with variants rather than an `@apply` class. Custom CSS is fine where utilities would obscure the intent.

Shared UI goes in `src/shared/ui` within an app and in `packages/ui` across apps.

Components use the app theme's semantic tokens rather than raw palette values. Author theme colors in `oklch(...)`.

Use Lucide (`lucide-react`) for icons in React interfaces.

Browser-rendered apps check accessibility with Playwright and `@davidvornholt/a11y-testing`, which provides the axe scanner and the shared Playwright configuration. Each app lists the routes and UI states it scans in `a11y/*.a11y.ts`. When a change adds or alters a route or a meaningful UI state, update its coverage there. Tests run in a desktop browser, and every `scanWcag22AaViolations` call also scans at phone width, so a scan needs no phone run. While an element is in fullscreen, such as a presented slide deck, the call scans only at the current size, because the fullscreen element fills the screen whatever the window's width. Tag a test whose result depends on the device or screen size, such as touch, hover, a responsive layout, or a branch on `isMobile`, with `mobileDeviceTag` from `@davidvornholt/a11y-testing/playwright-config`, so it also runs on the emulated phone.
