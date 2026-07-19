// Workspace-group keyed dev secrets document: `apps.<name>` and
// `packages.<name>` map env keys to string values — the shape mirrored in
// secrets/dev.example.yaml. Parsing gathers every problem instead of failing
// on the first one so a malformed document is repaired in one pass.
import { isRecord } from './github-settings-parse';

export type EnvValues = Readonly<Record<string, string>>;

export type DevEnvTarget = {
  readonly group: string;
  readonly workspace: string;
  readonly env: EnvValues;
};

export type DevEnvDocument = {
  readonly targets: ReadonlyArray<DevEnvTarget>;
  readonly problems: ReadonlyArray<string>;
};

const WORKSPACE_GROUPS: ReadonlyArray<string> = ['apps', 'packages'];

const parseWorkspaceEnv = (
  label: string,
  raw: Record<string, unknown>,
): { readonly env: EnvValues; readonly problems: ReadonlyArray<string> } => {
  const problems: Array<string> = [];
  const entries: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      entries.push([key, value]);
    } else {
      problems.push(`${label}.${key} must be a string value`);
    }
  }
  return { env: Object.fromEntries(entries), problems };
};

export const parseDevEnvDocument = (
  raw: unknown,
  source: string,
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
      for (const [workspace, env] of Object.entries(workspaces)) {
        if (isRecord(env)) {
          const parsed = parseWorkspaceEnv(
            `${source} "${group}.${workspace}"`,
            env,
          );
          problems.push(...parsed.problems);
          targets.push({ group, workspace, env: parsed.env });
        } else {
          problems.push(
            `${source} "${group}.${workspace}" must map env keys to string values`,
          );
        }
      }
    } else {
      problems.push(
        `${source} "${group}" must map workspace names to env objects`,
      );
    }
  }
  return { targets, problems };
};
