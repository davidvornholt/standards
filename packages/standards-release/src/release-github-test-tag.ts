export type RemoteState = {
  release: 'absent' | 'draft' | 'prerelease' | 'published';
  tagSha: string | null;
};

type StubResponse = {
  readonly body: unknown;
  readonly status: number;
};

export type RemoteOptions = {
  readonly authorizationFailure?: 1 | 2;
  readonly authorizationTrailingBranches?: ReadonlyArray<unknown>;
  readonly authorizationTrailingComparisons?: ReadonlyArray<
    StubResponse | undefined
  >;
  readonly releaseAuthorizationTagSha?: string | null;
  readonly releaseCreateReadback?: boolean;
  readonly releaseCreateStatus?: number;
  readonly releaseRace?: boolean;
  readonly tagCreateReadbackSha?: string | null;
  readonly tagCreateStatus?: number;
  readonly tagRaceSha?: string | null;
};

const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;

export const readRemoteTag = (
  state: RemoteState,
  options: RemoteOptions,
  afterAuthorization: boolean,
): Response => {
  if (
    afterAuthorization &&
    Object.hasOwn(options, 'releaseAuthorizationTagSha')
  ) {
    state.tagSha = options.releaseAuthorizationTagSha ?? null;
  }
  return state.tagSha === null
    ? Response.json({ message: 'Not Found' }, { status: HTTP_NOT_FOUND })
    : Response.json(
        { object: { sha: state.tagSha, type: 'commit' } },
        { status: HTTP_OK },
      );
};
