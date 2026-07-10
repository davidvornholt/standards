---
name: ux-ui
description: Must be used for every task that creates or modifies UI — pages, components, styles, layout, tokens, UI copy, client-side state, or visual behavior. Not optional for small UI edits like tweaking a button, color, or label. Covers the design contract (DESIGN.md), theme tokens, frontend standards, state management, and accessibility testing.
---

# UX/UI

## Design contract

- Use the `frontend-design` skill for all UI work.
- Read the root `DESIGN.md` before any UI work and follow it. It defines the design intent and references the theme.
- Skip `DESIGN.md` only when the user explicitly asks to explore a new design direction. Treat that exploration as a prototype: prioritize originality, taste, cohesion, and visual force over systemization.
- After a successful exploration, offer to update `DESIGN.md` and the theme so the system matches the new reality.

## Theme tokens

- All color and design values come from `packages/ui/src/theme.css`. No raw color values (`#hex`, `rgb()`, `hsl()`, `oklch()` literals) in app or component code.
- No default Tailwind palette classes (`text-blue-400`, `bg-red-500`, …). Use only semantic utilities generated from theme tokens (`bg-primary`, `text-muted`, …). The default palette is disabled in `theme.css` via `--color-*: initial`, so palette classes produce no CSS.
- Define color tokens and authored CSS colors with `oklch(...)` inside `theme.css`.
- If a needed token does not exist, add it rather than misusing a nearby token or hardcoding a value. New tokens must be semantic, follow the existing naming scheme, live in `theme.css`, and be reported to the user in the summary.
- Shared components in `packages/ui` use semantic theme tokens only. Hairline rules use `border-border`; the heavy chapter rule uses `border-foreground`; muted prose uses `text-muted-foreground` — never `ink-*` ramp steps.
- Transactional email HTML cannot resolve CSS variables. Email templates interpolate the shared mail palette (`apps/web/src/shared/mail/constants/mail-palette.ts`), whose hex constants mirror theme anchors. That file carries the only sanctioned raw color literals outside `theme.css`.

## Typography in code

- `font-display` (Titan One) is display-only: `text-2xl` is the minimum, `text-4xl` and larger is preferred. Put the size class on the heading element itself — the guardrail cascade in `apps/web/src/app/globals.css` only promotes `h1`–`h6` that carry `text-2xl`+, and an explicit `font-display` below that size is a violation, not an override.
- Below display size, use IBM Plex Sans with `font-semibold` or `font-bold`. Never use Titan One for small headings, cards, article teasers, review quotes, metadata, captions, phone numbers, or sentence-length content.

## Motion in code

- One easing curve. Use the `ease-editorial` utility (or `var(--ease-editorial)`); do not use `ease-out`, `ease-in-out`, or ad-hoc `cubic-bezier(...)` in product code.
- JS animation code (Motion library) imports `editorialEase` from `@fesk/ui/motion` instead of re-encoding the curve; a colocated test in `packages/ui` guards it against `theme.css`.

## Shape in code

- Pills (`rounded-full`) exist for status chips, avatars, and icon discs only.
- Full square corners are reserved for documentary forms (pull quotes, large image plates, list rows); everything else uses the theme's radius steps.

## Frontend standards

- Meet WCAG 2.2 AA with semantic HTML, correct heading hierarchy, keyboard navigation, visible focus states, and non-color-only communication.
- Use framework metadata/document primitives for SEO and prefer server-rendered/indexable content when SEO matters.
- Use browser hyphenation for long reader-facing text, and add manual soft hyphens only in curated display copy where wrapping needs help. Use `&shy;` in markup or `\u00AD` in string literals where entities are not decoded; avoid both in identifiers, URLs, form values, searchable data, tests, and accessibility labels.

## State management

- Keep state as local as practical. Use React local state for component-owned UI state.
- Use Zustand by default for shared client-side UI/app state in React and Next.js.
- Do not use Zustand as a server-data cache. If client-side remote data needs caching, refetching, invalidation, pagination, optimistic updates, or mutation coordination, propose TanStack Query before building custom store logic.

## Accessibility testing

- Browser-rendered apps must have Playwright + Axe coverage asserting zero violations against the full WCAG 2.2 AA tag set.
- Keep the Axe scan helper and Playwright config factory in `packages/a11y-testing`; app-local `a11y/*.a11y.ts` specs stay thin lists of routes and states.
- Cover every reachable route and meaningful interaction states (open menus, dialogs, expanded/error states).
