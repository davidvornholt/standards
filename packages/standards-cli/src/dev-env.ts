import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBrokeredReferences } from './dev-env-brokered-resolve';
import { composeDevEnv } from './dev-env-compose';
import {
  type DevEnvRemoval,
  type DevEnvWrite,
  devEnvDestinationProblems,
} from './dev-env-destination';
import { devEnvGitIgnoreProblem } from './dev-env-destination-gitignore';
import { parseDevEnvDocument } from './dev-env-document';
import { renderDotenv } from './dev-env-dotenv';
import type { DevEnvPlainInput } from './dev-env-plain-layer';
import { readPlainLayer } from './dev-env-plain-layer';
import { planDevEnvRemovals } from './dev-env-reconciliation';
import { DEV_SECRETS_FILE, readDevSecrets } from './dev-env-secrets';
import { applyDevEnvChanges } from './dev-env-transaction';

export const DEV_CONFIG_FILE = 'config/dev.yaml';
export const DEV_LOCAL_FILE = 'config/dev.local.yaml';

export type { DevEnvPlainInput } from './dev-env-plain-layer';

export type DevEnvInputs = {
  readonly config: DevEnvPlainInput;
  readonly secrets: unknown;
  readonly local: DevEnvPlainInput;
};

const documentProblems = (
  source: string,
  input: DevEnvPlainInput,
): ReadonlyArray<string> =>
  input === null
    ? []
    : parseDevEnvDocument(input.raw, source, 'allowed').problems;

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
      : { source, document: parseDevEnvDocument(input.raw, source, 'allowed') };
  const composed = composeDevEnv(
    layer(DEV_CONFIG_FILE, inputs.config),
    {
      source: DEV_SECRETS_FILE,
      document: parseDevEnvDocument(
        inputs.secrets,
        DEV_SECRETS_FILE,
        'forbidden',
      ),
    },
    layer(DEV_LOCAL_FILE, inputs.local),
  );
  const resolved = resolveBrokeredReferences(consumer, composed.targets);
  const problems: Array<string> = [...composed.problems, ...resolved.problems];
  const writes: Array<DevEnvWrite> = [];
  for (const target of resolved.targets) {
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
  const inputProblems = [
    ...config.problems,
    ...(secrets.ok ? [] : [secrets.problem]),
    ...local.problems,
    ...(localIgnoreProblem === null ? [] : [localIgnoreProblem]),
    ...documentProblems(DEV_CONFIG_FILE, config.input),
    ...(secrets.ok
      ? parseDevEnvDocument(secrets.value, DEV_SECRETS_FILE, 'forbidden')
          .problems
      : []),
    ...documentProblems(DEV_LOCAL_FILE, local.input),
  ];
  if (inputProblems.length > 0 || !secrets.ok) {
    console.error(`standards dev-env: ${inputProblems.length} problem(s):`);
    console.error(inputProblems.map((problem) => `  - ${problem}`).join('\n'));
    return false;
  }
  const plan = planDevEnvChanges(consumer, {
    config: config.input,
    secrets: secrets.value,
    local: local.input,
  });
  const problems = [
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
