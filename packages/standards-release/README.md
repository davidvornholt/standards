# Standards release tooling

This private workspace owns the repository-only npm and GitHub release boundary. It is not part of the published `@davidvornholt/standards` package.

Release packing acquires ownership of `packages/standards-cli/SOURCE_COMMIT` only after a successful exclusive open, without overwriting or removing a caller-owned file. It writes and closes the owned marker before packing, includes the tested commit in the tarball, verifies that marker, and requires cleanup after both success and failure. Marker open, write, close, and cleanup failures remain tagged release errors, and simultaneous operation and cleanup failures retain every cause. Matching npm SRI therefore binds an artifact without `gitHead` metadata to the tested commit; legacy unmarked artifacts fail closed.

## Configuration

- **`GITHUB_REPOSITORY`** (required by GitHub release commands) — repository identifier in `owner/repository` form. GitHub Actions supplies it automatically.
- **`GH_TOKEN` / `GITHUB_TOKEN`** (one required by GitHub release commands) — GitHub API token used to inspect and reconcile tags and releases. The first non-empty value is used, preferring `GH_TOKEN`; the release workflow exposes its GitHub-provided token as `GH_TOKEN`.
