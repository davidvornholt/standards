const BUN_PACKAGE_MANAGER =
  /^bun@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PACKAGE_MANAGER_PROBLEM =
  'package.json: "packageManager" must pin an exact bun@x.y.z version';

export const collectBunVersionProblems = (
  manifest: Record<string, unknown>,
): ReadonlyArray<string> =>
  typeof manifest.packageManager === 'string' &&
  BUN_PACKAGE_MANAGER.test(manifest.packageManager)
    ? []
    : [PACKAGE_MANAGER_PROBLEM];
