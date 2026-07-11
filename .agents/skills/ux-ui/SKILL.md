---
name: ux-ui
description: Must be used for every task that creates or modifies UI — pages, components, styles, layout, tokens, UI copy, client-side state, or visual behavior. Not optional for small UI edits like tweaking a button, color, or label. Covers the design contract (DESIGN.md), theme tokens, frontend standards, state management, and accessibility testing.
---

# UX/UI

## Design contract

- Use the `frontend-design` skill for all UI work.
- Read the root `DESIGN.md` before any UI work and follow it. It defines the design intent and points to the theme/token source.
- Skip `DESIGN.md` only when the user explicitly asks to explore a new design direction. Treat that exploration as a prototype: prioritize originality, taste, cohesion, and visual force over systemization.
- After a successful exploration, offer to update `DESIGN.md` and the theme so the system matches the new reality.

## Theme tokens

- All color and design values come from the project's central token source (its theme file). No raw color values (`#hex`, `rgb()`, `hsl()`, `oklch()` literals) in app or component code.
- When the project uses a semantic token layer, do not use default Tailwind palette classes (`text-blue-400`, `bg-red-500`, …); use only the semantic utilities generated from theme tokens (`bg-primary`, `text-muted`, …).
- Define color tokens and authored CSS colors with `oklch(...)` in the token source.
- If a needed token does not exist, add it rather than misusing a nearby token or hardcoding a value. New tokens must be semantic, follow the existing naming scheme, live in the token source, and be reported to the user in the summary.
- Shared and foundational components use semantic theme tokens only — never raw ramp steps or ad-hoc values.
- Contexts that cannot resolve CSS variables (for example transactional email HTML) may mirror the theme's anchor colors as raw literals in a single, clearly colocated constants file. Keep that the only sanctioned raw-color exception outside the token source.

## Typography in code

- Follow the project's typographic scale. A display or heading typeface is used only at the sizes the design system reserves for it, and the size class goes on the heading element itself. Do not use the display face for small headings, cards, teasers, quotes, metadata, captions, or sentence-length content.
- Below display size, use the project's body typeface at the weight the design system specifies.

## Motion in code

- Use one easing curve: the project's shared easing token or utility. Do not use ad-hoc `ease-out`, `ease-in-out`, or inline `cubic-bezier(...)` in product code.
- JS animation code imports the shared easing constant from the project's UI package instead of re-encoding the curve, so CSS and JS stay in sync; guard it with a colocated test where practical.

## Shape in code

- Use the theme's radius steps for corners.
- Reserve fully rounded shapes (`rounded-full`) for the elements the design system intends (status chips, avatars, icon discs), and reserve any full-square-corner treatment for its documented uses. Everything else uses the theme's radius steps.

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
- Keep the Axe scan helper and Playwright config factory in the shared `a11y-testing` package; app-local `a11y/*.a11y.ts` specs stay thin lists of routes and states.
- Cover every reachable route and meaningful interaction states (open menus, dialogs, expanded/error states).
