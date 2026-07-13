import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { decideReconciliation, decideRelease } from '../src/release-state.ts';

const requireArg = (value: string | undefined, name: string): string => {
  if (value === undefined || value === '') {
    process.stderr.write(`::error::${name} is required\n`);
    process.exit(1);
  }
  return value;
};

const writeOutput = (
  output: string,
  values: Readonly<Record<string, string | boolean>>,
): void => {
  const lines = Object.entries(values).map(
    ([key, value]) => `${key}=${value}\n`,
  );
  appendFileSync(output, lines.join(''));
};

const plan = (args: ReadonlyArray<string>): void => {
  const [output, version, parentVersion, npmLatest, npmVersionExists] = args;
  const result = decideRelease({
    npmLatest: npmLatest || null,
    npmVersionExists: npmVersionExists === 'true',
    parentVersion: requireArg(parentVersion, 'parent version'),
    version: requireArg(version, 'release version'),
  });
  if (!result.ok) {
    process.stderr.write(`::error::${result.error}\n`);
    process.exit(1);
  }
  writeOutput(requireArg(output, 'GitHub output path'), result.value);
};

const reconcile = (args: ReadonlyArray<string>): void => {
  const [output, expectedSha, releaseStatus, tagSha] = args;
  const requiredReleaseStatus = requireArg(releaseStatus, 'release status');
  if (!['absent', 'draft', 'published'].includes(requiredReleaseStatus)) {
    process.stderr.write(
      `::error::Unsupported release status ${requiredReleaseStatus}\n`,
    );
    process.exit(1);
  }
  const result = decideReconciliation({
    expectedSha: requireArg(expectedSha, 'release sha'),
    releaseStatus: requiredReleaseStatus as 'absent' | 'draft' | 'published',
    tagSha: tagSha || null,
  });
  if (!result.ok) {
    process.stderr.write(`::error::${result.error}\n`);
    process.exit(1);
  }
  writeOutput(requireArg(output, 'GitHub output path'), {
    action: result.value,
  });
};

const [command, ...commandArgs] = process.argv.slice(2);
if (command === 'plan') {
  plan(commandArgs);
} else if (command === 'reconcile') {
  reconcile(commandArgs);
} else {
  process.stderr.write(
    '::error::Expected release-state command plan or reconcile\n',
  );
  process.exit(1);
}
