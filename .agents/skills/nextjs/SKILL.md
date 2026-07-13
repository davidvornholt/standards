---
name: nextjs
description: Must be used for every task in a Next.js app that adds or modifies pages, layouts, Server Components, Route Handlers, Server Actions, or caching/rendering behavior. Covers the Cache Components caching policy.
---

# Next.js

## Caching and rendering

- Use Next.js Cache Components patterns: `'use cache'` plus `cacheLife`/`cacheTag` for cacheable async data, and Suspense/request-time APIs for genuinely dynamic content.
- Do not add route segment config (`runtime`, `dynamic`, `revalidate`, etc.).
