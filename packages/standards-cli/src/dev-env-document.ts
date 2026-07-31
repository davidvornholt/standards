// Workspace-group keyed dev env document: `apps.<name>` and
// `packages.<name>` map env keys to values — the shape mirrored in
// secrets/dev.example.yaml. Plain configuration layers may also declare a
// brokered S3 pair reference instead of a literal; the secrets layer may
// not, because a reference is configuration. The secrets layer instead owns
// the encrypted allowlist that authorizes exact target/key pairs. Parsing
// gathers every problem instead of failing on the first one so a malformed
// document is repaired in one pass.

import {
  type BrokeredS3Reference,
  isBrokeredS3ReferenceShape,
  parseBrokeredS3Reference,
} from './dev-env-brokered';
import {
  BROKERED_REFERENCES_KEY,
  parseBrokeredAllowlist,
} from './dev-env-brokered-allowlist';
import { encodeBunDotenvValue } from './dev-env-dotenv-value';
import { isRecord } from './github-settings-parse';

export type DevEnvValue = string | BrokeredS3Reference;

export type EnvValues = Readonly<Record<string, DevEnvValue>>;

export type DevEnvLayerKind = 'configuration' | 'secrets';

export type DevEnvTarget = {
  readonly group: string;
  readonly workspace: string;
  readonly env: EnvValues;
  readonly declaredKeys: ReadonlySet<string>;
};

export type DevEnvDocument = {
  readonly targets: ReadonlyArray<DevEnvTarget>;
  readonly brokeredReferences: ReadonlySet<string>;
  readonly problems: ReadonlyArray<string>;
};

const WORKSPACE_GROUPS: ReadonlyArray<string> = ['apps', 'packages'];
const PORTABLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const WORKSPACE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

type ParsedWorkspaces = {
  readonly targets: ReadonlyArray<DevEnvTarget>;
  readonly problems: ReadonlyArray<string>;
};

const parseWorkspaceValue = (
  label: string,
  key: string,
  value: unknown,
  layerKind: DevEnvLayerKind,
): {
  readonly value: DevEnvValue | null;
  readonly problems: ReadonlyArray<string>;
} => {
  if (typeof value === 'string') {
    return encodeBunDotenvValue(value) === null
      ? {
          value: null,
          problems: [
            `${label}.${key} cannot be represented losslessly in Bun dotenv syntax`,
          ],
        }
      : { value, problems: [] };
  }
  if (isBrokeredS3ReferenceShape(value)) {
    if (layerKind === 'secrets') {
      return {
        value: null,
        problems: [
          `${label}.${key} is a brokered S3 pair reference; references are configuration and belong in config/dev.yaml or config/dev.local.yaml, not the secrets layer`,
        ],
      };
    }
    const parsed = parseBrokeredS3Reference(`${label}.${key}`, value);
    return parsed.ok
      ? { value: parsed.reference, problems: [] }
      : { value: null, problems: parsed.problems };
  }
  return {
    value: null,
    problems: [
      layerKind === 'configuration'
        ? `${label}.${key} must be a string value or a brokered S3 pair reference`
        : `${label}.${key} must be a string value`,
    ],
  };
};

const parseWorkspaceEnv = (
  label: string,
  raw: Record<string, unknown>,
  layerKind: DevEnvLayerKind,
): {
  readonly env: EnvValues;
  readonly declaredKeys: ReadonlySet<string>;
  readonly problems: ReadonlyArray<string>;
} => {
  const problems: Array<string> = [];
  const env = Object.create(null) as Record<string, DevEnvValue>;
  const declaredKeys = new Set<string>();
  for (const [key, value] of Object.entries(raw)) {
    const portableName = PORTABLE_ENV_NAME.test(key);
    if (portableName) {
      declaredKeys.add(key);
    } else {
      problems.push(
        `${label} env key ${JSON.stringify(key)} must be a portable environment variable name`,
      );
    }
    const parsed = parseWorkspaceValue(label, key, value, layerKind);
    problems.push(...parsed.problems);
    if (portableName && parsed.value !== null) {
      env[key] = parsed.value;
    }
  }
  return { env, declaredKeys, problems };
};

const parseWorkspaces = (
  source: string,
  group: string,
  workspaces: Record<string, unknown>,
  layerKind: DevEnvLayerKind,
): ParsedWorkspaces => {
  const problems: Array<string> = [];
  const targets: Array<DevEnvTarget> = [];
  for (const [workspace, env] of Object.entries(workspaces)) {
    const validWorkspace = WORKSPACE_NAME.test(workspace);
    if (!validWorkspace) {
      problems.push(
        `${source} ${JSON.stringify(`${group}.${workspace}`)} workspace name must be one kebab-case path segment`,
      );
    }
    if (isRecord(env)) {
      const parsed = parseWorkspaceEnv(
        `${source} "${group}.${workspace}"`,
        env,
        layerKind,
      );
      problems.push(...parsed.problems);
      if (validWorkspace) {
        targets.push({
          group,
          workspace,
          env: parsed.env,
          declaredKeys: parsed.declaredKeys,
        });
      }
    } else {
      problems.push(
        `${source} "${group}.${workspace}" must map env keys to string values`,
      );
    }
  }
  return { targets, problems };
};

export const parseDevEnvDocument = (
  raw: unknown,
  source: string,
  layerKind: DevEnvLayerKind,
): DevEnvDocument => {
  if (!isRecord(raw)) {
    return {
      targets: [],
      brokeredReferences: new Set(),
      problems: [`${source} must decrypt to a YAML object`],
    };
  }
  const problems: Array<string> = [];
  const targets: Array<DevEnvTarget> = [];
  const brokeredReferences = new Set<string>();
  for (const [group, workspaces] of Object.entries(raw)) {
    if (group === BROKERED_REFERENCES_KEY) {
      const parsed = parseBrokeredAllowlist(source, workspaces, layerKind);
      problems.push(...parsed.problems);
      for (const entry of parsed.entries) {
        brokeredReferences.add(entry);
      }
    } else if (!WORKSPACE_GROUPS.includes(group)) {
      problems.push(
        `${source} top-level key "${group}" must be "apps" or "packages"${layerKind === 'secrets' ? ` or "${BROKERED_REFERENCES_KEY}"` : ''}`,
      );
    } else if (isRecord(workspaces)) {
      const parsed = parseWorkspaces(source, group, workspaces, layerKind);
      problems.push(...parsed.problems);
      targets.push(...parsed.targets);
    } else {
      problems.push(
        `${source} "${group}" must map workspace names to env objects`,
      );
    }
  }
  return { targets, brokeredReferences, problems };
};
