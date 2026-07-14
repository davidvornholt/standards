# Standards release tooling

This private workspace owns the repository-only npm and GitHub release boundary. It is not part of the published `@davidvornholt/standards` package.

Release packing acquires ownership of `packages/standards-cli/SOURCE_COMMIT` only after a successful exclusive open, without overwriting or removing a caller-owned file. It records the acquired inode, writes the owned marker, includes the tested commit in the tarball, and verifies that marker while retaining the owning handle through cleanup so the inode cannot be recycled. Cleanup atomically quarantines the current directory entry before checking its inode and deletes only the proven owned entry, then closes the handle. A caller replacement is restored with a no-clobber link while a recovery link remains preserved at the path reported by the typed cleanup error; if the public path was concurrently occupied, the quarantined entry remains at that reported recovery path. Marker open, identity, write, cleanup, and close failures remain tagged release errors, and simultaneous operation and cleanup failures retain every cause. Matching npm SRI therefore binds an artifact without `gitHead` metadata to the tested commit; legacy unmarked artifacts fail closed.

## Configuration

- **`GITHUB_REPOSITORY`** (required by GitHub release commands) — repository identifier in `owner/repository` form. GitHub Actions supplies it automatically.
- **`GH_TOKEN` / `GITHUB_TOKEN`** (one required by GitHub release commands) — GitHub API token used to inspect and reconcile tags and releases. The first non-empty value is used, preferring `GH_TOKEN`; the release workflow exposes its GitHub-provided token as `GH_TOKEN`.
