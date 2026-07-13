import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type Decision,
  decideArtifactIdentity,
  decideRelease,
  type ReleasePlan,
} from './release-state';

export type ReleaseFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type NpmInspection = ReleasePlan & { readonly integrity: string };
type NpmState = {
  readonly gitHead: string | null;
  readonly integrity: string | null;
  readonly latest: string | null;
  readonly versionExists: boolean;
};

const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const responseMessage = (body: unknown): string =>
  isRecord(body) && typeof body.error === 'string'
    ? body.error
    : 'unexpected response';

const parseDeclaredVersion = (
  declared: unknown,
): Decision<Pick<NpmState, 'gitHead' | 'integrity'>> => {
  if (!isRecord(declared)) {
    return { error: 'Declared npm version metadata is invalid', ok: false };
  }
  const { dist, gitHead } = declared;
  if (!isRecord(dist)) {
    return { error: 'Declared npm version has no dist metadata', ok: false };
  }
  if ('gitHead' in declared && typeof gitHead !== 'string') {
    return { error: 'Declared npm version has invalid gitHead', ok: false };
  }
  return {
    ok: true,
    value: {
      gitHead: typeof gitHead === 'string' ? gitHead : null,
      integrity: typeof dist.integrity === 'string' ? dist.integrity : null,
    },
  };
};

const parseMetadata = (body: unknown, version: string): Decision<NpmState> => {
  if (!isRecord(body)) {
    return { error: 'npm returned invalid package metadata', ok: false };
  }
  const { 'dist-tags': tags, versions } = body;
  if (!(isRecord(tags) && isRecord(versions))) {
    return {
      error: 'npm metadata is missing dist-tags or versions',
      ok: false,
    };
  }
  const { latest } = tags;
  const declared = versions[version];
  if (declared === undefined) {
    return {
      ok: true,
      value: {
        gitHead: null,
        integrity: null,
        latest: typeof latest === 'string' ? latest : null,
        versionExists: false,
      },
    };
  }
  const identity = parseDeclaredVersion(declared);
  return identity.ok
    ? {
        ok: true,
        value: {
          ...identity.value,
          latest: typeof latest === 'string' ? latest : null,
          versionExists: true,
        },
      }
    : identity;
};

const loadNpmState = async (input: {
  readonly fetcher: ReleaseFetcher;
  readonly name: string;
  readonly registryUrl: string;
  readonly version: string;
}): Promise<Decision<NpmState>> => {
  let response: Response;
  try {
    response = await input.fetcher(
      `${input.registryUrl}/${encodeURIComponent(input.name)}`,
      { headers: { accept: 'application/json' } },
    );
  } catch (error) {
    return {
      error: `Reading npm metadata failed: ${String(error)}`,
      ok: false,
    };
  }
  if (response.status === HTTP_NOT_FOUND) {
    return {
      ok: true,
      value: {
        gitHead: null,
        integrity: null,
        latest: null,
        versionExists: false,
      },
    };
  }
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return { error: 'npm returned invalid JSON metadata', ok: false };
  }
  return response.status === HTTP_OK
    ? parseMetadata(body, input.version)
    : {
        error: `Reading npm metadata: HTTP ${response.status} ${responseMessage(body)}`,
        ok: false,
      };
};

export const npmIntegrity = async (artifact: string): Promise<string> => {
  const digest = createHash('sha512')
    .update(await readFile(artifact))
    .digest('base64');
  return `sha512-${digest}`;
};

export const inspectNpmRelease = async (input: {
  readonly artifact: string;
  readonly expectedSha: string;
  readonly fetcher?: ReleaseFetcher;
  readonly name: string;
  readonly parentVersion: string | null;
  readonly registryUrl?: string;
  readonly version: string;
}): Promise<Decision<NpmInspection>> => {
  const expectedIntegrity = await npmIntegrity(input.artifact);
  const state = await loadNpmState({
    fetcher: input.fetcher ?? fetch,
    name: input.name,
    registryUrl: input.registryUrl ?? 'https://registry.npmjs.org',
    version: input.version,
  });
  if (!state.ok) {
    return state;
  }
  const identity = decideArtifactIdentity({
    expectedIntegrity,
    expectedSha: input.expectedSha,
    npmGitHead: state.value.gitHead,
    npmIntegrity: state.value.integrity,
    npmVersionExists: state.value.versionExists,
  });
  if (!identity.ok) {
    return identity;
  }
  const plan = decideRelease({
    npmLatest: state.value.latest,
    npmVersionExists: state.value.versionExists,
    parentVersion: input.parentVersion,
    version: input.version,
  });
  return plan.ok
    ? { ok: true, value: { ...plan.value, integrity: expectedIntegrity } }
    : plan;
};
