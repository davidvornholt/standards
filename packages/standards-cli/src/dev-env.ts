import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeDevEnv } from './dev-env-compose';
import {
  type DevEnvRemoval,
  type DevEnvWrite,
  devEnvDestinationProblems,
} from './dev-env-destination';
import { devEnvGitIgnoreProblem } from './dev-env-destination-gitignore';
import { parseDevEnvDocument } from './dev-env-document';
import { renderDotenv } from './dev-env-dotenv';
import { planDevEnvRemovals } from './dev-env-reconciliation';
import { DEV_SECRETS_FILE, readDevSecrets } from './dev-env-secrets';
import { applyDevEnvChanges } from './dev-env-transaction';
import { parseYaml } from './yaml-parse';

export const DEV_CONFIG_FILE = 'config/dev.yaml';
export const DEV_LOCAL_FILE = 'config/dev.local.yaml';

export type DevEnvPlainInput = { readonly raw: unknown } | null;

export type DevEnvInputs = {
  readonly config: DevEnvPlainInput;
  readonly secrets: unknown;
  readonly local: DevEnvPlainInput;
};

type PlainLayerResult = {
  readonly input: DevEnvPlainInput;
  readonly present: boolean;
  readonly problems: ReadonlyArray<string>;
};

const isMissingPathError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ENOENT';

// Comment-only files parse to null and compose as empty documents.
const readPlainLayer = (consumer: string, rel: string): PlainLayerResult => {
  const path = join(consumer, rel);
  try {
    lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { input: null, present: false, problems: [] };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      input: null,
      present: true,
      problems: [`could not inspect ${rel}: ${detail}`],
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      input: null,
      present: true,
      problems: [`could not read ${rel}: ${detail}`],
    };
  }
  const parsed = parseYaml(raw, rel);
  if (parsed.problem !== null) {
    return { input: null, present: true, problems: [parsed.problem] };
  }
  return { input: { raw: parsed.value ?? {} }, present: true, problems: [] };
};

export type DevEnvPlan = {
  readonly writes: ReadonlyArray<DevEnvWrite>;
  readonly removals: ReadonlyArray<DevEnvRemoval>;
  readonly problems: ReadonlyArray<string>;
};

export const planDevEnvChanges = (
  consumer: string,
  inputs: DevEnvInputs,
): DevEnvPlan => {
  const layer = (source: string, input: DevEnvPlainInput) =>
    input === null
      ? null
      : { source, document: parseDevEnvDocument(input.raw, source) };
  const composed = composeDevEnv(
    layer(DEV_CONFIG_FILE, inputs.config),
    {
      source: DEV_SECRETS_FILE,
      document: parseDevEnvDocument(inputs.secrets, DEV_SECRETS_FILE),
    },
    layer(DEV_LOCAL_FILE, inputs.local),
  );
  const problems: Array<string> = [...composed.problems];
  const writes: Array<DevEnvWrite> = [];
  for (const target of composed.targets) {
    const workspaceDir = `${target.group}/${target.workspace}`;
    const rel = `${workspaceDir}/.env.local`;
    if (existsSync(join(consumer, workspaceDir, 'package.json'))) {
      const ignoreProblem = devEnvGitIgnoreProblem(consumer, rel);
      if (ignoreProblem === null) {
        writes.push({
          rel,
          content: renderDotenv(
            `${target.group}.${target.workspace}`,
            target.sources,
            target.env,
          ),
        });
      } else {
        problems.push(ignoreProblem);
      }
    } else {
      problems.push(
        `${target.sources.join(' + ')} defines ${target.group}.${target.workspace}, but ${workspaceDir}/package.json does not exist`,
      );
    }
  }
  const removalPlan = planDevEnvRemovals(consumer, writes);
  return {
    writes,
    removals: removalPlan.removals,
    problems: [...problems, ...removalPlan.problems],
  };
};

export const runDevEnv = async (consumer: string): Promise<boolean> => {
  const config = readPlainLayer(consumer, DEV_CONFIG_FILE);
  const secrets = readDevSecrets(consumer);
  const local = readPlainLayer(consumer, DEV_LOCAL_FILE);
  const localIgnoreProblem = local.present
    ? devEnvGitIgnoreProblem(consumer, DEV_LOCAL_FILE)
    : null;
  const acquisitionProblems = [
    ...config.problems,
    ...(secrets.ok ? [] : [secrets.problem]),
    ...local.problems,
  ];
  const localProblems = localIgnoreProblem === null ? [] : [localIgnoreProblem];
  if (acquisitionProblems.length > 0 || !secrets.ok) {
    const problems = [...acquisitionProblems, ...localProblems];
    console.error(`standards dev-env: ${problems.length} problem(s):`);
    console.error(problems.map((problem) => `  - ${problem}`).join('\n'));
    return false;
  }
  const plan = planDevEnvChanges(consumer, {
    config: config.input,
    secrets: secrets.value,
    local: local.input,
  });
  const problems = [
    ...localProblems,
    ...plan.problems,
    ...(await devEnvDestinationProblems(consumer, [
      ...plan.writes,
      ...plan.removals,
    ])),
  ];
  if (problems.length > 0) {
    console.error(`standards dev-env: ${problems.length} problem(s):`);
    console.error(problems.map((problem) => `  - ${problem}`).join('\n'));
    return false;
  }
  const generated = await applyDevEnvChanges(consumer, [
    ...plan.writes,
    ...plan.removals,
  ]);
  if (!generated.ok) {
    console.error('standards dev-env: generation failed:');
    console.error(
      generated.problems.map((problem) => `  - ${problem}`).join('\n'),
    );
    return false;
  }
  if (generated.warnings.length > 0) {
    console.error(
      `standards dev-env: generated files with ${generated.warnings.length} cleanup warning(s):`,
    );
    console.error(
      generated.warnings.map((warning) => `  - ${warning}`).join('\n'),
    );
  }
  for (const write of plan.writes) {
    console.log(`  wrote ${write.rel}`);
  }
  for (const removal of plan.removals) {
    console.log(`  removed ${removal.rel}`);
  }
  const inputFiles = [
    ...(config.input === null ? [] : [DEV_CONFIG_FILE]),
    DEV_SECRETS_FILE,
    ...(local.input === null ? [] : [DEV_LOCAL_FILE]),
  ];
  console.log(
    `standards dev-env: generated ${plan.writes.length} and removed ${plan.removals.length} env file(s) from ${inputFiles.join(' + ')}`,
  );
  return true;
};
