---
name: nextjs
description: Use when changing pages, layouts, Server Components, Route Handlers, Server Actions, caching, or rendering in a Next.js application. Applies the repository's Cache Components policy.
---

# Next.js

Next.js apps use Cache Components (`cacheComponents: true`). Cache async data with `'use cache'` plus `cacheLife` and `cacheTag`, and read request-time data inside a `<Suspense>` boundary, so the rest of the page still prerenders. Don't export the route segment options `dynamic`, `dynamicParams`, `revalidate`, `fetchCache`, or `runtime`. Cache Components removes the first four and requires the default Node.js runtime.

Read the documentation for the installed version in `node_modules/next/dist/docs/` rather than relying on memory, starting with `01-app/02-guides/migrating-to-cache-components.md`. Moving an app that doesn't enable Cache Components yet is a change of its own.
