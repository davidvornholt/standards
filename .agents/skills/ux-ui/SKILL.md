---
name: ux-ui
description: Must be used for every task that creates or modifies UI — pages, components, styles, layout, tokens, UI copy, client-side state, or visual behavior. Not optional for small UI edits like tweaking a button, color, or label. Covers the design contract (DESIGN.md), theme tokens, frontend standards, state management, and accessibility testing.
---

# UX/UI

Use the `frontend-design` skill for visual work. Follow the root `DESIGN.md` when present; otherwise infer the design intent and token source from the existing UI and central theme. Explore a new direction only when the user explicitly requests it; treat that work as exploration until the project adopts it in `DESIGN.md` and the theme.

For pull requests that change rendered UI, use `screenshots-in-prs`.

## Tokens and motion

- Take every color and design value from the central theme. Do not hardcode raw color literals in product code.
- Use semantic utilities instead of default Tailwind palette classes when the project has a semantic token layer.
- Define authored color tokens with `oklch(...)` and add a semantic token when none fits.
- Use the shared easing token or constant in CSS and JavaScript. Do not encode another curve locally.
- A context that cannot resolve CSS variables may mirror anchor colors in one colocated constants file.

## Frontend contract

- Meet WCAG 2.2 AA with semantic HTML, correct headings, keyboard support, visible focus, and communication that does not rely on color alone.
- Use framework metadata and document primitives. Prefer server-rendered, indexable content where SEO matters.
- Use browser hyphenation for long prose. Reserve soft hyphens for curated display copy, never identifiers, URLs, form values, searchable data, tests, or accessibility labels.
- Write controls from the user's perspective with stable action names and specific error or empty-state guidance.

## State

Keep state local when one component owns it. Use Zustand for shared client-side UI state in React or Next.js. Do not use Zustand as a server-data cache; use TanStack Query when remote data needs caching, invalidation, pagination, optimistic updates, or coordinated mutations.

## Accessibility tests

Browser-rendered apps need Playwright plus Axe coverage against the shared WCAG 2.2 AA tag set. Keep the scanner and config in `@davidvornholt/a11y-testing`; app-local `a11y/*.a11y.ts` files list routes and meaningful interaction states.
