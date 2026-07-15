import {
  apiError,
  type BeforeGithubMutation,
  HTTP_OK,
  mutate,
} from './github-api';
import { diffRepositorySettings } from './github-diff';
import { decodeLiveRepositorySettings } from './github-repository-settings';
import { type GithubSettings, isRecord } from './github-settings';

type ApplyRepositorySettingsInput = {
  readonly beforeMutation: BeforeGithubMutation;
  readonly declared: GithubSettings;
  readonly live: Readonly<Record<string, unknown>>;
  readonly repo: string;
  readonly token: string;
};

const assertRepositoryUpdateConverged = (
  declared: GithubSettings,
  response: unknown,
): void => {
  if (!isRecord(response)) {
    throw new Error(
      'updating repository settings: GitHub returned an invalid repository response',
    );
  }
  const decoded = decodeLiveRepositorySettings(
    response,
    declared.repository,
    true,
  );
  const diff = diffRepositorySettings(declared.repository, decoded.settings);
  const problems = [
    ...decoded.problems,
    ...diff.drifted,
    ...diff.unverifiable.map(
      (key) => `repository setting "${key}" remained unverifiable`,
    ),
  ];
  if (problems.length > 0) {
    throw new Error(
      `updating repository settings did not prove convergence: ${problems.join('; ')}`,
    );
  }
};

export const applyRepositorySettings = async (
  input: ApplyRepositorySettingsInput,
): Promise<boolean> => {
  const diff = diffRepositorySettings(input.declared.repository, input.live);
  if (diff.drifted.length === 0 && diff.unverifiable.length === 0) {
    return false;
  }
  const patched = await mutate({
    beforeMutation: input.beforeMutation,
    body: input.declared.repository,
    method: 'PATCH',
    path: `/repos/${input.repo}`,
    token: input.token,
  });
  if (patched.status !== HTTP_OK) {
    throw new Error(apiError('updating repository settings', patched));
  }
  assertRepositoryUpdateConverged(input.declared, patched.body);
  return true;
};
