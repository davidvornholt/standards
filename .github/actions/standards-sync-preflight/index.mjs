import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { inspectSyncPolicy } from '../../../packages/standards-cli/src/sync-policy.ts';

const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined;

const main = () => {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const outputFile = process.env.GITHUB_OUTPUT;
  const workspace = process.env.GITHUB_WORKSPACE;
  if (eventName !== 'schedule' && eventName !== 'repository_dispatch') {
    throw new Error(
      `Unsupported Standards sync event: ${eventName ?? 'unset'}`,
    );
  }
  if (outputFile === undefined || outputFile.length === 0) {
    throw new Error('GITHUB_OUTPUT is required');
  }
  if (workspace === undefined || workspace.length === 0) {
    throw new Error('GITHUB_WORKSPACE is required');
  }

  const inspection = inspectSyncPolicy({
    packageText: readIfPresent(join(workspace, 'package.json')),
    policyText: readIfPresent(join(workspace, 'sync-standards.local.json')),
  });
  if (inspection.policy === null || inspection.problems.length > 0) {
    throw new Error(inspection.problems.join('\n'));
  }

  const runSync =
    eventName === 'repository_dispatch' || inspection.policy.scheduledSync;
  appendFileSync(outputFile, `run_sync=${runSync}\n`);
  console.log(
    runSync
      ? 'standards: sync preflight enabled this run'
      : 'standards: scheduled sync disabled by sync-standards.local.json',
  );
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`standards: sync preflight failed: ${message}`);
  process.exitCode = 1;
}
