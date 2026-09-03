---
name: ux-ui
description: Use when creating or changing any user-facing interface behavior or presentation. Keeps changes consistent with the project's UI and accessibility contracts.
---

# UX/UI

Use `frontend-design` for visual work. Follow the root `DESIGN.md` when present; otherwise infer the direction from the existing UI and theme. Explore a new direction only when the user requests it; it remains exploratory until adopted in `DESIGN.md` and the theme.

For pull requests that change rendered UI, use `screenshots-in-prs`.

## Theme

- Use the central theme and semantic utilities instead of raw color literals or default Tailwind palette classes.
- Add a semantic token when none fits; author color tokens with `oklch(...)`.
- Use the shared easing token or constant rather than defining another curve.
- A context that cannot resolve CSS variables may mirror anchor colors in one colocated constants file.

## Frontend contract

- Meet WCAG 2.2 AA with semantic HTML, correct headings, keyboard support, visible focus, and communication that does not rely on color alone.
- Use browser hyphenation for long prose. Reserve soft hyphens for curated display copy, never identifiers, URLs, form values, searchable data, tests, or accessibility labels.
- Write controls from the user's perspective with stable action names and specific error or empty-state guidance.

## State

Keep state local when one component owns it. Use Zustand for shared client-side UI state in React or Next.js. Do not use Zustand as a server-data cache; use TanStack Query when remote data needs caching, invalidation, pagination, optimistic updates, or coordinated mutations.

## Accessibility tests

Browser-rendered apps need Playwright plus Axe coverage against the shared WCAG 2.2 AA tag set. Keep the scanner and config in `@davidvornholt/a11y-testing`; app-local `a11y/*.a11y.ts` files list routes and meaningful interaction states.
