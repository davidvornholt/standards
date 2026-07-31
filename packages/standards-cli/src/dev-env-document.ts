// Workspace-group keyed dev env document: `apps.<name>` and
// `packages.<name>` map env keys to values — the shape mirrored in
// secrets/dev.example.yaml. Plain configuration layers may also declare a
// brokered S3 pair reference instead of a literal; the secrets layer may
// not, because a reference is configuration. Parsing gathers every problem
// instead of failing on the first one so a malformed document is repaired
// in one pass.

import {
  type BrokeredS3Reference,
  isBrokeredS3ReferenceShape,
  parseBrokeredS3Reference,
} from './dev-env-brokered';
import { encodeBunDotenvValue } from './dev-env-dotenv-value';
import { isRecord } from './github-settings-parse';

export type DevEnvValue = string | BrokeredS3Reference;

export type EnvValues = Readonly<Record<string, DevEnvValue>>;

export type DevEnvReferencesMode = 'allowed' | 'forbidden';

export type DevEnvTarget = {
  readonly group: string;
  readonly workspace: string;
  readonly env: EnvValues;
  readonly declaredKeys: ReadonlySet<string>;
};

export type DevEnvDocument = {
  readonly targets: ReadonlyArray<DevEnvTarget>;
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
  references: DevEnvReferencesMode,
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
    if (references === 'forbidden') {
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
      references === 'allowed'
        ? `${label}.${key} must be a string value or a brokered S3 pair reference`
        : `${label}.${key} must be a string value`,
    ],
  };
};

const parseWorkspaceEnv = (
  label: string,
  raw: Record<string, unknown>,
  references: DevEnvReferencesMode,
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
    const parsed = parseWorkspaceValue(label, key, value, references);
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
  references: DevEnvReferencesMode,
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
        references,
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
  references: DevEnvReferencesMode,
): DevEnvDocument => {
  if (!isRecord(raw)) {
    return {
      targets: [],
      problems: [`${source} must decrypt to a YAML object`],
    };
  }
  const problems: Array<string> = [];
  const targets: Array<DevEnvTarget> = [];
  for (const [group, workspaces] of Object.entries(raw)) {
    if (!WORKSPACE_GROUPS.includes(group)) {
      problems.push(
        `${source} top-level key "${group}" must be "apps" or "packages"`,
      );
    } else if (isRecord(workspaces)) {
      const parsed = parseWorkspaces(source, group, workspaces, references);
      problems.push(...parsed.problems);
      targets.push(...parsed.targets);
    } else {
      problems.push(
        `${source} "${group}" must map workspace names to env objects`,
      );
    }
  }
  return { targets, problems };
};
