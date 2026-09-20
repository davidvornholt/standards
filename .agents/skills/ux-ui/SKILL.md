---
name: ux-ui
description: Use when creating or changing a user-facing interface. Applies the project's theme ownership and browser accessibility-test contracts.
---

# UX/UI

- Style components with Tailwind utilities. Share repeated UI through components and variants, not CSS class bundles. Use custom CSS for generated content, document-level rules, or complex effects where utilities would obscure the implementation.
- Reuse existing components. Keep feature-specific UI within its feature, components shared across features in `src/shared/ui`, and components shared across apps in `packages/ui`. Extract shared components when their consumers should share behavior and styling.
- Shared visual values live in each application's established theme. Components consume semantic tokens instead of raw palette values; author theme colors in `oklch(...)`.
- Prefer Lucide React (`lucide-react`) for icons in React interfaces.
- Browser-rendered apps use Playwright and `@davidvornholt/a11y-testing` for automated accessibility checks. Add or update coverage for routes and meaningful interaction states affected by the change.
