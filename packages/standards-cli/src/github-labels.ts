// Live issue-label reading, drift, and convergence. Labels are an additive
// floor: every declared label must exist with the declared color and
// description; undeclared live labels (GitHub defaults, ad-hoc triage labels)
// are ignored. Any token that can read the repository can verify labels, so
// unlike merge settings there are no unverifiable states.

import { apiError, HTTP_CREATED, HTTP_OK, request } from './github-api';
import { listAllPages } from './github-paginate';
import { isRecord, type LabelDeclaration } from './github-settings-parse';

type LiveLabel = {
  readonly name: string;
  readonly color: string;
  readonly description: string;
};

export const fetchLiveLabels = async (
  token: string | null,
  repo: string,
): Promise<ReadonlyArray<LiveLabel>> => {
  const items = await listAllPages(
    token,
    `/repos/${repo}/labels`,
    `reading labels for ${repo}`,
  );
  return items.filter(isRecord).map((label) => ({
    name: typeof label.name === 'string' ? label.name : '',
    color: typeof label.color === 'string' ? label.color : '',
    description: typeof label.description === 'string' ? label.description : '',
  }));
};

const labelDrift = (
  declared: LabelDeclaration,
  live: LiveLabel | undefined,
): string | null => {
  if (live === undefined) {
    return `label "${declared.name}" is declared but missing on GitHub`;
  }
  // GitHub reports colors in varying case; declarations are lowercase.
  const liveColor = live.color.toLowerCase();
  if (liveColor !== declared.color) {
    return `label "${declared.name}" has color "${liveColor}" on GitHub, declared "${declared.color}"`;
  }
  if (live.description !== declared.description) {
    return `label "${declared.name}" has a different description on GitHub than declared`;
  }
  return null;
};

export const diffLabels = (
  declared: ReadonlyArray<LabelDeclaration>,
  live: ReadonlyArray<LiveLabel>,
): ReadonlyArray<string> => {
  const liveByName = new Map(live.map((label) => [label.name, label]));
  return declared.flatMap((label) => {
    const drift = labelDrift(label, liveByName.get(label.name));
    return drift === null ? [] : [drift];
  });
};

const convergeLabel = async (
  token: string,
  repo: string,
  declared: LabelDeclaration,
  live: LiveLabel | undefined,
): Promise<string | null> => {
  if (labelDrift(declared, live) === null) {
    return null;
  }
  if (live === undefined) {
    const created = await request(token, 'POST', `/repos/${repo}/labels`, {
      name: declared.name,
      color: declared.color,
      description: declared.description,
    });
    if (created.status !== HTTP_CREATED) {
      throw new Error(apiError(`creating label "${declared.name}"`, created));
    }
    return `created label "${declared.name}"`;
  }
  const updated = await request(
    token,
    'PATCH',
    `/repos/${repo}/labels/${encodeURIComponent(declared.name)}`,
    { color: declared.color, description: declared.description },
  );
  if (updated.status !== HTTP_OK) {
    throw new Error(apiError(`updating label "${declared.name}"`, updated));
  }
  return `updated label "${declared.name}"`;
};

export const applyLabels = async (
  token: string,
  repo: string,
  declared: ReadonlyArray<LabelDeclaration>,
): Promise<ReadonlyArray<string>> => {
  if (declared.length === 0) {
    return [];
  }
  const live = await fetchLiveLabels(token, repo);
  const liveByName = new Map(live.map((label) => [label.name, label]));
  const actions: Array<string> = [];
  for (const label of declared) {
    // biome-ignore lint/performance/noAwaitInLoops: GitHub advises against concurrent write requests (secondary rate limits); mutations run sequentially on purpose.
    const action = await convergeLabel(
      token,
      repo,
      label,
      liveByName.get(label.name),
    );
    if (action !== null) {
      actions.push(action);
    }
  }
  return actions;
};
