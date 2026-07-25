import { afterEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import { createSopsActionRunner } from './sops-secret-action-test-support';

const MASK_COMMAND_PREFIX = '::add-mask::';
const SECRET_KEY = 'example_token';
const runSopsAction = createSopsActionRunner(process.env);

afterEach(cleanupTmpDirs);

const ciValue = (value: string): string =>
  JSON.stringify({ ci: { [SECRET_KEY]: value } });

const unescapeRunnerCommandData = (value: string): string =>
  value.replaceAll('%0D', '\r').replaceAll('%0A', '\n').replaceAll('%25', '%');

describe('SOPS secret action masks', () => {
  it.each([
    'token%0Atail',
    'token%0Dtail',
    'token%25tail',
  ])('registers the complete literal percent sequence in %s', (secret) => {
    const actionRun = runSopsAction({ sopsOutput: ciValue(secret) });
    const commandData = actionRun.result.stdout
      .trimEnd()
      .slice(MASK_COMMAND_PREFIX.length);
    const registeredMask = unescapeRunnerCommandData(commandData);
    const exportedValue = actionRun.environment
      .trimEnd()
      .slice('GH_TOKEN='.length);

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.result.stdout).toBe(
      `${MASK_COMMAND_PREFIX}${secret.replaceAll('%', '%25')}\n`,
    );
    expect(exportedValue).toBe(secret);
    expect(exportedValue.replaceAll(registeredMask, '***')).toBe('***');
  });
});
