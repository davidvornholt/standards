// Composes the dev env layers — tracked config/dev.yaml, decrypted
// secrets/dev.yaml, and the gitignored per-machine config/dev.local.yaml —
// into one workspace-keyed target set. Later layers override earlier ones
// per env key. A key declared by both tracked shared layers is a placement
// error: a value is either configuration or a secret, never both.

import type {
  DevEnvDocument,
  DevEnvValue,
  EnvValues,
} from './dev-env-document';

export type DevEnvLayer = {
  readonly source: string;
  readonly document: DevEnvDocument;
};

export type ComposedDevEnvTarget = {
  readonly group: string;
  readonly workspace: string;
  readonly env: EnvValues;
  readonly sources: ReadonlyArray<string>;
};

export type ComposedDevEnv = {
  readonly targets: ReadonlyArray<ComposedDevEnvTarget>;
  readonly brokeredReferences: ReadonlySet<string>;
  readonly problems: ReadonlyArray<string>;
};

type MutableTarget = {
  readonly group: string;
  readonly workspace: string;
  readonly env: Record<string, DevEnvValue>;
  readonly sources: Array<string>;
};

const copyEnv = (source: EnvValues): Record<string, DevEnvValue> => {
  const copy = Object.create(null) as Record<string, DevEnvValue>;
  for (const [key, value] of Object.entries(source)) {
    copy[key] = value;
  }
  return copy;
};

const applyLayer = (
  merged: Map<string, MutableTarget>,
  layer: DevEnvLayer,
): void => {
  for (const target of layer.document.targets) {
    const key = `${target.group}.${target.workspace}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        group: target.group,
        workspace: target.workspace,
        env: copyEnv(target.env),
        sources: [layer.source],
      });
    } else {
      for (const [envKey, value] of Object.entries(target.env)) {
        existing.env[envKey] = value;
      }
      existing.sources.push(layer.source);
    }
  }
};

const sharedOverlapProblems = (
  config: DevEnvLayer,
  secrets: DevEnvLayer,
): ReadonlyArray<string> => {
  const secretTargets = new Map(
    secrets.document.targets.map((target) => [
      `${target.group}.${target.workspace}`,
      target,
    ]),
  );
  return config.document.targets.flatMap((target) => {
    const counterpart = secretTargets.get(
      `${target.group}.${target.workspace}`,
    );
    if (counterpart === undefined) {
      return [];
    }
    return [...target.declaredKeys]
      .filter((key) => counterpart.declaredKeys.has(key))
      .map(
        (key) =>
          `${target.group}.${target.workspace}.${key} is declared in both ${config.source} and ${secrets.source}; a value is either configuration or a secret, so keep it in exactly one`,
      );
  });
};

export const composeDevEnv = (
  config: DevEnvLayer | null,
  secrets: DevEnvLayer,
  local: DevEnvLayer | null,
): ComposedDevEnv => {
  const problems: ReadonlyArray<string> = [
    ...(config === null ? [] : config.document.problems),
    ...secrets.document.problems,
    ...(local === null ? [] : local.document.problems),
    ...(config === null ? [] : sharedOverlapProblems(config, secrets)),
  ];
  const merged = new Map<string, MutableTarget>();
  for (const layer of [config, secrets, local]) {
    if (layer !== null) {
      applyLayer(merged, layer);
    }
  }
  const targets = [...merged.values()]
    .sort((a, b) =>
      a.group === b.group
        ? a.workspace.localeCompare(b.workspace)
        : a.group.localeCompare(b.group),
    )
    .map((target) => ({
      group: target.group,
      workspace: target.workspace,
      env: target.env,
      sources: target.sources,
    }));
  return {
    targets,
    brokeredReferences: secrets.document.brokeredReferences,
    problems,
  };
};
