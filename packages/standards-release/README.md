# Standards release tooling

This private workspace owns the repository-only npm and GitHub release boundary. It is not part of the published `@davidvornholt/standards` package.

Release packing exclusively creates `packages/standards-cli/SOURCE_COMMIT` without overwriting a caller-owned file, includes the tested commit in the tarball, verifies that marker, and requires cleanup after both success and failure. Marker creation and cleanup failures remain tagged release errors, and simultaneous packing and cleanup failures retain both causes. Matching npm SRI therefore binds an artifact without `gitHead` metadata to the tested commit; legacy unmarked artifacts fail closed.

## Configuration

- **`GITHUB_REPOSITORY`** (required by GitHub release commands) — repository identifier in `owner/repository` form. GitHub Actions supplies it automatically.
- **`GH_TOKEN` / `GITHUB_TOKEN`** (one required by GitHub release commands) — GitHub API token used to inspect and reconcile tags and releases. The first non-empty value is used, preferring `GH_TOKEN`; the release workflow exposes its GitHub-provided token as `GH_TOKEN`.
