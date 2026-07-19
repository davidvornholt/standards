import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DevEnvWrite,
  devEnvDestinationProblems,
} from './dev-env-destination';
import { parseDevEnvDocument } from './dev-env-document';
import { renderDotenv } from './dev-env-dotenv';
import { writeDevEnvFiles } from './dev-env-transaction';

export const DEV_SECRETS_FILE = 'secrets/dev.yaml';

const SOPS_ARGS = ['--decrypt', '--output-type', 'json', DEV_SECRETS_FILE];

type DecryptResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: string };

// sops emits JSON here so the CLI never parses the encrypted YAML itself; the
// nix fallback mirrors the canonical secrets.just tool resolution.
const decryptDevSecrets = (consumer: string): DecryptResult => {
  const localSops = spawnSync('sops', SOPS_ARGS, {
    cwd: consumer,
    encoding: 'utf8',
  });
  const result =
    localSops.error === undefined && localSops.status !== null
      ? localSops
      : spawnSync(
          'nix',
          [
            '--extra-experimental-features',
            'nix-command flakes',
            'run',
            'nixpkgs#sops',
            '--',
            ...SOPS_ARGS,
          ],
          { cwd: consumer, encoding: 'utf8' },
        );
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim();
    return {
      ok: false,
      problem: detail
        ? `could not decrypt ${DEV_SECRETS_FILE}: ${detail}`
        : `could not decrypt ${DEV_SECRETS_FILE}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as unknown };
  } catch (error) {
    return {
      ok: false,
      problem: `could not parse decrypted ${DEV_SECRETS_FILE} as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

// Writing decrypted values into the tree is only safe when git will never
// track them. `git check-ignore` is authoritative; anything but a clear
// "ignored" answer fails closed, including running outside a git checkout.
const gitIgnoreProblem = (consumer: string, rel: string): string | null => {
  const result = spawnSync('git', ['check-ignore', '-q', '--', rel], {
    cwd: consumer,
  });
  if (result.error !== undefined || result.status === null) {
    return `cannot run git to verify ${rel} is gitignored`;
  }
  if (result.status === 0) {
    return null;
  }
  if (result.status === 1) {
    return `${rel} is not gitignored; ignore it before generating dev env files`;
  }
  return `cannot verify ${rel} is gitignored (git check-ignore exited ${result.status})`;
};

export type DevEnvPlan = {
  readonly writes: ReadonlyArray<DevEnvWrite>;
  readonly problems: ReadonlyArray<string>;
};

export const planDevEnvWrites = (
  consumer: string,
  raw: unknown,
): DevEnvPlan => {
  const document = parseDevEnvDocument(raw, DEV_SECRETS_FILE);
  const problems: Array<string> = [...document.problems];
  const writes: Array<DevEnvWrite> = [];
  for (const target of document.targets) {
    const workspaceDir = `${target.group}/${target.workspace}`;
    const rel = `${workspaceDir}/.env.local`;
    if (existsSync(join(consumer, workspaceDir, 'package.json'))) {
      const ignoreProblem = gitIgnoreProblem(consumer, rel);
      if (ignoreProblem === null) {
        writes.push({
          rel,
          content: renderDotenv(
            `${target.group}.${target.workspace}`,
            DEV_SECRETS_FILE,
            target.env,
          ),
        });
      } else {
        problems.push(ignoreProblem);
      }
    } else {
      problems.push(
        `${DEV_SECRETS_FILE} defines ${target.group}.${target.workspace}, but ${workspaceDir}/package.json does not exist`,
      );
    }
  }
  return { writes, problems };
};

export const runDevEnv = async (consumer: string): Promise<boolean> => {
  if (!existsSync(join(consumer, DEV_SECRETS_FILE))) {
    console.error(
      `standards dev-env: ${DEV_SECRETS_FILE} not found; create it with \`just secrets edit dev\``,
    );
    return false;
  }
  const decrypted = decryptDevSecrets(consumer);
  if (!decrypted.ok) {
    console.error(`standards dev-env: ${decrypted.problem}`);
    return false;
  }
  const plan = planDevEnvWrites(consumer, decrypted.value);
  const problems = [
    ...plan.problems,
    ...(await devEnvDestinationProblems(consumer, plan.writes)),
  ];
  if (problems.length > 0) {
    console.error(`standards dev-env: ${problems.length} problem(s):`);
    console.error(problems.map((problem) => `  - ${problem}`).join('\n'));
    return false;
  }
  const generated = await writeDevEnvFiles(consumer, plan.writes);
  if (!generated.ok) {
    console.error('standards dev-env: generation failed:');
    console.error(
      generated.problems.map((problem) => `  - ${problem}`).join('\n'),
    );
    return false;
  }
  for (const write of plan.writes) {
    console.log(`  wrote ${write.rel}`);
  }
  console.log(
    `standards dev-env: generated ${plan.writes.length} env file(s) from ${DEV_SECRETS_FILE}`,
  );
  return true;
};
