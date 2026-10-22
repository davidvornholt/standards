---
name: ux-ui
description: Use when creating or changing a user-facing interface. Applies the project's styling, component placement, theme, icon, and accessibility-test conventions.
---

# UX/UI

Style with Tailwind utilities in the markup. When UI repeats, share it as a component with variants rather than a CSS class bundle such as an `@apply` rule. A component shares the markup and behavior along with the styling, and its styles stay visible where they apply. Custom CSS is fine where utilities would obscure the intent: generated content, document-level rules, and complex effects.

Reuse existing components before writing new ones. Where a component lives follows the dependency rules in `AGENTS.md`. UI for one feature stays in that feature. UI shared across features of one app goes in `src/shared/ui`, because features can't import each other. UI shared across apps goes in `packages/ui`. Extract a shared component when its consumers should behave and look the same.

Visual values belong to the app's existing theme. Components use its semantic tokens, such as a surface or muted-text color, rather than raw palette values like `zinc-100`, so dark mode and later design changes happen in the theme alone. Author theme colors in `oklch(...)`. Its lightness channel is perceptually uniform, which keeps contrast predictable across hues.

Use Lucide (`lucide-react`) for icons in React interfaces, so icons keep one style across projects.

Browser-rendered apps check accessibility with Playwright and `@davidvornholt/a11y-testing`, which provides the axe scanner and the shared Playwright configuration. Each app lists the routes and interaction states it scans in `a11y/*.a11y.ts`. When a change adds or alters a route or a meaningful state, such as an open dialog or a form error, add or update its coverage there.
