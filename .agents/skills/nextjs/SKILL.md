---
name: nextjs
description: Use when changing pages, layouts, Server Components, Route Handlers, Server Actions, caching, or rendering in a Next.js application. Applies the repository's Cache Components policy.
---

# Next.js

## Caching and rendering

- Use Next.js Cache Components patterns: `'use cache'` plus `cacheLife`/`cacheTag` for cacheable async data, and Suspense/request-time APIs for genuinely dynamic content.
- Do not add route segment config (`runtime`, `dynamic`, `revalidate`, etc.).
