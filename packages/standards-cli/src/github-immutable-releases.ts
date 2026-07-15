import {
  apiError,
  type BeforeGithubMutation,
  HTTP_NO_CONTENT,
  HTTP_OK,
  mutate,
  request,
} from './github-api';
import { isRecord } from './github-settings-value';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

export type LiveImmutableReleases = {
  readonly enabled: boolean | null;
  readonly problem: string | null;
  readonly unverifiable: boolean;
};

export const diffImmutableReleases = (
  declared: boolean | null,
  live: LiveImmutableReleases | null,
): {
  readonly drifted: ReadonlyArray<string>;
  readonly unverifiable: ReadonlyArray<string>;
} => {
  if (declared === null || live === null) {
    return { drifted: [], unverifiable: [] };
  }
  if (live.unverifiable) {
    return { drifted: [], unverifiable: ['immutable releases policy'] };
  }
  return live.enabled === declared
    ? { drifted: [], unverifiable: [] }
    : {
        drifted: [
          `immutable releases are ${String(live.enabled)} on GitHub, declared ${String(declared)}`,
        ],
        unverifiable: [],
      };
};

const pathFor = (repo: string): string => `/repos/${repo}/immutable-releases`;

export const fetchImmutableReleases = async (
  token: string | null,
  repo: string,
  detailRequired: boolean,
): Promise<LiveImmutableReleases> => {
  const response = await request(token, 'GET', pathFor(repo));
  if (
    response.status === HTTP_OK &&
    isRecord(response.body) &&
    typeof response.body.enabled === 'boolean' &&
    typeof response.body.enforced_by_owner === 'boolean'
  ) {
    return {
      enabled: response.body.enabled,
      problem: null,
      unverifiable: false,
    };
  }
  if (
    !detailRequired &&
    (response.status === HTTP_UNAUTHORIZED ||
      response.status === HTTP_FORBIDDEN ||
      response.status === HTTP_NOT_FOUND)
  ) {
    return { enabled: null, problem: null, unverifiable: true };
  }
  if (response.status === HTTP_NOT_FOUND) {
    return { enabled: false, problem: null, unverifiable: false };
  }
  return {
    enabled: null,
    problem: apiError('reading immutable releases policy', response),
    unverifiable: false,
  };
};

type ReconcileImmutableReleasesInput = {
  readonly beforeMutation: BeforeGithubMutation;
  readonly declared: boolean;
  readonly live: LiveImmutableReleases;
  readonly repo: string;
  readonly token: string;
};

type ApplyImmutableReleasePolicyInput = {
  readonly beforeMutation: BeforeGithubMutation;
  readonly declared: boolean | null;
  readonly live: LiveImmutableReleases | null;
  readonly reportAction: (action: string) => void;
  readonly repo: string;
  readonly token: string;
};

export const reconcileImmutableReleases = async ({
  beforeMutation,
  declared,
  live,
  repo,
  token,
}: ReconcileImmutableReleasesInput): Promise<string | null> => {
  if (live.enabled === null) {
    throw new Error(
      live.problem ?? 'immutable releases policy was not readable before apply',
    );
  }
  if (live.enabled === declared) {
    return null;
  }
  const updated = await mutate({
    beforeMutation,
    method: declared ? 'PUT' : 'DELETE',
    path: pathFor(repo),
    token,
  });
  if (updated.status !== HTTP_NO_CONTENT) {
    throw new Error(apiError('updating immutable releases policy', updated));
  }
  const verified = await fetchImmutableReleases(token, repo, true);
  if (verified.enabled !== declared) {
    throw new Error(
      verified.problem ??
        'immutable releases policy did not converge after apply',
    );
  }
  return `${declared ? 'enabled' : 'disabled'} immutable releases`;
};

export const applyImmutableReleasePolicy = async ({
  beforeMutation,
  declared,
  live,
  reportAction,
  repo,
  token,
}: ApplyImmutableReleasePolicyInput): Promise<void> => {
  if (declared === null || live === null) {
    return;
  }
  const action = await reconcileImmutableReleases({
    beforeMutation,
    declared,
    live,
    repo,
    token,
  });
  if (action !== null) {
    reportAction(action);
  }
};
