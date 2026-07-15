import { CANONICAL_SETTINGS_FILE, LOCAL_SETTINGS_FILE } from './github-api';
import {
  type LoadedGithubSettings,
  loadGithubSettings,
} from './github-settings';
import {
  type FileState,
  fileStatesMatch,
  inspectRepositoryFile,
  type RepositoryRoot,
} from './sync-filesystem';
import { assertRepositoryRootUnchanged } from './sync-repository-root-generation';

export type GithubDeclarationSnapshot = {
  readonly canonical: FileState;
  readonly local: FileState;
  readonly root: RepositoryRoot;
};

export type LoadedGithubDeclaration = LoadedGithubSettings & {
  readonly snapshot: GithubDeclarationSnapshot | null;
};

export const loadDeclared = async (
  root: RepositoryRoot,
): Promise<LoadedGithubDeclaration> => {
  const canonical = await inspectRepositoryFile(root, CANONICAL_SETTINGS_FILE);
  if (canonical.contents === null) {
    return {
      merged: null,
      problems: [
        `${CANONICAL_SETTINGS_FILE} not found; run \`bun standards sync\` first`,
      ],
      snapshot: null,
    };
  }
  const local = await inspectRepositoryFile(root, LOCAL_SETTINGS_FILE);
  return {
    ...loadGithubSettings(
      canonical.contents.toString('utf8'),
      local.contents?.toString('utf8') ?? null,
    ),
    snapshot: { canonical, local, root },
  };
};

export const assertGithubDeclarationUnchanged = async (
  snapshot: GithubDeclarationSnapshot,
): Promise<void> => {
  await assertRepositoryRootUnchanged(snapshot.root);
  const [canonical, local] = await Promise.all([
    inspectRepositoryFile(snapshot.root, CANONICAL_SETTINGS_FILE),
    inspectRepositoryFile(snapshot.root, LOCAL_SETTINGS_FILE),
  ]);
  await assertRepositoryRootUnchanged(snapshot.root);
  if (
    !(
      fileStatesMatch(canonical, snapshot.canonical) &&
      fileStatesMatch(local, snapshot.local)
    )
  ) {
    throw new Error('GitHub settings declaration changed during apply');
  }
};
