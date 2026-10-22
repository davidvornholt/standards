---
name: nextjs
description: Use when changing pages, layouts, Server Components, Route Handlers, Server Actions, caching, or rendering in a Next.js application. Applies the repository's Cache Components policy.
---

# Next.js

Next.js apps use Cache Components (`cacheComponents: true` in `next.config`). Cache async data with `'use cache'` plus `cacheLife` and `cacheTag`. Read request-time data such as `cookies()`, `headers()`, or `searchParams` inside a `<Suspense>` boundary, so the rest of the page still prerenders.

Don't export the older route segment options `dynamic`, `revalidate`, `fetchCache`, `dynamicParams`, or `runtime`. Cache Components replaces them, and Next.js rejects most of them once it's enabled. They dominate older examples, so they're easy to reach for out of habit.

Next.js ships the documentation for its installed version in the app's `node_modules/next/dist/docs/`. When unsure what replaces a segment option or how a caching API behaves, read `01-app/02-guides/migrating-to-cache-components.md` there instead of relying on memory. Moving an app that doesn't enable Cache Components yet is a change of its own, and the same guide covers it.
